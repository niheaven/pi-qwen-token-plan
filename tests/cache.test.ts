import assert from "node:assert/strict";
import { test } from "node:test";
import {
    addPromptCache,
    DEFAULT_PROMPT_CACHE,
    normalizePromptCache,
    supportsPromptCache,
} from "../src/cache.ts";

test("prompt cache defaults to 5m and only accepts known retentions", () => {
    assert.equal(DEFAULT_PROMPT_CACHE, "5m");
    assert.equal(normalizePromptCache(undefined), "5m");
    assert.equal(normalizePromptCache("off"), "5m");
    assert.equal(normalizePromptCache("5m"), "5m");
    assert.equal(normalizePromptCache("1h"), "1h");
    assert.equal(normalizePromptCache("forever"), "5m");
});

test("prompt cache only targets qwen4 models", () => {
    assert.equal(supportsPromptCache("qwen4"), true);
    assert.equal(supportsPromptCache("qwen4-max"), true);
    assert.equal(supportsPromptCache("qwen4-max-preview"), true);
    assert.equal(supportsPromptCache("qwen3.8-flash"), false);
    const payload = { input: [] as unknown[], prompt_cache_options: undefined };
    assert.equal(addPromptCache(payload, "qwen3.8-flash", "5m"), payload);
    assert.deepEqual(addPromptCache(payload, "qwen4-max", "5m"), {
        input: [],
        prompt_cache_options: { mode: "implicit", ttl: "5m" },
    });
});

test("an existing cache option is preserved", () => {
    const payload = { prompt_cache_options: { mode: "explicit", ttl: "1h" } };
    assert.equal(addPromptCache(payload, "qwen4-max", "5m"), payload);
});
