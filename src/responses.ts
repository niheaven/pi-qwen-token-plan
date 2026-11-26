import type { StreamOptions } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { addPromptCache, type PromptCacheRetention } from "./cache.ts";
import {
    addHostedTools,
    createStreamAugmenter,
    type ResponsesPayload,
} from "./hosted.ts";
import type { JsonValue } from "./json.ts";

type PayloadHook = NonNullable<StreamOptions["onPayload"]>;
type StreamEventHook = NonNullable<StreamOptions["onProviderStreamEvent"]>;

/**
 * The plan enables multi-turn caching with this header (default `disable`).
 * It is a pure server-side gain, so it always rides along.
 */
function withSessionCache<T extends StreamOptions | undefined>(options: T): T {
    const headers = (options as StreamOptions | undefined)?.headers;
    return {
        ...options,
        headers: { ...headers, "x-dashscope-session-cache": "enable" },
    } as T;
}

export function withPlanOptions<T extends StreamOptions | undefined>(
    options: T,
    modelId: string,
    hostedEnabled: () => boolean,
    cacheRetention: () => PromptCacheRetention,
): T {
    const originalPayload = options?.onPayload;
    const onPayload: PayloadHook = async (payload, model) => {
        const hosted =
            addHostedTools(
                payload as ResponsesPayload,
                modelId,
                hostedEnabled(),
            ) ?? payload;
        const injected =
            addPromptCache(
                hosted as ResponsesPayload,
                modelId,
                cacheRetention(),
            ) ?? hosted;
        const replaced = await originalPayload?.(injected, model);
        return replaced ?? injected;
    };

    const originalEvent = options?.onProviderStreamEvent;
    const augment = createStreamAugmenter();
    const onProviderStreamEvent: StreamEventHook = async (event, model) => {
        augment(event as JsonValue);
        await originalEvent?.(event, model);
    };

    return {
        ...withSessionCache(options),
        onPayload,
        onProviderStreamEvent,
    } as T;
}

/**
 * The stock Responses implementation, with the plan's hosted tools added to
 * every request and provider citations copied into the final message text.
 * Both switches are read per request so `/qwen-settings` applies without a restart.
 */
export function createResponsesApi(
    hostedEnabled: () => boolean,
    cacheRetention: () => PromptCacheRetention = () => "5m",
) {
    const responses = openAIResponsesApi();
    return {
        stream: (
            model: Parameters<typeof responses.stream>[0],
            context: Parameters<typeof responses.stream>[1],
            options?: StreamOptions,
        ) =>
            responses.stream(
                model,
                context,
                withPlanOptions(
                    options,
                    model.id,
                    hostedEnabled,
                    cacheRetention,
                ),
            ),
        streamSimple: (
            model: Parameters<typeof responses.streamSimple>[0],
            context: Parameters<typeof responses.streamSimple>[1],
            options?: StreamOptions,
        ) =>
            responses.streamSimple(
                model,
                context,
                withPlanOptions(
                    options,
                    model.id,
                    hostedEnabled,
                    cacheRetention,
                ),
            ),
    };
}
