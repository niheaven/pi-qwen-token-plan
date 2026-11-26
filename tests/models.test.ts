import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModels, isResponsesModel } from "../src/models.ts";

test("responses capability follows the family, not the catalog size", () => {
    assert.equal(isResponsesModel("qwen3.8-flash"), true);
    assert.equal(isResponsesModel("deepseek-v4-pro"), true);
    assert.equal(isResponsesModel("glm-5"), false);
    assert.equal(isResponsesModel("glm-5.1"), false);
    assert.equal(isResponsesModel("glm-5.2"), true);
    assert.equal(isResponsesModel("glm-5.3"), true);
    assert.equal(isResponsesModel("kimi-k2.5"), false);
    assert.equal(isResponsesModel("qwen-image-2.0"), false);
    assert.equal(isResponsesModel("auto"), true);
});

test("known models keep their metadata and unknown ones get a fallback", () => {
    const models = buildModels([
        "qwen3.8-flash",
        "qwen4-max",
        "glm-5",
        "glm-5.3",
        "qwen3.8-flash",
    ]);
    assert.deepEqual(
        models.map((model) => model.id),
        ["qwen3.8-flash", "qwen4-max", "glm-5", "glm-5.3"],
    );
    const flash = models[0] as import("../src/models.ts").ModelConfig;
    assert.equal(flash.api, "openai-responses");
    assert.deepEqual(flash.input, ["text", "image"]);
    assert.equal(flash.maxTokens, 131_072);
    assert.equal(flash.thinkingLevelMap?.high, null);
    const max = models[1] as import("../src/models.ts").ModelConfig;
    assert.equal(max.maxTokens, 262_144);
    assert.equal(max.thinkingLevelMap?.high, "high");
    const glm5 = models[2] as import("../src/models.ts").ModelConfig;
    assert.equal(glm5.api, "anthropic-messages");
    assert.deepEqual(glm5.input, ["text"]);
    assert.equal(glm5.maxTokens, 65_536);
    const glm = models[3] as import("../src/models.ts").ModelConfig;
    assert.deepEqual(glm.input, ["text"]);
    assert.equal(glm.maxTokens, 131_072);
});
test("Anthropic models derive the apps/anthropic base URL", async () => {
    const { buildMessagesModel } = await import("../src/models.ts");
    assert.equal(
        buildMessagesModel(
            "glm-5",
            "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        ).baseUrl,
        "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    );
    const custom = buildMessagesModel("glm-5", "https://proxy.example/v1");
    assert.equal(custom.baseUrl, "https://proxy.example/v1/apps/anthropic");
});
