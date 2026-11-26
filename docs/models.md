# Models

## Endpoints

Two Token Plan hosts are supported, one per region:

- China: `https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1`
- International: `https://token-plan.maas.qwencloudapi.com/compatible-mode/v1`

The Anthropic-compatible sibling is the same host with `/compatible-mode/v1` replaced by
`/apps/anthropic`. Each host has its own provider id, and the base URL travels with that
provider's credential, so a login and the models it exposes cannot disagree.

| Provider id                     | Region        |
| ------------------------------- | ------------- |
| `qwen-token-plan-cn`            | China         |
| `qwen-token-plan`               | International |
| `qwen-token-plan-individual-cn` | China         |
| `qwen-token-plan-individual`    | International |

## Plan coverage

The extension does not hardcode a plan. Which ids exist is decided by
`GET /compatible-mode/v1/models`, and the answer differs per subscription: the personal
plan carries the decision model and the individual key set, while the team plan adds
`kimi-k2.*`, `glm-5`/`glm-5.1`, `MiniMax-M2.5` and the `happyhorse` video family. Routing
rules below are written for the union, so any of them resolves correctly whatever the
catalog contains.

## Wire routing

`src/models.ts` decides the wire from the model id alone:

- `openai-responses`: `^(qwen|deepseek)`, `glm-5.2` and newer, `kimi-k3*`, and `auto`
- `anthropic-messages`: `glm-5`, `glm-5.1`, `kimi-k2.*`, `MiniMax-*`
- `qwen-images`: `^qwen-image`, `^wan2.7-image`, `^wan2.6-image`, `^z-image`, excluding
  `*edit*`

Ids containing `image`, `audio`, `video`, `tts`, `asr`, `embed`, `rerank`, `wan`, `omni`,
`livetranslate` or `realtime` are never treated as chat models.

`glm-5` and `glm-5.1` are agent-disabled on `/responses` (`Agent capabilities are not
enabled for the current model`), which is why they - and the `kimi-k2` / `MiniMax` group -
use the Anthropic wire instead.

## Metadata

Model metadata is layered:

1. pi's built-in Qwen catalogs supply name, context window, max output and thinking
   levels when the id is known there.
2. The `KNOWN` table in `src/models.ts` covers ids those catalogs do not have.
3. Anything still unknown falls back to 1M context, 65k output and the full thinking
   scale.

The extension registers all four native provider ids above with this catalog, so the
picker shows one Qwen catalog per region rather than a mix of wires. Ids with no stored
credential list no models until one is added; the catalog and its wire come from the same
fetch, so a region can never serve another region's models.

## Thinking levels

pi's levels are mapped per model family. A `null` value means "not offered"; `off: null`
means no `reasoning` field is sent at all, so the provider default applies.

- `qwen4-max`: `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, default `high`;
  `minimal`/`low` collapse to `low`, `medium`/`high` to `high`, `xhigh`/`max` to `xhigh`
- `qwen3.8-*`: `none`/`low`/`medium`/`xhigh`, default `xhigh`; `minimal` -> `low`,
  `high`/`max` -> `xhigh`
- `deepseek-v4-flash`, `deepseek-v4-pro-0813`: `none`/`low`/`high`/`max`, default `high`
- `deepseek-v4.1-flash*`: `none`/`low`/`high`/`max`, default `high`; `medium`/`xhigh`
  map to `high`
- `deepseek-v4-pro`: `none`/`high`/`max`, default `high`
- `glm-5.3`: `low`/`high`/`max`, default `max`, no off
- `glm-5.2`: `none`/`high`/`max`, default `high`

## `auto`

`auto` is the router model. Probed against the live endpoint:

- answers `/responses` and accepts `max_output_tokens` up to 262144
- accepts function tools, and all five hosted tools
- accepts image input
- accepts `text.format` with `json_object` and `json_schema`
- **always thinks**: `reasoning.effort: "none"` fails with `The value of the
  enable_thinking parameter is restricted to True`

Its `off` level is therefore `null`, so pi never sends `none`, and reasoning cannot be
disabled on that model.

## Catalog

`GET /compatible-mode/v1/models` is the source of truth for ids. The result is stored in
pi's model store (`~/.pi/agent/models-store.json`, key = the provider id, shape
`{ models, checkedAt }`) through `context.publish({ persist })`, so each region keeps its
own catalog.

Only the id that owns the account keeps a catalog. `/login` writes the key into pi's
`auth.json` under the id the plan and region resolved to, and each start publishes it into
that id's own `QWEN_TOKEN_PLAN_*` variable, which is where pi resolves provider keys from.
Every other Qwen id is registered with no models, and a startup pass drops any duplicate
credential, so a stale entry cannot resurrect a second catalog.

- Cached until `modelSyncHours` expires (default 6h; `0` refreshes on every start).
- A malformed snapshot (any model missing `id` or `api`) is discarded and refetched; a
  network failure keeps the last known catalog.
- `/qwen-settings` -> **Sync models now** and `pi update --models` force a refresh.
