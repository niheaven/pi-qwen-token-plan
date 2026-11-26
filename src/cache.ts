// Qwen4 family models support explicit prompt caching on the Responses
// endpoint through top-level `prompt_cache_options`. Only qwen4 models accept
// the field.
// `implicit` is the automatic mode: the provider puts the breakpoint at the end
// of the last input message, so every request is cached without extra work.

export const PROMPT_CACHE_RETENTIONS = ["5m", "1h"] as const;
export type PromptCacheRetention = (typeof PROMPT_CACHE_RETENTIONS)[number];
export const DEFAULT_PROMPT_CACHE: PromptCacheRetention = "5m";

type CachePayload = { prompt_cache_options?: unknown };

export function normalizePromptCache(value: unknown): PromptCacheRetention {
    return typeof value === "string" &&
        (PROMPT_CACHE_RETENTIONS as readonly string[]).includes(value)
        ? (value as PromptCacheRetention)
        : DEFAULT_PROMPT_CACHE;
}

export function supportsPromptCache(modelId: string): boolean {
    return /^qwen4(?:-|$)/i.test(modelId);
}

/** `implicit` puts the breakpoint at the end of the last input message. */
export function addPromptCache<T extends CachePayload>(
    payload: T | undefined,
    modelId: string,
    retention: PromptCacheRetention,
): T | undefined {
    if (!payload || !supportsPromptCache(modelId)) return payload;
    if (payload.prompt_cache_options !== undefined) return payload;
    return {
        ...payload,
        prompt_cache_options: { mode: "implicit", ttl: retention },
    };
}
