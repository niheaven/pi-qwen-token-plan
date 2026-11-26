// The plan's GET /models returns ids only. Metadata comes from pi's own
// qwen-token-plan catalogs when they are available, then a verified table, then
// conservative heuristics. Responses-capable models use the Responses wire;
// chat-only models use the plan's Anthropic-compatible Messages wire.

export type BuiltinMetadata = {
    id: string;
    name?: string;
    input?: ("text" | "image")[];
    contextWindow?: number;
    maxTokens?: number;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    compat?: Record<string, unknown>;
};

export type ImageConfig = {
    type: "image";
    id: string;
    name: string;
    api: "qwen-images";
    baseUrl: string;
    input: ("text" | "image")[];
    output: "image"[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
};

export type ModelConfig = {
    id: string;
    name: string;
    api: "openai-responses" | "anthropic-messages";
    input: ("text" | "image")[];
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    thinkingLevelMap?: Record<string, string | null>;
    compat?: Record<string, unknown>;
    /** Per-model endpoint override; set for Anthropic Messages models. */
    baseUrl?: string;
};

/** The Responses endpoint accepts these flags; prompt cache fields are ignored. */
export const RESPONSES_COMPAT = {
    supportsStrictMode: true,
    supportsMaxOutputTokens: true,
    supportsOpenAIGrammarTools: false,
    supportsLongCacheRetention: false,
    promptCacheKeyMode: "disabled",
};

/** Chat-only models use the plan's Anthropic-compatible messages wire. */
export const ANTHROPIC_COMPAT = {
    supportsStrictTools: false,
    supportsMidConvoSystemMessages: true,
    // The plan only documents explicit cache_control on qwen4 family content
    // blocks, so do not put cache markers on tool schemas or request 1h here.
    supportsCacheControlOnTools: false,
    supportsLongCacheRetention: false,
};

const RESPONSES_FAMILY = /^(qwen|deepseek)/i;
/** Verified on /responses: glm-5.2 and glm-5.3; glm-5 and glm-5.1 are agent-disabled. */
const RESPONSES_GLM = /^glm-(?:5\.[2-9]|[6-9])/i;
/** kimi-k3 and kimi-k3.1-pro speak the Responses wire; kimi-k2.* does not. */
const RESPONSES_KIMI = /^kimi-k3/i;
/** Plan models that only answer over the Anthropic-compatible wire. */
const CHAT_ONLY = /^(?:glm-5(?:\.1)?|kimi-k2|MiniMax-)/i;
const NON_CHAT =
    /(image|audio|video|tts|asr|embed|rerank|wan|omni|livetranslate|realtime)/i;
/** Families whose text-to-image route is the sync multimodal endpoint. */
const IMAGE_FAMILY = /^(qwen-image|wan2\.7-image|wan2\.6-image|z-image)/i;

export function isResponsesModel(id: string): boolean {
    if (id === "auto") return true;
    return (
        (RESPONSES_FAMILY.test(id) ||
            RESPONSES_GLM.test(id) ||
            RESPONSES_KIMI.test(id)) &&
        !NON_CHAT.test(id)
    );
}

export function isImageModel(id: string): boolean {
    return IMAGE_FAMILY.test(id) && !/edit/i.test(id);
}

export function isChatOnlyModel(id: string): boolean {
    return CHAT_ONLY.test(id) && !NON_CHAT.test(id);
}

const ALL_LEVELS = {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
};

const QWEN_38_LEVELS = {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: null,
    xhigh: "xhigh",
    max: null,
};

const DEEPSEEK_LEVELS = {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
};

type Known = {
    contextWindow: number;
    maxTokens: number;
    levels: Record<string, string | null>;
    image: boolean;
};

const KNOWN = {
    // Probed on /responses: thinks always (reasoning.effort "none" is a 400), so
    // `off` stays null and pi never sends it; image input, function tools, all
    // five hosted tools, json_object and json_schema all work.
    auto: {
        contextWindow: 1_000_000,
        maxTokens: 262_144,
        levels: ALL_LEVELS,
        image: true,
    },
    "qwen4-max": {
        contextWindow: 1_000_000,
        maxTokens: 262_144,
        levels: ALL_LEVELS,
        image: true,
    },
    "qwen4-max-preview": {
        contextWindow: 1_000_000,
        maxTokens: 393_216,
        levels: QWEN_38_LEVELS,
        image: true,
    },
    "qwen3.8-max": {
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        levels: QWEN_38_LEVELS,
        image: true,
    },
    "qwen3.8-flash": {
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        levels: QWEN_38_LEVELS,
        image: true,
    },
    "qwen3.7-max": {
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        levels: ALL_LEVELS,
        image: false,
    },
    "qwen3.7-plus": {
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        levels: ALL_LEVELS,
        image: true,
    },
    "qwen3.6-plus": {
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        levels: ALL_LEVELS,
        image: true,
    },
    "qwen3.6-flash": {
        contextWindow: 1_000_000,
        maxTokens: 65_536,
        levels: ALL_LEVELS,
        image: true,
    },
    "deepseek-v4-pro": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        levels: DEEPSEEK_LEVELS,
        image: false,
    },
    "deepseek-v4-pro-0813": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        levels: DEEPSEEK_LEVELS,
        image: false,
    },
    "deepseek-v4-flash-0731": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        levels: DEEPSEEK_LEVELS,
        image: false,
    },
    "deepseek-v4.1-flash": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        levels: DEEPSEEK_LEVELS,
        image: true,
    },
    "deepseek-v4.1-flash-1017": {
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        levels: DEEPSEEK_LEVELS,
        image: true,
    },
    "glm-5.2": {
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        levels: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
        },
        image: false,
    },
    "glm-5.3": {
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        levels: {
            off: null,
            minimal: null,
            low: "low",
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
        },
        image: false,
    },
} satisfies Record<string, Known>;

function knownFor(id: string): Known | undefined {
    return (KNOWN as Record<string, Known>)[id];
}

function prettyName(id: string): string {
    return id
        .replace(/^qwen/i, "Qwen ")
        .replace(/^deepseek/i, "DeepSeek ")
        .replace(/-/g, " ")
        .replace(/\b([a-z])/g, (s) => s.toUpperCase())
        .trim();
}

function chatBase(id: string, builtin?: BuiltinMetadata) {
    const known = knownFor(id);
    const textOnly = /^deepseek|^glm|^auto/i.test(id);
    const image =
        builtin?.input?.includes("image") ?? known?.image ?? !textOnly;
    return {
        id,
        name: builtin?.name ?? prettyName(id),
        input: (image ? ["text", "image"] : ["text"]) as ("text" | "image")[],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: builtin?.reasoning ?? true,
        contextWindow:
            builtin?.contextWindow ?? known?.contextWindow ?? 1_000_000,
        maxTokens:
            builtin?.maxTokens ??
            known?.maxTokens ??
            (/^deepseek/i.test(id) ? 384_000 : 65_536),
        thinkingLevelMap:
            builtin?.thinkingLevelMap ??
            known?.levels ??
            (/^deepseek/i.test(id) ? DEEPSEEK_LEVELS : ALL_LEVELS),
    };
}

export function buildModel(id: string, builtin?: BuiltinMetadata): ModelConfig {
    return {
        ...chatBase(id, builtin),
        api: "openai-responses",
        compat: RESPONSES_COMPAT,
    };
}

function appsAnthropic(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, "");
    if (!trimmed || trimmed.endsWith("/apps/anthropic")) return trimmed;
    const root = trimmed.replace(/\/compatible-mode\/v1$/, "");
    return `${root}/apps/anthropic`;
}

export function buildMessagesModel(
    id: string,
    baseUrl = "",
    builtin?: BuiltinMetadata,
): ModelConfig {
    const anthropic = baseUrl ? appsAnthropic(baseUrl) : baseUrl;
    return {
        ...chatBase(id, builtin),
        api: "anthropic-messages",
        baseUrl: anthropic,
        compat: ANTHROPIC_COMPAT,
    };
}

function rootOf(baseUrl: string): string {
    return baseUrl.replace(/\/compatible-mode\/v1\/?$/, "").replace(/\/+$/, "");
}

export function buildImageModel(id: string, baseUrl: string): ImageConfig {
    return {
        type: "image",
        id,
        name: prettyName(id),
        api: "qwen-images",
        baseUrl: rootOf(baseUrl),
        input: ["text", "image"],
        output: ["image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}

export function buildModels(
    ids: readonly string[],
    baseUrl = "",
    builtin?: ReadonlyMap<string, BuiltinMetadata>,
): (ModelConfig | ImageConfig)[] {
    const seen = new Set<string>();
    const models: (ModelConfig | ImageConfig)[] = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        const metadata = builtin?.get(id);
        if (isImageModel(id)) {
            seen.add(id);
            models.push(buildImageModel(id, baseUrl));
        } else if (isResponsesModel(id)) {
            seen.add(id);
            models.push(buildModel(id, metadata));
        } else if (isChatOnlyModel(id)) {
            seen.add(id);
            models.push(buildMessagesModel(id, baseUrl, metadata));
        }
    }
    return models;
}

export async function fetchModelIds({
    baseUrl,
    apiKey,
    signal,
    fetchImpl = fetch,
    timeoutMs = 8_000,
}: {
    baseUrl: string;
    apiKey: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
}): Promise<string[]> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
        headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok)
        throw new Error(
            `Token Plan GET /models failed with HTTP ${response.status}`,
        );
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = Array.isArray(body?.data)
        ? body.data
              .map((entry) => entry?.id)
              .filter((id): id is string => typeof id === "string")
        : [];
    if (ids.length === 0)
        throw new Error("Token Plan GET /models returned no models");
    return ids;
}
