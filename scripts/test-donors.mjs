#!/usr/bin/env node
/**
 * test-donors.mjs — offline checks for the donor rules.
 *
 * The one distinction everything hangs on: a catalog that writes an explicit
 * `null` for a level has CLAIMED the model does not support it, and that claim
 * wins. A catalog that leaves the key out has said nothing, and saying nothing
 * must not erase a value we already know.
 */

import { join } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname, "..");
const {
  BUNDLED_FIELDS,
  PROVIDER_PRIORITY,
  bareName,
  overlayDonors,
  readBundledCatalog,
  readPiCatalogs,
  findBundledCatalogDir,
  readCuratedIndex,
} = await import(join(ROOT, "donors-opendesign.ts"));

let passed = 0;
const failed = [];
const check = (name, cond, detail) => {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const cat = (provider, models) => ({ provider, models: new Map(Object.entries(models)) });
const agentDir = join(process.env.HOME ?? "", ".pi", "agent");

const FULL = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const has = (m) => Object.values(m ?? {}).filter((v) => v !== null && v !== undefined).length;

console.log("\nbare name");
check("strips a vendor prefix", bareName("deepseek/deepseek-v4-flash") === "deepseek-v4-flash");
check("leaves an unprefixed id alone", bareName("glm-5.3-flash") === "glm-5.3-flash");

console.log("\nan explicit null is a claim, and wins");
{
  const donor = cat("openrouter", {
    "deepseek-v4-flash": {
      id: "deepseek/deepseek-v4-flash",
      maxTokens: 384000,
      thinkingLevelMap: { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh", max: null },
    },
  });
  const model = { id: "deepseek-v4-flash", maxTokens: 232000, thinkingLevelMap: FULL, contextWindow: 1048576 };
  const r = overlayDonors(model, "deepseek-v4-flash", [donor]);
  check("the donor's ceiling wins", r.entry.maxTokens === 384000, String(r.entry.maxTokens));
  check("the levels it rejects are withdrawn", has(r.entry.thinkingLevelMap) === 3, String(has(r.entry.thinkingLevelMap)));
  check("the matched id keeps its prefix", r.matchedId === "deepseek/deepseek-v4-flash", String(r.matchedId));
  check("the changed fields are reported", r.applied.sort().join(",") === "maxTokens,thinkingLevelMap", r.applied.join(","));
}

console.log("\nsilence is not a claim");
{
  const oneKey = cat("openrouter", { "kimi-k2.7-code": { id: "moonshotai/kimi-k2.7-code", thinkingLevelMap: { off: null } } });
  const five = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: null, xhigh: null, max: null };
  const r = overlayDonors({ id: "kimi-k2.7-code", thinkingLevelMap: five, maxTokens: 262000 }, "kimi-k2.7-code", [oneKey]);
  // four usable levels in, `off: null` applied → off is withdrawn, the other
  // three the donor never mentioned survive untouched.
  check("a one-key map keeps the levels it says nothing about", has(r.entry.thinkingLevelMap) === 3, String(has(r.entry.thinkingLevelMap)));
  check("but the key it does state is applied", r.entry.thinkingLevelMap.off === null, String(r.entry.thinkingLevelMap.off));
  check("and the untouched levels keep their values", r.entry.thinkingLevelMap.medium === "medium" && r.entry.thinkingLevelMap.max === null, JSON.stringify(r.entry.thinkingLevelMap));

  const none = cat("openrouter", { "mimo-v2.6-flash": { id: "xiaomi/mimo-v2.6-flash", maxTokens: 131072 } });
  const seven = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  const r2 = overlayDonors({ id: "mimo-v2.6-flash", thinkingLevelMap: seven, maxTokens: 131072 }, "mimo-v2.6-flash", [none]);
  check("a catalog with no map at all changes nothing", has(r2.entry.thinkingLevelMap) === 7, String(has(r2.entry.thinkingLevelMap)));
  check("and reports no change", r2.applied.length === 0, r2.applied.join(","));
}

console.log("\ncorroboration fills gaps, never overrides");
{
  const primary = cat("openrouter", { "qwen3.8-max": { id: "qwen/qwen3.8-max-0902", maxTokens: 131072 } });
  const other = cat("opencode", { "qwen3.8-max": { id: "qwen3.8-max-0902", input: ["text", "image"], maxTokens: 999999 } });
  const r = overlayDonors({ id: "qwen3.8-max", maxTokens: 16 }, "qwen3.8-max", [primary, other]);
  check("the primary keeps the ceiling", r.entry.maxTokens === 131072, String(r.entry.maxTokens));
  check("the other fills a field nobody stated", JSON.stringify(r.entry.input) === '["text","image"]', JSON.stringify(r.entry.input));
  check("and is recorded as corroboration", r.corroborating.join(",") === "opencode", r.corroborating.join(","));
}

console.log("\nwhat no donor may set");
{
  const donor = cat("openrouter", {
    "gpt-6-luna": {
      id: "openai/gpt-6-luna",
      contextWindow: 999999,
      cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 },
      compat: { thinkingFormat: "openrouter" },
      maxTokens: 128000,
    },
  });
  const r = overlayDonors({ id: "gpt-6-luna", contextWindow: 1050000, maxTokens: 128000 }, "gpt-6-luna", [donor]);
  check("contextWindow stays with the endpoint", r.entry.contextWindow === 1050000, String(r.entry.contextWindow));
  check("compat is never inherited", r.entry.compat === undefined, JSON.stringify(r.entry.compat));
  check("cost is never inherited", r.entry.cost === undefined);
  check("maxTokens still is", r.entry.maxTokens === 128000);
}

console.log("\nthe real catalogs, no credential needed");
{
  check("openrouter leads", PROVIDER_PRIORITY[0] === "openrouter");
  const dir = findBundledCatalogDir(agentDir);
  if (!dir) {
    console.log("  --   catálogo de Pi no encontrado, se omiten");
  } else {
    const catalogs = readPiCatalogs(agentDir, { exclude: ["opendesign"] });
    check("every catalog Pi ships is read", catalogs.length > 30, String(catalogs.length));
    check("openrouter is first", catalogs[0]?.provider === "openrouter", catalogs[0]?.provider);
    const or = readBundledCatalog(dir, "openrouter");
    check("no free id survives", ![...or.models.keys()].some((k) => /free/i.test(k)));
    check("the opendesign bundle itself is excluded", !catalogs.some((c) => c.provider === "opendesign"));

    // The live configuration, resolved for real.
    const curated = readCuratedIndex(agentDir);
    if (curated.size) {
      let touched = 0;
      for (const m of curated.values()) {
        if (overlayDonors(m, bareName(m.id), catalogs).applied.length) touched++;
      }
      check("the real configuration actually uses the donors", touched > 0, String(touched));
    }
  }
}

console.log("\na relocated agent dir and a differently-named store folder");
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: J } = await import("node:path");
  const { storeCatalogs, agentRoots } = await import(join(ROOT, "donors-opendesign.ts"));

  const home = mkdtempSync(J(tmpdir(), "enclave-layout-"));
  const store = J(
    home,
    ".gentle-shell/agent/npm/node_modules/.pnpm/@earendil-works+pi-agent-core@1.0.1_hash",
  );
  const leaf = J(store, "node_modules/@earendil-works/pi-ai/dist/providers/data");
  mkdirSync(leaf, { recursive: true });
  writeFileSync(
    J(leaf, "openrouter.json"),
    JSON.stringify({ "openai-completions": { "z-ai/glm-5.3": { id: "z-ai/glm-5.3", maxTokens: 262144 } } }),
  );
  writeFileSync(J(leaf, "together.json"), JSON.stringify({ "openai-completions": { "x/y": { id: "x/y" } } }));
  const agentDir = J(home, ".gentle-shell/agent");

  const dirs = storeCatalogs(agentDir);
  check("a relocated agent dir is searched", agentRoots(agentDir).some((r) => r.includes("gentle-shell")), agentRoots(agentDir).join(","));
  const gentle = dirs.find((x) => x.includes("gentle-shell"));
  check("a store folder named after ANOTHER package is still found", !!gentle, dirs.join(","));
  check("and it is the right directory", gentle?.endsWith(J("pi-ai", "dist", "providers", "data")), String(gentle));
  check("with both catalogs", gentle && readdirSync(gentle).filter((f) => f.endsWith(".json")).length === 2);

  // The flat layout other teams report: no .pnpm, no dist.
  const flatDir = mkdtempSync(J(tmpdir(), "enclave-flat-"));
  const flatLeaf = J(flatDir, "agent/npm/node_modules/@earendil-works/pi-ai/providers/data");
  mkdirSync(flatLeaf, { recursive: true });
  writeFileSync(J(flatLeaf, "openrouter.json"), "{}");
  writeFileSync(J(flatLeaf, "together.json"), "{}");
  const flatAgent = J(flatDir, "agent");
  const flatFound = storeCatalogs(flatAgent).filter((x) => x.includes("enclave-flat-"));
  check("a flat install with no dist is found", flatFound.length === 1, flatFound.join(","));
  check("and it holds both catalogs", flatFound.length === 1 && readdirSync(flatFound[0]).filter((f) => f.endsWith(".json")).length === 2);
  rmSync(flatDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

console.log("\na broken catalog tree must never take the provider down");
{
  const { readFileSync: rf3 } = await import("node:fs");
  const { makeRefreshModels } = await import(join(ROOT, "opendesign-live.ts"));
  const agentDir = process.env.HOME + "/" + ".pi/agent";
  const cfg = rf3(join(agentDir, "models.json"), "utf8");
  const key = JSON.parse(cfg).providers?.opendesign?.apiKey;
  if (!key) {
    console.log("  --   sin credencial de opendesign, se omite");
  } else {
    // An ES module namespace is read-only, so the builtin module object itself
    // has to be patched — which is what happens on Windows when a junction or a
    // symlink loop makes readdirSync throw.
    const fsMod = (await import("node:fs")).default;
    const real = fsMod.readdirSync;
    fsMod.readdirSync = function (p, ...rest) {
      // A broken junction or an ELOOP on Windows throws from readdir.
      if (typeof p === "string" && p.includes("providers")) {
        throw Object.assign(new Error("ELOOP: too many symbolic links"), { code: "ELOOP" });
      }
      return real.call(fsMod, p, ...rest);
    };
    let threw = null;
    let published = 0;
    try {
      const out = await makeRefreshModels({ agentDir })({
        credential: { type: "api_key", key },
        stored: undefined,
        allowNetwork: true,
        signal: AbortSignal.any([AbortSignal.timeout(20000)]),
        async publish() {
          published++;
          return true;
        },
      });
      threw = null;
      check("the provider still publishes with a broken tree", Array.isArray(out) && out.length > 0, String(out && out.length));
    } catch (e) {
      threw = e;
      check("the provider still publishes with a broken tree", false, e.message);
    }
    check("and the refresh did not throw", threw === null, threw && threw.message);
    fsMod.readdirSync = real;
  }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}