// pi has no web_fetch tool. The plan's web_extractor is a provider-hosted tool,
// so it only runs inside a model response. This bridge sends a minimal
// non-streaming Responses request with web_search + web_extractor, then reads
// the raw `web_extractor_call.output` item. web_extractor is rejected unless
// web_search is declared alongside it.
export type WebFetchResult = {
    text: string;
    url: string;
    requestId?: string;
    model: string;
};

const REQUEST_TIMEOUT_MS = 120_000;

type OutputItem = {
    type?: unknown;
    output?: unknown;
    urls?: unknown;
    content?: unknown;
};

function messageText(items: OutputItem[]): string {
    const parts: string[] = [];
    for (const item of items) {
        if (item?.type !== "message" || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            const text = (part as { text?: unknown })?.text;
            if (typeof text === "string") parts.push(text);
        }
    }
    return parts.join("\n").trim();
}

export async function webFetch({
    baseUrl,
    apiKey,
    url,
    prompt,
    model = "qwen3.8-flash",
    maxChars = 20_000,
    sessionId,
    signal,
    fetchImpl = fetch,
}: {
    baseUrl: string;
    apiKey: string;
    url: string;
    prompt?: string;
    model?: string;
    maxChars?: number;
    sessionId?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}): Promise<WebFetchResult> {
    if (!/^https?:\/\//i.test(url))
        throw new Error("url must start with http:// or https://");
    const instruction =
        `Use the web_extractor tool on ${url}. ` +
        (prompt?.trim() || "Return the page's main text.") +
        " Do not summarize unless the instruction asks for a summary.";
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(
        `${baseUrl.replace(/\/+$/, "")}/responses`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                accept: "application/json",
                ...(sessionId ? { "x-session-id": sessionId } : {}),
            },
            body: JSON.stringify({
                model,
                input: instruction,
                stream: false,
                max_output_tokens: 1200,
                ...(sessionId ? { prompt_cache_key: sessionId } : {}),
                tools: [{ type: "web_search" }, { type: "web_extractor" }],
            }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
    );
    const raw = await response.text();
    const payload = parseWebFetch(raw, response.status);
    const output = Array.isArray(payload.output)
        ? (payload.output as OutputItem[])
        : [];
    const call = output.find(
        (item) =>
            item?.type === "web_extractor_call" &&
            typeof item.output === "string",
    );
    const extracted = typeof call?.output === "string" ? call.output : "";
    const text = (extracted || messageText(output)).slice(
        0,
        Math.max(200, maxChars),
    );
    if (!text) throw new Error("web_extractor returned no content");
    const requestId = typeof payload.id === "string" ? payload.id : undefined;
    const result: WebFetchResult = { text, url, model };
    if (requestId) result.requestId = requestId;
    return result;
}

function parseWebFetch(raw: string, status: number): Record<string, unknown> {
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new Error(
            `web_fetch returned HTTP ${status}: ${raw.slice(0, 300)}`,
        );
    }
    if (status >= 400 || status === 0) {
        const error = (payload as { error?: { message?: unknown } }).error;
        const message =
            typeof error?.message === "string"
                ? error.message
                : raw.slice(0, 300);
        throw new Error(`web_fetch HTTP ${status}: ${message}`);
    }
    return payload;
}
