# Tools

Two kinds of tool exist here: local tools the extension registers with pi, and
provider-hosted tools the model executes server-side.

## Provider-hosted tools

These have no local handler. They are declared in the Responses `tools` array and run on
the provider. A model that does not support a tool rejects the whole request, so
`src/hosted.ts` never over-declares: support is matched by model family, following the
plan's own documentation.

Web tools (`web_search`, and `web_extractor` which must travel with it):

- supported: `qwen4-*`, `qwen3.5-3.8` except `omni`, `deepseek-v4-pro`, `deepseek-v4-pro-0813`,
  `deepseek-v4-flash-0731`, `deepseek-v4.1-flash-1017`, `glm-5.2`, `kimi-k3*`, `auto`
- not supported: `glm-5.3`, `deepseek-v4.1-flash` (the non-`1017` id), `glm-5`, `glm-5.1`,
  `kimi-k2.*`, `MiniMax-*`

`code_interpreter` is narrower: no `glm-*`, no `deepseek-v4-pro`/`-0813`, no
`deepseek-v4.1-flash`; `qwen3.6-27b` is excluded explicitly.

Image tools (`web_search_image`, and `image_search` which additionally needs an image in
the request) are limited to `auto`, `qwen4-max`, `qwen3.8-max`/`flash`, `qwen3.7-plus` and
`qwen3.6-plus`/`flash`. `qwen3.7-max` only gained them in its `2026-06-08` snapshot.

`auto` was probed directly: all five hosted tools fire on it, so it gets the full set.

Declarations are appended after pi's function tools in a fixed order so the cached prefix
stays stable. `QWEN_HOSTED_TOOLS=off|0|false` disables them at startup; the `Hosted tools`
setting toggles them at runtime.

### Search sources

Sources arrive in two places: `web_search_call.action.sources` (the Responses shape) and
`message.content[].annotations`. pi's Responses parser drops both, so the extension
collects them while streaming and appends up to six links (at most two per host) to the
finished message under `Sources:`. If the model already wrote its own link list, the
append is skipped so the answer is not duplicated.

### Anthropic server tools

On the Anthropic wire, models on the plan's server-tool list get `web_search_20250305`
and, where documented, `web_fetch_20250910`, plus the marker the endpoint requires:

```text
x-anthropic-billing-header: cc_entrypoint=cli;
```

`web_fetch` is only injected together with `web_search`. Models absent from the list get
no provider-side search; the local `web_fetch` tool still works for every model.

## Local tools

### `web_fetch`

pi has no built-in `web_fetch`. The extension bridges the hosted `web_extractor` through
a minimal non-streaming Responses request that declares `web_search` + `web_extractor`
together, because the extractor is rejected on its own.

```text
web_fetch({ url, prompt?, maxChars?, model? })
```

`url` must be `http(s)`, `maxChars` defaults to 20000, `model` to `qwen3.8-flash`. The
result is the extractor's rendition of the page, not raw HTML. The request carries the pi
session id as `x-session-id` and `prompt_cache_key`, which the service requires for a
stable conversation identity.

### `qwen_json`

Structured output uses the Responses `text.format` field, which pi's model layer never
sets. This tool sends its own one-shot request:

```text
qwen_json({ prompt, schema?, model?, maxTokens? })
```

Pass `schema` as a JSON string for strict `json_schema` output; omit it for `json_object`.
It does not see the conversation.

### `qwen_vision_describe`

```text
qwen_vision_describe({ image?, pdf?, prompt?, model? })
```

`image` is a local file, `pdf` a local PDF sent as Responses `input_file` with a base64
data URI. PDF input is documented for `qwen4-max` and the `qwen3.8` max/flash families
only. Default model is `qwen3.8-flash`.

### `qwen_image_generate`

```text
qwen_image_generate({ prompt, model?, size?, n?, image?, images?, negativePrompt?, seed?, promptExtendMode?, watermark? })
```

- Default model `qwen-image-3.0-pro`; also `qwen-image-2.0-pro`, `qwen-image-2.0`,
  `wan2.7-image-pro`, `wan2.7-image`.
- `image` and `images` are reference or edit inputs; the 3.0 family takes up to 3, the 2.1
  family up to 10.
- `size` accepts `W*H` or `auto`. `n` is 1-4.
- `negativePrompt` is qwen-image-3.0-only.
- `promptExtendMode` accepts `direct` or `agent`; `agent` is text-to-image only and is
  dropped when reference images are present, because the API rejects it for editing.
- `size` falls back to the `Image size` setting; `auto` sends nothing.

Output is saved under `~/.pi/agent/qwen-token-plan-media/` and also returned to the model
as an image block.

### `qwen_video_generate`

```text
qwen_video_generate({ prompt, model?, image?, references?, duration?, resolution?, ratio?, seed?, watermark? })
```

- Families: `happyhorse` (`happyhorse-1.1-t2v`, `-i2v`, `-r2v`) or `wan`
  (`wan3.0-video`). The mode is inferred: reference images -> r2v, first frame -> i2v,
  otherwise t2v.
- `duration` is 3-15 seconds; `ratio` examples `16:9`, `9:16`, `1:1`; up to 9 reference
  images.
- `resolution` falls back to the `Video resolution` setting; `auto` sends nothing and the
  provider default (1080P) applies.

Video is an async task: the tool submits, polls `/api/v1/tasks/{id}`, then downloads the
file to the media directory and returns its path plus the source URL.

### Speech tools

`qwen_text_to_speech` (`qwen-audio-3.0-tts-plus`, voices such as `longanhuan_v3.6`,
formats mp3/wav/opus/pcm) and `qwen_speech_to_text` (`qwen-audio-3.0-asr-flash`, local
file or public URL, optional `format`, `sampleRate`, `languageHints`). Both are gated by
the `Speech tools` setting; vision and image/video generation have their own toggles.
