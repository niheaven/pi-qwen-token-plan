import assert from "node:assert/strict";
import { test } from "node:test";
import {
    injectAnthropicServerTools,
    supportsAnthropicWebFetch,
    supportsAnthropicWebSearch,
} from "../src/anthropic-tools.ts";

test("server tool support follows the documented model list", () => {
    assert.equal(supportsAnthropicWebSearch("qwen3.8-flash"), true);
    assert.equal(supportsAnthropicWebSearch("qwen4-max"), true);
    assert.equal(supportsAnthropicWebSearch("glm-5.2"), true);
    assert.equal(supportsAnthropicWebSearch("glm-5"), false);
    assert.equal(supportsAnthropicWebSearch("kimi-k2.7-code"), false);
    assert.equal(supportsAnthropicWebFetch("qwen4-max"), true);
    assert.equal(supportsAnthropicWebFetch("qwen3.8-flash"), false);
    assert.equal(supportsAnthropicWebFetch("kimi-k3.1-pro"), true);
});

test("injection adds web_search and the billing marker", () => {
    const payload = {
        model: "qwen3.8-flash",
        system: [{ type: "text", text: "be brief" }],
        tools: [{ name: "bash", input_schema: { type: "object" } }],
    };
    const result = injectAnthropicServerTools(payload) as typeof payload & {
        system: { text: string }[];
        tools: { type?: string; name?: string }[];
    };
    assert.equal(
        result.tools.some((tool) => tool.name === "web_search"),
        true,
    );
    assert.equal(
        result.tools.some((tool) => tool.name === "web_fetch"),
        false,
    );
    assert.equal(
        result.system[0]?.text,
        "x-anthropic-billing-header: cc_entrypoint=cli;",
    );
    assert.equal(result.system[1]?.text, "be brief");
});

test("injection is idempotent and ignores unsupported models", () => {
    const payload = {
        model: "qwen4-max",
        system: [],
        tools: [{ type: "web_search_20250305", name: "web_search" }],
    };
    injectAnthropicServerTools(payload);
    const result = injectAnthropicServerTools(payload) as typeof payload & {
        system: { text: string }[];
        tools: { name?: string }[];
    };
    assert.equal(
        result.tools.filter((tool) => tool.name === "web_search").length,
        1,
    );
    assert.equal(
        result.tools.some((tool) => tool.name === "web_fetch"),
        true,
    );
    assert.equal(
        result.system.filter((block) =>
            (block as { text?: string }).text?.includes(
                "x-anthropic-billing-header:",
            ),
        ).length,
        1,
    );
    const untouched = { model: "glm-5", system: [], tools: [] };
    assert.equal(injectAnthropicServerTools(untouched), undefined);
});
