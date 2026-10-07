#!/usr/bin/env node
/**
 * diagnose.mjs — what THIS machine actually resolved.
 *
 *   node diagnose.mjs              the whole report
 *   node diagnose.mjs --md         the same, as a markdown block for an issue
 *
 * Works from anywhere: it reads the files in `~/.pi/agent/extensions`, not the
 * repository, because a user who installed with `pi install npm:…` has no repo
 * next to them and asking them to clone one to report a bug is a way of getting
 * no bug reports.
 *
 * Read-only. Touches nothing.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const asMd = process.argv.includes("--md");
const HERE = dirname(fileURLToPath(import.meta.url));

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const extDir = join(agentDir, "extensions");

const out = [];
const say = (s = "") => out.push(s);
const kv = (k, v) => say(`  ${String(k).padEnd(26)}${v}`);

/** Reads a deployed file without importing it — it may need deps we lack here. */
function readDeployed(file) {
  const p = join(extDir, file);
  if (!existsSync(p)) return undefined;
  return { path: p, mtime: statSync(p).mtime, text: readFileSync(p, "utf8") };
}

function versionOf(text) {
  const m = /BRIDGE_VERSION\s*=\s*"([^"]+)"/.exec(text ?? "");
  return m?.[1];
}

say();
say("```");
say("· OpenDesign / EnClave bridge — diagnóstico");
say("  fecha        " + new Date().toISOString());
say("  node         " + process.version);
say();

// ── what's installed, and where ──────────────────────────────────────────────
say("· instalación");
kv("agent dir", agentDir);
kv("extensions", existsSync(extDir) ? extDir + dim("  (existe)") : extDir + bad("  (NO EXISTE)"));

const deployed = [
  ["opendesign bridge", "opendesign.ts"],
  ["opendesign donors", "donors-opendesign.ts"],
  ["opendesign engine", "opendesign-live.ts"],
  ["enclave bridge", "enclave-bridge.ts"],
  ["enclave donors", "donors-enclave.ts"],
  ["enclave engine", "enclave-live.ts"],
];

function dim(s) { return s; }
function bad(s) { return s; }

let anyDeployed = false;
for (const [label, file] of deployed) {
  const d = readDeployed(file);
  if (!d) {
    kv(label, file + "  — no instalado como archivo");
    continue;
  }
  anyDeployed = true;
  const v = versionOf(d.text);
  const size = Math.round(statSync(d.path).size / 1024);
  kv(label, `${v ? v + "  ·  " : "versión NO DECLARADA  ·  "}${size} KB  ·  ${d.mtime.toISOString().slice(0, 16).replace("T", " ")}`);
}
if (!anyDeployed) say("  (ninguno instalado como archivos sueltos)");

// as an npm package?
const npmDir = join(agentDir, "npm", "node_modules", "@lokeraar");
if (existsSync(npmDir)) {
  say();
  for (const p of readdirSync(npmDir)) {
    const pj = join(npmDir, p, "package.json");
    let v = "—";
    try { v = JSON.parse(readFileSync(pj, "utf8")).version; } catch {}
    kv("paquete npm", `${p}@${v}`);
  }
} else {
  say();
  kv("paquete npm", "ninguno instalado con `pi install npm:…`");
}

// ── where the catalogs were looked for ──────────────────────────────────────
say();
say("· dónde se buscó el catálogo de Pi");

const roots = [
  join(agentDir, "npm", "node_modules", ".pnpm"),
  join(homedir(), ".gentle-shell", "agent", "npm", "node_modules", ".pnpm"),
  join(homedir(), ".pi", "agent", "npm", "node_modules", ".pnpm"),
  join(agentDir, "npm", "node_modules"),
  join(homedir(), ".gentle-shell", "agent", "npm", "node_modules"),
];
const prefix = dirname(dirname(process.execPath));
roots.push(join(prefix, "lib", "node_modules"), "/usr/local/lib/node_modules", "/usr/lib/node_modules");

let foundAny = false;
for (const r of [...new Set(roots)]) {
  let n = 0;
  try { n = readdirSync(r).length; } catch {}
  const shown = r.length > 24 ? "…" + r.slice(-23) : r;
  kv(shown, (n ? `${n} entradas` : "no existe"));
  if (!n) continue;
  // look for the catalogs under it
  const stack = [[r, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop();
    if (depth > 2) continue;
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const shape of [join(full, "dist", "providers", "data"), join(full, "providers", "data")]) {
        let count = 0;
        try { count = readdirSync(shape).filter((f) => f.endsWith(".json")).length; } catch {}
        if (count) {
          kv("  ENCONTRADO", `${count} catálogos  ${shape}`);
          foundAny = true;
        }
      }
      stack.push([full, depth + 1]);
    }
  }
}
if (!foundAny) {
  kv("resultado", "NINGÚN CATÁLOGO ENCONTRADO — los valores vienen de los defaults");
  say("                          si esperabas valores de openrouter, esto es lo que falta");
}

say("```");

const text = out.join("\n");
console.log(text);

if (asMd) {
  console.log("\n<!-- pega lo de arriba dentro de un bloque de código en el issue -->");
}