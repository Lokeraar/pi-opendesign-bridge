/**
 * opendesign-live.ts — Live /models Fetch layer for the `opendesign` provider.
 *
 * Two-layer catalog, after the design of @gtrabanco/pi-nan-provider, minus any
 * premium/tier gating: this layer registers exactly what the endpoint returns
 * for the stored key — no tier detection, no quotas, no paywall logic.
 *
 * Layer 1 — curated (always present): `models.json` (Mode 1) or `STATIC_MODELS`
 *   (Mode 2 fallback). Authoritative for VALUES of known ids: reasoning levels,
 *   `off` semantics and max output come from vendor docs + live probes and are
 *   never overwritten by the endpoint, which does not expose them.
 * Layer 2 — live (this file): `refreshModels()` driven by Pi core.
 *   • Phase 1 (always, cache-only): restore `ctx.stored` from models-store.json,
 *     re-merged so curated entries win; re-persists only when the merge changed.
 *   • Phase 2 (network allowed + credential): `GET {baseUrl}/models` — the live
 *     list is AUTHORITATIVE FOR MEMBERSHIP: new ids appear, removed ids drop.
 *     Values: curated → previously probed (stored) → auto-probe (brand-new ids).
 *     Persists via `ctx.publish({ persist })` and returns the merged list, which
 *     Pi's composer layer applies over models.json (`applyExtension` REPLACES
 *     the model list, so curated values must ride in the returned entries).
 *
 * Auto-probe per brand-new id (~15 tiny non-stream requests):
 *   • 6 effort levels → `null` on HTTP error (builds `thinkingLevelMap`);
 *   • `reasoning_effort:"none"` (+ reasoning token count) → `off:"none"` only
 *     when it is accepted AND returns 0 reasoning tokens; otherwise `off:null`;
 *   • ascending `max_tokens` ceiling → `maxTokens = min(context_budget, highestAccepted)`;
 *   • conservative placeholder on failure — a broken probe never blocks refresh.
 *
 * Kill switch: `PI_OPENDESIGN_LIVE=0` (or `false`/`off`) skips the live layer.
 * Maintenance: `PI_OPENDESIGN_REPROBE=1` re-probes the curated ids after a
 *   network refresh and reports ceiling/level drift plus retired ids to
 *   `<agentDir>/opendesign-reprobe.json` and stderr. Report-only, never mutates.
 * Freshness: one lightweight GET per network refresh (no TTL) — "live" semantics.
 *
 * This module imports node builtins ONLY, so the test harness can import the
 * real logic natively (node ≥ 22.6 type stripping) without the Pi runtime.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BundledCatalog,
  bareName,
  overlayDonors,
  readPiCatalogs,
} from "./donors-opendesign.ts";

// ---------------------------------------------------------------------------
// Types (structural mirrors of pi-ai / Pi extension types — see provider-composer.d.ts)
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** Model entry as returned by refreshModels (ProviderModelConfig). */
/**
 * Where each value came from. Lets a reader tell a MEASURED value from a
 * DECLARED one without trusting the bridge: `contextWindow` is never probed
 * (an over-long prompt is silently truncated, indistinguishable from success),
 * so it is always at best the endpoint's own claim.
 */
export type ValueOrigin = "curated" | "measured" | "gateway" | "vanilla";

export interface ValueProvenance {
  contextWindow: ValueOrigin;
  maxTokens: ValueOrigin;
  thinkingLevelMap: ValueOrigin;
  input: ValueOrigin;
  /** Which catalog decided this model's values, and which ones agreed. */
  donor?: {
    source: string;
    matchedId?: string;
    corroborating: string[];
    applied: string[];
  };
}

export interface LiveModelConfig {
  id: string;
  name: string;
  api?: string;
  provider?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Structural mirror of pi-ai's RefreshModelsContext. */
export interface RefreshModelsContextLike {
  credential?: { type?: string; key?: string };
  stored?: { models?: readonly LiveModelConfig[]; checkedAt?: number; etag?: string; lastModified?: number };
  publish(publication: { persist?: { models: LiveModelConfig[]; checkedAt?: number } | null; update?: () => void }): Promise<boolean>;
  allowNetwork: boolean;
  force?: boolean;
  signal: AbortSignal;
}

export interface ModelsJsonProviderLike {
  baseUrl?: string;
  compat?: Record<string, unknown>;
  models?: LiveModelConfig[];
}

// ---------------------------------------------------------------------------
// Static layer (shared with opendesign.ts registration and the harness)
// ---------------------------------------------------------------------------

export const OPENDESIGN_BASE_URL = "https://amr-link.open-design.ai/v1";
export const PROVIDER_ID = "opendesign";

export const THINKING_LEVELS: Array<Exclude<ThinkingLevel, "off">> = [
  "minimal", "low", "medium", "high", "xhigh", "max",
];

/**
 * `off` behaviour (measured 2026-10-01 against the gateway):
 *   - `"none"`: `reasoning_effort:"none"` accepted AND disables thinking (0
 *     reasoning tokens) — deepseek family, gpt-6-luna, mimo-v2.6 family.
 *   - `null`: rejected HTTP 400 (glm-5.3*, gpt-6.1-sol) or no effect
 *     (kimi-k2.7-code always thinks). `off` disappears from the UI.
 * Levels the gateway rejects are `null` so `clampThinkingLevel` snaps to the
 * nearest supported level instead of sending one the API refuses:
 *   - glm-5.3*: minimal/medium/xhigh (official spec: low/high/max only)
 *   - kimi-k2.7-code: max
 *   - gpt-6-luna / gpt-6.1-sol: minimal (official OpenAI spec)
 * `xhigh`/`max` must be listed explicitly or Pi never offers them.
 */
const OFF_NONE = new Set<string>([
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "deepseek-v4-pro",
  "deepseek-v4.1-flash",
  "gpt-6-luna",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
]);
const OFF_UNSUPPORTED = new Set<string>([
  "glm-5.3-flash",
  "glm-5.3-flashx",
  "gpt-6.1-sol",
  "kimi-k2.7-code",
]);

export function thinkingLevelMap(id: string): ThinkingLevelMap {
  const rejected = id.startsWith("glm-5.3")
    ? new Set<string>(["minimal", "medium", "xhigh"])
    : id === "kimi-k2.7-code"
      ? new Set<string>(["max"])
      : id.startsWith("gpt-6")
        ? new Set<string>(["minimal"])
        : new Set<string>();

  const map: ThinkingLevelMap = {};
  if (OFF_NONE.has(id)) map.off = "none";
  else if (OFF_UNSUPPORTED.has(id)) map.off = null;
  for (const level of THINKING_LEVELS) {
    map[level] = rejected.has(level) ? null : level;
  }
  return map;
}

/**
 * Static fallback list: [id, contextWindow, maxTokens, accepts images].
 * `contextWindow` = gateway `metadata.context_limit`;
 * `maxTokens` = min(`metadata.context_budget`, official vendor max output):
 *   GLM-5.3 and GPT-6 (luna/sol) cap output at 128K officially, below the
 *   gateway budget, so 128K wins there.
 *
 * `cost` is mandatory: Pi's usage calculator crashes without it. `compat` must
 * live per model: `applyExtension()` does not merge a provider-level compat.
 */
export const STATIC_MODELS: LiveModelConfig[] = ([
  ["deepseek-v4-flash", 1_048_000, 232_000, false],
  ["deepseek-v4-flash-vision-exp", 1_048_000, 232_000, true],
  ["deepseek-v4-pro", 1_048_000, 232_000, false],
  ["deepseek-v4.1-flash", 1_048_000, 232_000, true],
  ["glm-5.3-flash", 1_048_000, 128_000, true],
  ["glm-5.3-flashx", 1_000_000, 128_000, true],
  ["gpt-6-luna", 1_050_000, 128_000, true],
  ["gpt-6.1-sol", 1_050_000, 128_000, true],
  ["kimi-k2.7-code", 262_000, 262_000, true],
  ["mimo-v2.6-flash", 1_048_000, 131_072, true],
  ["mimo-v2.6-pro", 1_048_000, 131_072, true],
] as Array<[string, number, number, boolean]>).map(([id, contextWindow, maxTokens, images]) => ({
  id,
  name: id,
  api: "openai-completions",
  provider: PROVIDER_ID,
  reasoning: true,
  input: images ? (["text", "image"] as Array<"text" | "image">) : (["text"] as Array<"text" | "image">),
  contextWindow,
  maxTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false },
  thinkingLevelMap: thinkingLevelMap(id),
}));

// ---------------------------------------------------------------------------
// models.json access
// ---------------------------------------------------------------------------

/** Read `providers.opendesign` from models.json on every refresh (never stale). */
export function readProviderConfig(agentDir: string): ModelsJsonProviderLike | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
    const provider = (parsed as { providers?: Record<string, ModelsJsonProviderLike> } | null)?.providers?.opendesign;
    return provider && typeof provider === "object" ? provider : undefined;
  } catch {
    return undefined;
  }
}

/** Fill required fields and merge provider-level compat onto one entry. */
function normalize(m: LiveModelConfig, providerCompat?: Record<string, unknown>): LiveModelConfig {
  const mergedCompat = { supportsDeveloperRole: false, ...(providerCompat ?? {}), ...(m.compat ?? {}) };
  // Invariant: the ONLY models that reach here without provenance are the ones
  // read from models.json / STATIC_MODELS, i.e. hand-written. Probe and
  // conservativeModel always set it, and stored entries carry it forward via
  // the spread. So an absent provenance means "curated", by construction.
  const provenance: ValueProvenance = m.provenance ?? {
    contextWindow: "curated",
    maxTokens: "curated",
    thinkingLevelMap: "curated",
    input: "curated",
  };
  return {
    ...m,
    name: m.name ?? m.id,
    api: m.api ?? "openai-completions",
    provider: PROVIDER_ID,
    reasoning: m.reasoning ?? true,
    input: m.input && m.input.length ? m.input : ["text"],
    cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow && m.contextWindow > 0 ? m.contextWindow : 128_000,
    maxTokens: m.maxTokens && m.maxTokens > 0 ? m.maxTokens : 16_384,
    compat: mergedCompat,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  /** reasoning tokens reported by usage, when present */
  rt?: number;
  status?: number;
  /** transport-level failure (timeout/conn) as opposed to an HTTP rejection */
  net?: boolean;
}

async function postChat(
  baseUrl: string,
  key: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  timeoutMs = 20_000,
): Promise<ProbeResult> {
  if (signal.aborted) return { ok: false, net: true };
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = (await res.json()) as {
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    const rt = json?.usage?.completion_tokens_details?.reasoning_tokens;
    return { ok: true, rt: typeof rt === "number" ? rt : undefined };
  } catch (error) {
    if (signal.aborted) return { ok: false, net: true };
    return { ok: false, net: true };
  }
}

interface LiveListing {
  id: string;
  inputModalities: string[];
  contextLimit?: number;
  contextBudget?: number;
}

/** Non-chat endpoint ids the chat picker must never see (embed/tts/image-gen...). */
const NOISE_PATTERN = /\b(embed|embedding|tts|whisper|dall-?e|clip|moderation|rerank|reranker)\b|^image[-_]|[-_]embed/i;

/** Fetch + normalize the endpoint catalog. Exported for the maintenance CLI. */
export async function fetchLiveListing(
  baseUrl: string,
  key: string,
  signal: AbortSignal,
): Promise<LiveListing[] | undefined> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: Array<{
        id?: unknown;
        enabled?: unknown;
        architecture?: { input_modalities?: unknown };
        metadata?: { context_limit?: unknown; context_budget?: unknown };
      }>;
    };
    const out: LiveListing[] = [];
    for (const entry of json?.data ?? []) {
      const id = typeof entry?.id === "string" ? entry.id : undefined;
      if (!id || entry.enabled === false || NOISE_PATTERN.test(id)) continue;
      const modalities = Array.isArray(entry.architecture?.input_modalities)
        ? (entry.architecture!.input_modalities as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const limit = entry.metadata?.context_limit;
      const budget = entry.metadata?.context_budget;
      out.push({
        id,
        inputModalities: modalities,
        contextLimit: typeof limit === "number" && limit > 0 ? limit : undefined,
        contextBudget: typeof budget === "number" && budget > 0 ? budget : undefined,
      });
    }
    return out;
  } catch {
    return undefined; // endpoint unreachable → live layer no-ops, curated layer stays
  }
}

// ---------------------------------------------------------------------------
// Auto-probe for brand-new ids
// ---------------------------------------------------------------------------

const PROBE_BODY_MESSAGES = [
  { role: "system", content: "Be terse." },
  { role: "user", content: "hi" },
];
/** Ascending output-cap candidates; first HTTP rejection stops the walk. */
const CEILING_CANDIDATES = [8_192, 32_768, 131_072, 262_144, 393_216, 524_288, 1_048_576, 2_097_152];

function conservativeModel(listing: LiveListing): LiveModelConfig {
  return normalize({
    id: listing.id,
    name: listing.id,
    reasoning: true,
    input: listing.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    contextWindow: listing.contextLimit ?? 1_000_000,
    maxTokens: listing.contextBudget ?? 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
    thinkingLevelMap: { off: null, minimal: null, low: null, medium: "medium", high: null, xhigh: null, max: null },
    provenance: {
      contextWindow: listing.contextLimit ? "gateway" : "vanilla",
      maxTokens: listing.contextBudget ? "gateway" : "vanilla",
      thinkingLevelMap: "vanilla",
      input: listing.inputModalities.length ? "gateway" : "vanilla",
    } satisfies ValueProvenance,
  });
}

/**
 * HTTP statuses that mean "this parameter is wrong for this model" — the only
 * kind of rejection that is a valid per-parameter MEASUREMENT.
 *
 * Everything else is a request-level failure that says nothing about the model:
 * 402 quota exhausted, 401/403 auth, 429 rate limit, 5xx, transport errors.
 * Treating those as measurements is how a probe concludes "this model has no
 * reasoning levels and a 232k ceiling" while the account simply cannot pay.
 */
function isParameterRejection(status?: number): boolean {
  return status === 400 || status === 422;
}

/**
 * Measure a brand-new model: level acceptance, real `off` behaviour and the
 * output ceiling. Returns `undefined` on transport failure (caller falls back
 * to `conservativeModel`); an HTTP rejection per level is a valid measurement.
 */
export async function probeNewModel(
  listing: LiveListing,
  baseUrl: string,
  key: string,
  signal: AbortSignal,
): Promise<LiveModelConfig | undefined> {
  const base = { model: listing.id, messages: PROBE_BODY_MESSAGES, max_tokens: 16, stream: false };

  const noParam = await postChat(baseUrl, key, base, signal);
  // Quota/auth/rate-limit/5xx is not a measurement — do not derive values from it.
  if (!noParam.ok && !isParameterRejection(noParam.status)) return undefined;

  // 1. effort levels
  const map: ThinkingLevelMap = {};
  let anyLevelOk = false;
  let anyReasoningSeen = (noParam.rt ?? 0) > 0;
  for (const level of THINKING_LEVELS) {
    if (signal.aborted) return undefined;
    const r = await postChat(baseUrl, key, { ...base, reasoning_effort: level }, signal);
    if (!r.ok && !isParameterRejection(r.status)) return undefined;
    map[level] = r.ok ? level : null;
    if (r.ok) anyLevelOk = true;
    if ((r.rt ?? 0) > 0) anyReasoningSeen = true;
  }

  // 2. `off` semantics: accepted AND zero reasoning tokens → "none"
  if (signal.aborted) return undefined;
  const none = await postChat(baseUrl, key, { ...base, reasoning_effort: "none" }, signal);
  if (!none.ok && !isParameterRejection(none.status)) return undefined;
  map.off = none.ok && !(none.rt !== undefined && none.rt > 0) ? "none" : null;
  if ((none.rt ?? 0) > 0) anyReasoningSeen = true;

  // A model that rejects every effort value AND never reports reasoning tokens
  // is classified as non-reasoning (Pi then hides the thinking selector).
  const reasoning = anyLevelOk || none.ok || anyReasoningSeen;

  // 3. output ceiling (no effort param — effort validation must not confound it)
  let highest = 0;
  for (const n of CEILING_CANDIDATES) {
    if (signal.aborted) return undefined;
    const r = await postChat(baseUrl, key, { ...base, max_tokens: n }, signal, 30_000);
    if (!r.ok) {
      // A timeout or quota error mid-walk is not a ceiling measurement; bail out
      // so the caller uses the conservative placeholder instead of a wrong floor.
      if (!isParameterRejection(r.status)) return undefined;
      break;
    }
    highest = n;
  }
  const budget = listing.contextBudget;
  const contextWindow = listing.contextLimit ?? 1_000_000;
  const maxTokens =
    budget !== undefined
      ? Math.min(budget, highest > 0 ? highest : budget)
      : highest > 0
        ? highest
        : Math.min(contextWindow, 16_384);

  return normalize({
    id: listing.id,
    name: listing.id,
    reasoning,
    input: listing.inputModalities.includes("image") ? ["text", "image"] : ["text"],
    contextWindow,
    maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsDeveloperRole: false },
    thinkingLevelMap: map,
    provenance: {
      contextWindow: listing.contextLimit ? "gateway" : "vanilla",
      maxTokens: "measured",
      thinkingLevelMap: "measured",
      input: listing.inputModalities.length ? "gateway" : "vanilla",
    } satisfies ValueProvenance,
  });
}

// ---------------------------------------------------------------------------
// Curated re-probe audit — PI_OPENDESIGN_REPROBE
//
// Curated values are authoritative and never overwritten at runtime, so a
// vendor that moves a ceiling leaves this bridge silently stale forever. The
// audit re-runs the SAME probe used for brand-new ids against every curated id
// the endpoint still serves, and reports drift. It never mutates the catalog:
// the maintainer reads the report and decides. Report-only on purpose —
// promoting a measured value automatically is what this audit exists to make
// unnecessary.
//
// It also reports RETIRED ids: curated entries the endpoint no longer lists.
// Membership is live-only, so the published catalog already drops them, but
// models.json may still declare them and Pi composes models.json ABOVE the
// provider — so only the config can actually remove one.
// ---------------------------------------------------------------------------

export interface ReprobeFinding {
  id: string;
  field: "contextWindow" | "maxTokens" | "thinkingLevelMap" | "reasoning" | "input";
  curated: unknown;
  measured: unknown;
  status: "changed" | "match" | "probe-failed";
  /**
   * What the "measured" side actually IS. Critical: `maxTokens` comes from a
   * real probe, but `contextWindow` is only what the gateway DECLARES. Reading
   * a context drift as "my curated value is wrong" would overwrite a verified
   * number with an unverified one.
   */
  basis: "probe" | "gateway-declaration" | "none";
}

export interface ReprobeReport {
  generatedAt: string;
  baseUrl: string;
  audited: number;
  changed: ReprobeFinding[];
  retired: string[];
  uncurated: string[];
  findings: ReprobeFinding[];
}

function truthyEnv(envName: string): boolean {
  const v = (process.env[envName] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

/**
 * Numeric fields are compared with tolerance: curated values are hand-written
 * in round units (128_000) while the probe reports candidate steps (131_072).
 * Same window, different notation — flagging it would bury real drift in noise.
 */
function numericClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.05 * Math.max(Math.abs(a), Math.abs(b));
}

/**
 * Which side of the comparison is authoritative. The probe measured
 * `maxTokens`, the effort levels and `reasoning`; `contextWindow` and `input`
 * are only what the endpoint DECLARED, because context cannot be probed
 * (an over-long prompt is silently truncated, which looks identical to success).
 */
const FIELD_BASIS: Record<ReprobeFinding["field"], ReprobeFinding["basis"]> = {
  contextWindow: "gateway-declaration",
  maxTokens: "probe",
  thinkingLevelMap: "probe",
  reasoning: "probe",
  input: "gateway-declaration",
};

function diffCuratedVsMeasured(curated: LiveModelConfig, measured: LiveModelConfig): ReprobeFinding[] {
  const out: ReprobeFinding[] = [];
  const numeric = (field: "contextWindow" | "maxTokens") => {
    const a = Number(curated[field] ?? 0);
    const b = Number(measured[field] ?? 0);
    return numericClose(a, b) ? null : { field, curated: a, measured: b };
  };
  const exact = (field: "thinkingLevelMap" | "reasoning" | "input") => {
    const a = JSON.stringify(curated[field] ?? null);
    const b = JSON.stringify(measured[field] ?? null);
    return a === b ? null : { field, curated: curated[field] ?? null, measured: measured[field] ?? null };
  };
  for (const field of ["contextWindow", "maxTokens"] as const) {
    const d = numeric(field);
    if (d) out.push({ id: curated.id, status: "changed", basis: FIELD_BASIS[field], ...d });
  }
  for (const field of ["thinkingLevelMap", "reasoning", "input"] as const) {
    const d = exact(field);
    if (d) out.push({ id: curated.id, status: "changed", basis: FIELD_BASIS[field], ...d });
  }
  return out;
}

function fmt(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

function writeReprobeReport(agentDir: string, report: ReprobeReport): void {
  const path = join(agentDir, "opendesign-reprobe.json");
  try {
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    // A read-only agent dir must not break the refresh.
  }

  const tag = "[opendesign:reprobe]";
  console.error(`${tag} ${report.changed.length} drift(s), ${report.retired.length} retired, ${report.audited} audited → ${path}`);
  let warnedGateway = false;
  for (const f of report.changed) {
    const suffix = f.basis === "gateway-declaration" ? "  [gateway-declaration: verify against vendor docs]" : "";
    if (f.basis === "gateway-declaration") warnedGateway = true;
    console.error(`${tag}   ${f.id}.${f.field}: curated=${fmt(f.curated)} ${f.basis}=${fmt(f.measured)}${suffix}`);
  }
  if (warnedGateway) {
    console.error(`${tag}   ^ those rows are NOT measurements. The endpoint declared them; verify against vendor docs before changing your curated value.`);
  }
  for (const id of report.retired) {
    console.error(`${tag}   RETIRED ${id}: curated but absent from ${report.baseUrl}/models — remove it from models.json`);
  }
}

/**
 * Re-probe every curated id the endpoint still serves and diff the result.
 * Costs ~16 tiny requests per curated model; run it deliberately, not per refresh.
 */
export async function runReprobeAudit(options: {
  agentDir: string;
  baseUrl: string;
  key: string;
  signal: AbortSignal;
  curated: readonly LiveModelConfig[];
  live: readonly LiveListing[];
}): Promise<ReprobeReport | undefined> {
  const liveById = new Map(options.live.map((l) => [l.id, l]));
  const curatedIds = new Set(options.curated.map((m) => m.id));
  const retired = options.curated.filter((m) => !liveById.has(m.id)).map((m) => m.id);
  const uncurated = options.live.filter((l) => !curatedIds.has(l.id)).map((l) => l.id);

  const findings: ReprobeFinding[] = [];
  let audited = 0;
  for (const entry of options.curated) {
    if (options.signal.aborted) return undefined;
    const listing = liveById.get(entry.id);
    if (!listing) continue; // retired: reported separately, never probed
    audited++;
    const measured = await probeNewModel(listing, options.baseUrl, options.key, options.signal);
    if (!measured) {
      findings.push({ id: entry.id, field: "maxTokens", curated: null, measured: null, status: "probe-failed", basis: "none" });
      continue;
    }
    findings.push(...diffCuratedVsMeasured(entry, measured));
  }

  const report: ReprobeReport = {
    generatedAt: new Date().toISOString(),
    baseUrl: options.baseUrl,
    audited,
    changed: findings.filter((f) => f.status === "changed"),
    retired,
    uncurated,
    findings,
  };
  writeReprobeReport(options.agentDir, report);
  return report;
}

// ---------------------------------------------------------------------------
// Retirement ledger — closes the offline-resurrection loop
//
// Pi's store is a cache, and Phase 1 (offline) unions `stored + curated`. So a
// model the endpoint retired stayed alive forever: it was re-added from
// models.json and re-persisted on every offline refresh. `publish` cannot carry
// a side-car field (only `models` + `checkedAt`), so the ledger lives in its own
// file next to the store.
//
// It records only ids a SUCCESSFUL live check did not serve, so it is
// self-correcting: if the endpoint lists the model again, Phase 2 drops it from
// the ledger and it returns with its curated values intact.
// ---------------------------------------------------------------------------

const RETIRED_FILE = "opendesign-retired.json";

export interface RetiredLedger {
  updatedAt: number;
  /** id -> epoch ms of the live check that first stopped serving it. */
  retired: Record<string, number>;
}

function readRetiredLedger(agentDir: string): RetiredLedger {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir, RETIRED_FILE), "utf8")) as RetiredLedger;
    if (parsed && typeof parsed === "object" && parsed.retired && typeof parsed.retired === "object") {
      return parsed;
    }
  } catch {
    // Missing or corrupt: treat as "nothing retired" so we never hide a model.
  }
  return { updatedAt: 0, retired: {} };
}

function writeRetiredLedger(agentDir: string, ledger: RetiredLedger): void {
  try {
    writeFileSync(join(agentDir, RETIRED_FILE), `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    // Read-only agent dir must not break the refresh.
  }
}

/** Record which curated/stored ids the endpoint stopped serving. */
function reconcileRetired(
  agentDir: string,
  liveIds: ReadonlySet<string>,
  candidates: readonly LiveModelConfig[],
): RetiredLedger {
  const ledger = readRetiredLedger(agentDir);
  const now = Date.now();
  const next: Record<string, number> = { ...ledger.retired };
  // Served again by the endpoint → no longer retired.
  for (const id of Object.keys(next)) if (liveIds.has(id)) delete next[id];
  // Newly retired: candidate ids that a SUCCESSFUL live check did not serve.
  for (const m of candidates) {
    if (liveIds.has(m.id)) continue;
    next[m.id] ??= now; // keep the ORIGINAL retirement date
  }
  if (JSON.stringify(next) === JSON.stringify(ledger.retired)) return ledger;
  const updated: RetiredLedger = { updatedAt: now, retired: next };
  writeRetiredLedger(agentDir, updated);
  return updated;
}

// ---------------------------------------------------------------------------
// refreshModels — the two-phase hook
// ---------------------------------------------------------------------------

export interface RefreshModelsOptions {
  agentDir: string;
  /** Fallback when models.json does not declare a baseUrl. */
  fallbackBaseUrl?: string;
  /** Test hook: force the endpoint (production leaves this undefined). */
  baseUrlOverride?: string;
  /** Env var name for the kill switch (default PI_OPENDESIGN_LIVE). */
  killSwitchEnv?: string;
  /** Env var name for the curated re-probe audit (default PI_OPENDESIGN_REPROBE). */
  reprobeEnv?: string;
}

function liveDisabled(envName: string): boolean {
  const v = process.env[envName];
  return v === "0" || v === "false" || v === "off";
}

function sameModels(a: readonly LiveModelConfig[], b: readonly LiveModelConfig[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pi's extension loader treats EVERY `extensions/*.ts` file as an extension
 * factory and reports "does not export a valid factory function" otherwise.
 * This module is a helper imported by `opendesign.ts`, so it must expose a
 * no-op default factory to load silently alongside it.
 */
export default async function opendesignLiveHelper(): Promise<void> {}

/**
 * Tokens held back from an output ceiling so the prompt has room. A ceiling equal
 * to the window always fails: the endpoint answers "This request needs about N
 * tokens (messages + tools + max_tokens)". Measured on a 262,144-token window,
 * 262,144 was rejected and 261,120 passed.
 */
const PROMPT_RESERVE_TOKENS = 2_048;

/**
 * Apply Pi's bundled catalogs to models we already built, and record where each
 * value came from.
 *
 * Runs on both phases so the offline catalog is not a worse version of the live
 * one. `contextWindow` and `cost` are never touched: they belong to the endpoint.
 */
function overlayBundled(
  models: LiveModelConfig[],
  bundled: readonly BundledCatalog[],
): LiveModelConfig[] {
  if (!bundled.length) return models;
  return models.map((m) => {
    const r = overlayDonors(m, bareName(m.id), bundled);
    const out = { ...r.entry } as LiveModelConfig;
    // A ceiling the window cannot hold is not a bigger claim, it is an
    // impossible one. A ceiling inside the limit is used exactly as given.
    const window = Number(out.contextWindow);
    if (Number.isFinite(window) && window > 0 && Number(out.maxTokens) > 0) {
      out.maxTokens = Math.min(out.maxTokens, Math.max(1024, window - PROMPT_RESERVE_TOKENS));
    }
    out.provenance = {
      ...out.provenance,
      donor: {
        source: r.source ?? "none",
        matchedId: r.matchedId,
        corroborating: r.corroborating,
        applied: r.applied,
      },
    } as LiveModelConfig["provenance"];
    return out;
  });
}

export function makeRefreshModels(options: RefreshModelsOptions) {
  const envName = options.killSwitchEnv ?? "PI_OPENDESIGN_LIVE";

  return async function refreshModels(
    ctx: RefreshModelsContextLike,
  ): Promise<LiveModelConfig[] | undefined> {
    if (liveDisabled(envName)) return undefined;

    const cfg = readProviderConfig(options.agentDir);
    // Pi's bundled catalogs: no credential needed, they are data Pi ships.
    // Read once per refresh; a missing directory simply yields no donor.
    const bundled = readPiCatalogs(options.agentDir, { exclude: [PROVIDER_ID] });
    const curatedSource = cfg?.models && cfg.models.length ? cfg.models : STATIC_MODELS;
    const curated = curatedSource.map((m) => normalize(m, cfg?.compat));
    const curatedById = new Map(curated.map((m) => [m.id, m]));
    const baseUrl = options.baseUrlOverride ?? cfg?.baseUrl ?? options.fallbackBaseUrl ?? OPENDESIGN_BASE_URL;
    const storedModels = (ctx.stored?.models ?? []).filter(
      (m) => m && typeof m.id === "string" && (!m.provider || m.provider === PROVIDER_ID),
    );

    // ---- Phase 1: cache-only restore (runs on every runtime creation) ----
    if (!ctx.allowNetwork) {
      if (!storedModels.length) return undefined;
      // Ids a previous SUCCESSFUL live check found retired must not come back,
      // neither from the store nor from models.json. Without this the union
      // below re-added and re-persisted a dead model on every offline refresh.
      const retiredIds = new Set(Object.keys(readRetiredLedger(options.agentDir).retired));
      const alive = (m: LiveModelConfig) => !retiredIds.has(m.id);
      const liveStored = storedModels.filter(alive);
      const liveCurated = curated.filter(alive);
      // Union of last-known membership + curated ids; curated VALUES win.
      const ids: string[] = [];
      for (const m of [...liveStored, ...liveCurated]) if (!ids.includes(m.id)) ids.push(m.id);
      const merged = ids.map((id) => {
        const storedEntry = liveStored.find((m) => m.id === id);
        return normalize(curatedById.get(id) ?? (storedEntry as LiveModelConfig), cfg?.compat);
      });
      const mergedDonated = overlayBundled(merged, bundled);
      if (ctx.signal.aborted) return mergedDonated;
      if (!sameModels(mergedDonated, storedModels)) {
        const ok = await ctx.publish({
          persist: { models: mergedDonated, checkedAt: ctx.stored?.checkedAt },
        });
        if (!ok || ctx.signal.aborted) return undefined;
      }
      return mergedDonated;
    }

    // ---- Phase 2: live membership (network + credential) ----
    const key = ctx.credential?.type === "api_key" ? ctx.credential.key : undefined;
    if (!key) return undefined;

    const live = await fetchLiveListing(baseUrl, key, ctx.signal);
    if (!live || ctx.signal.aborted) return undefined;

    // This fetch SUCCEEDED, so it is authoritative about membership: whatever it
    // did not serve is now retired, unless the fetch was empty.
    if (live.length) {
      reconcileRetired(options.agentDir, new Set(live.map((l) => l.id)), [...storedModels, ...curated]);
    }

    const storedById = new Map(storedModels.map((m) => [m.id, m]));
    const out: LiveModelConfig[] = [];
    for (const listing of live) {
      if (ctx.signal.aborted) return undefined;
      const known = curatedById.get(listing.id);
      if (known) {
        out.push(known); // curated values are never overwritten by metadata
        continue;
      }
      const previous = storedById.get(listing.id);
      if (previous) {
        out.push(normalize(previous, cfg?.compat)); // already probed in a past session
        continue;
      }
      const probed = await probeNewModel(listing, baseUrl, key, ctx.signal); // brand-new id
      if (ctx.signal.aborted) return undefined;
      out.push(probed ?? conservativeModel(listing));
    }

    // Los catalogos de Pi se aplican DESPUES de construir, para que ganen
    // sobre la capa curada y sobre el sondeo: el orden es model card > openrouter
    // > resto, igual que en el bridge de EnClave.
    const donated = overlayBundled(out, bundled);

    const persisted = await ctx.publish({ persist: { models: donated, checkedAt: Date.now() } });
    if (!persisted || ctx.signal.aborted) return undefined;

    // Maintenance-only: re-probe the curated ids we just published and report
    // drift + retired ids. Runs AFTER publish so the catalog is never delayed,
    // and never mutates what was published.
    if (truthyEnv(options.reprobeEnv ?? "PI_OPENDESIGN_REPROBE")) {
      await runReprobeAudit({ agentDir: options.agentDir, baseUrl, key, signal: ctx.signal, curated, live });
    }

    return donated;
  };
}
