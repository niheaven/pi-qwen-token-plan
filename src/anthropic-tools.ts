// The plan's Anthropic-compatible Messages endpoint exposes server-side
// web_search / web_fetch tools, but only for the models listed in the docs and
// only when the request's system prompt carries the CLI billing marker.
import { asObject, asString, type JsonObject, type JsonValue } from "./json.ts";

const WEB_SEARCH = [
    /^qwen4-max$/i,
    /^qwen3\.[5-8]-(?:max|plus|flash)(?:-|$)/i,
    /^deepseek-v4(?:\.1)?-(?:pro|flash)/i,
    /^glm-5\.2$/i,
    /^kimi-k3(?:\.1-pro)?$/i,
];

const WEB_FETCH = [
    /^qwen4-max$/i,
    /^deepseek-v4\.1-flash-1017$/i,
    /^kimi-k3\.1-pro$/i,
];

export function supportsAnthropicWebSearch(modelId: string): boolean {
    return WEB_SEARCH.some((pattern) => pattern.test(modelId));
}

export function supportsAnthropicWebFetch(modelId: string): boolean {
    return WEB_FETCH.some((pattern) => pattern.test(modelId));
}

export type AnthropicRequest = JsonObject & {
    model: string;
    system: JsonObject[];
    tools: JsonObject[];
};

function systemBlocks(system: JsonValue | undefined): JsonObject[] {
    const text = asString(system);
    if (text !== undefined) return [{ type: "text", text }];
    if (!Array.isArray(system)) return [];
    return system
        .map(asObject)
        .filter((block): block is JsonObject => block !== undefined);
}

/** Inject server tools + the required billing marker into an Anthropic payload. */
export function injectAnthropicServerTools(
    payload: JsonValue,
): AnthropicRequest | undefined {
    const body = asObject(payload);
    if (!body) return undefined;
    const model = asString(body.model);
    if (!model) return undefined;
    const fetchTool = supportsAnthropicWebFetch(model);
    const search = fetchTool || supportsAnthropicWebSearch(model);
    if (!search) return undefined;

    const tools = Array.isArray(body.tools)
        ? body.tools
              .map(asObject)
              .filter((tool): tool is JsonObject => tool !== undefined)
        : [];
    const names = new Set(
        tools
            .map((tool) => asString(tool.name))
            .filter((name): name is string => name !== undefined),
    );
    if (!names.has("web_search")) {
        tools.push({
            type: "web_search_20250305",
            name: "web_search",
            max_uses: 5,
        });
    }
    if (fetchTool && !names.has("web_fetch")) {
        // web_fetch must be declared together with web_search.
        tools.push({
            type: "web_fetch_20250910",
            name: "web_fetch",
            max_uses: 3,
        });
    }
    body.tools = tools;

    const system = systemBlocks(body.system);
    if (
        !system.some((block) =>
            (asString(block.text) ?? "").includes(
                "x-anthropic-billing-header:",
            ),
        )
    ) {
        system.unshift({
            type: "text",
            text: "x-anthropic-billing-header: cc_entrypoint=cli;",
        });
    }
    body.system = system;
    return { ...body, model, system, tools };
}
