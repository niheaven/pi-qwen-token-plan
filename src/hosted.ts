// Hosted (provider-side) tools for the Responses API. These are declared next to
// pi's function tools; the provider executes them server-side, so no local tool
// handler exists for them.
//
// Support is per model family, not blanket: the plan documents a different model
// list per tool, and a model that does not support a tool rejects the whole
// request. See web-search.md, web-extractor.md and qwen-code-interpreter.md.
import { asObject, asString, type JsonValue } from "./json.ts";

/** web_search and web_extractor share one model list. */
const WEB_FAMILIES = [
    /^auto$/, // probed: all five hosted tools work on the router model
    /^qwen4-/, // qwen4-max family
    /^qwen3\.[5-8]-(?!omni)/, // qwen3.5-3.8 max/plus/flash and open-source
    /^deepseek-v4-pro/, // deepseek-v4-pro, -0813
    /^deepseek-v4-flash/, // deepseek-v4-flash-0731
    /^deepseek-v4\.1-flash-1017/,
    /^glm-5\.2/, // glm-5.3 is not on the list
    /^kimi-k3/,
];

/** code_interpreter is narrower than web_search: no glm, no deepseek-v4-pro. */
const CODE_INTERPRETER_FAMILIES = [
    /^auto$/,
    /^qwen4-/,
    /^qwen3\.[5-8]-(?!omni)/,
    /^deepseek-v4-flash/,
    /^deepseek-v4\.1-flash-1017/,
    /^kimi-k3\.1-pro/,
];

/** Image tools are not family-wide either. */
const IMAGE_TOOL_FAMILIES = [
    /^auto$/, // probed: web_search_image and image_search both fired
    /^qwen4-max/,
    /^qwen3\.8-(?:max|flash)/,
    /^qwen3\.7-plus/,
    /^qwen3\.6-(?:plus|flash)/,
];

const MAX_LINKS = 6;
const MAX_PER_HOST = 2;

export type HostedTool = { type: string };
export type ResponsesPayload = {
    tools?: unknown[];
    input?: unknown;
    prompt_cache_options?: unknown;
};
export type MessageItem = { type?: JsonValue; content?: JsonValue[] };
export type ProviderStreamEvent = { type?: JsonValue; item?: MessageItem };

function matchesAny(modelId: string, families: RegExp[]): boolean {
    return families.some((family) => family.test(modelId));
}

export function supportsWebTools(modelId: string): boolean {
    return matchesAny(modelId, WEB_FAMILIES);
}

export function supportsCodeInterpreter(modelId: string): boolean {
    // Documented exception: qwen3.6-27b has no code_interpreter.
    if (/^qwen3\.6-27b/.test(modelId)) return false;
    return matchesAny(modelId, CODE_INTERPRETER_FAMILIES);
}

export function supportsImageTools(modelId: string): boolean {
    return matchesAny(modelId, IMAGE_TOOL_FAMILIES);
}

export function hasImageInput(
    payload: { input?: unknown } | undefined,
): boolean {
    const input = payload?.input;
    if (!Array.isArray(input)) return false;
    return input.some(
        (item) =>
            Array.isArray((item as { content?: unknown })?.content) &&
            (item as { content: unknown[] }).content.some(
                (part) => (part as { type?: unknown })?.type === "input_image",
            ),
    );
}

export function hostedToolsFor(
    modelId: string,
    payload: { input?: unknown } | undefined,
): HostedTool[] {
    const tools: HostedTool[] = [];
    if (supportsWebTools(modelId)) {
        tools.push({ type: "web_search" }, { type: "web_extractor" });
    }
    if (supportsCodeInterpreter(modelId)) {
        tools.push({ type: "code_interpreter" });
    }
    if (supportsImageTools(modelId)) {
        tools.push({ type: "web_search_image" });
        if (hasImageInput(payload)) tools.push({ type: "image_search" });
    }
    return tools;
}

/** Append the hosted tools a request is missing; existing declarations are kept as-is. */
export function addHostedTools(
    payload: ResponsesPayload | undefined,
    modelId: string,
    enabled = true,
): ResponsesPayload | undefined {
    if (!enabled || !payload) return payload;
    const current = Array.isArray(payload.tools) ? payload.tools : [];
    const missing = hostedToolsFor(modelId, payload).filter(
        (tool) =>
            !current.some(
                (present) =>
                    (present as { type?: unknown })?.type === tool.type,
            ),
    );
    if (missing.length === 0) return payload;
    return { ...payload, tools: [...current, ...missing] };
}

export type Citation = { title: string; url: string };

function citationTitle(record: unknown, url: string): string {
    return (
        (asString(asObject(record)?.title) ?? "")
            .replace(/\s+/g, " ")
            .replace(/[[\]]/g, "")
            .trim()
            .slice(0, 80) || url
    );
}

/** `web_search_call.action.sources` entries are objects with `url` (or bare URLs). */
export function searchSources(item: MessageItem | undefined): Citation[] {
    if (item?.type !== "web_search_call") return [];
    const action = asObject((item as { action?: unknown }).action);
    const list = action?.sources;
    if (!Array.isArray(list)) return [];
    const links: Citation[] = [];
    for (const entry of list) {
        const url =
            asString(entry) ?? asString(asObject(entry)?.url) ?? undefined;
        if (!url) continue;
        links.push({ title: citationTitle(entry, url), url });
    }
    return links;
}

/**
 * Citations live in two places: `message.content[].annotations` and
 * `web_search_call.action.sources`. pi's Responses parser drops both.
 */
export function citationsFor(
    item: MessageItem | undefined,
    extra: Citation[] = [],
): Citation[] {
    const content = item?.content;
    const parts = Array.isArray(content) ? content : [];
    const seen = new Set<string>();
    const perHost = new Map<string, number>();
    const links: Citation[] = [];
    const push = (title: string, url: string): boolean => {
        if (seen.has(url)) return true;
        let host: string;
        try {
            host = new URL(url).host;
        } catch {
            return true;
        }
        const used = perHost.get(host) ?? 0;
        if (used >= MAX_PER_HOST) return true;
        seen.add(url);
        perHost.set(host, used + 1);
        links.push({ title, url });
        return links.length < MAX_LINKS;
    };
    for (const link of extra) {
        if (!push(link.title, link.url)) return links;
    }
    for (const part of parts) {
        const annotations = asObject(part)?.annotations;
        if (!Array.isArray(annotations)) continue;
        for (const annotation of annotations) {
            const url = asString(asObject(annotation)?.url);
            if (!url) continue;
            if (!push(citationTitle(annotation, url), url)) return links;
        }
    }
    return links;
}

/**
 * Append the source list to the finished message text. The parser replaces the
 * streamed text with `item.content` at `response.output_item.done`, so a late
 * append shows up exactly once, at the end.
 */
export function appendSources(
    item: MessageItem | undefined,
    extra: Citation[] = [],
): boolean {
    if (item?.type !== "message") return false;
    const links = citationsFor(item, extra);
    if (links.length === 0) return false;
    const parts = item.content;
    if (!Array.isArray(parts)) return false;
    const target = parts
        .toReversed()
        .map(asObject)
        .find((part) => asString(part?.text) !== undefined);
    const text = asString(target?.text);
    if (!target || text === undefined || text.includes("\n---\nSources:"))
        return false;
    target.text =
        `${text}\n\n---\nSources:\n` +
        links.map((link) => `- [${link.title}](<${link.url}>)`).join("\n");
    return true;
}

export type ToolUsage = Record<string, number>;

let lastToolUsage: ToolUsage | undefined;

/** Tool call counts from the most recent response, for `/qwen-tokens`. */
export function toolUsage(): ToolUsage | undefined {
    return lastToolUsage;
}

function recordToolUsage(response: unknown): void {
    const body = asObject(response);
    const counts: ToolUsage = {};
    const collect = (value: unknown): void => {
        const record = asObject(value);
        if (!record) return;
        for (const [tool, entry] of Object.entries(record)) {
            const requests = asObject(entry)?.num_requests;
            if (typeof requests === "number") counts[tool] = requests;
        }
    };
    collect(body?.tool_usage);
    collect(asObject(body?.usage)?.x_tools);
    if (Object.keys(counts).length > 0) lastToolUsage = counts;
}

/**
 * One augmenter per request: it collects `web_search_call` sources while the
 * stream runs and appends them to the message that closes the response.
 */
export function createStreamAugmenter(): (event: JsonValue) => void {
    const collected: Citation[] = [];
    return (event: JsonValue): void => {
        const streamEvent = asObject(event) as ProviderStreamEvent | undefined;
        const type = streamEvent?.type;
        if (type === "response.output_item.done") {
            const item = streamEvent?.item;
            if (item?.type === "web_search_call") {
                collected.push(...searchSources(item));
                return;
            }
            appendSources(item, collected);
            return;
        }
        if (type === "response.completed") {
            recordToolUsage(asObject(streamEvent)?.response);
        }
    };
}
