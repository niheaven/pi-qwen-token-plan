import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    buildAcsCanonicalQuery,
    fetchQuota,
    parseSeats,
    parseUsageWindows,
    readBailianConfig,
    resolveOpenApi,
    signAcsRequest,
    statusText,
    usage,
    windowLabel,
} from "../src/quota.ts";

test("token-plan percentages are used fractions", () => {
    const windows = parseUsageWindows({
        data: {
            DataV2: {
                data: {
                    data: {
                        per5HourPercentage: 0.25,
                        per1WeekPercentage: 0.5,
                        per1MonthResetTime: 1798012800000,
                    },
                },
            },
        },
    });
    assert.deepEqual(
        windows.map((window) => [window.key, window.percentRemaining]),
        [
            ["per5Hour", 75],
            ["per1Week", 50],
        ],
    );
});

test("seats keep NORMAL rows and derive the remaining ratio", () => {
    const seats = parseSeats({
        Data: {
            Items: [
                {
                    Status: "NORMAL",
                    AccountName: "alice",
                    SpecType: "pro",
                    EquityList: [
                        {
                            CycleSurplusValue: 75,
                            CycleTotalValue: 100,
                            CycleEndTime: 1798012800000,
                        },
                    ],
                },
                { Status: "RELEASE", AccountName: "gone" },
            ],
        },
    });
    assert.equal(seats.length, 1);
    assert.equal(seats[0].name, "alice");
    assert.equal(seats[0].percentRemaining, 75);
});

test("status text prefers the two nearest windows", () => {
    const report = {
        at: 0,
        source: "token-plan" as const,
        windows: [
            {
                key: "per5Hour",
                count: 5,
                unit: "Hour" as const,
                percentRemaining: 82,
                resetsAt: 0,
            },
            {
                key: "per1Week",
                count: 1,
                unit: "Week" as const,
                percentRemaining: 64,
            },
            {
                key: "per1Month",
                count: 1,
                unit: "Month" as const,
                percentRemaining: 91,
            },
        ],
        seats: [],
        errors: [],
    };
    assert.equal(statusText(report, { now: 0 }), "◕ 5h 82% 1w 64% · now");
});

test("footer icon follows the lowest remaining percentage", () => {
    const report = (percentRemaining: number) => ({
        at: 0,
        source: "token-plan" as const,
        windows: [
            {
                key: "per5Hour",
                count: 5,
                unit: "Hour" as const,
                percentRemaining,
            },
        ],
        seats: [],
        errors: [],
    });
    assert.equal(statusText(report(0), { now: 0 })?.charAt(0), "○");
    assert.equal(statusText(report(20), { now: 0 })?.charAt(0), "◔");
    assert.equal(statusText(report(30), { now: 0 })?.charAt(0), "◑");
    assert.equal(statusText(report(60), { now: 0 })?.charAt(0), "◕");
    assert.equal(statusText(report(80), { now: 0 })?.charAt(0), "●");
});

test("ACS query is sorted and array params are indexed", () => {
    assert.equal(
        buildAcsCanonicalQuery({
            PageNo: "1",
            StatusList: ["NORMAL", "LIMIT"],
            QueryAssigned: "true",
        }),
        "PageNo=1&QueryAssigned=true&StatusList.1=NORMAL&StatusList.2=LIMIT",
    );
});
test("windows follow what the API returned, not a fixed 5h/1w pair", () => {
    const windows = parseUsageWindows({ per1MonthPercentage: 0.2 });
    assert.deepEqual(
        windows.map((window) => [windowLabel(window), window.percentRemaining]),
        [["1mo", 80]],
    );
});

test("seat filter narrows the footer and keeps the seat name", () => {
    const report = {
        at: 0,
        source: "seats" as const,
        windows: [],
        seats: [
            { name: "alpha", spec: "pro", percentRemaining: 94 },
            { name: "beta", spec: "max", percentRemaining: 88 },
        ],
        errors: [],
    };
    assert.equal(
        statusText(report, { now: 0, seatFilter: "beta" }),
        "● beta 88%",
    );
    assert.equal(
        statusText(report, { now: 0, seatFilter: "beta,alp" }),
        "● alpha 94% · beta 88%",
    );
    assert.equal(
        statusText(report, { now: 0, seatFilter: "missing" }),
        "● alpha 94% · beta 88%",
    );
});

test("usage draws a colored bar only when enabled", () => {
    const ESC = "\u001b[";
    assert.equal(usage(82), "82%");
    assert.equal(
        usage(82, true),
        `${ESC}32m${"█".repeat(8)}${ESC}39m${"░".repeat(2)} 82%`,
    );
    assert.ok(usage(30, true).startsWith(`${ESC}33m${"█".repeat(3)}`));
    assert.ok(usage(5, true).startsWith(`${ESC}31m█`));
});

test("the footer bar follows the seat selection", () => {
    const report = {
        at: 0,
        source: "seats" as const,
        windows: [],
        seats: [
            { name: "etfpub", percentRemaining: 90 },
            { name: "rmpub", percentRemaining: 40 },
        ],
        errors: [],
    };
    assert.ok(
        statusText(report, {
            now: 0,
            seatFilter: "etfpub",
            bar: true,
        })?.endsWith("90%"),
    );
    assert.ok(
        !(statusText(report, { now: 0, seatFilter: "etfpub" }) ?? "").includes(
            "\u001b[",
        ),
    );
});

const BASE_URL = "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1";

function jsonResponse(payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
    });
}

function withEnv<T>(
    values: Record<string, string | undefined>,
    fn: () => T,
): T {
    const saved = Object.fromEntries(
        Object.keys(values).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

/** Temp config dir with a config.json holding the given console token. */
function configDir(accessToken: string): string {
    const dir = mkdtempSync(join(tmpdir(), "qwen-config-"));
    writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({ access_token: accessToken }),
    );
    return dir;
}

async function withEnvAsync<T>(
    values: Record<string, string | undefined>,
    fn: () => Promise<T>,
): Promise<T> {
    const saved = Object.fromEntries(
        Object.keys(values).map((key) => [key, process.env[key]]),
    );
    for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try {
        return await fn();
    } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

test("Bailian config active profile supplies AK/SK", () => {
    const dir = mkdtempSync(join(tmpdir(), "qwen-quota-"));
    const path = join(dir, "config.json");
    writeFileSync(
        path,
        JSON.stringify({
            active_config: "work",
            work: {
                access_key_id: "ak",
                access_key_secret: "sk",
                security_token: "sts",
            },
        }),
    );
    try {
        withEnv(
            {
                BAILIAN_CONFIG_DIR: dir,
                BAILIAN_ACCESS_KEY_ID: undefined,
                BAILIAN_ACCESS_KEY_SECRET: undefined,
                BAILIAN_SECURITY_TOKEN: undefined,
                ALIBABA_CLOUD_ACCESS_KEY_ID: undefined,
                ALIBABA_CLOUD_ACCESS_KEY_SECRET: undefined,
                ALIBABA_CLOUD_SECURITY_TOKEN: undefined,
            },
            () => {
                const config = readBailianConfig();
                assert.equal(config.access_key_id, "ak");
                const credential = resolveOpenApi(config);
                assert.equal(credential?.accessKeyId, "ak");
                assert.equal(credential?.securityToken, "sts");
            },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("Bailian env wins over config for AK/SK", () => {
    withEnv(
        {
            BAILIAN_ACCESS_KEY_ID: "env-ak",
            BAILIAN_ACCESS_KEY_SECRET: "env-sk",
            BAILIAN_SECURITY_TOKEN: undefined,
            ALIBABA_CLOUD_ACCESS_KEY_ID: "cloud-ak",
            ALIBABA_CLOUD_ACCESS_KEY_SECRET: "cloud-sk",
            ALIBABA_CLOUD_SECURITY_TOKEN: undefined,
        },
        () => {
            const credential = resolveOpenApi({
                access_key_id: "cfg-ak",
                access_key_secret: "cfg-sk",
                security_token: "cfg-sts",
            });
            assert.deepEqual(credential, {
                accessKeyId: "env-ak",
                accessKeySecret: "env-sk",
            });
        },
    );
});

test("ACS signature covers action, host and security token", () => {
    const headers = signAcsRequest({
        credential: {
            accessKeyId: "ak",
            accessKeySecret: "sk",
            securityToken: "sts",
        },
        action: "GetSubscriptionSeatDetails",
        version: "2026-02-10",
        body: "",
        host: "modelstudio.cn-beijing.aliyuncs.com",
        pathname: "/tokenplan/subscription/seat-detail",
        method: "GET",
    });
    assert.equal(headers.host, "modelstudio.cn-beijing.aliyuncs.com");
    assert.equal(headers["x-acs-action"], "GetSubscriptionSeatDetails");
    assert.equal(headers["x-acs-version"], "2026-02-10");
    assert.equal(headers["x-acs-security-token"], "sts");
    assert.match(
        headers.authorization ?? "",
        /^ACS3-HMAC-SHA256 Credential=ak,SignedHeaders=[a-z0-9;-]+,Signature=[0-9a-f]{64}$/,
    );
    assert.match(
        headers["x-acs-date"] ?? "",
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
});

test("fetchQuota reads token-plan usage", async () => {
    await withEnvAsync({ BAILIAN_CONFIG_DIR: configDir("token") }, async () => {
        const report = await fetchQuota({
            baseUrl: BASE_URL,
            fetchImpl: async () =>
                jsonResponse({
                    data: { success: true, data: { per5HourPercentage: 0.25 } },
                }),
        });
        assert.equal(report.source, "token-plan");
        assert.equal(report.windows[0]?.percentRemaining, 75);
        assert.deepEqual(report.errors, []);
    });
});

test("a team-only account ignores the missing personal plan", async () => {
    const report = await fetchQuota({
        baseUrl: BASE_URL,
        config: { access_token: "old" },
        credential: { accessKeyId: "ak", accessKeySecret: "sk" },
        fetchImpl: async (input) => {
            const url = String(input);
            if (url.includes("generateAccessToken"))
                return jsonResponse({ Success: true, cliAccessToken: "new" });
            if (url.includes("tokenplan/personal"))
                return jsonResponse({
                    data: { success: false, errorCode: "NotLogined" },
                });
            if (url.includes("seat-detail"))
                return jsonResponse({
                    Success: true,
                    Data: {
                        Items: [
                            {
                                Status: "NORMAL",
                                AccountName: "alice",
                                EquityList: [
                                    {
                                        CycleSurplusValue: 80,
                                        CycleTotalValue: 100,
                                    },
                                ],
                            },
                        ],
                        Total: 1,
                    },
                });
            throw new Error(`unexpected ${url}`);
        },
    });
    assert.equal(report.source, "seats");
    assert.deepEqual(report.plans, ["team"]);
    assert.equal(report.seats[0]?.name, "alice");
    assert.deepEqual(report.errors, []);
});

test("fetchQuota renews an expired console token once", async () => {
    await withEnvAsync({ BAILIAN_CONFIG_DIR: configDir("old") }, async () => {
        const calls: string[] = [];
        const report = await fetchQuota({
            baseUrl: BASE_URL,
            credential: { accessKeyId: "ak", accessKeySecret: "sk" },
            fetchImpl: async (input, init) => {
                const url = String(input);
                calls.push(url);
                if (url.includes("generateAccessToken"))
                    return jsonResponse({
                        Success: true,
                        cliAccessToken: "new",
                    });
                // Only the minted token is accepted; the stored one is expired.
                const auth = new Headers(init?.headers).get("authorization");
                if (auth !== "Bearer new")
                    return jsonResponse({
                        data: { success: false, errorCode: "NotLogined" },
                    });
                return jsonResponse({
                    data: {
                        success: true,
                        data: { per5HourPercentage: 0.5 },
                    },
                });
            },
        });
        assert.equal(report.source, "token-plan");
        assert.equal(report.windows[0]?.percentRemaining, 50);
        assert.equal(
            calls.filter((entry) => entry.includes("generateAccessToken"))
                .length,
            1,
        );
    });
});
