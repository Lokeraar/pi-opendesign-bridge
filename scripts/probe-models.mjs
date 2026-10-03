#!/usr/bin/env node
/**
 * probe-models.mjs — maintain the curated layer without hand-editing it.
 *
 * Re-runs the SAME probe the extension uses for brand-new ids, against models
 * you already curate, and prints a table plus the exact models.json patch.
 *
 * It never writes anything. The diff IS the deliverable: you read it, and you
 * decide. That is deliberate — a script that silently rewrites your config is
 * worse than one that makes you approve the change.
 *
 * Usage (from the package root):
 *   node --experimental-strip-types scripts/probe-models.mjs --all
 *   node --experimental-strip-types scripts/probe-models.mjs gpt-6-luna kimi-k2.7-code
 *   node --experimental-strip-types scripts/probe-models.mjs --all --json
 *
 * Flags:
 *   --all        probe every curated id the endpoint currently serves
 *   --json       machine-readable output instead of the table
 *   --base-url   override the endpoint (default: models.json, then the built-in)
 *   --agent-dir  override ~/.pi/agent
 *
 * Requires a reachable endpoint with quota: an exhausted plan answers HTTP 402
 * and every row comes back "probe-failed", which is reported honestly rather
 * than guessed around.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const { probeNewModel, fetchLiveListing, readProviderConfig, STATIC_MODELS, OPENDESIGN_BASE_URL } =
  await import(join(ROOT, "opendesign-live.ts"));

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));

if (flag("--help") || argv.length === 0) {
  console.log(
    [
      "probe-models — re-probe curated models and emit a models.json patch",
      "",
      "  node --experimental-strip-types scripts/probe-models.mjs --all",
      "  node --experimental-strip-types scripts/probe-models.mjs <model-id>...",
      "",
      "Flags: --all --json --base-url <url> --agent-dir <dir>",
    ].join("\n"),
  );
  process.exit(argv.length === 0 ? 1 : 0);
}

const agentDir = opt("--agent-dir", join(homedir(), ".pi", "agent"));
const asJson = flag("--json");

// ---------------------------------------------------------------- credential
function readKey() {
  try {
    const auth = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    const cred = auth.opendesign ?? (auth.credentials ?? {}).opendesign;
    return cred?.key ?? null;
  } catch {
    return null;
  }
}

const key = readKey();
if (!key) {
  console.error(`No OpenDesign credential in ${join(agentDir, "auth.json")}. Run /login opendesign first.`);
  process.exit(1);
}

const cfg = readProviderConfig(agentDir);
const curatedSource = cfg?.models?.length ? cfg.models : STATIC_MODELS;
const curated = new Map(curatedSource.map((m) => [m.id, m]));
const baseUrl = opt("--base-url", cfg?.baseUrl ?? OPENDESIGN_BASE_URL);

// ---------------------------------------------------------------- run
const live = await fetchLiveListing(baseUrl, key, new AbortController().signal);
if (!live || !live.length) {
  console.error(`Could not read ${baseUrl}/models. Check the endpoint and the quota.`);
  process.exit(1);
}

const liveById = new Map(live.map((l) => [l.id, l]));
const selected = flag("--all")
  ? live.map((l) => l.id)
  : positional.length
    ? positional
    : live.map((l) => l.id);

const rows = [];
for (const id of [...new Set(selected)]) {
  const listing = liveById.get(id);
  if (!listing) {
    rows.push({ id, status: "not-served", note: "endpoint does not list it" });
    continue;
  }
  const before = curated.get(id);
  const measured = await probeNewModel(listing, baseUrl, key, new AbortController().signal);
  if (!measured) {
    rows.push({
      id,
      status: "probe-failed",
      note: "quota, auth or transport error — not a measurement",
      contextWindow: before?.contextWindow ?? null,
      maxTokens: before?.maxTokens ?? null,
    });
    continue;
  }
  rows.push({
    id,
    status: "ok",
    contextWindow: measured.contextWindow,
    maxTokens: measured.maxTokens,
    input: measured.input,
    reasoning: measured.reasoning,
    thinkingLevelMap: measured.thinkingLevelMap,
    previous: before
      ? {
          contextWindow: before.contextWindow ?? null,
          maxTokens: before.maxTokens ?? null,
          input: before.input ?? null,
          reasoning: before.reasoning ?? null,
          thinkingLevelMap: before.thinkingLevelMap ?? null,
        }
      : null,
  });
}

// ---------------------------------------------------------------- output
const close = (a, b) => Math.abs(a - b) <= 0.05 * Math.max(Math.abs(a), Math.abs(b));
const changed = (r) => {
  if (!r.previous) return true;
  return (
    !close(Number(r.contextWindow), Number(r.previous.contextWindow)) ||
    !close(Number(r.maxTokens), Number(r.previous.maxTokens)) ||
    JSON.stringify(r.input) !== JSON.stringify(r.previous.input) ||
    r.reasoning !== r.previous.reasoning ||
    JSON.stringify(r.thinkingLevelMap) !== JSON.stringify(r.previous.thinkingLevelMap)
  );
};

if (asJson) {
  console.log(JSON.stringify({ baseUrl, generatedAt: new Date().toISOString(), rows }, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nEndpoint: ${baseUrl}`);
console.log(`Curated source: ${cfg?.models?.length ? "models.json" : "STATIC_MODELS"} (${curated.size} entries)\n`);
console.log(`${pad("MODEL", 26)} ${pad("CTX", 10)} ${pad("MAX", 10)} ${pad("REASON", 7)} ${pad("IMG", 4)} STATUS`);
console.log("-".repeat(86));
for (const r of rows) {
  if (r.status !== "ok") {
    console.log(`${pad(r.id, 26)} ${pad("-", 10)} ${pad("-", 10)} ${pad("-", 7)} ${pad("-", 4)} ${r.status.toUpperCase()} — ${r.note}`);
    continue;
  }
  const mark = r.previous ? (changed(r) ? "CHANGED" : "ok") : "NEW";
  console.log(
    `${pad(r.id, 26)} ${pad(r.contextWindow, 10)} ${pad(r.maxTokens, 10)} ` +
      `${pad(String(r.reasoning), 7)} ${pad(r.input.includes("image") ? "yes" : "no", 4)} ${mark}`,
  );
}

const retired = [...curated.keys()].filter((id) => !liveById.has(id));
if (retired.length) {
  console.log(`\nRETIRED (curated, but the endpoint does not serve it):`);
  for (const id of retired) console.log(`  - ${id}   → remove it from models.json`);
}

const drift = rows.filter((r) => r.status === "ok" && r.previous && changed(r));
const fresh = rows.filter((r) => r.status === "ok" && !r.previous);
const failed = rows.filter((r) => r.status === "probe-failed");
const notServed = rows.filter((r) => r.status === "not-served");

console.log(
  `\n${rows.length} probed · ${drift.length} changed · ${fresh.length} new · ` +
    `${retired.length} retired · ${failed.length} probe-failed · ${notServed.length} not-served`,
);

if (fresh.length) {
  console.log(`\n--- new models: paste into models.json → providers.opendesign.models ---`);
  for (const r of fresh) {
    console.log(
      JSON.stringify(
        {
          id: r.id,
          name: r.id,
          api: "openai-completions",
          reasoning: r.reasoning,
          input: r.input,
          contextWindow: r.contextWindow,
          maxTokens: r.maxTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { supportsDeveloperRole: false },
          thinkingLevelMap: r.thinkingLevelMap,
        },
        null,
        2,
      ),
    );
  }
}

if (drift.length && cfg?.models?.length) {
  console.log(`\n--- models.json patch (not applied) ---`);
  for (const r of drift) {
    console.log(`  ${r.id}:`);
    if (!close(Number(r.contextWindow), Number(r.previous.contextWindow))) {
      console.log(`    contextWindow: ${r.previous.contextWindow} → ${r.contextWindow}`);
    }
    if (!close(Number(r.maxTokens), Number(r.previous.maxTokens))) {
      console.log(`    maxTokens:     ${r.previous.maxTokens} → ${r.maxTokens}`);
    }
    if (JSON.stringify(r.input) !== JSON.stringify(r.previous.input)) {
      console.log(`    input:         ${JSON.stringify(r.previous.input)} → ${JSON.stringify(r.input)}`);
    }
    if (JSON.stringify(r.thinkingLevelMap) !== JSON.stringify(r.previous.thinkingLevelMap)) {
      console.log(`    thinking:      ${JSON.stringify(r.previous.thinkingLevelMap)}`);
      console.log(`                → ${JSON.stringify(r.thinkingLevelMap)}`);
    }
  }
  console.log(`\ncontextWindow is NOT probed (over-long prompts truncate silently).`);
  console.log(`Only apply that row if the vendor documentation confirms the new number.\n`);
}
if (failed.length) {
  console.log(`probe-failed means the endpoint refused the request (usually HTTP 402 quota).`);
  console.log(`No value was guessed. Re-run once the plan has quota.\n`);
}
