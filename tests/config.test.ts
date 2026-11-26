import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/config.ts";
import { buildModels, isImageModel } from "../src/models.ts";

test("settings normalize bad values to defaults", () => {
    assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    const value = normalizeSettings({
        quota: {
            show: false,
            windows: 9,
            refreshMinutes: 0,
            seatFilter: "  team  ",
            bar: true,
        },
        hostedTools: false,
        modelSyncHours: -5,
    });
    assert.equal(value.quota.show, false);
    assert.equal(value.quota.windows, 3);
    assert.equal(value.quota.refreshMinutes, 1);
    assert.equal(value.quota.seatFilter, "team");
    assert.equal(value.quota.bar, true);
    assert.equal(value.hostedTools, false);
    assert.equal(value.modelSyncHours, 0);
    assert.equal(value.imageModel, "qwen-image-3.0-pro");
    assert.equal(value.imageSize, "auto");
    assert.equal(value.videoModel, "happyhorse");
    assert.equal(value.videoResolution, "auto");
    assert.equal(value.promptCache, "5m");
    const media = normalizeSettings({
        imageModel: "wan2.7-image",
        imageSize: "1328*1328",
        videoModel: "wan",
        videoResolution: "1080P",
        promptCache: "1h",
    });
    assert.equal(media.imageModel, "wan2.7-image");
    assert.equal(media.imageSize, "1328*1328");
    assert.equal(media.videoModel, "wan");
    assert.equal(media.videoResolution, "1080P");
    assert.equal(media.promptCache, "1h");
    assert.equal(normalizeSettings({ promptCache: "1h" }).promptCache, "1h");
    assert.equal(normalizeSettings({ imageSize: "huge" }).imageSize, "auto");
    assert.equal(
        normalizeSettings({ videoResolution: "4K" }).videoResolution,
        "auto",
    );
});

test("auto is a thinking-only, vision-capable router model", () => {
    const [auto] = buildModels(["auto"], "https://host/compatible-mode/v1");
    assert.equal(auto.api, "openai-responses");
    assert.deepEqual(auto.input, ["text", "image"]);
    // It always thinks, so pi must never send reasoning.effort "none".
    assert.equal(auto.thinkingLevelMap?.off, null);
    assert.equal(auto.thinkingLevelMap?.low, "low");
    assert.equal(auto.maxTokens, 262_144);
});

test("image models are classified separately from chat", () => {
    assert.equal(isImageModel("qwen-image-2.0"), true);
    assert.equal(isImageModel("wan2.7-image-pro"), true);
    assert.equal(isImageModel("qwen-image-2.0-edit"), false);
    assert.equal(isImageModel("qwen3.8-flash"), false);
    const models = buildModels(
        ["qwen3.8-flash", "qwen-image-2.0", "wan2.7-image", "glm-5"],
        "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    );
    assert.deepEqual(
        models.map((model) => [
            model.id,
            "type" in model ? model.type : undefined,
        ]),
        [
            ["qwen3.8-flash", undefined],
            ["qwen-image-2.0", "image"],
            ["wan2.7-image", "image"],
            ["glm-5", undefined],
        ],
    );
    const image = models[1] as { baseUrl: string; api: string };
    assert.equal(
        image.baseUrl,
        "https://token-plan.cn-beijing.maas.aliyuncs.com",
    );
    assert.equal(image.api, "qwen-images");
    const messages = models[3] as { api: string; baseUrl: string };
    assert.equal(messages.api, "anthropic-messages");
    assert.equal(
        messages.baseUrl,
        "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
    );
});
