# Wire notes

What the extension adds to, or deliberately leaves out of, each request.

## Responses

Every request keeps pi's normal shape and adds:

- **hosted tools** in `tools`, appended after pi's function tools in a stable order
  (see [tools.md](tools.md))
- **`prompt_cache_options`** on `qwen4` ids only: `{ mode: "implicit", ttl }`, where `ttl`
  is `5m` (default) or `1h`. `implicit` places the breakpoint at the end of the last input
  message. Other models never receive the field.
- **`x-dashscope-session-cache: enable`** as a header on every request; the plan defaults
  it to `disable`, and enabling it is what gives multi-turn calls a server-side cache.
- **`reasoning`** when a thinking level is selected, plus
  `include: ["reasoning.encrypted_content"]`. pi stores the reasoning item, encrypted
  content included, in the message's `thinkingSignature` and replays it next turn, which
  is how `qwen4` restores earlier thinking.
- **`store: false`** always: the extension never relies on server-side conversation state.

Deliberately unused:

- `previous_response_id` and `conversation` - pi replays the transcript itself, which keeps
  forks and compaction honest.
- `background` - the endpoint is synchronous.
- `search_options` (`forced_search`, `search_strategy`, freshness, site limits) - Chat
  Completions only; Responses silently ignores them. Agent-style retrieval on Responses
  comes from declaring `web_search` instead.
- `partial` (prefix continuation) - Chat Completions only, so it is unavailable on every
  wire this provider uses.
- `prompt_cache_breakpoint` - manual breakpoints on content blocks; the automatic
  breakpoint covers the usual case.

Note that the Responses input context is about 80% of the model window: roughly 20% is
reserved for hosted tools and reasoning, and excess input is truncated rather than
rejected.

### Text format

`text.format` accepts `{ type: "text" }`, `{ type: "json_object" }` and
`{ type: "json_schema", json_schema: { name, schema, strict } }`. pi's model layer has no
way to ask for it, so it is only reachable through the `qwen_json` tool
(see [tools.md](tools.md)).

## Anthropic Messages

Chat-only models use the plan's Anthropic-compatible endpoint. On top of pi's normal
request:

- `web_search_20250305` is injected for models on the documented server-tool list, and
  `web_fetch_20250910` for the subset that supports it - never without `web_search`.
- A `system` block carrying `x-anthropic-billing-header: cc_entrypoint=cli;` is prepended
  when missing. Without it the server does not run the search tools.
- pi's ephemeral `cache_control` markers are kept, but markers on tool schemas and 1h
  retention are disabled: the plan documents explicit caching only for `qwen4` content
  blocks.

`max_tokens` semantics differ per model - for `qwen4`, `deepseek-v4*` and the `qwen3.8`
max/flash families it caps reply plus thinking; for others it caps the reply and thinking
is bounded separately.

## Local bridges

The tools that cannot ride pi's model layer (`web_fetch`, `qwen_json`,
`qwen_vision_describe`) post their own Responses request. They carry
`x-session-id` / `prompt_cache_key` from the pi session, because the service wants a stable
conversation identity for cache affinity and rejects requests without one on some paths.

## Media endpoints

Image, video, TTS and ASR use the DashScope-compatible routes on the same host:

- image: `POST /api/v1/services/aigc/multimodal-generation/generation`
- video: `POST /api/v1/services/aigc/video-generation/video-synthesis`, then
  `GET /api/v1/tasks/{task_id}` (the id lives 24 hours)
- TTS: `POST /api/v1/services/audio/tts/SpeechSynthesizer`
- ASR: `POST /api/v1/services/aigc/multimodal-generation/generation` with an
  `input_audio` content part

Generated URLs expire, so every media tool downloads the result immediately and reports a
local path.
