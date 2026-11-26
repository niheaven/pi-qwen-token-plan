import assert from "node:assert/strict";
import { test } from "node:test";
import {
    buildImageBody,
    buildVideoBody,
    dashScopeRoot,
    parseImageUrls,
    parseVideoUrl,
} from "../src/media.ts";

test("dashScopeRoot strips the compatible-mode suffix", () => {
    assert.equal(
        dashScopeRoot(
            "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        ),
        "https://token-plan.cn-beijing.maas.aliyuncs.com",
    );
    assert.equal(dashScopeRoot("https://host/"), "https://host");
});

test("image body carries text and input images", () => {
    const body = buildImageBody({
        model: "qwen-image-2.0",
        prompt: "a cube",
        size: "1024*1024",
        images: [{ data: "AAAA", mimeType: "image/png" }],
    });
    assert.equal(body.model, "qwen-image-2.0");
    assert.deepEqual(
        (body.input as { messages: { content: unknown[] }[] }).messages[0]
            .content,
        [{ text: "a cube" }, { image: "data:image/png;base64,AAAA" }],
    );
    assert.equal((body.parameters as { size: string }).size, "1024*1024");
});

test("negative prompt and agent extend are 3.0-only text-to-image options", () => {
    const three = buildImageBody({
        model: "qwen-image-3.0-pro",
        prompt: "a cube",
        negativePrompt: "blurry",
        seed: 7,
        promptExtendMode: "agent",
    });
    const parameters = three.parameters as Record<string, unknown>;
    assert.equal(parameters.negative_prompt, "blurry");
    assert.equal(parameters.seed, 7);
    assert.equal(parameters.prompt_extend_mode, "agent");

    const older = buildImageBody({
        model: "qwen-image-2.0",
        prompt: "a cube",
        negativePrompt: "blurry",
        promptExtendMode: "agent",
    });
    assert.equal(
        (older.parameters as Record<string, unknown>).negative_prompt,
        undefined,
    );

    // Agent extend is rejected for image editing, so it is dropped with inputs.
    const editing = buildImageBody({
        model: "qwen-image-3.0-pro",
        prompt: "a cube",
        images: [{ data: "AAAA", mimeType: "image/png" }],
        promptExtendMode: "agent",
    });
    assert.equal(
        (editing.parameters as Record<string, unknown>).prompt_extend_mode,
        undefined,
    );
});

test("image response URLs come from choices and results", () => {
    assert.deepEqual(
        parseImageUrls({
            output: {
                choices: [
                    {
                        message: {
                            content: [
                                { image: "https://a/1.png" },
                                { image: "https://a/2.png" },
                            ],
                        },
                    },
                ],
                results: [
                    { url: "https://a/1.png" },
                    { url: "https://a/3.png" },
                ],
            },
        }),
        ["https://a/1.png", "https://a/2.png", "https://a/3.png"],
    );
});

test("video body uses the media first frame", () => {
    const body = buildVideoBody({
        model: "wan3.0-video",
        prompt: "move",
        image: { data: "BBBB", mimeType: "image/jpeg" },
        resolution: "720P",
        duration: 5,
    });
    assert.deepEqual((body.input as { media: unknown[] }).media, [
        { type: "first_frame", url: "data:image/jpeg;base64,BBBB" },
    ]);
    assert.equal((body.parameters as { duration: number }).duration, 5);
});

test("video result URL accepts both shapes", () => {
    assert.equal(
        parseVideoUrl({ output: { video_url: "https://v/1.mp4" } }),
        "https://v/1.mp4",
    );
    assert.equal(
        parseVideoUrl({ output: { results: [{ url: "https://v/2.mp4" }] } }),
        "https://v/2.mp4",
    );
});

test("web_fetch reads the raw web_extractor output", async () => {
    const { webFetch } = await import("../src/webfetch.ts");
    let sent: Record<string, unknown> | undefined;
    let headers: Record<string, string> | undefined;
    const fakeFetch = (async (
        _url: string,
        init: { body?: string; headers?: Record<string, string> },
    ) => {
        headers = init.headers;
        sent = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        return Response.json({
            id: "resp_1",
            output: [
                {
                    type: "web_extractor_call",
                    output: "raw page text",
                    urls: ["https://example.com"],
                },
                { type: "message", content: [{ text: "model answer" }] },
            ],
        });
    }) as unknown as typeof fetch;
    const result = await webFetch({
        baseUrl: "https://host/compatible-mode/v1",
        apiKey: "k",
        url: "https://example.com",
        sessionId: "session-1",
        fetchImpl: fakeFetch,
    });
    assert.equal(result.text, "raw page text");
    assert.equal(headers?.["x-session-id"], "session-1");
    assert.equal(sent?.prompt_cache_key, "session-1");
    assert.deepEqual(
        ((sent as { tools?: { type: string }[] } | undefined)?.tools ?? []).map(
            (tool) => tool.type,
        ),
        ["web_search", "web_extractor"],
    );
});
