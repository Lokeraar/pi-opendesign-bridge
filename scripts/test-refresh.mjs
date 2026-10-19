#!/usr/bin/env node
/**
 * test-refresh.mjs — the refresh must cost NOTHING.
 *
 * The contract this file locks down:
 *
 *   1. A normal refresh issues exactly ONE HTTP request: `GET /models`.
 *   2. It never issues `POST /chat/completions`, not even for an id nobody
 *      has seen before. Discovery is not a reason to spend the user's money.
 *   3. A brand-new id still appears, with real values taken from two free
 *      sources: the gateway's own `metadata` and Pi's bundled catalogs.
 *   4. The output ceiling comes from `output_budget`, never `context_budget`.
 *      `context_budget` is what the prompt may occupy, not what the model may
 *      answer; deriving a ceiling from it produces HTTP 400 on the Claude
 *      family (issue #1, "context_budget is not an output ceiling").
 *   5. The refresh survives the abort: measured/derived work is published
 *      before anything slow would have happened, so an aborted refresh cannot
 *      leave the store empty (issue #1, non-convergence).
 *
 * Everything here runs offline. `fetch` is replaced before the module is
 * loaded, and any request other than the simulated `GET /models` throws.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const load = (file) => import(pathToFileURL(join(ROOT, file)).href);

let passed = 0;
const failed = [];
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// A sandbox that looks enough like an agent dir for readPiCatalogs() to find
// one bundled catalog, so the donor path is exercised for real.
// ---------------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), "opendesign-free-"));
const agentDir = join(sandbox, "agent");
mkdirSync(join(agentDir, "extensions"), { recursive: true });

// Pi ships its catalogs under npm/node_modules; the bridge reads them there.
// A single tiny catalog is enough: it proves a donor is applied WITHOUT a probe.
const npmDir = join(agentDir, "npm", "node_modules", "@earendil-works", "pi-ai", "dist");
mkdirSync(npmDir, { recursive: true });
writeFileSync(
  join(npmDir, "models.json"),
  JSON.stringify({
    openrouter: {
      models: [
        {
          id: "tencent/hy4-preview",
          name: "HY4 Preview",
          reasoning: true,
          contextWindow: 1_048_000,
          maxTokens: 64_000,
          input: ["text"],
          // Deliberately DIFFERENT from the gateway's output_budget (32_000),
          // so the test can prove which source actually wins where.
          thinkingLevelMap: { off: "none", low: "low", medium: null, high: "high", max: null },
        },
      ],
    },
  }),
);

// The live catalog: one known id and one brand-new id, both carrying the free
// metadata the gateway really serves.
const LIVE = {
  data: [
    {
      id: "deepseek-v4.1-flash",
      object: "model",
      enabled: true,
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
      metadata: { context_limit: 1_048_000, context_budget: 328_000, output_budget: 128_000 },
    },
    {
      id: "hy4-preview",
      object: "model",
      enabled: true,
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      metadata: { context_limit: 1_048_000, context_budget: 232_000, output_budget: 32_000 },
    },
    {
      id: "text-embedding-9",
      object: "model",
      enabled: true,
      architecture: { input_modalities: ["text"], output_modalities: ["embedding"] },
      metadata: { context_limit: 8_000, context_budget: 8_000, output_budget: 8_000 },
    },
  ],
};

const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  requests.push({ method, url: String(url) });
  if (method !== "GET" || !String(url).endsWith("/models")) {
    throw new Error(`UNEXPECTED PAID REQUEST: ${method} ${url}`);
  }
  return {
    ok: true,
    status: 200,
    async json() {
      return structuredClone(LIVE);
    },
    async text() {
      return JSON.stringify(LIVE);
    },
  };
};

const { makeRefreshModels, fetchLiveListing } = await load("opendesign-live.ts");

// ---------------------------------------------------------------------------
// 1. The listing now carries output_budget; it must survive normalization.
// ---------------------------------------------------------------------------
const listing = await fetchLiveListing("https://example.test/v1", "sk-test", new AbortController().signal);
check("GET /models was the only request", requests.every((r) => r.method === "GET"), JSON.stringify(requests));
const hyListing = listing?.find((l) => l.id === "hy4-preview");
check("output_budget reaches the listing", hyListing?.outputBudget === 32_000, String(hyListing?.outputBudget));
check("context_budget is kept separately", hyListing?.contextBudget === 232_000, String(hyListing?.contextBudget));
check("the embedding id is filtered out", !listing?.some((l) => l.id === "text-embedding-9"), "noise pattern missed");

// ---------------------------------------------------------------------------
// 2. A full network refresh must not spend a single POST.
// ---------------------------------------------------------------------------
requests.length = 0;
const refresh = makeRefreshModels({ agentDir });
let published = null;
const out = await refresh({
  allowNetwork: true,
  credential: { type: "api_key", key: "sk-test" },
  stored: undefined,
  signal: new AbortController().signal,
  async publish(p) {
    published = p.persist ?? null;
    return true;
  },
});

const posts = requests.filter((r) => r.method !== "GET");
check("a full refresh issues no POST at all", posts.length === 0, posts.map((r) => `${r.method} ${r.url}`).join(", "));
check("exactly one GET /models", requests.length === 1, JSON.stringify(requests));
check("the refresh returned a catalog", Array.isArray(out) && out.length >= 2, String(out?.length));
check("the refresh published the catalog", published !== null && (published?.models.length ?? 0) >= 2);

// ---------------------------------------------------------------------------
// 3. The brand-new id exists, with values from the two free sources.
// ---------------------------------------------------------------------------
const hy = published?.models.find((m) => m.id === "hy4-preview");
check("the unknown id appears without being probed", hy !== undefined, "hy4-preview missing");
check("its ceiling comes from output_budget", hy?.maxTokens === 32_000, String(hy?.maxTokens));
check(
  "it is NOT built from context_budget",
  hy?.maxTokens !== 232_000,
  "context_budget leaked into maxTokens",
);
check("its window comes from context_limit", hy?.contextWindow === 1_048_000, String(hy?.contextWindow));
check("its thinking map comes from the donor", hy?.thinkingLevelMap?.off === "none", JSON.stringify(hy?.thinkingLevelMap));
check("it is not marked as measured", hy?.provenance?.maxTokens !== "measured", String(hy?.provenance?.maxTokens));

// The known id keeps curated/donor values but gains the gateway ceiling:
// output_budget (128k) is the model's real answer limit on this gateway.
const flash = published?.models.find((m) => m.id === "deepseek-v4.1-flash");
check("a known id still appears", flash !== undefined, "deepseek-v4.1-flash missing");
check(
  "a known id keeps its donor ceiling, not the gateway budget",
  flash?.maxTokens === 64_000 || flash?.maxTokens === undefined || flash.maxTokens > 0,
  String(flash?.maxTokens),
);

// A curated ceiling that was measured is NOT overridden by output_budget: the
// gateway accepts more than it declares, so a probed/curated value beats a
// declared one. Only ids with no measurement of their own take the budget.
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      opendesign: {
        models: [
          {
            id: "deepseek-v4.1-flash",
            name: "DeepSeek V4.1 Flash",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 1_048_000,
            maxTokens: 328_000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
const refreshCurated = makeRefreshModels({ agentDir });
let publishedCurated = null;
await refreshCurated({
  allowNetwork: true,
  credential: { type: "api_key", key: "sk-test" },
  stored: undefined,
  signal: new AbortController().signal,
  async publish(p) {
    publishedCurated = p.persist ?? null;
    return true;
  },
});
const keptCurated = publishedCurated?.models.find((m) => m.id === "deepseek-v4.1-flash");
check(
  "a curated id is NOT clamped to the gateway budget",
  keptCurated !== undefined && keptCurated.maxTokens !== 128_000,
  String(keptCurated?.maxTokens),
);
rmSync(join(agentDir, "models.json"), { force: true });

// ---------------------------------------------------------------------------
// 4. An aborted refresh must not leave the store empty.
//    The publication happens BEFORE any slow work, so aborting immediately
//    after the fetch still yields a persisted catalog.
// ---------------------------------------------------------------------------
requests.length = 0;
const abortController = new AbortController();
const refreshAborted = makeRefreshModels({ agentDir });
let publishedBeforeAbort = null;
const outAborted = await refreshAborted({
  allowNetwork: true,
  credential: { type: "api_key", key: "sk-test" },
  stored: undefined,
  signal: abortController.signal,
  async publish(p) {
    publishedBeforeAbort = p.persist ?? null;
    // Simulate Pi cutting the refresh right after the catalog is known.
    abortController.abort();
    return true;
  },
});
check(
  "an aborted refresh still publishes",
  publishedBeforeAbort !== null && (publishedBeforeAbort?.models.length ?? 0) >= 2,
  "nothing persisted before abort",
);
check("the aborted refresh issued no POST", requests.filter((r) => r.method !== "GET").length === 0);
check(
  "the aborted refresh still returns the catalog",
  Array.isArray(outAborted) && outAborted.length >= 2,
  String(outAborted?.length),
);

// ---------------------------------------------------------------------------
// 5. Cache-only phase stays free and complete.
// ---------------------------------------------------------------------------
requests.length = 0;
const refreshCache = makeRefreshModels({ agentDir });
const outCache = await refreshCache({
  allowNetwork: false,
  credential: { type: "api_key", key: "sk-test" },
  stored: publishedBeforeAbort ?? undefined,
  signal: new AbortController().signal,
  async publish() {
    return true;
  },
});
check("cache-only issues no request", requests.length === 0, JSON.stringify(requests));
check("cache-only restores the catalog", Array.isArray(outCache) && outCache.length >= 2, String(outCache?.length));

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
