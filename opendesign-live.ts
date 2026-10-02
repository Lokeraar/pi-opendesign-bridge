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
 * Freshness: one lightweight GET per network refresh (no TTL) — "live" semantics.
 *
 * This module imports node builtins ONLY, so the test harness can import the
 * real logic natively (node ≥ 22.6 type stripping) without the Pi runtime.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types (structural mirrors of pi-ai / Pi extension types — see provider-composer.d.ts)
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** Model entry as returned by refreshModels (ProviderModelConfig). */
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

async function fetchLiveListing(
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
  });
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
  if (noParam.net) return undefined; // gateway unreachable → do not guess from failures

  // 1. effort levels
  const map: ThinkingLevelMap = {};
  let anyLevelOk = false;
  let anyReasoningSeen = (noParam.rt ?? 0) > 0;
  for (const level of THINKING_LEVELS) {
    if (signal.aborted) return undefined;
    const r = await postChat(baseUrl, key, { ...base, reasoning_effort: level }, signal);
    map[level] = r.ok ? level : null;
    if (r.ok) anyLevelOk = true;
    if ((r.rt ?? 0) > 0) anyReasoningSeen = true;
  }

  // 2. `off` semantics: accepted AND zero reasoning tokens → "none"
  if (signal.aborted) return undefined;
  const none = await postChat(baseUrl, key, { ...base, reasoning_effort: "none" }, signal);
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
    if (!r.ok) break;
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
  });
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

export function makeRefreshModels(options: RefreshModelsOptions) {
  const envName = options.killSwitchEnv ?? "PI_OPENDESIGN_LIVE";

  return async function refreshModels(
    ctx: RefreshModelsContextLike,
  ): Promise<LiveModelConfig[] | undefined> {
    if (liveDisabled(envName)) return undefined;

    const cfg = readProviderConfig(options.agentDir);
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
      // Union of last-known membership + curated ids; curated VALUES win.
      const ids: string[] = [];
      for (const m of [...storedModels, ...curated]) if (!ids.includes(m.id)) ids.push(m.id);
      const merged = ids.map((id) => {
        const storedEntry = storedModels.find((m) => m.id === id);
        return normalize(curatedById.get(id) ?? (storedEntry as LiveModelConfig), cfg?.compat);
      });
      if (ctx.signal.aborted) return undefined;
      if (!sameModels(merged, storedModels)) {
        const ok = await ctx.publish({
          persist: { models: merged, checkedAt: ctx.stored?.checkedAt },
        });
        if (!ok || ctx.signal.aborted) return undefined;
      }
      return merged;
    }

    // ---- Phase 2: live membership (network + credential) ----
    const key = ctx.credential?.type === "api_key" ? ctx.credential.key : undefined;
    if (!key) return undefined;

    const live = await fetchLiveListing(baseUrl, key, ctx.signal);
    if (!live || ctx.signal.aborted) return undefined;

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

    const persisted = await ctx.publish({ persist: { models: out, checkedAt: Date.now() } });
    if (!persisted || ctx.signal.aborted) return undefined;
    return out;
  };
}
