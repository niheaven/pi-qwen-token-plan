import assert from "node:assert/strict";
import { test } from "node:test";
import { structuredJson } from "../src/structured.ts";

test("json_object without a schema", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = (async (url: string, init: { body?: string }) => {
        assert.match(url, /\/responses$/);
        sent = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        return Response.json({
            id: "resp_1",
            output: [
                {
                    type: "message",
                    content: [{ type: "output_text", text: '{"a":1}' }],
                },
            ],
        });
    }) as unknown as typeof fetch;
    const result = await structuredJson({
        baseUrl: "https://host/compatible-mode/v1",
        apiKey: "k",
        prompt: "give me json",
        fetchImpl,
    });
    assert.equal(result.text, '{"a":1}');
    assert.deepEqual(sent?.text, { format: { type: "json_object" } });
});

test("json_schema carries name, schema and strict", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: { body?: string }) => {
        sent = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        return Response.json({
            output: [
                {
                    type: "message",
                    content: [{ type: "output_text", text: "{}" }],
                },
            ],
        });
    }) as unknown as typeof fetch;
    const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
    };
    await structuredJson({
        baseUrl: "https://host/compatible-mode/v1",
        apiKey: "k",
        prompt: "extract",
        schema,
        name: "person",
        model: "qwen4-max",
        fetchImpl,
    });
    assert.equal(sent?.model, "qwen4-max");
    assert.deepEqual(sent?.text, {
        format: {
            type: "json_schema",
            json_schema: { name: "person", schema, strict: true },
        },
    });
});

test("an error response reports the provider message", async () => {
    const fetchImpl = (async () =>
        Response.json(
            { error: { message: "Unsupported model" } },
            { status: 400 },
        )) as unknown as typeof fetch;
    await assert.rejects(
        structuredJson({
            baseUrl: "https://host/compatible-mode/v1",
            apiKey: "k",
            prompt: "x",
            fetchImpl,
        }),
        /Unsupported model/,
    );
});

// Keep the helper type-checked even though only the second test uses it.
