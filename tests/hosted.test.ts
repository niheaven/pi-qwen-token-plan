import assert from "node:assert/strict";
import { test } from "node:test";
import {
    addHostedTools,
    appendSources,
    citationsFor,
    createStreamAugmenter,
    hostedToolsFor,
    searchSources,
    supportsCodeInterpreter,
    supportsWebTools,
    toolUsage,
} from "../src/hosted.ts";

test("hosted tools are gated by model family", () => {
    const names = (id: string) =>
        hostedToolsFor(id, {}).map((tool) => tool.type);
    assert.deepEqual(names("qwen4-max"), [
        "web_search",
        "web_extractor",
        "code_interpreter",
        "web_search_image",
    ]);
    // Probed: the router model accepts every hosted tool.
    assert.deepEqual(names("auto"), [
        "web_search",
        "web_extractor",
        "code_interpreter",
        "web_search_image",
    ]);
    // deepseek-v4-pro has web tools but no code_interpreter.
    assert.deepEqual(names("deepseek-v4-pro-0813"), [
        "web_search",
        "web_extractor",
    ]);
    assert.deepEqual(names("deepseek-v4-flash-0731"), [
        "web_search",
        "web_extractor",
        "code_interpreter",
    ]);
    assert.deepEqual(names("deepseek-v4.1-flash-1017"), [
        "web_search",
        "web_extractor",
        "code_interpreter",
    ]);
    // Not on the web-tool list and no glm code interpreter either.
    assert.deepEqual(names("deepseek-v4.1-flash"), []);
    assert.deepEqual(names("glm-5.2"), ["web_search", "web_extractor"]);
    assert.deepEqual(names("glm-5.3"), []);
});

test("image tools follow their own family list", () => {
    const names = (id: string) =>
        hostedToolsFor(id, {}).map((tool) => tool.type);
    assert.ok(names("qwen3.8-max-0902").includes("web_search_image"));
    assert.ok(names("qwen3.6-plus").includes("web_search_image"));
    // qwen3.7-max only gained image tools in the 2026-06-08 snapshot.
    assert.ok(!names("qwen3.7-max").includes("web_search_image"));
    assert.ok(names("qwen3.7-plus").includes("web_search_image"));
});

test("supportsCodeInterpreter excludes qwen3.6-27b", () => {
    assert.equal(supportsCodeInterpreter("qwen3.6-plus"), true);
    assert.equal(supportsCodeInterpreter("qwen3.6-27b"), false);
    assert.equal(supportsCodeInterpreter("glm-5.2"), false);
    assert.equal(supportsWebTools("glm-5.2"), true);
});

test("existing hosted tools are not duplicated", () => {
    const payload = { tools: [{ type: "function", name: "read" }] };
    const withTools = addHostedTools(payload, "qwen4-max") as {
        tools: { type: string }[];
    };
    const again = addHostedTools(withTools, "qwen4-max") as {
        tools: unknown[];
    };
    assert.equal(again.tools.length, withTools.tools.length);
});

test("web_search_call sources become citations", () => {
    const item = {
        type: "web_search_call",
        action: {
            sources: [
                { url: "https://b.example/1", title: "B one" },
                "https://c.example/2",
            ],
        },
    };
    assert.deepEqual(searchSources(item), [
        { title: "B one", url: "https://b.example/1" },
        { title: "https://c.example/2", url: "https://c.example/2" },
    ]);
    assert.deepEqual(searchSources({ type: "message" }), []);
});

test("annotations become one bounded source list", () => {
    const item = {
        type: "message",
        content: [
            {
                type: "output_text",
                text: "answer",
                annotations: [
                    {
                        type: "url_citation",
                        url: "https://a.example/1",
                        title: "A one",
                    },
                    {
                        type: "url_citation",
                        url: "https://a.example/2",
                        title: "A two",
                    },
                    {
                        type: "url_citation",
                        url: "https://a.example/3",
                        title: "A three",
                    },
                ],
            },
        ],
    };
    assert.equal(citationsFor(item).length, 2);
    assert.equal(appendSources(item), true);
    assert.match(item.content[0].text, /Sources:/);
    assert.match(
        item.content[0].text,
        /\[A one\]\(<https:\/\/a\.example\/1>\)/,
    );
    // A second pass must not duplicate the list.
    assert.equal(appendSources(item), false);
});

test("streamed search sources are appended to the message", () => {
    const augment = createStreamAugmenter();
    augment({
        type: "response.output_item.done",
        item: {
            type: "web_search_call",
            action: { sources: [{ url: "https://d.example/1" }] },
        },
    });
    const message = {
        type: "message",
        content: [{ type: "output_text", text: "answer" }],
    };
    augment({ type: "response.output_item.done", item: message });
    assert.match(message.content[0].text, /https:\/\/d\.example\/1/);
});

test("tool usage is recorded from the completed response", () => {
    const augment = createStreamAugmenter();
    augment({
        type: "response.completed",
        response: {
            tool_usage: {
                web_search: { num_requests: 2 },
                web_extractor: { num_requests: 1 },
            },
        },
    });
    assert.deepEqual(toolUsage(), { web_search: 2, web_extractor: 1 });
});
