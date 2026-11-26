import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_SETTINGS, type QwenSettings } from "./config.ts";
import { asObject, type JsonObject } from "./json.ts";
import {
    audioFromFile,
    describeImage,
    generateImage,
    generateSpeech,
    generateVideo,
    imageFromFile,
    pdfFromFile,
    saveMedia,
    transcribeAudio,
} from "./media.ts";
import {
    IMAGE_MODELS,
    resolveVideoSelection,
    VIDEO_FAMILIES,
} from "./media-models.ts";
import { structuredJson } from "./structured.ts";
import { webFetch } from "./webfetch.ts";

export type ToolHost = {
    getSettings(): QwenSettings;
    activeKey(): string | undefined;
    mediaRoot(): string;
    baseUrl(): string;
};

type ImageParams = {
    prompt: string;
    model?: string;
    size?: string;
    n?: number;
    image?: string;
    images?: string[];
    negativePrompt?: string;
    seed?: number;
    promptExtendMode?: string;
    watermark?: boolean;
};

async function imageRequest(
    host: ToolHost,
    apiKey: string,
    params: ImageParams,
    signal: AbortSignal | undefined,
): Promise<{
    saved: string[];
    images: { data: string; mimeType: string }[];
    model: string;
    requestId?: string;
}> {
    const settings = host.getSettings();
    const model = params.model || settings.imageModel;
    const paths = [
        ...(params.image ? [params.image] : []),
        ...(params.images ?? []),
    ];
    const inputImages = paths.map((path) => imageFromFile(path).block);
    const wanted =
        params.size && params.size !== "auto"
            ? params.size
            : settings.imageSize;
    const size = wanted === "auto" ? undefined : wanted;
    const mode = params.promptExtendMode;
    const result = await generateImage({
        root: host.mediaRoot(),
        apiKey,
        model,
        prompt: params.prompt,
        images: inputImages,
        ...(size ? { size } : {}),
        ...(params.n ? { n: params.n } : {}),
        ...(params.negativePrompt
            ? { negativePrompt: params.negativePrompt }
            : {}),
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        ...(mode === "agent" || mode === "direct"
            ? { promptExtendMode: mode }
            : {}),
        ...(params.watermark === undefined
            ? {}
            : { watermark: params.watermark }),
        signal,
    });
    const saved = result.images.map((image, index) =>
        saveMedia(image.data, image.mimeType, `image-${index + 1}`),
    );
    return { saved, images: result.images, model, requestId: result.requestId };
}

// pi-lens-ignore: high-complexity, high-fan-out -- six tools are a flat registration table
export function registerTools(pi: ExtensionAPI, host: ToolHost): void {
    function toolError(message: string) {
        return {
            content: [{ type: "text" as const, text: message }],
            details: {},
            isError: true,
        };
    }

    pi.registerTool({
        name: "web_fetch",
        label: "Web Fetch",
        description:
            "Fetch a URL through Qwen's server-side web_extractor (needs web_search alongside it) and return the extracted main text.",
        promptSnippet: "Fetch a URL with Qwen's server-side web_extractor",
        parameters: Type.Object({
            url: Type.String({ description: "http(s) URL" }),
            prompt: Type.Optional(
                Type.String({
                    description: "What to extract (default: main text)",
                }),
            ),
            maxChars: Type.Optional(
                Type.Number({
                    description: "Maximum characters (default 20000)",
                    minimum: 200,
                    maximum: 100000,
                }),
            ),
            model: Type.Optional(
                Type.String({
                    description:
                        "Model driving the extractor (default qwen3.8-flash)",
                }),
            ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (!host.getSettings().webFetch)
                return toolError("web_fetch is disabled in /qwen-settings.");
            const apiKey = host.activeKey();
            if (!apiKey)
                return toolError(
                    "No Qwen credential. Run /login qwen-token-plan.",
                );
            try {
                const result = await webFetch({
                    baseUrl: host.baseUrl(),
                    apiKey,
                    url: params.url,
                    ...(params.prompt ? { prompt: params.prompt } : {}),
                    ...(params.maxChars ? { maxChars: params.maxChars } : {}),
                    ...(params.model ? { model: params.model } : {}),
                    sessionId: ctx.sessionManager.getSessionId(),
                    signal,
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `${result.text}\n\nSource: ${result.url}`,
                        },
                    ],
                    details: {
                        url: result.url,
                        requestId: result.requestId,
                        model: result.model,
                    },
                };
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    });

    pi.registerTool({
        name: "qwen_text_to_speech",
        label: "Qwen TTS",
        description:
            "Synthesize speech with Qwen Token Plan (qwen-audio-3.0-tts-plus), save the audio file and return its path.",
        promptSnippet: "Synthesize speech with Qwen Token Plan",
        parameters: Type.Object({
            text: Type.String({ description: "Text to speak" }),
            voice: Type.Optional(
                Type.String({
                    description: "Voice id (default longanhuan_v3.6)",
                }),
            ),
            format: Type.Optional(
                Type.String({
                    description: "mp3, wav, opus or pcm (default mp3)",
                }),
            ),
            sampleRate: Type.Optional(
                Type.Number({ description: "Sample rate (default 22050)" }),
            ),
            model: Type.Optional(
                Type.String({
                    description: "TTS model (default qwen-audio-3.0-tts-plus)",
                }),
            ),
        }),
        async execute(_toolCallId, params, signal) {
            if (!host.getSettings().speech)
                return toolError(
                    "Speech tools are disabled in /qwen-settings.",
                );
            const apiKey = host.activeKey();
            if (!apiKey)
                return toolError(
                    "No Qwen credential. Run /login qwen-token-plan.",
                );
            try {
                const result = await generateSpeech({
                    root: host.mediaRoot(),
                    apiKey,
                    text: params.text,
                    ...(params.voice ? { voice: params.voice } : {}),
                    ...(params.format ? { format: params.format } : {}),
                    ...(params.sampleRate
                        ? { sampleRate: params.sampleRate }
                        : {}),
                    ...(params.model ? { model: params.model } : {}),
                    signal,
                });
                const path = saveMedia(result.data, result.mimeType, "speech");
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Audio saved to ${path}`,
                        },
                    ],
                    details: { path, sourceUrl: result.url },
                };
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    });

    pi.registerTool({
        name: "qwen_speech_to_text",
        label: "Qwen ASR",
        description:
            "Transcribe a local audio file or public audio URL with qwen-audio-3.0-asr-flash and return the text.",
        promptSnippet: "Transcribe audio with Qwen Token Plan",
        parameters: Type.Object({
            source: Type.String({
                description: "Local audio path or public http(s) URL",
            }),
            format: Type.Optional(
                Type.String({
                    description:
                        "Audio format; inferred from the file/URL when omitted",
                }),
            ),
            languageHints: Type.Optional(
                Type.Array(Type.String(), {
                    description: 'Language hints, at most 4, e.g. ["zh"]',
                }),
            ),
            sampleRate: Type.Optional(
                Type.Number({ description: "Sample rate, e.g. 16000" }),
            ),
            model: Type.Optional(
                Type.String({
                    description: "ASR model (default qwen-audio-3.0-asr-flash)",
                }),
            ),
        }),
        async execute(_toolCallId, params, signal) {
            if (!host.getSettings().speech)
                return toolError(
                    "Speech tools are disabled in /qwen-settings.",
                );
            const apiKey = host.activeKey();
            if (!apiKey)
                return toolError(
                    "No Qwen credential. Run /login qwen-token-plan.",
                );
            try {
                const remote = /^https?:\/\//i.test(params.source);
                const local = remote ? undefined : audioFromFile(params.source);
                const format =
                    params.format ||
                    local?.format ||
                    (new URL(params.source).pathname.match(
                        /\.([a-z0-9]+)$/i,
                    )?.[1] ??
                        "mp3");
                const result = await transcribeAudio({
                    root: host.mediaRoot(),
                    apiKey,
                    audio: local?.dataUri ?? params.source,
                    format,
                    ...(params.languageHints
                        ? { languageHints: params.languageHints }
                        : {}),
                    ...(params.sampleRate
                        ? { sampleRate: params.sampleRate }
                        : {}),
                    ...(params.model ? { model: params.model } : {}),
                    signal,
                });
                return {
                    content: [{ type: "text" as const, text: result.text }],
                    details: {
                        format,
                        duration: result.duration,
                        sentence: result.sentence,
                    },
                };
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    });

    pi.registerTool({
        name: "qwen_vision_describe",
        label: "Qwen Vision",
        description:
            "Describe a local image with a vision-capable Qwen model (default qwen3.8-flash). Useful when the active chat model is text-only.",
        promptSnippet: "Describe an image with a Qwen vision model",
        parameters: Type.Object({
            image: Type.Optional(
                Type.String({ description: "Local image path" }),
            ),
            pdf: Type.Optional(
                Type.String({
                    description:
                        "Local PDF path (qwen4-max and qwen3.8 max/flash only)",
                }),
            ),
            prompt: Type.Optional(
                Type.String({ description: "What to ask about the input" }),
            ),
            model: Type.Optional(
                Type.String({
                    description: "Vision model (default qwen3.8-flash)",
                }),
            ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            if (!host.getSettings().vision)
                return toolError("Vision tool is disabled in /qwen-settings.");
            const apiKey = host.activeKey();
            if (!apiKey)
                return toolError(
                    "No Qwen credential. Run /login qwen-token-plan.",
                );
            if (!params.image && !params.pdf)
                return toolError("Pass either image or pdf.");
            try {
                const image = params.image
                    ? imageFromFile(params.image).block
                    : undefined;
                const pdf = params.pdf ? pdfFromFile(params.pdf) : undefined;
                const result = await describeImage({
                    baseUrl: host.baseUrl(),
                    apiKey,
                    ...(image ? { image } : {}),
                    ...(pdf ? { pdf } : {}),
                    ...(params.prompt ? { prompt: params.prompt } : {}),
                    ...(params.model ? { model: params.model } : {}),
                    sessionId: ctx.sessionManager.getSessionId(),
                    signal,
                });
                return {
                    content: [{ type: "text" as const, text: result.text }],
                    details: { model: result.model },
                };
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    });

    pi.registerTool({
        name: "qwen_image_generate",
        label: "Qwen Image",
        description:
            "Generate or edit an image with Qwen Token Plan (qwen-image / wan2.7-image). Saves the result and returns the file path plus the image.",
        promptSnippet: "Generate an image with Qwen Token Plan",
        parameters: Type.Object({
            prompt: Type.String({ description: "Image description" }),
            model: Type.Optional(
                Type.String({
                    description: `Image model: ${IMAGE_MODELS.join(", ")} (default ${DEFAULT_SETTINGS.imageModel})`,
                }),
            ),
            size: Type.Optional(
                Type.String({
                    description: `Image size, e.g. 1328*1328 or auto (default ${DEFAULT_SETTINGS.imageSize})`,
                }),
            ),
            n: Type.Optional(
                Type.Number({
                    description: "Number of images (1-4)",
                    minimum: 1,
                    maximum: 4,
                }),
            ),
            image: Type.Optional(
                Type.String({
                    description:
                        "Optional local input image path for editing/reference",
                }),
            ),
            images: Type.Optional(
                Type.Array(Type.String(), {
                    description:
                        "Optional local input image paths (qwen-image-3.0 takes up to 3, 2.1 up to 10); used together with image",
                }),
            ),
            negativePrompt: Type.Optional(
                Type.String({
                    description:
                        "What to avoid in the image (qwen-image-3.0 family only)",
                }),
            ),
            seed: Type.Optional(
                Type.Number({ description: "Optional random seed" }),
            ),
            promptExtendMode: Type.Optional(
                Type.String({
                    description:
                        "direct (default) or agent; agent is text-to-image only",
                }),
            ),
            watermark: Type.Optional(
                Type.Boolean({ description: "Add watermark (default false)" }),
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate) {
            if (!host.getSettings().imageGeneration)
                return toolError(
                    "Image generation is disabled in /qwen-settings.",
                );
            const apiKey = host.activeKey();
            if (!apiKey)
                return toolError(
                    "No Qwen credential. Run /login qwen-token-plan.",
                );
            try {
                onUpdate?.({
                    content: [{ type: "text", text: "Generating image…" }],
                    details: {},
                });
                const { saved, images, model, requestId } = await imageRequest(
                    host,
                    apiKey,
                    params,
                    signal,
                );
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Generated ${saved.length} image(s):\n${saved.map((path) => `- ${path}`).join("\n")}`,
                        },
                        ...images.map((image) => ({
                            type: "image" as const,
                            data: image.data,
                            mimeType: image.mimeType,
                        })),
                    ],
                    details: { paths: saved, requestId, model },
                };
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    });

    pi.registerTool({
        name: "qwen_video_generate",
        label: "Qwen Video",
        description:
            "Generate a video with Qwen Token Plan. Choose happyhorse or wan; t2v/i2v/r2v is picked automatically from the supplied image or reference images.",
        promptSnippet: "Generate a video with Qwen Token Plan",
        parameters: Type.Object({
            prompt: Type.String({ description: "Video description" }),
            model: Type.Optional(
                Type.String({
                    description: `Video family: ${VIDEO_FAMILIES.join(" or ")} (default ${DEFAULT_SETTINGS.videoModel})`,
                }),
            ),
            image: Type.Optional(
                Type.String({
                    description: "Optional local first-frame image path (i2v)",
                }),
            ),
            references: Type.Optional(
                Type.Array(Type.String(), {
                    description:
                        "Optional reference image paths (1-9, r2v; takes precedence over image)",
                }),
            ),
            duration: Type.Optional(
                Type.Number({
                    description: "Duration in seconds (default 5)",
                    minimum: 3,
                    maximum: 15,
                }),
            ),
            resolution: Type.Optional(
                Type.String({
                    description: `480P, 720P or 1080P (default ${DEFAULT_SETTINGS.videoResolution})`,
                }),
            ),
            ratio: Type.Optional(
                Type.String({
                    description: "Aspect ratio, e.g. 16:9, 9:16, 1:1",
                }),
            ),
            seed: Type.Optional(
                Type.Number({ description: "Optional random seed" }),
            ),
            watermark: Type.Optional(
                Type.Boolean({ description: "Add watermark (default false)" }),
            ),
        }),
        async execute(_toolCallId, params, signal, onUpdate) {
            if (!host.getSettings().videoGeneration)
                return toolError(
                    "Video generation is disabled in /qwen-settings.",
                );
            const apiKey = host.activeKey();
            if (!apiKey)
                return toolError(
                    "No Qwen credential. Run /login qwen-token-plan.",
                );
            try {
                const references = (params.references ?? []).map(
                    (path) => imageFromFile(path).block,
                );
                if (references.length > 9)
                    return toolError(
                        "At most 9 reference images are supported.",
                    );
                const selection = resolveVideoSelection({
                    family: params.model || host.getSettings().videoModel,
                    hasImage: Boolean(params.image),
                    referenceCount: references.length,
                });
                onUpdate?.({
                    content: [
                        {
                            type: "text",
                            text: `Submitting ${selection.model} (${selection.mode})…`,
                        },
                    ],
                    details: {},
                });
                const settings = host.getSettings();
                let resolution = params.resolution;
                if (!resolution || resolution === "auto") {
                    resolution =
                        settings.videoResolution === "auto"
                            ? undefined
                            : settings.videoResolution;
                }
                const result = await generateVideo({
                    root: host.mediaRoot(),
                    apiKey,
                    model: selection.model,
                    prompt: params.prompt,
                    mode: selection.mode,
                    image: params.image
                        ? imageFromFile(params.image).block
                        : undefined,
                    references: references.length > 0 ? references : undefined,
                    duration: params.duration,
                    ...(resolution ? { resolution } : {}),
                    ratio: params.ratio,
                    seed: params.seed,
                    watermark: params.watermark,
                    signal,
                });
                const path = saveMedia(result.data, result.mimeType, "video");
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Video saved to ${path}\nSource URL: ${result.url}`,
                        },
                    ],
                    details: {
                        path,
                        taskId: result.taskId,
                        url: result.url,
                        model: selection.model,
                        mode: selection.mode,
                        references: references.length,
                    },
                };
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    });

    pi.registerTool({
        name: "qwen_json",
        label: "Qwen JSON",
        description:
            "Ask a Qwen model for a JSON answer, optionally constrained by a JSON Schema (Responses text.format). One-shot: it does not see the conversation.",
        promptSnippet: "Get a structured JSON answer from Qwen",
        parameters: Type.Object({
            prompt: Type.String({
                description: "What to extract or answer, as a prompt",
            }),
            schema: Type.Optional(
                Type.String({
                    description:
                        "JSON Schema as a JSON string; without it the model only promises valid JSON",
                }),
            ),
            model: Type.Optional(
                Type.String({
                    description: "Model (default qwen3.8-flash)",
                }),
            ),
            maxTokens: Type.Optional(
                Type.Number({
                    description: "Max output tokens (default 4096)",
                }),
            ),
        }),
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const apiKey = host.activeKey();
            if (!apiKey)
                return toolError(
                    "No Qwen credential. Run /login qwen-token-plan.",
                );
            let schema: JsonObject | undefined;
            if (params.schema) {
                try {
                    schema = asObject(JSON.parse(params.schema));
                } catch {
                    return toolError("schema is not valid JSON");
                }
                if (!schema) return toolError("schema must be a JSON object");
            }
            try {
                const result = await structuredJson({
                    baseUrl: host.baseUrl(),
                    apiKey,
                    prompt: params.prompt,
                    ...(schema ? { schema } : {}),
                    ...(params.model ? { model: params.model } : {}),
                    ...(params.maxTokens
                        ? { maxTokens: params.maxTokens }
                        : {}),
                    sessionId: ctx.sessionManager.getSessionId(),
                    signal,
                });
                return {
                    content: [{ type: "text" as const, text: result.text }],
                    details: { model: result.model, schema: Boolean(schema) },
                };
            } catch (error) {
                return toolError(
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    });
}
