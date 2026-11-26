// Structured output lives on the Responses API as top-level `text.format`, which
// pi's model layer does not expose. A local one-shot call keeps it usable without
// forcing every assistant turn into JSON.
import { asObject, asString, type JsonObject } from "./json.ts";

const REQUEST_TIMEOUT_MS = 120_000;

export type StructuredSync = {
    baseUrl: string;
    apiKey: string;
    prompt: string;
    /** JSON Schema object; without it the model only promises valid JSON. */
    schema?: JsonObject;
    name?: string;
    model?: string;
    maxTokens?: number;
    sessionId?: string;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
};

export type StructuredResult = {
    text: string;
    model: string;
    requestId?: string;
};

export async function structuredJson({
    baseUrl,
    apiKey,
    prompt,
    schema,
    name = "result",
    model = "qwen3.8-flash",
    maxTokens = 4096,
    sessionId,
    signal,
    fetchImpl = fetch,
}: StructuredSync): Promise<StructuredResult> {
    const format = schema
        ? { type: "json_schema", json_schema: { name, schema, strict: true } }
        : { type: "json_object" };
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
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
                input: prompt,
                stream: false,
                max_output_tokens: maxTokens,
                text: { format },
            }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        },
    );
    const raw = await response.text();
    const payload = parseStructured(raw, response.status);
    const output = Array.isArray(payload.output) ? payload.output : [];
    const text = outputText(output);
    if (!text) throw new Error("structured output returned no text");
    const requestId = asString(payload.id);
    return { text, model, ...(requestId ? { requestId } : {}) };
}

function parseStructured(raw: string, status: number): JsonObject {
    let payload: JsonObject;
    try {
        payload = asObject(JSON.parse(raw)) ?? {};
    } catch {
        throw new Error(
            `structured output HTTP ${status}: ${raw.slice(0, 300)}`,
        );
    }
    if (status >= 400 || status === 0) {
        const message = asString(asObject(payload.error)?.message);
        throw new Error(
            `structured output HTTP ${status}: ${message ?? raw.slice(0, 300)}`,
        );
    }
    return payload;
}

function outputText(output: unknown[]): string {
    return output
        .filter((item) => asObject(item)?.type === "message")
        .flatMap((item) => {
            const content = asObject(item)?.content;
            return Array.isArray(content) ? content : [];
        })
        .map((part) => asString(asObject(part)?.text) ?? "")
        .join("")
        .trim();
}
