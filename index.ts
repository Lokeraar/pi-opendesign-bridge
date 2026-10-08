/**
 * @lokeraar/pi-opendesign-bridge — OpenDesign provider for Pi: registration
 * + Live /models Fetch wiring.
 *
 * Installed via `pi install npm:@lokeraar/pi-opendesign-bridge`. If you also
 * keep local copies in `~/.pi/agent/extensions/opendesign*.ts`, remove them:
 * two registrations of the same provider fight over the model list.
 *
 * Two-layer catalog (design after @gtrabanco/pi-nan-provider, NO premium/tier
 * gating — the endpoint's answer for this key IS the catalog):
 *
 *   Layer 1 — curated: `~/.pi/agent/models.json` (Mode 1) or `STATIC_MODELS`
 *     (Mode 2 fallback). Authoritative for the VALUES of known models:
 *     thinking levels, `off` semantics and max output come from vendor docs +
 *     live probes — see `opendesign-live.ts` for the measured maps.
 *   Layer 2 — live: `refreshModels()` (auto-probes brand-new ids). Pi core
 *     drives it: cache-only restore on every runtime creation, network refresh
 *     on interactive startup / rpc background (unless PI_OFFLINE). Kill switch:
 *     PI_OPENDESIGN_LIVE=0.
 *
 * Registration modes:
 *   1. models.json declares `opendesign` with a non-empty model list → we
 *      register WITHOUT `models` (applyExtension would REPLACE the configured
 *      list with ours — the historical bug where startup needed a manual
 *      /model pick) but WITH refreshModels, so the live layer runs while
 *      models.json keeps owning the list.
 *   2. Fallback (models.json missing/empty) → register `STATIC_MODELS`
 *      eagerly so findInitialModel() can resolve settings.defaultModel
 *      during startup, plus refreshModels.
 *
 * Keep STATIC_MODELS in sync with models.json (both live in opendesign-live.ts
 * now, so there is a single source for the static layer). New gateway models
 * arrive through the live layer with probed values — no manual sync needed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Kept in step with package.json by `scripts/sync-models.mjs --stamp`, because
 * a user running loose files in `~/.pi/agent/extensions` has no other way to
 * tell which build they are on — and a bug report without that is a bug report
 * we cannot act on.
 */
export const BRIDGE_VERSION = readPackageVersion() ?? "0.0.0-unknown";

/**
 * The version comes from package.json, which is the only place it is written.
 *
 * It used to be a constant next to this line, and it drifted the moment a
 * release bumped one and not the other. Two sources of truth always drift; there
 * is now one. Undefined for a loose copy in `~/.pi/agent/extensions`, which has
 * no manifest beside it.
 */
function readPackageVersion(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8")) as { version?: string };
    return typeof manifest.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}
import {
  makeRefreshModels,
  readProviderConfig,
  STATIC_MODELS,
  OPENDESIGN_BASE_URL,
} from "./opendesign-live.ts";

export default async function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const cfg = readProviderConfig(agentDir);
  const hasModels = Array.isArray(cfg?.models) && cfg.models.length > 0;

  // Printed on every load so the number is visible in the session, not buried in
  // a file the user would have to know to open.
  console.error(`[opendesign-bridge] ${BRIDGE_VERSION} · agent dir ${agentDir}`);

  pi.registerProvider("opendesign", {
    name: `OpenDesign ${BRIDGE_VERSION}`,
    api: "openai-completions",
    authHeader: true,
    refreshModels: makeRefreshModels({ agentDir, fallbackBaseUrl: OPENDESIGN_BASE_URL }),
    // Mode 2 only: Mode 1 must not pass `models` (it would replace the
    // models.json list) and passes no `baseUrl` either, so models.json wins.
    ...(hasModels ? {} : { baseUrl: cfg?.baseUrl ?? OPENDESIGN_BASE_URL, models: STATIC_MODELS }),
  });
}
