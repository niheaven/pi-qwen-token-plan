# pi-qwen-token-plan

Qwen Token Plan provider for [pi](https://github.com/earendil-works/pi).

It works with the personal and team Token Plan subscriptions, in both the China and
international regions, and adds what the plan offers beyond plain chat: provider-hosted
web tools, quota reporting, image/video generation, speech, vision, structured output and
prompt caching.

The extension overrides pi's own Qwen Token Plan provider ids instead of inventing new
ones, so an existing credential keeps working:

| Provider id                     | Plan       | Region        |
| ------------------------------- | ---------- | ------------- |
| `qwen-token-plan-cn`            | team       | China         |
| `qwen-token-plan`               | team       | International |
| `qwen-token-plan-individual-cn` | individual | China         |
| `qwen-token-plan-individual`    | individual | International |

## Requirements

- pi with extension-provider support
- Node.js 24 or newer
- A Qwen Token Plan subscription and its `sk-sp-...` key

## Install

```bash
pi install git:github.com/niheaven/pi-qwen-token-plan
```

Run a checkout without installing it:

```bash
pi -ne -e ./extensions/index.ts --model qwen-token-plan-cn/qwen3.8-flash
```

## Login

```text
/login qwen-token-plan
```

There is one login entry, `Qwen Token Plan`. The flow asks two things - **Team or
Individual**, then **China or International** - reads the `sk-sp-...` key, and validates it
against that host. The chosen plan and region decide which of pi's provider ids owns the
account (`qwen-token-plan-cn`, `qwen-token-plan`, `qwen-token-plan-individual-cn` or
`qwen-token-plan-individual`).

The credential is stored in pi's own `~/.pi/agent/auth.json` as an `api_key` entry under
that id, written the way pi writes it: a `proper-lockfile` lock on the resolved file, a
read-modify-write of the whole store, `0600`, two-space JSON. The other Qwen ids are
dropped in the same write, and a startup pass prunes any credential pi wrote for a
different id, so exactly one Qwen provider is ever configured. On every start the same key
is also published into the id's own `QWEN_TOKEN_PLAN_*` variable, which is how pi resolves
it for the request.

Without logging in, a key can come from the matching env key
(`QWEN_TOKEN_PLAN_TEAM_CN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY`,
`QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY`, `QWEN_TOKEN_PLAN_TEAM_API_KEY`,
`QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY`), or `DASHSCOPE_API_KEY` for the media tools only.

Quota is not part of the login: it is read from the Bailian console, so it needs a console
login through [bailian-cli](https://github.com/modelstudioai/cli)
(`bl auth login --console`) or an AK/SK pair - see [docs/quota.md](docs/quota.md).

The first start fetches `GET /compatible-mode/v1/models` and stores the catalog in pi's
model store; later starts restore it before any network call.

## Models

Which models exist depends on the subscription and region - the live catalog decides. The
extension routes each id to a wire:

- **OpenAI Responses:** `qwen*`, `deepseek*`, `glm-5.2`, `glm-5.3`, `kimi-k3*`, `auto`
- **Anthropic Messages:** `glm-5`, `glm-5.1`, `kimi-k2.*`, `MiniMax-*`
- **Image generation:** `qwen-image-*`, `wan2.7-image*`

See [docs/models.md](docs/models.md) for routing rules, thinking levels, the `auto` probe
results and catalog caching.

## Tools

Local tools: `web_fetch`, `qwen_json`, `qwen_vision_describe`, `qwen_image_generate`,
`qwen_video_generate`, `qwen_text_to_speech`, `qwen_speech_to_text`.

Provider-hosted tools (`web_search`, `web_extractor`, `code_interpreter`,
`web_search_image`, `image_search`) are declared per model family and run server-side.

See [docs/tools.md](docs/tools.md) for the support matrix, parameters and defaults.

## Commands

| Command                | Purpose                            |
| ---------------------- | ---------------------------------- |
| `/qwen-quota`          | Detailed quota report              |
| `/qwen-quota refresh`  | Bypass the quota cache             |
| `/qwen-settings`       | Interactive settings               |
| `/qwen-cache [5m\|1h]` | Set the qwen4 prompt-cache TTL     |
| `/qwen-tokens`         | Context estimate and last response |

Quota sources, windows and the footer format are described in
[docs/quota.md](docs/quota.md). Quota is read from the Bailian console, so it needs a
console token or an AK/SK pair; the `sk-sp-...` inference key cannot query quota.

## Settings

`/qwen-settings` edits `~/.pi/agent/qwen-token-plan-config.json` without a restart. It
covers the quota footer, hosted and local tool switches, image/video defaults
(`Image model`, `Image size`, `Video model`, `Video resolution`), the qwen4 prompt-cache
TTL and the catalog sync interval. Unknown keys in the file are preserved.

## Configuration

| Variable                                                                                                 | Meaning                                                                            |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `QWEN_HOSTED_TOOLS`                                                                                      | `off` / `0` / `false` disables Responses hosted tools                              |
| `QWEN_PROMPT_CACHE`                                                                                      | `5m` / `1h` qwen4 prompt-cache TTL                                                 |
| `QWEN_PROVIDER`                                                                                          | Default provider id when several credentials are stored                            |
| `QWEN_TOKEN_PLAN_TEAM_CN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY`, `QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY` | Official Qwen Token Plan CN env keys; used when no `/login` credential is stored   |
| `QWEN_TOKEN_PLAN_TEAM_API_KEY`, `QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY`                                     | International counterparts of the keys above                                       |
| `DASHSCOPE_API_KEY`                                                                                      | Key for the media tools only (same name and meaning as in bailian-cli)             |
| `BAILIAN_CONFIG_DIR`                                                                                     | Directory holding `config.json`, default `~/.bailian` (bailian-cli's own variable) |
| `BAILIAN_ACCESS_KEY_ID`, `BAILIAN_ACCESS_KEY_SECRET`, `BAILIAN_SECURITY_TOKEN`                           | AK/SK for token minting and seats                                                  |
| `ALIBABA_CLOUD_ACCESS_KEY_ID`, `ALIBABA_CLOUD_ACCESS_KEY_SECRET`, `ALIBABA_CLOUD_SECURITY_TOKEN`         | AK/SK fallback                                                                     |
| `PI_CODING_AGENT_DIR`                                                                                    | pi agent directory (default `~/.pi/agent`)                                         |

## Limitations

- Realtime voice (`qwen-audio-3.0-realtime-plus`) is not integrated; it needs a
  long-lived WebSocket plus microphone and speaker access.
- The decision model (`decision-model-preview`) is offered on the personal plan only and
  is not integrated.
- Video editing models are not exposed as tools.
- Prefix continuation (`partial: true`) is a Chat Completions feature; none of the wires
  this provider uses accept it.
- Manual prompt-cache breakpoints are not used; qwen4 relies on automatic breakpoints.

## Development

```bash
npm ci
npm run check     # biome
npm run typecheck # tsc --noEmit
npm test          # node --test
```

Wire-level details live in [docs/protocol.md](docs/protocol.md).

## License

MIT. See [LICENSE](LICENSE).
