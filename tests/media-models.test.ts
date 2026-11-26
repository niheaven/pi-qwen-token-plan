import assert from "node:assert/strict";
import { test } from "node:test";
import {
    DEFAULT_IMAGE_MODEL,
    DEFAULT_VIDEO_FAMILY,
    normalizeImageModel,
    normalizeVideoFamily,
    resolveVideoSelection,
} from "../src/media-models.ts";

test("media defaults follow the plan's verified models", () => {
    assert.equal(DEFAULT_IMAGE_MODEL, "qwen-image-3.0-pro");
    assert.equal(DEFAULT_VIDEO_FAMILY, "happyhorse");
    assert.equal(normalizeImageModel("wan2.7-image-pro"), "wan2.7-image-pro");
    assert.equal(normalizeImageModel("unknown"), "qwen-image-3.0-pro");
    assert.equal(normalizeVideoFamily("wan"), "wan");
    assert.equal(normalizeVideoFamily("unknown"), "happyhorse");
});

test("video mode is inferred from image and reference inputs", () => {
    assert.deepEqual(resolveVideoSelection({ family: "happyhorse" }), {
        family: "happyhorse",
        mode: "t2v",
        model: "happyhorse-1.1-t2v",
    });
    assert.deepEqual(
        resolveVideoSelection({ family: "happyhorse", hasImage: true }),
        {
            family: "happyhorse",
            mode: "i2v",
            model: "happyhorse-1.1-i2v",
        },
    );
    assert.deepEqual(
        resolveVideoSelection({
            family: "happyhorse",
            hasImage: true,
            referenceCount: 2,
        }),
        {
            family: "happyhorse",
            mode: "r2v",
            model: "happyhorse-1.1-r2v",
        },
    );
    assert.deepEqual(
        resolveVideoSelection({ family: "wan", referenceCount: 1 }),
        {
            family: "wan",
            mode: "r2v",
            model: "wan3.0-video",
        },
    );
});
