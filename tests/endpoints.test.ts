import assert from "node:assert/strict";
import { test } from "node:test";
import {
    endpointsFor,
    parseEndpoints,
    resolveRegion,
} from "../src/endpoints.ts";

test("endpoints derive the anthropic sibling", () => {
    assert.deepEqual(
        endpointsFor(
            "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
        ),
        {
            openai: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
            anthropic:
                "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic",
        },
    );
});

test("stored refresh JSON restores both endpoints", () => {
    const endpoints = parseEndpoints(
        JSON.stringify({
            openai: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
            anthropic: "https://custom.example/apps/anthropic",
        }),
    );
    assert.equal(
        endpoints?.openai,
        "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    );
    assert.equal(endpoints?.anthropic, "https://custom.example/apps/anthropic");
    assert.equal(parseEndpoints(""), undefined);
    assert.equal(parseEndpoints("not json"), undefined);
});

test("region defaults to China and accepts only known ids", () => {
    assert.equal(resolveRegion(undefined), "cn");
    assert.equal(resolveRegion("sg"), "global");
    assert.equal(resolveRegion("global"), "global");
    assert.equal(resolveRegion("eu"), "cn");
});
