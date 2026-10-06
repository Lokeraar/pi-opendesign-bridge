[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version: 0.2.2](https://img.shields.io/badge/version-0.2.2-blue.svg)](https://www.npmjs.com/package/@lokeraar/pi-opendesign-bridge)

# @lokeraar/pi-opendesign-bridge

<a href="https://github.com/Gentleman-Programming/gentle-ai">
  <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
</a>

OpenDesign provider bridge for [pi](https://github.com/earendil-works/pi): registers the `opendesign` provider (`https://amr-link.open-design.ai/v1`) via `pi.registerProvider()` and keeps its catalog in sync with the endpoint. After `/login opendesign`, the models you can actually use appear in `/model` **with their real structure** — input modalities, context window, max output, reasoning levels and `off` behavior — instead of generic guesses.

> 📦 Page: [pi.dev/packages/@lokeraar/pi-opendesign-bridge](https://pi.dev/packages/@lokeraar/pi-opendesign-bridge)

## 🔗 Where to find me

| | |
|---|---|
| 📦 **npm** | [`@lokeraar/pi-opendesign-bridge`](https://www.npmjs.com/package/@lokeraar/pi-opendesign-bridge) |
| 🌐 **Pi catalog** | [pi.dev/packages/@lokeraar/pi-opendesign-bridge](https://pi.dev/packages/@lokeraar/pi-opendesign-bridge) |
| ⭐ **Source** | [github.com/Lokeraar/pi-opendesign-bridge](https://github.com/Lokeraar/pi-opendesign-bridge) |

Install it in Pi:

```bash
pi install npm:@lokeraar/pi-opendesign-bridge
```

> 💛 If this bridge ever saved you from guessing a model's limits, a ⭐ on the
> repo goes a long way — it is the only thing that helps somebody else find it.
> Every star is read by a human, and so is every bug report.

## Why this package exists

Connecting Pi to OpenDesign takes more than a base URL:

- Pi needs the **full model structure** to drive `/model`, the thinking-level selector and context budgets — but an OpenAI-compatible `/v1/models` only answers with ids and coarse metadata. There are no reasoning levels, no official max output, and no `off` semantics to fetch — and unlike paid tiered gateways, **there is no premium catalog hiding behind your key: what the endpoint returns IS the catalog**.
- Hand-curated `~/.pi/agent/models.json` entries go stale the moment the endpoint adds or discontinues a model (a new "Hunyuan H4 Preview" today, a retired model tomorrow — nobody announces it in the payload).
- `/providers sync` (provider-manager) can only fill unknown ids with **vanilla defaults** (128k/16k, `medium` only) and never refreshes existing ones — the opposite of "real values".

This bridge solves both sides at once: a **curated structure layer** (verified values that never get clobbered) plus a **live `/models` fetch layer** (membership synced automatically, brand-new ids *measured* with tiny probe requests). And it ships with **zero premium/tier/quota logic** — completely free: the endpoint's answer for your key is the catalog, full stop.

## 📋 Releases

### 0.2.1 — documentation

Links in both directions, so the npm page and the source repo point at each
other, and a note asking for a star. No behaviour change.

### 0.2.0 — the values come from Pi's own catalog

The biggest change since the first release. Values were hand-curated with no
other source, so a model nobody had thought about arrived with placeholder
numbers. Pi ships **42 provider catalogs** inside its own package and this
bridge now reads them:

```
<pi-ai>/dist/providers/data/<provider>.json
```

No credential is needed — a key is only required to *call* an API, not to read
what Pi already installed. Matching is on the bare model name, and the exact id
that matched is recorded with its prefix:

```json
"provenance": { "donor": {
  "source": "openrouter",
  "matchedId": "deepseek/deepseek-v4-flash",
  "corroborating": ["together", "nvidia"],
  "applied": ["maxTokens", "thinkingLevelMap"]
}}
```

Precedence: **the vendor's model card > openrouter > the other 41**. openrouter
decides every field it states; the rest confirm and may fill a field nobody
above stated. Nothing is averaged.

An explicit `null` in a catalog is a **claim** and is applied. An absent key is
**silence** and does not erase what is known — which is why a thinking map is
merged key by key. openrouter lists `kimi-k2.7-code` with one key and the
`mimo-v2.6-*` models with none; a wholesale replace would have deleted eight
working reasoning levels.

Also in this release:

- **A retirement ledger** with two reasons a model can be dropped: absent from a
  successful fetch, or listed with no healthy route for your key.
- **A tunnel-aware probe.** This router proxies other providers and answers
  `502` with the upstream status in the body, so `max_tokens=393216` arrives as
  `502 "Inference provider returned HTTP 400"`. Judging by status alone threw
  that measurement away and lost the real ceiling on 12 of 14 models.
- **A ceiling clamp** to the window minus a prompt reserve. A ceiling the window
  cannot hold is not a bigger claim, it is an impossible one.
- **`npm run diagnose`**, which prints what this installation actually resolved
  — see below.

### 0.1.0 — first release

The live `/models` fetch, the curated layer, and auto-probe for new ids.

## ⚡ Quick Start

1. **Get an OpenDesign API key** (the one you use for the gateway).
2. **Install**:

   ```
   pi install npm:@lokeraar/pi-opendesign-bridge
   ```

3. **Authenticate**:

   ```
   pi > /login opendesign
   ```

4. **Verify** — restart Pi (or start a new session) and check:

   ```
   pi --list-models opendesign
   ```

   or open `/model`: the OpenDesign catalog appears with context window, max output, image support and the thinking levels each model actually accepts.

> [!WARNING]
> If you previously kept local copies in `~/.pi/agent/extensions/opendesign*.ts`, **remove them** before installing this package — two registrations of the same provider fight over the model list.

## ⚙️ How it works

The provider uses a **two-layer model catalog** to ensure reliability:

| Layer | Source | Purpose |
|---|---|---|
| **1. Curated structure** | `models.json` (if present) → bundled static catalog | Authoritative **values** for known ids: context window, max output (`min(gateway budget, official cap)`), reasoning levels, `off` semantics, role compatibility. Verified against vendor docs and measured against the gateway — never overwritten by the endpoint. |
| **2. Live `/models` fetch** | `GET /v1/models` with your key | Authoritative **membership**: new models appear automatically, discontinued ones drop out, non-chat ids are filtered. The live list is merged over the curated layer and persisted between runs. |

The registration is synchronous on purpose: the bundled catalog is available immediately, and Pi's Models runtime drives the live refresh (network refresh at interactive startup and on `/model` search, cache-only in headless modes), persisting the overlay in `~/.pi/agent/models-store.json`.

### 🔎 Live refresh phases

| Phase | When | Network | What it does |
|---|---|---|---|
| **Restore** | Every runtime creation (`pi -p`, `--list-models`, sessions) | no | Rebuilds the last-known catalog from `models-store.json`, re-merged so curated values win; re-persists only when the merge changed. |
| **Live fetch** | Interactive startup / `/model` search (15 s budget; skipped when `PI_OFFLINE` is set) | yes | `GET /v1/models` → merge membership → persist. Errors are swallowed: the curated layer always keeps Pi usable. |

### 🧪 Auto-probe for brand-new models

When the endpoint publishes an id the curated layer doesn't know, the bridge **measures it** (~12 tiny requests, no manual editing):

- **Reasoning levels** — each of `minimal · low · medium · high · xhigh · max` is probed; HTTP-rejected levels become `null`, so `clampThinkingLevel` snaps to the nearest supported level instead of sending one the API refuses.
- **`off` behavior** — `reasoning_effort:"none"` is only mapped to `off` when it is accepted **and** returns 0 reasoning tokens; rejected (`glm-5.3*`, `gpt-6.1-sol`) or ineffective (kimi) → `off` is hidden from the UI.
- **Output ceiling** — `max_tokens` is walked up until the first rejection; the model gets `min(context_budget, highest accepted)`.
- **Input modalities / context** — taken from the endpoint metadata (`text`/`image`; the Pi schema does not model audio/video/file ids).
- If the probe fails mid-way (network, timeout), a **conservative placeholder** is used — a broken probe never blocks the refresh.

> [!NOTE]
> `PI_OPENDESIGN_LIVE=0` disables the live layer entirely (curated catalog only). The same applies via `PI_OFFLINE` for the network phase.

## 🧬 Value donors — where the numbers come from

Values do not only come from hand-curating. Pi ships a catalog per provider in
its own package, and this bridge reads them:

```
<pi-ai>/dist/providers/data/<provider>.json      42 of them
```

No credential is needed to read them — a key is only needed to *call* an API.
Matching is on the **bare model name**, so `deepseek-v4-flash` finds
`deepseek/deepseek-v4-flash`, with the prefix stripped on both sides. The exact
id that matched is recorded with its prefix, so a match can be audited:

```json
"provenance": {
  "donor": {
    "source": "openrouter",
    "matchedId": "deepseek/deepseek-v4-flash",
    "corroborating": ["together", "nvidia"],
    "applied": ["maxTokens", "thinkingLevelMap"]
  }
}
```

### The order

```
the vendor's own model card  >  openrouter  >  the other 41 catalogs
```

**openrouter decides every field it states.** It is the largest model router in
the world and the catalog is its core business. The other catalogs confirm that a
model exists and may fill a field nobody above stated; they never override.
Nothing is averaged.

### An explicit `null` is a claim; an absent key is silence

This is the distinction the whole thing hangs on.

A catalog that writes `"minimal": null` is **claiming** the model does not accept
that effort level, and the claim wins. `openrouter` does exactly this for the
DeepSeek family, which is why `deepseek-v4-flash` drops from seven levels to
three here.

A catalog that leaves the key out has said **nothing**, and saying nothing must
not erase what we know. `openrouter` lists `kimi-k2.7-code` with a single key and
`mimo-v2.6-*` with none, so a thinking map is merged **key by key**: a one-key
map cannot delete a seven-key one. Without that, two models would silently lose
their reasoning levels to a gap in the catalog.

### What no donor may set

| Field | Owner | Why |
|---|---|---|
| `contextWindow` | the endpoint's `metadata.context_limit` | It states what this gateway actually serves. |
| `cost` | the endpoint | A catalog's price is for a different reseller. |
| `compat` | never inherited | `thinkingFormat` and friends describe how one reseller frames reasoning. Amr-link was verified by sending `reasoning_effort` and watching what came back. |

### The ceiling clamp

A ceiling the window cannot hold is an impossible claim, not a big one, so it is
clamped to the window minus a 2,048-token prompt reserve. A ceiling inside the
limit is used exactly as given.

> **Verify after an update.** A donor's ceiling is a catalog's statement about
> its own infrastructure. When OpenDesign's quota is available again, spot-check
> that the published ceilings are accepted: `maxTokens` values that are too high
> produce `400` on every request, which is loud but easy to misread as an outage.

### Known endpoint state

As of 2026-10-03 every `/v1/chat` call on amr-link answers `402` — the quota is
exhausted and resets on 2026-10-08. The donor values are applied offline and are
visible in `/model` regardless, but the ceilings could not be confirmed against
the live endpoint while the quota is out.

## 🐞 Fixes

Named here because each one had a symptom that looked like something else.

**A `402` is not a measurement.** The probe used to treat every HTTP status as
the model's opinion, so an exhausted quota — `402`, `401`, `403`, `429`, any
`5xx`, any timeout — was read as "this model has no reasoning levels and a small
ceiling", and then written down. Before the fix the audit reported 25 false
positives; after, zero. Only `400` and `422` are now treated as a parameter
rejection, because only those mean the request shape was refused.

**A `502` can be a `400`.** This router proxies other providers, so when the
inference provider refuses a parameter the answer arrives as
`502 "Inference provider returned HTTP 400"`. Judging by status alone threw that
measurement away, which cost the real ceiling on 12 of 14 models. The upstream
status in the body is now what counts.

**A ceiling that the window cannot hold is impossible, not large.** OpenRouter
listed `inkling` at 471,859 against a 262,144 window here, and the endpoint
refused it with *"This request needs about N tokens (messages + tools +
max_tokens)"*. Clamped to the window minus a prompt reserve — and it cannot equal
the window either: 262,144 was rejected while 261,120 passed.

**A catalog that omits a key has not claimed anything.** An explicit `null` is a
claim and is applied; an absent key is silence and does not erase a known value.
Thinking maps are therefore merged key by key. Without that rule
`kimi-k2.7-code` and both `mimo-v2.6-*` lost working reasoning levels to a gap in
the catalog.

**`maxTokens` must never be `null`.** Pi's model list calls `.toString()` on it
and crashes with *"Cannot read properties of undefined"*, taking the whole list
with it.

**A scoped package publishes private by default.** `npm publish` failed with
`E402 "You must sign up for private packages"`, which reads like a billing
problem and is not one: restricted packages need a paid plan. Declared in the
manifest as `"publishConfig": { "access": "public" }`, so a bare `npm publish`
does the right thing.

## 🩺 Diagnose

When someone reports that models are missing or that values did not come
through, the useful question is not their tier but this:

```bash
npm run diagnose
```

It prints, read-only:

```
build
  package               @lokeraar/pi-opendesign-bridge@0.1.1
  commit                cc14275

model catalog
  la extension usa      43 catálogos  …/pi-ai/dist/providers/data
  encontrado            43 catálogos  …

coverage of this provider
  provider              opendesign
  modelos               10 en models.json, 10 con donante
  el endpoint sirve     14 modelos para esta clave
  publicados aquí       10
  faltantes             deepseek-v4-pro, mimo-v2.6-turbo, …
```

Three things worth reading:

- **`la extension usa`** is what the extension itself resolved. If that line
  says `NINGUNO`, no donor ran and every value fell back to what was already
  written. That is indistinguishable from "the donors do not work" unless you
  print it.
- **`faltantes`** compares what your key is served against what is published. A
  non-empty line is the subscription-tier problem: the endpoint has models the
  extension is not showing, and they have to be added by hand.
- The catalog is searched by **content**: any package containing
  `dist/providers/data/*.json` counts, whatever it is named. That is not a
  preference. Pi installs the same catalogs under different package names
  depending on the version and the launcher, so a lookup keyed on the name
  reports "no donor" on every layout but its own.
- The store is searched under the running agent directory **and its siblings**,
  so a wrapper that relocates it resolves too. Reporters on Pi 1.0.1 through
  `gentle-shell` — which installs into `~/.gentle-shell/agent` — were seeing
  neither their tier's models nor any inherited values, because the lookup
  returned nothing and every model fell back to its defaults. It also descends
  into store entries, which sit directly under the store root rather than under a
  `node_modules`, so a walk that looks only there sees an empty store.

The two scan results are printed separately on purpose: the first is what the
extension does, the second is what a broader search could find. When they differ,
the extension is missing something it could have used.

## 🔑 Authentication

| Method | Action | Notes |
|---|---|---|
| **`/login`** | `pi > /login opendesign` | Persistent; stores in `~/.pi/agent/auth.json`. |
| **Manual Config** | Edit `~/.pi/agent/auth.json` | Direct JSON manipulation (`{"opendesign": {"key": "sk-…"}}`). |

The stored key is what the live fetch uses — the endpoint scopes the catalog per key, so models appear exactly when your key can use them.

## 📊 Models

Bundled catalog (verified against vendor documentation and measured against the gateway, 2026-10-01/02):

| Model | Context | Max output | Input | `off` | Reasoning levels |
|---|---|---|---|---|---|
| `deepseek-v4-flash` | 1,048,000 | 232,000 | text | ✅ `none` | `minimal · low · medium · high · xhigh · max` |
| `deepseek-v4-flash-vision-exp` | 1,048,000 | 232,000 | text, image | ✅ `none` | same |
| `deepseek-v4-pro` | 1,048,000 | 232,000 | text | ✅ `none` | same |
| `deepseek-v4.1-flash` | 1,048,000 | 232,000 | text, image | ✅ `none` | same |
| `glm-5.3-flash` | 1,048,000 | **128,000** | text, image | ❌ hidden | `low · high · max` only |
| `glm-5.3-flashx` | 1,000,000 | **128,000** | text, image | ❌ hidden | `low · high · max` only |
| `gpt-6-luna` | 1,050,000 | **128,000** | text, image | ✅ `none` | `low · medium · high · xhigh · max` (no `minimal`) |
| `gpt-6.1-sol` | 1,050,000 | **128,000** | text, image | ❌ hidden | `low · medium · high · xhigh · max` (no `none`/`minimal`) |
| `kimi-k2.7-code` | 262,000 | 262,000 | text, image | ❌ hidden | accepts `minimal · low · medium · high · xhigh` (`max` rejected) |
| `mimo-v2.6-flash` | 1,048,000 | 131,072 | text, image¹ | ✅ `none` | all seven levels |
| `mimo-v2.6-pro` | 1,048,000 | 131,072 | text, image¹ | ✅ `none` | all seven levels |

¹ The endpoint also accepts audio/video for MiMo; Pi's schema models `text`/`image` only.

Notes on the numbers:

- **Max output** is `min(gateway-declared budget, official vendor cap)` — GLM-5.3 and GPT-6 cap at 128K officially, below the gateway budget, so 128K wins.
- DeepSeek's official `max_tokens` ceiling is 393,216 (384K); the gateway budget (232,000) is the bound used here.
- `deepseek-v4.1-flash` the *model* supports a continuous numeric reasoning effort of **1–100** (NVIDIA NIM/vLLM docs; evals used `100` = max), but this gateway rejects numeric values and exposes the named levels only — so the bridge sends names, never numbers.

## 🧠 Reasoning controls

Effort control varies per model, exactly as measured:

- **`off` sends `reasoning_effort:"none"`** for the deepseek family, `gpt-6-luna` and `mimo-v2.6*` — verified to actually disable thinking (0 reasoning tokens). Everywhere else `off` is **hidden**, because the gateway rejects `none` (HTTP 400) or ignores it (kimi-k2.7-code always thinks).
- **Unsupported levels are `null` in the map**, never sent: requesting `medium` on a GLM snaps to `high`, `max` on kimi snaps to `xhigh`, `minimal` on GPT-6 snaps to `low`.
- Sending `role:"developer"` would fail on 6 of the 11 models (422/400), so the provider registers `supportsDeveloperRole: false` and Pi always uses `role:"system"` — accepted by all of them.

## ⚙️ Configuration

Curated values live in `~/.pi/agent/models.json` (optional — the bundled catalog covers a fresh install):

```json
{
  "providers": {
    "opendesign": {
      "modelOverrides": {
        "some-model": { "maxTokens": 65536, "thinkingLevelMap": { "off": null } }
      }
    }
  }
}
```

`modelOverrides` is Pi's topmost layer — per-model edits there always win, over both the bundled catalog and the live overlay. Plain provider-level `models.json` entries are also honored: known ids keep their curated values while the live layer only decides *membership*.

| Env var | Effect |
|---|---|
| `PI_OPENDESIGN_LIVE=0` | Disable the live `/models` fetch (curated catalog only). |
| `PI_OFFLINE` | Pi-wide: skip the network refresh phase (cache-only restore still runs). |

## 🚀 Development

Layout (flat, mirrors `@fanchaozz/provider-manager`):

```
scripts/probe-models.mjs # curated-layer maintenance CLI (report-only)
index.ts            # registration + refreshModels wiring (extension entry)
opendesign-live.ts  # live fetch engine + auto-probe + bundled catalog (node builtins only)
```

`opendesign-live.ts` intentionally imports nothing from Pi, so its logic can be exercised directly with `node` (≥ 22.6 type stripping) against a mock gateway: membership add/drop, curated precedence, probe budgets, kill switch.

### Where each value comes from

Every published model carries a `provenance` block, so you never have to guess whether a number was measured or merely claimed:

| `provenance` | Meaning |
|---|---|
| `curated` | Hand-verified in `models.json` / `STATIC_MODELS`. Wins over everything. |
| `measured` | A real probe request against the endpoint. Only `maxTokens`, the effort levels and `reasoning` qualify. |
| `gateway` | The endpoint **declared** it. `contextWindow` and `input` are always at best this. |
| `vanilla` | The conservative fallback. Used only when the probe could not run. |

`contextWindow` is never measured: an over-long prompt is silently truncated, which is indistinguishable from success. Treat it as a claim, and confirm it against vendor documentation before curating it.

### Maintaining the curated layer

Two tools, both report-only — the diff is the product, you decide what to apply:

```
# Re-probe curated models, print a table and the exact models.json patch
node --experimental-strip-types scripts/probe-models.mjs --all
node --experimental-strip-types scripts/probe-models.mjs gpt-6-luna kimi-k2.7-code
```

```
# Re-probe after an interactive refresh; writes a report and prints drift to stderr
PI_OPENDESIGN_REPROBE=1 pi
```

The report goes to `~/.pi/agent/opendesign-reprobe.json`. Findings are labelled by what the comparison actually rests on: `probe` rows are measurements, `gateway-declaration` rows are not — confirm those against vendor docs before changing a curated value.

Both require a reachable endpoint **with quota**. An exhausted plan answers HTTP 402 and every row comes back `probe-failed`; no value is ever guessed around it.

### Retired models

Membership is live-only: a model the endpoint stops serving disappears from the published catalog. Because Pi's store is a cache and the offline phase unions stored + curated, that used to resurrect dead models forever. The extension now keeps a small ledger (`~/.pi/agent/opendesign-retired.json`) of ids a **successful** live check stopped serving, and skips them offline. It self-corrects: if the endpoint lists the model again, it is un-retired and returns with its curated values intact.

`models.json` is yours — `probe-models.mjs` reports retired ids so you can remove them from the config.

Kill switch: `PI_OPENDESIGN_LIVE=0` skips the live layer entirely.

Manual verification after changes:

```
pi --list-models opendesign           # catalog renders, exit 0
pi -p "reply ok"                      # default resolution end-to-end
```

## License

MIT © Lokeraar
