import assert from "node:assert/strict";
import { test } from "node:test";
import { asNumber, asObject, asString } from "../src/json.ts";

test("JSON decoders reject the wrong shapes", () => {
    assert.deepEqual(asObject({ a: 1 }), { a: 1 });
    assert.equal(asObject([]), undefined);
    assert.equal(asObject(null), undefined);
    assert.equal(asString("x"), "x");
    assert.equal(asString(1), undefined);
    assert.equal(asNumber("1.5"), 1.5);
    assert.equal(asNumber(" "), undefined);
    assert.equal(asNumber(Number.NaN), undefined);
});
