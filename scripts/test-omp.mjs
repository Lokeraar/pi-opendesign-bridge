#!/usr/bin/env node
/**
 * test-omp.mjs — the omp path, offline.
 *
 * omp (a pi fork) implements `registerProvider()` but never calls an extension
 * provider's `refreshModels`, and only lists providers in `/login` when they
 * declare `oauth`. The contract this file locks down:
 *
 *   1. Host detection is the documented marker, nothing else.
 *   2. omp's models.yml wins over the models.json it migrated and left behind;
 *      that leftover declares `opendesign` with an id and no limits, and using
 *      it as the curated layer would default every model to 128K/16K.
 *   3. The catalog is resolved once at load: fresh cache means no request,
 *      stale cache means one request, failure falls back to cache, and no cache
 *      falls back to STATIC_MODELS. A read-only agent dir never throws.
 *   4. `oauth.login()` validates a pasted key before returning credentials,
 *      and never returns a key the endpoint rejected.
 *
 * Everything here runs offline: `refresh` and `fetch` are injected.
 */

import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
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

const {
  isOmpHost,
  readHostProviderConfig,
  resolveOmpCatalog,
  makeApiKeyOAuth,
  STATIC_MODELS,
  OPENDESIGN_BASE_URL,
} = await load("opendesign-live.ts");

// ---------------------------------------------------------------------------
// 1. Host detection
// ---------------------------------------------------------------------------
check("OMPCODE=1 is omp", isOmpHost({ OMPCODE: "1" }) === true);
check("an empty env is pi", isOmpHost({}) === false);
check("OMPCODE=0 is not omp", isOmpHost({ OMPCODE: "0" }) === false);
check("OMPCODE=true is not omp", isOmpHost({ OMPCODE: "true" }) === false);

// ---------------------------------------------------------------------------
// 2. Config resolution: models.yml beats the migrated models.json stub
// ---------------------------------------------------------------------------
const sandbox = mkdtempSync(join(tmpdir(), "opendesign-omp-"));
const agentDir = join(sandbox, "agent");
mkdirSync(agentDir, { recursive: true });

writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      opendesign: {
        baseUrl: "https://stale-json.example/v1",
        apiKey: "sk-json",
        models: [{ id: "deepseek-v4.1-flash" }],
      },
    },
  }),
);
writeFileSync(
  join(agentDir, "models.yml"),
  "providers:\n  opendesign:\n    baseUrl: https://yml.example/v1\n    apiKey: sk-yml\n",
);

const yamlParse = (text) => {
  for (const block of text.split(/\n\s{2}(?=\w)/)) {
    if (!block.startsWith("opendesign:")) continue;
    return {
      providers: {
        opendesign: {
          baseUrl: block.match(/baseUrl:\s*(\S+)/)?.[1],
          apiKey: block.match(/apiKey:\s*(\S+)/)?.[1],
        },
      },
    };
  }
  return { providers: {} };
};

const hostCfg = readHostProviderConfig(agentDir, yamlParse);
check("models.yml baseUrl wins", hostCfg.baseUrl === "https://yml.example/v1", hostCfg.baseUrl);
check("models.yml apiKey wins", hostCfg.apiKey === "sk-yml", hostCfg.apiKey);

// Without a YAML parser (plain node), the JSON file is still read.
const jsonCfg = readHostProviderConfig(agentDir);
check("no yaml parser falls back to models.json", jsonCfg.apiKey === "sk-json", jsonCfg.apiKey);
check("no yaml parser keeps models.json baseUrl", jsonCfg.baseUrl === "https://stale-json.example/v1", jsonCfg.baseUrl);

// A models.yml that does not mention opendesign must not hide models.json.
writeFileSync(join(agentDir, "models.yml"), "providers:\n  ollama:\n    baseUrl: http://localhost:11434/v1\n");
const otherCfg = readHostProviderConfig(agentDir, yamlParse);
check("models.yml without opendesign falls through", otherCfg.apiKey === "sk-json", otherCfg.apiKey);

const emptyDir = join(sandbox, "empty");
mkdirSync(emptyDir, { recursive: true });
check("missing config yields no key", readHostProviderConfig(emptyDir, yamlParse).apiKey === undefined);

// Restore the full provider block the catalog tests expect.
writeFileSync(
  join(agentDir, "models.yml"),
  "providers:\n  opendesign:\n    baseUrl: https://yml.example/v1\n    apiKey: sk-yml\n",
);

// ---------------------------------------------------------------------------
// 3. Catalog resolution: one refresh, cached, never throwing
// ---------------------------------------------------------------------------
// omp runs on Bun, so models.yml is always readable there. Stub the same global
// parser so this suite exercises the same branch without Bun.
globalThis.Bun = { YAML: { parse: yamlParse } };
const liveModel = {
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  provider: "opendesign",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_048_000,
  maxTokens: 232_000,
};

function recordingRefresh(result, calls) {
  return async (ctx) => {
    calls.push({ allowNetwork: ctx.allowNetwork, stored: ctx.stored, credential: ctx.credential });
    if (result === undefined) return undefined;
    await ctx.publish({ persist: { models: result, checkedAt: 1_700_000_000_000 } });
    return result;
  };
}

const stateDir = join(sandbox, "state");
const storeFile = join(stateDir, "omp-models-store.json");

// 3a. No cache → network refresh, persisted.
let calls = [];
let out = await resolveOmpCatalog({
  agentDir,
  stateDir,
  refresh: recordingRefresh([liveModel], calls),
});
check("cold catalog is live", out.source === "live", out.source);
check("cold catalog allows network", calls[0]?.allowNetwork === true);
check("cold catalog passes the config key", calls[0]?.credential?.key === "sk-yml", JSON.stringify(calls[0]?.credential));
check("cold catalog returns the models", out.models.length === 1 && out.models[0].id === liveModel.id);
check("cold catalog persists the store", existsSync(storeFile));

// 3b. Within the TTL → cache only, no network.
calls = [];
out = await resolveOmpCatalog({
  agentDir,
  stateDir,
  now: () => 1_700_000_000_000 + 60_000,
  refresh: recordingRefresh([liveModel], calls),
});
check("fresh store is cache", out.source === "cache", out.source);
check("fresh store does not allow network", calls[0]?.allowNetwork === false);
check("fresh store feeds stored back", calls[0]?.stored?.models?.length === 1);

// 3c. Past the TTL → network again.
calls = [];
out = await resolveOmpCatalog({
  agentDir,
  stateDir,
  now: () => 1_700_000_000_000 + 11 * 60_000,
  refresh: recordingRefresh([liveModel], calls),
});
check("expired store refreshes", out.source === "live", out.source);
check("expired store allows network", calls[0]?.allowNetwork === true);

// 3d. Refresh fails but a cache exists → cache, not static.
out = await resolveOmpCatalog({
  agentDir,
  stateDir,
  now: () => 1_700_000_000_000 + 12 * 60_000,
  refresh: recordingRefresh(undefined, []),
});
check("failed refresh keeps the cache", out.source === "cache", out.source);
check("failed refresh keeps the cached models", out.models.length === 1);

// 3e. No cache and no network → STATIC_MODELS.
const otherState = join(sandbox, "state-empty");
out = await resolveOmpCatalog({
  agentDir: emptyDir,
  stateDir: otherState,
  refresh: recordingRefresh(undefined, []),
});
check("no cache and no network is static", out.source === "static", out.source);
check("static fallback is the curated list", out.models.length === STATIC_MODELS.length);

// 3f. A read-only state dir must not throw while persisting.
const readOnlyState = join(sandbox, "readonly");
mkdirSync(readOnlyState, { recursive: true });
writeFileSync(join(readOnlyState, "omp-models-store.json"), JSON.stringify({ models: [liveModel], checkedAt: 0 }));
chmodSync(readOnlyState, 0o500);
let readOnlyOk = true;
try {
  await resolveOmpCatalog({
    agentDir: emptyDir,
    stateDir: readOnlyState,
    refresh: async () => [liveModel],
  });
} catch {
  readOnlyOk = false;
} finally {
  chmodSync(readOnlyState, 0o700);
}
check("unwritable store never throws", readOnlyOk);

// ---------------------------------------------------------------------------
// 4. oauth: paste an API key, validate it, then store it
// ---------------------------------------------------------------------------
const prompts = [];
const callbacks = {
  async onPrompt(prompt) {
    prompts.push(prompt);
    return "  sk-amr-test  ";
  },
};

let requested = [];
const okFetch = async (url, init) => {
  requested.push({ url: String(url), auth: init?.headers?.Authorization });
  return new Response("{}", { status: 200 });
};

const oauth = makeApiKeyOAuth({ baseUrl: "https://od.example/v1", fetch: okFetch });
const creds = await oauth.login(callbacks);
check("login prompts once", prompts.length === 1);
check("login prompt is masked", prompts[0]?.secret === true);
check("login trims the pasted key", creds.access === "sk-amr-test", creds.access);
check("login returns the same key as refresh token", creds.refresh === "sk-amr-test");
check("login keeps the credential alive", creds.expires > Date.now());
check("login validates against /models", requested[0]?.url === "https://od.example/v1/models", requested[0]?.url);
check("login sends the key as a bearer", requested[0]?.auth === "Bearer sk-amr-test", requested[0]?.auth);
check("getApiKey returns the pasted key", oauth.getApiKey(creds) === "sk-amr-test");
check("refreshToken is an identity", (await oauth.refreshToken(creds)) === creds);

// A rejected key must not be returned as credentials.
const rejectFetch = async () => new Response("nope", { status: 401 });
let rejected;
try {
  await makeApiKeyOAuth({ baseUrl: "https://od.example/v1", fetch: rejectFetch }).login(callbacks);
} catch (err) {
  rejected = err;
}
check("rejected key throws", rejected instanceof Error);
check("rejected key names the status", String(rejected?.message).includes("401"), rejected?.message);

// An unreachable endpoint is a distinct error, not "wrong key".
const downFetch = async () => {
  throw new Error("ECONNREFUSED");
};
let unreachable;
try {
  await makeApiKeyOAuth({ baseUrl: "https://od.example/v1", fetch: downFetch }).login(callbacks);
} catch (err) {
  unreachable = err;
}
check("unreachable endpoint throws", unreachable instanceof Error);
check("unreachable endpoint is not a rejection", String(unreachable?.message).includes("Could not reach"), unreachable?.message);

// An empty paste never reaches the endpoint.
let emptyFetchCalls = 0;
let emptyRejected;
try {
  await makeApiKeyOAuth({
    baseUrl: "https://od.example/v1",
    fetch: async () => {
      emptyFetchCalls += 1;
      return new Response("{}", { status: 200 });
    },
  }).login({ async onPrompt() { return "   "; } });
} catch (err) {
  emptyRejected = err;
}
check("empty key throws", emptyRejected instanceof Error);
check("empty key costs no request", emptyFetchCalls === 0, String(emptyFetchCalls));

// Default base URL is the gateway the provider uses.
check("default base URL is the gateway", OPENDESIGN_BASE_URL.endsWith("/v1"));

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
