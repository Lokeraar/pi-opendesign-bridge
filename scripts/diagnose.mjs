/**
 * diagnose.mjs — print what this installation actually resolved.
 *
 * The single most useful thing to know when someone reports "the models are
 * wrong" or "the values did not come through" is not their tier but this:
 *
 *   - which build of the package they are running
 *   - whether a model catalog was found at all
 *   - where it looked, and why it found nothing if it did not
 *   - what it fell back to
 *
 * Usage:
 *   node --experimental-strip-types scripts/diagnose.mjs
 *
 * Read-only. Touches nothing.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(homedir(), ".pi", "agent");

const line = (label, value) => console.log("  " + String(label).padEnd(22) + value);
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log("\n\x1b[1mbuild\x1b[0m");
try {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  line("package", `${pkg.name}@${pkg.version}`);
} catch {
  line("package", bad("package.json no encontrado"));
}
try {
  const { execSync } = await import("node:child_process");
  const sha = execSync("git rev-parse --short HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
  const dirty = execSync("git status --porcelain", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
  line("commit", sha + (dirty ? bad("  (árbol con cambios sin commitear)") : ""));
} catch {
  line("commit", dim("no es un checkout de git"));
}

// ---------------------------------------------------------------- catalog
console.log("\n\x1b[1mmodel catalog\x1b[0m");

/**
 * Deliberately accepts ANY package that happens to contain
 * `dist/providers/data/*.json`, not just a hardcoded package name. Pi has
 * shipped this under more than one package name across versions, and a lookup
 * that insists on one name silently reports "no donor" on every layout but its
 * own — which is indistinguishable from "the donors do not work".
 */
function findCatalogs() {
  const prefix = dirname(dirname(process.execPath));
  const home = dirname(agentDir);
  const roots = [
    join(agentDir, "npm", "node_modules", ".pnpm"),
    // A shell wrapper such as gentle-shell relocates the agent directory, so
    // its siblings are checked too.
    join(home, ".gentle-shell", "agent", "npm", "node_modules", ".pnpm"),
    join(home, ".pi", "agent", "npm", "node_modules", ".pnpm"),
    join(prefix, "lib", "node_modules"),
    "/usr/local/lib/node_modules",
    "/usr/lib/node_modules",
  ];

  const found = [];
  const searched = new Set();

  const accept = (pkgDir, depth = 0) => {
    const dir = join(pkgDir, "dist", "providers", "data");
    let count = 0;
    try {
      count = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
      count = 0;
    }
    if (count && !found.some((f) => f.dir === dir)) found.push({ dir, count });

    // Pi keeps pi-ai NESTED one level down, inside the coding-agent package:
    //   node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai
    // Stopping at the first level misses the copy Pi actually loads, which is
    // the one that matters most.
    if (depth < 2) {
      try {
        for (const scope of readdirSync(join(pkgDir, "node_modules"))) {
          const scopeDir = join(pkgDir, "node_modules", scope);
          if (scope.startsWith("@")) {
            for (const pkg of readdirSync(scopeDir)) accept(join(scopeDir, pkg), depth + 1);
          } else {
            accept(scopeDir, depth + 1);
          }
        }
      } catch {
        // no nested node_modules
      }
    }
  };

  /** Every package one or two levels under a node_modules directory. */
  const walkPackages = (nodeModules) => {
    let scopes = [];
    try {
      scopes = readdirSync(nodeModules);
    } catch {
      return;
    }
    for (const scope of scopes) {
      const scopeDir = join(nodeModules, scope);
      if (scope.startsWith("@")) {
        try {
          for (const pkg of readdirSync(scopeDir)) accept(join(scopeDir, pkg));
        } catch {
          // unreadable scope
        }
      } else {
        accept(scopeDir);
      }
    }
  };

  for (const root of roots) {
    if (searched.has(root)) continue;
    searched.add(root);
    try {
      if (!statSync(root).isDirectory()) continue;
    } catch {
      continue;
    }

    // 1. a plain node_modules tree
    walkPackages(root);

    // 2. the pnpm store, whose folders carry a version and a dependency hash
    let entries = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.includes("+")) continue; // pnpm folders are `name@version_hash`
      const nm = join(root, entry, "node_modules");
      let exists = false;
      try {
        exists = statSync(nm).isDirectory();
      } catch {
        exists = false;
      }
      if (exists) walkPackages(nm);
    }
  }
  return { found, searched: [...searched] };
}

const { found, searched } = findCatalogs();

/**
 * What the extension ITSELF resolves. Reported first and labelled separately,
 * because the point of this script is to show reality rather than what a
 * broader scan could find. The broad scan above is there to answer the other
 * question: is the extension missing a catalog it could have used?
 */
let used = null;
try {
  const { findBundledCatalogDir, findBundledCatalogs } = await import(join(ROOT, "donors.ts"));
  const dirs = findBundledCatalogs(agentDir);
  used = dirs[0]?.dir ?? null;
  if (used) {
    let n = 0;
    try {
      n = readdirSync(used).filter((f) => f.endsWith(".json")).length;
    } catch {
      /* reported as unknown below */
    }
    line("la extension usa", `${ok(n + " catálogos")}  ${dim(used.replace(homedir(), "~"))}`);
    const others = found.filter((f) => f.dir !== used);
    if (others.length) {
      const real = new Set(others.map((f) => {
        try {
          return realpathSync(f.dir);
        } catch {
          return f.dir;
        }
      }));
      line(dim("otros Ubicaciones"), dim(`${real.size} (mismo contenido por symlink del store)`));
    }
  } else {
    line("la extension usa", bad("NINGUNO — los valores no vienen de ningún catálogo"));
  }
} catch (e) {
  line("la extension usa", dim(`no se pudo determinar: ${e.message}`));
}

if (!found.length) {
  line("estado", bad("NINGUNO ENCONTRADO"));
  line("busqué en", "");
  for (const s of searched) line("", dim(s));
  console.log(
    "\n  " +
      bad("sin catálogo no hay donantes") +
      ": los valores salen de los que ya estaban escritos,\n" +
      "  o de los defaults. Es el sintoma exacto de quien reporta eso.\n",
  );
  process.exit(1);
}

for (const f of found.slice(0, 3)) {
  line("encontrado", `${ok(f.count + " catálogos")}  ${dim(f.dir.replace(homedir(), "~"))}`);
}
if (found.length > 3) line(dim("…"), dim(`${found.length - 3} ubicaciones más`));

// ---------------------------------------------------------------- coverage
console.log("\n\x1b[1mcoverage of this provider\x1b[0m");
try {
  const { readPiCatalogs, bareName } = await import(join(ROOT, "donors.ts"));
  const cfg = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
  const provider = Object.keys(cfg.providers ?? {}).includes("opendesign")
    ? "opendesign"
    : Object.keys(cfg.providers ?? {})[0];
  const models = cfg.providers?.[provider]?.models ?? [];
  const catalogs = readPiCatalogs(agentDir, { exclude: [provider] });
  const withDonor = models.filter((m) => catalogs.some((c) => c.models.has(bareName(m.id))));

  line("provider", provider);
  line("modelos", `${models.length} en models.json, ${withDonor.length} con donante`);
  if (models.length > withDonor.length) {
    const missing = models.filter((m) => !catalogs.some((c) => c.models.has(bareName(m.id)))).map((m) => m.id);
    line("sin donante", dim(missing.join(", ")));
  }

  // Which models does the endpoint serve for this key, versus what we publish?
  const creds = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
  const key = creds?.[provider]?.key;
  const cfgProvider = cfg.providers?.[provider]?.apiKey;
  const auth = key ?? cfgProvider;
  if (auth) {
    const res = await fetch(`${cfg.providers[provider].baseUrl}/models`, {
      headers: { Authorization: `Bearer ${auth}` },
      signal: AbortSignal.timeout(20000),
    });
    if (res.ok) {
      const json = await res.json();
      const live = new Set((json.data ?? []).map((m) => m.id));
      const published = new Set(models.map((m) => m.id));
      const missing = [...live].filter((id) => !published.has(id));
      const extra = [...published].filter((id) => !live.has(id));
      line("el endpoint sirve", `${live.size} modelos para esta clave`);
      line("publicados aquí", `${published.size}`);
      if (missing.length) {
        line(dim("FALTAN"), bad(missing.join(", ")));
        console.log(
          "\n  " +
            dim("esto es lo que se agrega a mano: el endpoint los sirve y la\n") +
            dim("extensión no los publica. almost siempre es una versión vieja\n") +
            dim("en npm, o una extension local sin installar.\n"),
        );
      } else {
        line("faltantes", ok("ninguno"));
      }
      if (extra.length) line(dim("publicados que ya no estan"), extra.join(", "));
    } else {
      line("el endpoint sirve", bad(`HTTP ${res.status} — no se pudo comparar`));
    }
  } else {
    line("el endpoint sirve", dim("sin credencial para " + provider));
  }
} catch (e) {
  // A missing models.json is not a failure worth a stack trace.
  line("coverage", dim(e.code === "ENOENT" ? "no hay models.json todavia" : e.message));
}

console.log("");