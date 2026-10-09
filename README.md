[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version: 0.2.9](https://img.shields.io/badge/version-0.2.9-blue.svg)](https://www.npmjs.com/package/@lokeraar/pi-opendesign-bridge)

# @lokeraar/pi-opendesign-bridge

<a href="https://github.com/Gentleman-Programming/gentle-ai">
  <img width="220" src="https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/docs/assets/brand/built-with-gentle-ai.png" alt="Built with Gentle-AI" />
</a>

OpenDesign provider bridge for [pi](https://github.com/earendil-works/pi).

Pi is a coding assistant that talks to AI models. OpenDesign is a gateway at
`https://amr-link.open-design.ai/v1`, registered here as the provider
`opendesign`. When you connect the two, Pi needs to know
each model's real shape: how much text it can read, how much it can write back,
whether it understands images, and which thinking-effort settings it accepts.

OpenDesign's own `/models` address answers with ids and coarse metadata only — no
reasoning levels, no real output ceiling. Without those, Pi falls back to generic
guesses. This bridge fills the gap: after `/login opendesign`, the models your key
can actually use appear in `/model` **with their real structure** instead of
defaults that merely look plausible.

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

Straight from the repository, if you would rather follow `main` than a release:

```bash
pi install git:github.com/Lokeraar/pi-opendesign-bridge
```

The git form tracks `main`, so it can change under you. Prefer npm unless you are
testing something specific, or a fix has not been published yet — during that
window this is the only way to get it. To pin a release:

```bash
pi install git:github.com/Lokeraar/pi-opendesign-bridge#v0.2.9
```

> **First check how the older copy was installed.** Pi can load an extension as
> an installed package, or directly from a `.ts` file in `~/.pi/agent/extensions/`.
> If both copies are present, both can register OpenDesign and conflict. Updating
> a package does not remove a loose file.
>
> `pi list` shows installed packages. If this package is already listed from npm,
> update it in place:
>
> ```bash
> pi update npm:@lokeraar/pi-opendesign-bridge
> ```
>
> If `pi list` shows it was installed from git, update that same source instead:
>
> ```bash
> pi update git:github.com/Lokeraar/pi-opendesign-bridge
> ```
>
> **Do not run both commands.** Use the one that matches the source already
> installed; switching sources can leave two package entries. If you also have
> an old loose OpenDesign file in `~/.pi/agent/extensions/`, remove it or move it
> outside that folder, then restart Pi.


> 💛 If this bridge ever saved you from guessing a model's limits, a ⭐ on the
> repo goes a long way — it is the only thing that helps somebody else find it.
> Every star is read by a human, and so is every bug report.

## Why this package exists

Connecting Pi to OpenDesign takes more than a base URL:

Connecting Pi to OpenDesign takes more than pasting a base URL, for three
concrete reasons.

**Pi needs the full model structure, and OpenDesign does not provide it.** Pi
uses those numbers to drive `/model`, the thinking-level selector and context
budgets. An OpenAI-compatible `/v1/models` endpoint answers with ids and coarse
metadata: no reasoning levels, no official output ceiling, no `off` semantics.
And there is nothing richer to fetch behind the scenes — unlike paid tiered
gateways, **there is no premium catalog hidden behind your key. What the endpoint
returns is the catalog.**

**Hand-editing `~/.pi/agent/models.json` goes stale immediately.** The moment the
endpoint adds a model (a new "Hunyuan H4 Preview" today) or discontinues one
tomorrow, your hand-written entry is wrong, and the payload never announces it.

**`/providers sync` fills gaps with placeholder numbers.** It can only fill unknown
ids with defaults (128k context, 16k output, `medium` thinking only) and never
refreshes ids it already knows. That is the opposite of "real values".

This bridge handles both halves of the problem at once: a **curated structure
layer** with verified values that the endpoint cannot overwrite, plus a **live
`/models` layer** that keeps membership current and *measures* brand-new ids with
a handful of tiny test requests. It also ships with **no premium, tier or quota
logic at all** — completely free. Whatever the endpoint answers for your key is
the catalog.

## 📋 Releases

### 0.2.9 — vendor reasoning levels resolve key by key

An official catalog can declare a partial `thinkingLevelMap`. That does not mean
it owns levels it omitted. Each level now follows the same source rule as other
fields: the vendor decides if it explicitly declares that level (including an
explicit `null`); if it is silent, corroboration decides that key. A partial
Anthropic map can therefore supply `max` without erasing `low` or `high` that
other catalogs agree on. Added regression coverage for full official maps,
partial official maps, and explicit vendor nulls.

Tests: 47 passing, up from 40.

### 0.2.8 — the vendor's catalog decides, and agreement settles the rest

The order that decides a model's values has changed, and it was worth getting
wrong twice before it was right.

**The vendor's own catalog now decides.** For `deepseek-v4.1-flash`, eight
catalogs say `maxTokens` 384000 — DeepSeek's own first among them — and
openrouter alone says 943718, a figure amr-link rejects. The published ceiling
followed openrouter, so it was wrong. A catalog the vendor maintains records
what the model implements; a reseller's records what one gateway accepts, and
gateways disagree.

**Models are matched to their vendor by family**: `kimi` → moonshotai,
`claude` → anthropic, `gpt` → openai, `glm` → zai, `deepseek` → deepseek,
`mimo` → xiaomi, `nemotron` → nvidia. It cannot be derived automatically —
every catalog stamps `provider` on its entries, but a reseller stamps its own
name on a model it resells — so it is data, one line per family.

**When there is no vendor catalog, the value most catalogs agree on stands.**
`qwen3.8-max` has no first-party catalog in Pi. It now publishes
`minimal: null` and `high: null`, which is exactly what amr-link accepts:
`low`, `medium` and `xhigh` work; `minimal`, `off` and `high` return
`502 ... provider returned HTTP 400`. The rule found that without being told.

**A ceiling that reaches the model's own window is treated as silence.**
Moonshot lists `kimi-k3` with `contextWindow: 1048576` and `maxTokens: 1048576`
— the same number twice. A ceiling equal to the window leaves no room for the
prompt, so it cannot describe output; the field falls through to the catalogs
that state a ceiling a model can serve, and `kimi-k3` stays at 131072.

**A model is found by its human name as well as its id.** DeepSeek's catalog
writes `id: "deepseek-flash"` with `name: "DeepSeek V4.1 Flash"`, so the
endpoint's id and that name are one key once punctuation is stripped. This is
an exact match on a different field, not a similarity guess: dated variants
stay apart because the date is in the name too.

**`cost` is still never published from a catalog**, and never will be — a
price belongs to a reseller, so averaging prices from several would produce a
number nobody charges. What is available instead is a range, asked for
explicitly, showing the spread across every catalog.


### 0.2.5 — a broken catalog tree no longer takes the provider down

Pi refreshes every provider in one batch. An exception thrown while looking for
catalogs therefore aborted the batch for **all** of them, and Pi reported
`could not refresh N model catalogs` for providers that were working fine —
right after a successful `/login`:

```
Saved API key for EnClave, but local model state could not be synchronized
```

The credential was saved; the refresh that followed it failed. Every donor lookup
is now wrapped, and a catalog that cannot be read degrades to "no donors" instead
of throwing. A donor layer is an enhancement and is not allowed to take the
provider down with it.

The version comparison also split the path on `/`, which is wrong on Windows where
the separator is a backslash, so the pick was arbitrary there.

### 0.2.4 — catalogs from a flat install too

The catalogs can sit at three places depending on how Pi was installed:

```
<active Pi package>/node_modules/@earendil-works/pi-ai/dist/providers/data
<agent>/npm/node_modules/.pnpm/@earendil-works+pi-ai@…/node_modules/…/pi-ai/dist/providers/data
<agent>/npm/node_modules/@earendil-works/pi-ai/providers/data
```

The active Pi package is discovered at runtime. Its exact path differs across
Termux, Windows, global prefixes, local installs and package managers. The store
and flat layouts are fallbacks, not assumptions about how Pi was installed.

Two bugs fixed alongside it. The sibling roots were built from
`dirname(agentDir)` as if that were the home directory, which for
`agentDir = ~/.pi/agent` produces the nonsense `~/.pi/.pi/agent`. And the root
walk tested an entry for `@` before testing it for `+`, so a pnpm entry like
`@earendil-works+pi-ai@0.85.1_hash` — which is both — was treated as an empty
scope and skipped, losing the very copy being looked for.

### 0.2.3 — find the catalog by content, and stop the two bridges colliding

Discovery was keyed on the package name, so a store named after a different
package returned nothing. It is now by content: any package containing
`dist/providers/data/*.json` counts, whatever it is named.

Both bridges also installed a file called `donors.ts` into the same extensions
directory, so whichever was copied last overwrote the other. Renamed per bridge,
so installing one can never displace the other.

### 0.2.2 — find the catalog by content

First pass at the same fix, before the flat install shape was known.

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

Precedence is per field: hand-written model card > the official vendor catalog
> a simple majority among catalogs that state the field (only when no vendor
catalog exists) > openrouter fallback (when there is no vendor or majority) >
what is already written when nobody states the field. The vendor's catalog is
absolute for the values it states; it is not one vote among resellers. Nothing
is averaged.

An explicit `null` in a catalog is a **claim**; an absent key is **silence**.
For `thinkingLevelMap`, every level resolves independently: the vendor's
explicit value wins, including `null`; a vendor-omitted level falls through to
the remaining catalogs and their majority. A reseller's partial map cannot erase
vendor-declared levels, and a partial vendor map can be completed from
corroboration. `contextWindow` belongs to the endpoint and is never overwritten.
`cost` is excluded from published donor values because prices belong to
resellers; the module can provide an approximate range for inspection instead.

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

Two layers split the work, because the endpoint is good at one thing and silent
about the other.

| Layer | Where it comes from | What it decides |
|---|---|---|
| **1. Curated structure** | `models.json` if present, otherwise the catalog bundled with this package | The **values** for known models: context window, maximum output (`min(gateway budget, official cap)`), reasoning levels, `off` behaviour, role compatibility. Checked against vendor documentation and measured against the gateway. The endpoint never overwrites these. |
| **2. Live `/models` fetch** | `GET /v1/models` using your key | **Membership only**: which models exist right now. New ones appear, discontinued ones drop out, non-chat ids are filtered out. The live list is merged over the curated layer and saved between runs. |

Registration goes through `pi.registerProvider()` and is deliberately
synchronous: the bundled catalog is ready the moment Pi asks, and Pi's own model runtime then drives the live refresh — hitting the
network at interactive startup and during `/model` search, and using only the
cache in headless modes. The merged result is stored in
`~/.pi/agent/models-store.json`.

### 🔎 Live refresh phases

| Phase | When it runs | Uses network? | What it does |
|---|---|---|---|
| **Restore** | Every time Pi creates the provider (`pi -p`, `--list-models`, sessions) | no | Rebuilds the last-known catalog from `models-store.json`, merging again so the curated values win. It only writes back when the merge actually changed something. |
| **Live fetch** | Interactive startup and `/model` search — 15 second budget, skipped when `PI_OFFLINE` is set | yes | Calls `GET /v1/models`, merges the membership, saves the result. Any error is swallowed on purpose: the curated layer keeps Pi usable regardless. |

### 🧪 Auto-probe for brand-new models

When the endpoint announces a model the curated layer has never seen, the bridge
does not guess: it **measures the model** with about a dozen tiny requests, and
writes down the answers.

- **Reasoning levels.** Each of `minimal · low · medium · high · xhigh · max` is
  tried. Any level the API rejects is recorded as `null`, so Pi's
  `clampThinkingLevel` snaps to the closest working level instead of sending one
  the API refuses.
- **`off` behaviour.** Sending `reasoning_effort:"none"` only counts as "thinking
  can be turned off" when the API accepts it **and** the reply contains zero
  reasoning tokens. If it is rejected (`glm-5.3*`, `gpt-6.1-sol`) or accepted but
  ignored, the `off` option is hidden from the interface.
- **Output ceiling.** `max_tokens` is increased step by step until the first
  rejection; the model gets `min(context_budget, highest accepted)`.
- **Input types and context.** Taken from the endpoint's own metadata. Pi
  understands `text` and `image`; audio, video and file ids are not modelled.
- **If the probe fails partway** — a dropped connection, a timeout — a
  conservative placeholder is used instead. A failed probe never blocks the
  refresh.

> [!NOTE]
> `PI_OPENDESIGN_LIVE=0` disables the live layer entirely (curated catalog only). The same applies via `PI_OFFLINE` for the network phase.

## 🧬 Value donors — where the numbers come from

The numbers do not all come from hand-editing. Pi ships one catalog per provider
inside its own package, and this bridge reads them:

```
<active Pi package>/node_modules/@earendil-works/pi-ai/dist/providers/data/<provider>.json
```

Reading them needs no credential — an API key is only required to *call* a model,
not to read a file Pi already installed.

The location is worked out at run time from the Pi installation that is actually
running. The path differs between operating systems, install prefixes and package
managers, so the line above describes a layout, not a fixed path. Agent-local store
and flat-install layouts are used as fallbacks. Pi currently ships 42 catalogs
there, and that set changes with the Pi version: after upgrading Pi, restart it or
refresh the provider to pick up the new files.

**How a model is matched.** Two spellings of the same model have to meet. The
endpoint says `deepseek-v4.1-flash`; DeepSeek's own catalog lists that model with
the id `deepseek-flash` and the written name `DeepSeek V4.1 Flash`. So matching
uses an exact key derived from *either* the id or the `name`, with vendor prefixes
removed from ids and punctuation and spaces removed from names. Both spellings
produce the same key.

This is not fuzzy matching. Dated variants stay separate because their names
contain the date — `deepseek-v4-flash` and `deepseek-v4-flash-0731` never collide.
The full matched id is recorded with its prefix, so any match can be checked:

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

Each field is decided separately, by this order:

```text
1. a hand-written vendor card
2. the catalog belonging to the model's own vendor
3. a simple majority among catalogs that state the field   (only if step 2 is absent)
4. openrouter                                              (only if step 3 has no majority)
5. whatever is already written                             (only if no catalog states the field)
```

**The vendor's own catalog wins, and it is not one vote among many.** Many of
the catalogs Pi ships belong to *resellers* — companies that host other
companies' models. A reseller's catalog describes what one gateway happens to
accept. The vendor's own catalog describes the model itself. When they disagree,
the vendor is describing the thing and the reseller is describing one doorway to
it.

The case that forced this rule: for `deepseek-v4.1-flash`, eight catalogs state an
output ceiling of 384,000 tokens — DeepSeek's own first among them — while
openrouter alone says 943,718. The old rule published openrouter's number, and
this endpoint rejected it. The vendor's number is what gets published now.

**How the vendor is identified.** By the model's family name: `kimi` belongs to
Moonshot, `claude` to Anthropic, `gpt` to OpenAI, `glm` to zai, `deepseek` to
DeepSeek, `mimo` to Xiaomi, `nemotron` to NVIDIA. This cannot be worked out from
the files, because every catalog stamps its own name as the provider — including
a reseller stamping its name on a model it did not make. So the list is written
down explicitly, one line per family, exactly like the dated-model aliases.

**With no vendor catalog, the catalogs vote.** A model like `qwen3.8-max` has no
first-party catalog in Pi, so there the value most catalogs agree on is used. It
needs a *simple majority* of the catalogs that state the field at all: three votes
out of ten is a split, not agreement, and a split falls back to openrouter.
Nothing is averaged — an average of two real numbers is a third number that nobody
published.

**A ceiling that fills the whole window is treated as silence.** Some catalogs
write the row that way: Moonshot lists `kimi-k3` with a context window of
1,048,576 and an output ceiling of 1,048,576 — the same number twice. But the
prompt has to fit in the window alongside the output, so a ceiling that fills the
window cannot be served. That figure is treated as no answer at all, and the field
falls through to catalogs that state a ceiling a model can keep.

**A model is found by its written name as well as its id.** DeepSeek's catalog
lists the model as `id: "deepseek-flash"` but names it `"DeepSeek V4.1 Flash"`.
Once punctuation is removed, that written name and the endpoint's
`deepseek-v4.1-flash` produce the same key, which is how the vendor's own entry
becomes reachable without hardcoding an alias. It is an exact match on a different
field, not a similarity guess — which is what keeps it safe: `deepseek-v4-flash`
and `deepseek-v4-flash-0731` stay apart because the date appears in the name too,
and `glm-5.3` can never reach `glm-5.3-flash`.

### Claims and silence are resolved per key

The thinking levels a model accepts are not one value but seven independent ones
(`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Each is decided
separately.

If the vendor states a level — even `null`, meaning "not supported" — that answer
is final. If the vendor simply does not mention the level, that silence says
nothing, and only that one level is decided by the other catalogs. Two useful
consequences: a reseller listing only two levels cannot erase the five the vendor
declared, and a vendor listing only one level does not block the others from being
filled in.

**Two fields are never taken from a catalog at all.** `contextWindow` describes
what *this* endpoint serves, not what the model can do, so it belongs to the
endpoint. `cost` belongs to whoever charges it: a catalog's price is another
reseller's price, and combining several would produce a number OpenDesign may
never charge. The donor module can report an approximate minimum-to-maximum range
when asked directly, for inspection only — it is not published as a price.

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

These are listed because each one produced a symptom that pointed somewhere else.

**An error code is not a measurement.** The probe used to read every HTTP status
as the model's opinion. So an exhausted quota — `402`, `401`, `403`, `429`, any
`5xx`, any timeout — was recorded as "this model has no reasoning levels and a
small output ceiling". A failed request was being written down as a fact about the
model. The audit reported 25 false positives before the fix and zero after. Only
`400` and `422` count as a refusal of the request's shape; everything else means
"no answer".

**A `502` can really be a `400`.** This router forwards to other providers, so
when the provider behind it rejects a parameter, the reply arrives as
`502 "Inference provider returned HTTP 400"`. Judging by the outer status discarded
that measurement and lost the true ceiling on 12 of 14 models. The upstream status
inside the body is what counts now.

**A ceiling bigger than the window is impossible, not generous.** OpenRouter
listed `inkling` with a 471,859-token ceiling against a 262,144-token window here,
and the endpoint refused every request with *"This request needs about N tokens
(messages + tools + max_tokens)"*. It is clamped to the window minus a prompt
reserve — and it cannot be *equal* to the window either: 262,144 was rejected
while 261,120 passed.

**A catalog that omits a key has not claimed anything.** An explicit `null` is a
claim and is applied. A missing key is silence and erases nothing. That is why
thinking levels are merged level by level: without it, `kimi-k2.7-code` and both
`mimo-v2.6-*` lost working reasoning levels because of a gap in someone else's
catalog.

**`maxTokens` must never be `null`.** Pi's model list calls `.toString()` on it,
crashes with *"Cannot read properties of undefined"*, and takes the entire list
down with it.

**A scoped package publishes as private by default.** `npm publish` failed with
`E402 "You must sign up for private packages"`, which sounds like a billing
problem and is not one: private packages need a paid plan. Fixed by declaring
`"publishConfig": { "access": "public" }` in the manifest, so a bare `npm publish`
does the right thing.

## 🩺 Diagnose

When someone reports that models are missing, or that the numbers look wrong,
the useful question is not which plan they are on. It is this:

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

Four details worth reading:

- **`la extension usa`** is the path the extension itself resolved. If it says
  `NINGUNO`, no catalog was found, so every value came from what was already
  written. Without this line printed, that looks exactly the same as "the
  catalogs are broken" — which is why it is here.
- **`faltantes`** lists models your key can use but the extension is not
  publishing. A non-empty line means the endpoint serves models that still have
  to be added by hand.
- **Where the catalog came from.** The primary path is discovered from the Pi
  installation that is actually running. It differs across operating systems,
  prefixes, install methods and launchers — it is not fixed to one device.
- **What the fallbacks did.** If the active Pi package is not found, the
  agent-local store and flat-install layouts are searched instead. The store is
  searched in the running agent directory **and its siblings**, so a wrapper that
  relocates the agent directory still resolves. Note that store entries sit
  directly under the store root rather than inside a nested `node_modules`, and
  the fallback walk accounts for that.

### Runtime discovery, with fallbacks

The bridge first discovers the `pi-ai` catalogs belonging to the active Pi
installation. For example, a global npm installation may place them at:

```
<active Pi package>/node_modules/@earendil-works/pi-ai/dist/providers/data
```

That is a layout, not a hardcoded path: Termux, Windows, a local install, a
custom prefix, or another package manager may place Pi elsewhere. If the active
package is not found, the bridge searches the agent-local pnpm store and flat
install layout as fallbacks. The directory actually found is reported by the
diagnose script.

The two scan results are printed separately on purpose. The first is what the
extension actually resolved; the second is what a wider search could have found.
When the two differ, the extension is missing a catalog it could have used.

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

Every published model carries a `provenance` block, so you never have to guess
whether a number was measured, or merely claimed:

| `provenance` | Meaning |
|---|---|
| `curated` | Hand-verified in `models.json` / `STATIC_MODELS`. Wins over everything. |
| `measured` | A real probe request against the endpoint. Only `maxTokens`, the effort levels and `reasoning` qualify. |
| `gateway` | The endpoint **declared** it. `contextWindow` and `input` are always at best this. |
| `vanilla` | The conservative fallback. Used only when the probe could not run. |

`contextWindow` is never measured, and deliberately so: an over-long prompt is
silently truncated, which looks exactly like success. Treat it as a claim and
check it against vendor documentation before trusting it.

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
