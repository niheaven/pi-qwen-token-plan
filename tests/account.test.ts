import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    adoptAccountEnv,
    pruneAccounts,
    readAccount,
    writeAccount,
} from "../src/account.ts";

async function withAgentDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "qwen-account-"));
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
        return await fn(dir);
    } finally {
        if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = saved;
        rmSync(dir, { recursive: true, force: true });
    }
}

function stored(dir: string): Record<string, { type?: string; key?: string }> {
    return JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")) as Record<
        string,
        { type?: string; key?: string }
    >;
}

test("writing the account stores an api_key entry for the chosen id", async () => {
    await withAgentDir(async (dir) => {
        await writeAccount("qwen-token-plan-individual-cn", "sk-sp-test");
        const store = stored(dir);
        assert.deepEqual(Object.keys(store), ["qwen-token-plan-individual-cn"]);
        assert.equal(store["qwen-token-plan-individual-cn"]?.key, "sk-sp-test");
        assert.equal(store["qwen-token-plan-individual-cn"]?.type, "api_key");
        assert.equal(readAccount()?.provider, "qwen-token-plan-individual-cn");
        assert.equal(readAccount()?.access, "sk-sp-test");
    });
});

test("writing the account drops the other Qwen ids", async () => {
    await withAgentDir(async (dir) => {
        await writeAccount("qwen-token-plan-cn", "sk-sp-a");
        await writeAccount("qwen-token-plan-individual", "sk-sp-b");
        assert.deepEqual(Object.keys(stored(dir)), [
            "qwen-token-plan-individual",
        ]);
        // Unrelated providers are left alone.
        writeFileSync(
            join(dir, "auth.json"),
            JSON.stringify({ ...stored(dir), anthropic: { type: "api_key" } }),
        );
        await writeAccount("qwen-token-plan-cn", "sk-sp-c");
        assert.deepEqual(Object.keys(stored(dir)).sort(), [
            "anthropic",
            "qwen-token-plan-cn",
        ]);
    });
});

test("pruning keeps our entry over a stale oauth one", async () => {
    await withAgentDir(async (dir) => {
        writeFileSync(
            join(dir, "auth.json"),
            JSON.stringify({
                "qwen-token-plan-cn": { type: "oauth", access: "ghost" },
                "qwen-token-plan-individual-cn": {
                    type: "api_key",
                    key: "sk-sp-real",
                },
            }),
        );
        assert.equal(readAccount()?.provider, "qwen-token-plan-individual-cn");
        await pruneAccounts();
        assert.deepEqual(Object.keys(stored(dir)), [
            "qwen-token-plan-individual-cn",
        ]);
    });
});

test("a single credential is left alone by pruning", async () => {
    await withAgentDir(async (dir) => {
        writeFileSync(
            join(dir, "auth.json"),
            JSON.stringify({
                "qwen-token-plan-cn": {
                    type: "oauth",
                    access: "sk-sp-team",
                },
            }),
        );
        await pruneAccounts();
        assert.deepEqual(Object.keys(stored(dir)), ["qwen-token-plan-cn"]);
        assert.equal(readAccount()?.access, "sk-sp-team");
    });
});

test("the account is published into the id's own env key only", async () => {
    const saved = {
        team: process.env.QWEN_TOKEN_PLAN_TEAM_CN_API_KEY,
        shared: process.env.QWEN_TOKEN_PLAN_CN_API_KEY,
    };
    delete process.env.QWEN_TOKEN_PLAN_TEAM_CN_API_KEY;
    delete process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
    try {
        adoptAccountEnv({
            provider: "qwen-token-plan-cn",
            access: "sk-sp-env",
        });
        assert.equal(process.env.QWEN_TOKEN_PLAN_TEAM_CN_API_KEY, "sk-sp-env");
        // The shared key would light up the individual id as well.
        assert.equal(process.env.QWEN_TOKEN_PLAN_CN_API_KEY, undefined);
    } finally {
        if (saved.team === undefined)
            delete process.env.QWEN_TOKEN_PLAN_TEAM_CN_API_KEY;
        else process.env.QWEN_TOKEN_PLAN_TEAM_CN_API_KEY = saved.team;
        if (saved.shared === undefined)
            delete process.env.QWEN_TOKEN_PLAN_CN_API_KEY;
        else process.env.QWEN_TOKEN_PLAN_CN_API_KEY = saved.shared;
    }
});
