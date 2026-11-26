// DashScope media APIs used by the plan. Images use the synchronous
// multimodal-generation route; video submits an async task and polls /api/v1/tasks.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type {
    AssistantImages,
    ImageModel,
    ImagesContext,
} from "@earendil-works/pi-ai";
import { mediaDir } from "./config.ts";

export type ImageBlock = { data: string; mimeType: string };
export type GeneratedImage = ImageBlock & { url?: string };

export type ImageRequest = {
    root: string;
    apiKey: string;
    model: string;
    prompt: string;
    images?: ImageBlock[];
    size?: string;
    n?: number;
    /** qwen-image-3.0 family only. */
    negativePrompt?: string;
    seed?: number;
    /** `agent` is text-to-image only; the API rejects it for image editing. */
    promptExtendMode?: "direct" | "agent";
    watermark?: boolean;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
};

export type VideoRequest = {
    root: string;
    apiKey: string;
    model: string;
    prompt: string;
    image?: ImageBlock;
    references?: ImageBlock[];
    /** Inferred by the tool; happyhorse uses it to pick t2v/i2v/r2v. */
    mode?: "t2v" | "i2v" | "r2v";
    resolution?: string;
    ratio?: string;
    duration?: number;
    seed?: number;
    watermark?: boolean;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
};

export type GeneratedVideo = {
    taskId: string;
    url: string;
    data: string;
    mimeType: string;
};

const REQUEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;
const VIDEO_TIMEOUT_MS = 15 * 60_000;

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    return signal
        ? AbortSignal.any([signal, AbortSignal.timeout(ms)])
        : AbortSignal.timeout(ms);
}

let preferredRoot: string | undefined;

/** Index keeps this in sync with the active credential region. */
export function setMediaRoot(root: string | undefined): void {
    preferredRoot = root;
}

/** `https://host/compatible-mode/v1` and `https://host` both map to `https://host`. */
export function dashScopeRoot(baseUrl: string): string {
    return baseUrl.replace(/\/compatible-mode\/v1\/?$/, "").replace(/\/+$/, "");
}

export function buildImageBody({
    model,
    prompt,
    images = [],
    size,
    n = 1,
    negativePrompt,
    seed,
    promptExtendMode,
    watermark = false,
}: Pick<
    ImageRequest,
    | "model"
    | "prompt"
    | "images"
    | "size"
    | "n"
    | "negativePrompt"
    | "seed"
    | "promptExtendMode"
    | "watermark"
>): Record<string, unknown> {
    const content: Record<string, unknown>[] = [{ text: prompt }];
    for (const image of images) {
        content.push({ image: `data:${image.mimeType};base64,${image.data}` });
    }
    const threeSeries = /^qwen-image-3\.0/.test(model);
    const parameters: Record<string, unknown> = {
        n,
        prompt_extend: true,
        watermark,
    };
    if (size) parameters.size = size;
    if (threeSeries && negativePrompt)
        parameters.negative_prompt = negativePrompt;
    if (seed !== undefined) parameters.seed = seed;
    if (promptExtendMode === "agent" && images.length === 0)
        parameters.prompt_extend_mode = "agent";
    return {
        model,
        input: { messages: [{ role: "user", content }] },
        parameters,
    };
}

export function parseImageUrls(payload: unknown): string[] {
    const output = (payload as { output?: unknown })?.output as
        | { choices?: unknown; results?: unknown; image_url?: unknown }
        | undefined;
    const urls: string[] = [];
    const choices = Array.isArray(output?.choices) ? output.choices : [];
    for (const choice of choices) {
        const content = (choice as { message?: { content?: unknown } })?.message
            ?.content;
        if (!Array.isArray(content)) continue;
        for (const item of content) {
            const image = (item as { image?: unknown })?.image;
            if (typeof image === "string" && image) urls.push(image);
        }
    }
    const results = Array.isArray(output?.results) ? output.results : [];
    for (const result of results) {
        const url = (result as { url?: unknown })?.url;
        if (typeof url === "string" && url) urls.push(url);
    }
    if (typeof output?.image_url === "string" && output.image_url)
        urls.push(output.image_url);
    return [...new Set(urls)];
}

async function fetchBlock(
    url: string,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<ImageBlock> {
    if (url.startsWith("data:")) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(url);
        if (!match) throw new Error("unsupported data URL");
        return { mimeType: match[1], data: match[2] };
    }
    const response = await fetchImpl(url, {
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`image download failed with HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const mimeType =
        response.headers.get("content-type")?.split(";")[0] || "image/png";
    return { mimeType, data: bytes.toString("base64") };
}

export async function generateImage(
    request: ImageRequest,
): Promise<{ images: GeneratedImage[]; requestId?: string }> {
    const fetchImpl = request.fetchImpl ?? fetch;
    const response = await fetchImpl(
        `${dashScopeRoot(request.root)}/api/v1/services/aigc/multimodal-generation/generation`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${request.apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(buildImageBody(request)),
            signal: withTimeout(request.signal, REQUEST_TIMEOUT_MS),
        },
    );
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error(
            `image API returned HTTP ${response.status}: ${text.slice(0, 300)}`,
        );
    }
    if (!response.ok) {
        const message = (payload as { message?: unknown }).message;
        throw new Error(
            `image API HTTP ${response.status}: ${typeof message === "string" ? message : text.slice(0, 300)}`,
        );
    }
    const urls = parseImageUrls(payload);
    if (urls.length === 0) throw new Error("image API returned no images");
    const images = await Promise.all(
        urls.map(async (url) => ({
            ...(await fetchBlock(url, fetchImpl, request.signal)),
            url,
        })),
    );
    const requestId =
        typeof payload.request_id === "string" ? payload.request_id : undefined;
    return { images, ...(requestId ? { requestId } : {}) };
}

/** pi image-model adapter: codemode can call `models.generateImages` directly. */
export const qwenImagesApi = {
    generateImages: async (
        model: ImageModel<"qwen-images">,
        context: ImagesContext,
        options?: {
            apiKey?: string;
            signal?: AbortSignal;
            fetch?: typeof fetch;
            metadata?: Record<string, unknown>;
        },
    ): Promise<AssistantImages> => {
        const output: AssistantImages = {
            api: model.api,
            provider: model.provider,
            model: model.id,
            output: [],
            stopReason: "stop",
            timestamp: Date.now(),
        };
        try {
            if (!options?.apiKey)
                throw new Error(`No API key for provider: ${model.provider}`);
            const prompt = context.input
                .filter((item) => item.type === "text")
                .map((item) => (item.type === "text" ? item.text : ""))
                .join("\n")
                .trim();
            const images = context.input
                .filter((item) => item.type === "image")
                .map((item) =>
                    item.type === "image"
                        ? { data: item.data, mimeType: item.mimeType }
                        : undefined,
                )
                .filter((item): item is ImageBlock => item !== undefined);
            const metadata = options.metadata ?? {};
            const result = await generateImage({
                root: preferredRoot ?? dashScopeRoot(model.baseUrl),
                apiKey: options.apiKey,
                model: model.id,
                prompt,
                images,
                ...(typeof metadata.size === "string"
                    ? { size: metadata.size }
                    : {}),
                ...(typeof metadata.n === "number" ? { n: metadata.n } : {}),
                ...(typeof metadata.watermark === "boolean"
                    ? { watermark: metadata.watermark }
                    : {}),
                signal: options.signal,
                fetchImpl: options.fetch,
            });
            output.output = result.images.map((image) => ({
                type: "image",
                data: image.data,
                mimeType: image.mimeType,
            }));
            if (result.requestId) output.responseId = result.requestId;
        } catch (error) {
            output.stopReason = options?.signal?.aborted ? "aborted" : "error";
            output.errorMessage =
                error instanceof Error ? error.message : String(error);
        }
        return output;
    },
};

export function buildVideoBody({
    model,
    prompt,
    image,
    references = [],
    mode,
    resolution,
    ratio,
    duration,
    seed,
    watermark = false,
}: Pick<
    VideoRequest,
    | "model"
    | "prompt"
    | "image"
    | "references"
    | "mode"
    | "resolution"
    | "ratio"
    | "duration"
    | "seed"
    | "watermark"
>): Record<string, unknown> {
    let selected = mode;
    if (!selected) {
        if (references.length > 0) selected = "r2v";
        else if (image) selected = "i2v";
        else selected = "t2v";
    }
    let media: { type: string; url: string }[] = [];
    if (selected === "r2v") {
        media = references.map((item) => ({
            type: "reference_image",
            url: `data:${item.mimeType};base64,${item.data}`,
        }));
    } else if (selected === "i2v" && image) {
        media = [
            {
                type: "first_frame",
                url: `data:${image.mimeType};base64,${image.data}`,
            },
        ];
    }
    return {
        model,
        input: {
            prompt,
            ...(media.length > 0 ? { media } : {}),
        },
        parameters: {
            ...(resolution ? { resolution } : {}),
            ...(ratio ? { ratio } : {}),
            ...(duration ? { duration } : {}),
            ...(seed !== undefined ? { seed } : {}),
            prompt_extend: true,
            watermark,
        },
    };
}

export function parseVideoUrl(payload: unknown): string | undefined {
    const output = (payload as { output?: unknown })?.output as
        | { video_url?: unknown; results?: unknown }
        | undefined;
    if (typeof output?.video_url === "string" && output.video_url)
        return output.video_url;
    if (Array.isArray(output?.results)) {
        const url = (output.results[0] as { url?: unknown })?.url;
        if (typeof url === "string" && url) return url;
    }
    return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolvePromise();
        }, ms);
        const abort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("aborted"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
    });
}

async function pollVideo(
    fetchImpl: typeof fetch,
    root: string,
    apiKey: string,
    taskId: string,
    initialStatus: string,
    signal: AbortSignal,
): Promise<string> {
    let status = initialStatus;
    while (
        status !== "SUCCEEDED" &&
        status !== "FAILED" &&
        status !== "CANCELED" &&
        status !== "UNKNOWN"
    ) {
        await sleep(POLL_INTERVAL_MS, signal);
        const poll = await fetchImpl(
            `${root}/api/v1/tasks/${encodeURIComponent(taskId)}`,
            {
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    accept: "application/json",
                },
                signal,
            },
        );
        const pollText = await poll.text();
        if (!poll.ok)
            throw new Error(
                `video task HTTP ${poll.status}: ${pollText.slice(0, 300)}`,
            );
        let pollPayload: Record<string, unknown>;
        try {
            pollPayload = JSON.parse(pollText) as Record<string, unknown>;
        } catch {
            throw new Error(
                `video task returned non-JSON: ${pollText.slice(0, 300)}`,
            );
        }
        const pollOutput = (
            pollPayload as { output?: { task_status?: unknown } }
        ).output;
        status =
            typeof pollOutput?.task_status === "string"
                ? pollOutput.task_status
                : status;
        if (status === "SUCCEEDED") {
            const url = parseVideoUrl(pollPayload);
            if (url) return url;
            break;
        }
        if (status === "FAILED") {
            const message = (pollPayload as { message?: unknown }).message;
            throw new Error(
                typeof message === "string" ? message : "video task failed",
            );
        }
    }
    throw new Error("video task finished without a video URL");
}

export async function generateVideo(
    request: VideoRequest,
): Promise<GeneratedVideo> {
    const fetchImpl = request.fetchImpl ?? fetch;
    const root = dashScopeRoot(request.root);
    const signal = withTimeout(request.signal, VIDEO_TIMEOUT_MS);
    const response = await fetchImpl(
        `${root}/api/v1/services/aigc/video-generation/video-synthesis`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${request.apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
                "X-DashScope-Async": "enable",
            },
            body: JSON.stringify(buildVideoBody(request)),
            signal,
        },
    );
    const text = await response.text();
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
        throw new Error(
            `video API returned HTTP ${response.status}: ${text.slice(0, 300)}`,
        );
    }
    if (!response.ok) {
        const message = (payload as { message?: unknown }).message;
        throw new Error(
            `video API HTTP ${response.status}: ${typeof message === "string" ? message : text.slice(0, 300)}`,
        );
    }
    const output = (
        payload as { output?: { task_id?: unknown; task_status?: unknown } }
    ).output;
    const taskId = typeof output?.task_id === "string" ? output.task_id : "";
    if (!taskId) throw new Error("video API returned no task_id");

    const status =
        typeof output?.task_status === "string"
            ? output.task_status
            : "PENDING";
    const url = await pollVideo(
        fetchImpl,
        root,
        request.apiKey,
        taskId,
        status,
        signal,
    );
    const download = await fetchImpl(url, { signal });
    if (!download.ok)
        throw new Error(`video download failed with HTTP ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    return {
        taskId,
        url,
        data: bytes.toString("base64"),
        mimeType:
            download.headers.get("content-type")?.split(";")[0] || "video/mp4",
    };
}

const MIME_BY_EXTENSION: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
};

const MAX_INPUT_BYTES = 25 * 1024 * 1024;

function readBase64(path: string): string {
    const size = statSync(path).size;
    if (size > MAX_INPUT_BYTES) {
        throw new Error(
            `input file is ${Math.round(size / 1024 / 1024)} MB; the limit is 25 MB`,
        );
    }
    return readFileSync(path).toString("base64");
}

export function imageFromFile(path: string): {
    block: ImageBlock;
    name: string;
} {
    const name = resolve(path);
    const mimeType = MIME_BY_EXTENSION[extname(name).toLowerCase()];
    if (!mimeType)
        throw new Error(`unsupported image type: ${extname(name) || "(none)"}`);
    return { block: { data: readBase64(name), mimeType }, name };
}

function extensionFor(mimeType: string): string {
    if (mimeType.includes("jpeg")) return ".jpg";
    if (mimeType.includes("webp")) return ".webp";
    if (mimeType.includes("gif")) return ".gif";
    if (mimeType.includes("mp4")) return ".mp4";
    if (mimeType.includes("webm")) return ".webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return ".mp3";
    if (mimeType.includes("wav")) return ".wav";
    if (mimeType.includes("opus")) return ".opus";
    if (mimeType.includes("pcm")) return ".pcm";
    return ".png";
}

export function saveMedia(
    data: string,
    mimeType: string,
    prefix: string,
): string {
    mkdirSync(mediaDir(), { recursive: true });
    const path = resolve(
        mediaDir(),
        `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}${extensionFor(mimeType)}`,
    );
    writeFileSync(path, Buffer.from(data, "base64"), { flag: "wx" });
    return path;
}
// - Speech -

export type SpeechResult = {
    data: string;
    mimeType: string;
    url: string;
    expiresAt?: number;
};
export type TranscriptResult = {
    text: string;
    sentence?: unknown;
    duration?: number;
};

const AUDIO_MIME: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    pcm: "audio/pcm",
    opus: "audio/opus",
    m4a: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    ogg: "audio/ogg",
    webm: "audio/webm",
};

export function audioFromFile(path: string): {
    dataUri: string;
    format: string;
} {
    const name = resolve(path);
    const format = extname(name).replace(/^\./, "").toLowerCase();
    const mimeType = AUDIO_MIME[format];
    if (!mimeType)
        throw new Error(`unsupported audio type: ${format || "(none)"}`);
    return { dataUri: `data:${mimeType};base64,${readBase64(name)}`, format };
}

export async function generateSpeech({
    root,
    apiKey,
    text,
    voice = "longanhuan_v3.6",
    format = "mp3",
    sampleRate = 22050,
    model = "qwen-audio-3.0-tts-plus",
    signal,
    fetchImpl = fetch,
}: {
    root: string;
    apiKey: string;
    text: string;
    voice?: string;
    format?: string;
    sampleRate?: number;
    model?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}): Promise<SpeechResult> {
    const response = await fetchImpl(
        `${dashScopeRoot(root)}/api/v1/services/audio/tts/SpeechSynthesizer`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({
                model,
                input: { text, voice, format, sample_rate: sampleRate },
            }),
            signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
        },
    );
    const raw = await response.text();
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new Error(
            `speech API returned HTTP ${response.status}: ${raw.slice(0, 300)}`,
        );
    }
    if (!response.ok) {
        const message = (payload as { message?: unknown }).message;
        throw new Error(
            `speech API HTTP ${response.status}: ${typeof message === "string" ? message : raw.slice(0, 300)}`,
        );
    }
    const audio = (
        payload as {
            output?: { audio?: { url?: unknown; expires_at?: unknown } };
        }
    ).output?.audio;
    const url = typeof audio?.url === "string" ? audio.url : "";
    if (!url) throw new Error("speech API returned no audio URL");
    const download = await fetchImpl(url, {
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    });
    if (!download.ok)
        throw new Error(`speech download failed with HTTP ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const expiresAt =
        typeof audio?.expires_at === "number" ? audio.expires_at : undefined;
    return {
        data: bytes.toString("base64"),
        mimeType: AUDIO_MIME[format] ?? "audio/mpeg",
        url,
        ...(expiresAt ? { expiresAt } : {}),
    };
}

export async function transcribeAudio({
    root,
    apiKey,
    audio,
    format,
    sampleRate,
    languageHints,
    model = "qwen-audio-3.0-asr-flash",
    signal,
    fetchImpl = fetch,
}: {
    root: string;
    apiKey: string;
    /** Public URL or `data:audio/...;base64,...`. */
    audio: string;
    format: string;
    sampleRate?: number;
    languageHints?: string[];
    model?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}): Promise<TranscriptResult> {
    const parameters: Record<string, unknown> = { format };
    if (sampleRate) parameters.sample_rate = sampleRate;
    if (languageHints?.length)
        parameters.language_hints = languageHints.slice(0, 4);
    const response = await fetchImpl(
        `${dashScopeRoot(root)}/api/v1/services/aigc/multimodal-generation/generation`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({
                model,
                input: {
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "input_audio",
                                    input_audio: { data: audio },
                                },
                            ],
                        },
                    ],
                },
                parameters,
            }),
            signal: withTimeout(signal, 300_000),
        },
    );
    const raw = await response.text();
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new Error(
            `ASR API returned HTTP ${response.status}: ${raw.slice(0, 300)}`,
        );
    }
    if (!response.ok) {
        const message = (payload as { message?: unknown }).message;
        throw new Error(
            `ASR API HTTP ${response.status}: ${typeof message === "string" ? message : raw.slice(0, 300)}`,
        );
    }
    const output = (
        payload as { output?: { text?: unknown; sentence?: unknown } }
    ).output;
    let text = "";
    if (typeof output?.text === "string") {
        text = output.text;
    } else {
        const sentence = output?.sentence as { text?: unknown } | undefined;
        if (typeof sentence?.text === "string") text = sentence.text;
    }
    if (!text) throw new Error("ASR API returned no text");
    const usage = (payload as { usage?: { duration?: unknown } }).usage;
    const duration =
        typeof usage?.duration === "number" ? usage.duration : undefined;
    return {
        text,
        ...(output?.sentence ? { sentence: output.sentence } : {}),
        ...(duration ? { duration } : {}),
    };
}

// - Vision -

export async function describeImage({
    baseUrl,
    apiKey,
    image,
    pdf,
    prompt = "Describe this image in detail, including any text.",
    model = "qwen3.8-flash",
    maxTokens = 1200,
    sessionId,
    signal,
    fetchImpl = fetch,
}: {
    baseUrl: string;
    apiKey: string;
    image?: ImageBlock;
    /** PDF input; only qwen4-max and the qwen3.8 max/flash families accept it. */
    pdf?: { data: string; filename: string };
    prompt?: string;
    model?: string;
    maxTokens?: number;
    sessionId?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}): Promise<{ text: string; model: string }> {
    let attachment: Record<string, string> | undefined;
    if (pdf) {
        attachment = {
            type: "input_file",
            filename: pdf.filename,
            file_data: `data:application/pdf;base64,${pdf.data}`,
        };
    } else if (image) {
        attachment = {
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.data}`,
        };
    }
    if (!attachment) throw new Error("describeImage needs an image or a PDF");
    const response = await fetchImpl(
        `${baseUrl.replace(/\/+$/, "")}/responses`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
                "x-dashscope-session-cache": "enable",
                ...(sessionId ? { "x-session-id": sessionId } : {}),
            },
            body: JSON.stringify({
                model,
                input: [
                    {
                        role: "user",
                        content: [
                            { type: "input_text", text: prompt },
                            attachment,
                        ],
                    },
                ],
                stream: false,
                max_output_tokens: maxTokens,
            }),
            signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
        },
    );
    const raw = await response.text();
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new Error(
            `vision API returned HTTP ${response.status}: ${raw.slice(0, 300)}`,
        );
    }
    if (!response.ok) {
        const error = (payload as { error?: { message?: unknown } }).error;
        throw new Error(
            `vision API HTTP ${response.status}: ${typeof error?.message === "string" ? error.message : raw.slice(0, 300)}`,
        );
    }
    const output = Array.isArray(payload.output) ? payload.output : [];
    const text = output
        .filter((item) => (item as { type?: unknown }).type === "message")
        .flatMap((item) =>
            Array.isArray((item as { content?: unknown[] }).content)
                ? (item as { content: unknown[] }).content
                : [],
        )
        .map((part) =>
            typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
        )
        .join("\n")
        .trim();
    if (!text) throw new Error("vision API returned no text");
    return { text, model };
}

/** PDF input for `input_file`; the plan caps the file at 100 MB. */
export function pdfFromFile(path: string): {
    data: string;
    filename: string;
} {
    const name = resolve(path);
    if (extname(name).toLowerCase() !== ".pdf")
        throw new Error(`not a PDF: ${extname(name) || "(none)"}`);
    return { data: readBase64(name), filename: basename(name) };
}
