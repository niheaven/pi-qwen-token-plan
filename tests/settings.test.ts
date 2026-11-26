import assert from "node:assert/strict";
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    agentDir,
    DEFAULT_SETTINGS,
    saveSettings,
    settingsPath,
} from "../src/config.ts";

test("PI_CODING_AGENT_DIR selects the agent directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-qwen-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
        assert.equal(agentDir(), dir);
        assert.equal(settingsPath(), join(dir, "qwen-token-plan-config.json"));
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a corrupt shared settings file is backed up, not silently lost", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-qwen-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
        writeFileSync(settingsPath(), "{not json");
        saveSettings(DEFAULT_SETTINGS);
        const files = readdirSync(dir);
        assert.equal(
            files.some((name) =>
                name.startsWith("qwen-token-plan-config.json.corrupt-"),
            ),
            true,
        );
        const saved = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
            promptCache?: string;
        };
        assert.equal(saved.promptCache, "5m");
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(dir, { recursive: true, force: true });
    }
});
