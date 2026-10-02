[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version: 0.1.0](https://img.shields.io/badge/version-0.1.0-blue.svg)](https://www.npmjs.com/package/@lokeraar/pi-opendesign-bridge)

# @lokeraar/pi-opendesign-bridge

OpenDesign provider bridge for [pi](https://github.com/earendil-works/pi): registers the `opendesign` provider (`https://amr-link.open-design.ai/v1`) via `pi.registerProvider()` and keeps its catalog in sync with the endpoint. After `/login opendesign`, the models you can actually use appear in `/model` **with their real structure** — input modalities, context window, max output, reasoning levels and `off` behavior — instead of generic guesses.

> 📦 Page: [pi.dev/packages/@lokeraar/pi-opendesign-bridge](https://pi.dev/packages/@lokeraar/pi-opendesign-bridge)

## Why this package exists

Connecting Pi to OpenDesign takes more than a base URL:

- Pi needs the **full model structure** to drive `/model`, the thinking-level selector and context budgets — but an OpenAI-compatible `/v1/models` only answers with ids and coarse metadata. There are no reasoning levels, no official max output, and no `off` semantics to fetch — and unlike paid tiered gateways, **there is no premium catalog hiding behind your key: what the endpoint returns IS the catalog**.
- Hand-curated `~/.pi/agent/models.json` entries go stale the moment the endpoint adds or discontinues a model (a new "Hunyuan H4 Preview" today, a retired model tomorrow — nobody announces it in the payload).
- `/providers sync` (provider-manager) can only fill unknown ids with **vanilla defaults** (128k/16k, `medium` only) and never refreshes existing ones — the opposite of "real values".

This bridge solves both sides at once: a **curated structure layer** (verified values that never get clobbered) plus a **live `/models` fetch layer** (membership synced automatically, brand-new ids *measured* with tiny probe requests). And it ships with **zero premium/tier/quota logic** — completely free: the endpoint's answer for your key is the catalog, full stop.

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
index.ts            # registration + refreshModels wiring (extension entry)
opendesign-live.ts  # live fetch engine + auto-probe + bundled catalog (node builtins only)
```

`opendesign-live.ts` intentionally imports nothing from Pi, so its logic can be exercised directly with `node` (≥ 22.6 type stripping) against a mock gateway: membership add/drop, curated precedence, probe budgets, kill switch.

Manual verification after changes:

```
pi --list-models opendesign           # catalog renders, exit 0
pi -p "reply ok"                      # default resolution end-to-end
```

## License

MIT © Lokeraar
