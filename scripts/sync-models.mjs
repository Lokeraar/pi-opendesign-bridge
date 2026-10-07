#!/usr/bin/env node
/**
 * sync-models.mjs — rebuild the `EnClave` block of `models.json`.
 *
 * The whole donor mechanism lives here, in one readable place:
 *
 *   1. Read the live catalog from the endpoint — who is actually served.
 *   2. Read the donor (`providers.opendesign` in the same file) by BARE model
 *      name: the id with any `vendor/` prefix stripped on both sides.
 *   3. Copy the donor's values onto the matching EnClave entries.
 *   4. For models with no donor, keep whatever the block already says.
 *   5. For models with neither, report them — that is the hand work left to do.
 *
 * The donor is the source of truth. Its numbers are copied as they are, even
 * when they are larger than a local measurement: a value chosen on purpose
 * beats one this tool inferred. If a value ever causes a problem, lower it
 * deliberately then, not preemptively here.
 *
 * Two fields are never taken from the donor, because they describe this
 * endpoint rather than the model:
 *   contextWindow — the catalog declares it, and it is what actually serves
 *   cost          — the donor has no price at all; inheriting it would make
 *                   every model look free
 *
 * A model is published only if the catalog lists it, `routeable_endpoint_count`
 * is greater than 0, and it answers a request.
 *
 * Usage:
 *   node --experimental-strip-types scripts/sync-models.mjs --dry-run
 *   node --experimental-strip-types scripts/sync-models.mjs
 */

import { copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = join(HERE, "..");
const {
  ENCLAVE_BASE_URL,
  PROVIDER_ID,
  buildBlock,
  fetchCatalog,
  keptIndex,
  liveness,
  providerModels,
  readModelsJson,
  writeModelsJson,
} = await import(join(ROOT, "enclave-live.ts"));
const { findBundledCatalogDir, readPiCatalogs } = await import(join(ROOT, "donors.ts"));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

if (flag("--help")) {
  console.log("sync-models — rebuild the EnClave block of models.json\n\n  --dry-run   report only, write nothing\n  --agent-dir <dir>   default ~/.pi/agent");
  process.exit(0);
}

const agentDir = opt("--agent-dir", join(homedir(), ".pi", "agent"));
const dryRun = flag("--dry-run");
const checkLive = !flag("--no-check");

const modelsJsonPath = join(agentDir, "models.json");
const data = readModelsJson(agentDir);
const cfg = data.providers?.[PROVIDER_ID] ?? {};
const baseUrl = cfg.baseUrl ?? ENCLAVE_BASE_URL;
const key = (cfg.apiKey ?? process.env.ENCLAVE_API_KEY ?? "").trim();

if (!key) {
  console.error(`No API key. Add providers.${PROVIDER_ID}.apiKey in ${modelsJsonPath}, or set ENCLAVE_API_KEY.`);
  process.exit(2);
}

const signal = AbortSignal.any([AbortSignal.timeout(120_000)]);
const catalog = await fetchCatalog(baseUrl, key, signal);
if (!catalog) {
  console.error(`GET ${baseUrl}/models failed.`);
  process.exit(1);
}

// A listed model with routeable_endpoint_count 0 is already excluded by the
// catalog. Beyond that, check that each one actually answers.
const dead = new Set();
if (checkLive) {
  process.stderr.write("Comprobando que cada modelo responde...\n");
  for (const listing of catalog.models) {
    if (!listing.routeable) continue;
    const state = await liveness(baseUrl, key, listing.id, signal);
    if (state === "upstream-gone" || state === "no-route") dead.add(listing.id);
  }
  for (const alias of catalog.aliases) {
    const state = await liveness(baseUrl, key, alias.id, signal);
    if (state === "upstream-gone" || state === "no-route") dead.add(alias.id);
  }
}

const kept = keptIndex(data);
// Pi's own bundled catalogs, for whichever providers are active. The directory
// name carries the pi-ai version and a dependency hash, so it is discovered at
// run time rather than stored.
const catalogDir = findBundledCatalogDir(agentDir);
const bundled = catalogDir ? readPiCatalogs(agentDir, { exclude: [PROVIDER_ID] }) : [];
const result = buildBlock(catalog, kept, bundled, baseUrl, (id) => !dead.has(id));

const short = (id) => id.replace(/^cyberouter\//, "");
const byRule = (rule) => [...result.resolved.entries()].filter(([, r]) => r.rule === rule && r.source);

const report = [
  `EnClave — ${baseUrl}`,
  `${result.models.length} publicables (${catalog.models.length} modelos + ${catalog.aliases.length} aliases en el catálogo)`,
  ``,
  `Donantes disponibles:`,
  `  ya escrito       ${kept.size} entradas en providers.EnClave`,
  `  catálogos de Pi  ${bundled.length} leídos: ${bundled.slice(0, 6).map((c) => c.provider).join(", ")}${bundled.length > 6 ? " …" : ""}`,
  `  catálogo de Pi   ${catalogDir ?? "NO ENCONTRADO"}`,
  ``,
  `Resueltos desde un donante: ${[...result.resolved.values()].filter((r) => r.source).length}`,
  ``,
  `Orden: model card del vendor > openrouter > otros catálogos (solo confirman).`,
];

const grouped = [
  ["model card del vendor (máxima autoridad)", byRule("vendor")],
  ["de openrouter, confirmado por otros catálogos", byRule("corroborated")],
  ["de openrouter", byRule("donated")],
  ["sin donante: queda lo ya escrito", byRule("kept")],
];
for (const [label, rows] of grouped) {
  if (!rows.length) continue;
  report.push(`\n  ${label}: ${rows.length}`);
  for (const [id, r] of rows) {
    // Confirmar con 42 catálogos no es información: es ruido. Con 3 alcanza.
    const n = r.corroborating.length;
    const shown = r.corroborating.slice(0, 3).join(", ");
    const more = n > 3 ? ` +${n - 3} más` : "";
    const corr = n ? `   confirmado por ${n}: ${shown}${more}` : "";
    report.push(`    ${short(id).padEnd(22)} ${r.matchedId ?? "-"}`.padEnd(52) + ` ${r.source ?? "-"}${corr}`);
  }
}

const corroboratedOnly = [...result.resolved.values()].filter((r) => r.source !== "hand" && r.corroborating.length);
if (corroboratedOnly.length) {
  report.push(`\n  además confirmados por un segundo proveedor: ${corroboratedOnly.length}`);
}

// Aliases are handled in their own loop, so they are reported separately rather
// than looked for among the resolved models.
const aliasIds = new Set(catalog.aliases.map((a) => a.id));
const aliasesPublished = result.models.filter((m) => aliasIds.has(m.id));
report.push(`\n  aliases publicados sin tocar (vanilla, a propósito): ${aliasesPublished.length}`);
for (const a of aliasesPublished) report.push(`    ${short(a.id)}`);

const pendingReal = result.pending.filter((id) => !aliasIds.has(id));
if (pendingReal.length) {
  report.push(`\nModelos sin donante y sin valores — trabajo a mano: ${pendingReal.length}`);
  for (const id of pendingReal) report.push(`  ?  ${short(id)}`);
}
if (result.skipped.length) {
  report.push(`\nExcluidos: ${result.skipped.length}`);
  for (const s of result.skipped) report.push(`  x  ${short(s.id).padEnd(24)} ${s.why}`);
}
report.push("");
console.log(report.join("\n"));

if (dryRun) {
  console.log("--dry-run: no se escribió nada.\n");
  process.exit(0);
}

copyFileSync(modelsJsonPath, `${modelsJsonPath}.bak`);
data.providers ??= {};
data.providers[PROVIDER_ID] = {
  ...cfg,
  name: cfg.name ?? "EnClave",
  baseUrl,
  api: cfg.api ?? "openai-completions",
  authHeader: cfg.authHeader !== false,
  models: result.models,
};
writeModelsJson(agentDir, data);
console.log(`Escrito: ${result.models.length} modelos. Backup en ${modelsJsonPath}.bak\n`);