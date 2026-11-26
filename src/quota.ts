// Quota without an external CLI. Personal and team plans each meter
// differently; see docs/quota.md for the three shapes and the token chain.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    asNumber,
    asObject,
    asString,
    type JsonObject,
    type JsonValue,
} from "./json.ts";

export type Unit = "Hour" | "Day" | "Week" | "Month";

export type QuotaWindow = {
    key: string;
    count: number;
    unit: Unit;
    percentRemaining: number;
    resetsAt?: number;
};

export type QuotaSeat = {
    name: string;
    spec?: string;
    surplus?: number;
    total?: number;
    percentRemaining?: number;
    resetsAt?: number;
};

/** The subscriptions this extension reports. */
export type QuotaPlan = "personal" | "team";

export type QuotaSource = "token-plan" | "seats";

export type QuotaReport = {
    at: number;
    /** Primary shape, kept for callers that only need one label. */
    source?: QuotaSource;
    /** Every subscription that returned data. */
    plans?: QuotaPlan[];
    windows: QuotaWindow[];
    seats: QuotaSeat[];
    errors: string[];
};

export type ConsoleSite = "domestic" | "international";
export type ConsoleTarget = { region: string; site: ConsoleSite };
export type OpenApiCredential = {
    accessKeyId: string;
    accessKeySecret: string;
    securityToken?: string;
};

const TOKEN_PLAN_USAGE_API =
    "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const CLI_TOKEN_PATH = "/modelstudio/cli/generateAccessToken";
const CLI_TOKEN_ACTION = "GenerateCLIAccessToken";
const SEAT_PATH = "/tokenplan/subscription/seat-detail";
const SEAT_ACTION = "GetSubscriptionSeatDetails";
const OPENAPI_VERSION = "2026-02-10";

/** Same contract as bailian-cli: per5HourPercentage / per1WeekResetTime / per1MonthPercentage. */
const WINDOW_FIELD = /^per(\d+)(Hour|Day|Week|Month)(Percentage|ResetTime)$/;
const UNIT_HOURS = {
    Hour: 1,
    Day: 24,
    Week: 168,
    Month: 720,
} satisfies Record<Unit, number>;
const MAX_RESET_MS = 4_102_444_800_000;

/** Accept epoch seconds or milliseconds; reject implausible values. */
function resetMs(value: number | undefined): number | undefined {
    if (value === undefined) return undefined;
    const ms = value < 1e11 ? value * 1000 : value;
    return ms > 0 && ms <= MAX_RESET_MS ? ms : undefined;
}

function resetField(value: number | undefined): { resetsAt?: number } {
    const resetsAt = resetMs(value);
    return resetsAt === undefined ? {} : { resetsAt };
}

function sortWindows(windows: QuotaWindow[]): QuotaWindow[] {
    return windows.sort(
        (left, right) =>
            left.count * UNIT_HOURS[left.unit] -
            right.count * UNIT_HOURS[right.unit],
    );
}

// pi-lens-ignore: no-unknown-parameters -- catch clauses deliver unknown
function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_SEAT_PAGES = 20;

// Gateway map from the official Bailian CLI (bailian-cli-core).
type Gateway = { host: string; action: string };
type GatewayMap = Record<string, Record<ConsoleSite, Gateway>>;
const GATEWAYS = {
    "cn-beijing": {
        domestic: {
            host: "bailian-cs.console.aliyun.com",
            action: "BroadScopeAspnGateway",
        },
        international: {
            host: "bailian-cs.console.alibabacloud.com",
            action: "BroadScopeAspnGateway",
        },
    },
    "ap-southeast-1": {
        domestic: {
            host: "modelstudio-cs.console.aliyun.com",
            action: "IntlBroadScopeAspnGateway",
        },
        international: {
            host: "bailian-singapore-cs.alibabacloud.com",
            action: "IntlBroadScopeAspnGateway",
        },
    },
} satisfies GatewayMap;

function gatewayFor(region: string): Record<ConsoleSite, Gateway> {
    return (GATEWAYS as GatewayMap)[region] ?? GATEWAYS["cn-beijing"];
}

const MODEL_STUDIO_HOSTS = {
    "cn-beijing": "modelstudio.cn-beijing.aliyuncs.com",
    "ap-southeast-1": "modelstudio.ap-southeast-1.aliyuncs.com",
} satisfies Record<string, string>;

function modelStudioHost(target: ConsoleTarget): string {
    return (
        (MODEL_STUDIO_HOSTS as Record<string, string>)[target.region] ??
        MODEL_STUDIO_HOSTS["cn-beijing"]
    );
}

export class ConsoleExpiredError extends Error {}

// ── Config and credentials ────────────────────────────────────────────

/** Active profile of `~/.bailian/config.json` flattened over the top level. */
export function readBailianConfig(): JsonObject {
    // Same location logic as bailian-cli (`BAILIAN_CONFIG_DIR` redirects the dir).
    const dir =
        process.env.BAILIAN_CONFIG_DIR?.trim() || join(homedir(), ".bailian");
    const path = join(dir, "config.json");
    if (!existsSync(path)) return {};
    try {
        const raw = asObject(JSON.parse(readFileSync(path, "utf8")));
        if (!raw) return {};
        const active = asString(raw.active_config);
        const profile = active ? asObject(raw[active]) : undefined;
        return { ...raw, ...(profile ?? {}) };
    } catch {
        return {};
    }
}

function envPair(
    idName: string,
    secretName: string,
    tokenName?: string,
): OpenApiCredential | undefined {
    const accessKeyId = process.env[idName]?.trim();
    const accessKeySecret = process.env[secretName]?.trim();
    if (!accessKeyId || !accessKeySecret) return undefined;
    const securityToken = tokenName
        ? process.env[tokenName]?.trim()
        : undefined;
    const credential: OpenApiCredential = { accessKeyId, accessKeySecret };
    if (securityToken) credential.securityToken = securityToken;
    return credential;
}

/** AK/SK: Bailian env > Bailian config > Alibaba Cloud env. */
export function resolveOpenApi(
    config = readBailianConfig(),
): OpenApiCredential | undefined {
    const bailian = envPair(
        "BAILIAN_ACCESS_KEY_ID",
        "BAILIAN_ACCESS_KEY_SECRET",
        "BAILIAN_SECURITY_TOKEN",
    );
    if (bailian) return bailian;
    const accessKeyId = asString(config.access_key_id)?.trim() ?? "";
    const accessKeySecret = asString(config.access_key_secret)?.trim() ?? "";
    if (accessKeyId && accessKeySecret) {
        const securityToken = asString(config.security_token)?.trim() ?? "";
        const credential: OpenApiCredential = {
            accessKeyId,
            accessKeySecret,
        };
        if (securityToken) credential.securityToken = securityToken;
        return credential;
    }
    return envPair(
        "ALIBABA_CLOUD_ACCESS_KEY_ID",
        "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
        "ALIBABA_CLOUD_SECURITY_TOKEN",
    );
}

/** Console target: `console_region` / `console_site` from the config file, else the base URL. */
export function resolveConsoleTarget(
    baseUrl: string,
    config = readBailianConfig(),
): ConsoleTarget {
    const configRegion = asString(config.console_region);
    const configSite = asString(config.console_site);
    const derived = /ap-southeast-1/.test(baseUrl)
        ? { region: "ap-southeast-1", site: "international" as ConsoleSite }
        : { region: "cn-beijing", site: "domestic" as ConsoleSite };
    const region = configRegion || derived.region;
    let site: ConsoleSite = derived.site;
    if (configSite === "domestic" || configSite === "international")
        site = configSite;
    return { region, site };
}

/** Where `bl auth login --console` stores it; bailian-cli has no env override. */
export function resolveConsoleToken(
    config = readBailianConfig(),
): string | undefined {
    const token = asString(config.access_token)?.trim() ?? "";
    return token || undefined;
}

// ── ACS3 signing (mirrors bailian-cli core/client/acs.ts) ─────────────

type AcsQuery = Record<string, string | string[] | number | undefined>;

function encodeRfc3986(value: string): string {
    return encodeURIComponent(value).replace(
        /[!'()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

export function buildAcsCanonicalQuery(params: AcsQuery): string {
    const pairs: Array<[string, string | number]> = [];
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === "") continue;
        if (Array.isArray(value)) {
            value.forEach((entry, index) => {
                if (entry !== "") pairs.push([`${key}.${index + 1}`, entry]);
            });
        } else {
            pairs.push([key, value]);
        }
    }
    pairs.sort(([left], [right]) => left.localeCompare(right));
    return pairs
        .map(
            ([key, value]) =>
                `${encodeRfc3986(key)}=${encodeRfc3986(String(value))}`,
        )
        .join("&");
}

function sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmacSha256Hex(key: string, value: string): string {
    return createHmac("sha256", key).update(value, "utf8").digest("hex");
}

export function signAcsRequest({
    credential,
    action,
    version,
    body,
    host,
    pathname,
    method,
    queryString = "",
}: {
    credential: OpenApiCredential;
    action: string;
    version: string;
    body: string;
    host: string;
    pathname: string;
    method: "GET" | "POST";
    queryString?: string;
}): Record<string, string> {
    const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const hashedBody = sha256Hex(body);
    // pi-lens-ignore: no-known-value-widening -- optional ACS headers are added below
    const headers: Record<string, string> = {};
    Object.assign(headers, {
        host,
        "x-acs-action": action,
        "x-acs-version": version,
        "x-acs-date": date,
        "x-acs-signature-nonce": randomUUID(),
        "x-acs-content-sha256": hashedBody,
        "content-type": "application/json",
    });
    if (credential.securityToken)
        headers["x-acs-security-token"] = credential.securityToken;

    const signedKeys = Object.keys(headers)
        .filter(
            (key) =>
                key === "host" ||
                key === "content-type" ||
                key.startsWith("x-acs-"),
        )
        .sort((left, right) => left.localeCompare(right));
    const canonicalHeaders = `${signedKeys.map((key) => `${key}:${headers[key]}`).join("\n")}\n`;
    const signedHeaders = signedKeys.join(";");
    const canonicalRequest = [
        method,
        pathname,
        queryString,
        canonicalHeaders,
        signedHeaders,
        hashedBody,
    ].join("\n");
    const algorithm = "ACS3-HMAC-SHA256";
    const signature = hmacSha256Hex(
        credential.accessKeySecret,
        `${algorithm}\n${sha256Hex(canonicalRequest)}`,
    );
    headers.authorization = `${algorithm} Credential=${credential.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
    return headers;
}

type OpenApiRequest = {
    host: string;
    path: string;
    action: string;
    version?: string;
    method: "GET" | "POST";
    query?: AcsQuery;
    body?: unknown;
};

async function openApiJson<T extends JsonObject>(
    request: OpenApiRequest,
    credential: OpenApiCredential,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<T> {
    const body = request.body === undefined ? "" : JSON.stringify(request.body);
    const queryString = request.query
        ? buildAcsCanonicalQuery(request.query)
        : "";
    const endpoint = `https://${request.host}${request.path}${queryString ? `?${queryString}` : ""}`;
    const headers = {
        ...signAcsRequest({
            credential,
            action: request.action,
            version: request.version ?? OPENAPI_VERSION,
            body,
            host: request.host,
            pathname: request.path,
            method: request.method,
            queryString,
        }),
        accept: "application/json",
    };
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const init: RequestInit = {
        method: request.method,
        headers,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    };
    if (body) init.body = body;
    const response = await fetchImpl(endpoint, init);
    const text = await response.text();
    let payload: JsonObject;
    try {
        payload = JSON.parse(text) as JsonObject;
    } catch {
        throw new Error(
            `${response.status} ${response.statusText}: ${text.slice(0, 300)}`,
        );
    }
    if (!response.ok || payload.Success === false) {
        const code = asString(payload.Code) ?? response.status;
        const message = asString(payload.Message) ?? response.statusText;
        throw new Error(`${code}: ${message}`);
    }
    return payload as T;
}

// ── Console gateway ───────────────────────────────────────────────────

async function generateConsoleToken(
    target: ConsoleTarget,
    credential: OpenApiCredential,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<string> {
    const host = modelStudioHost(target);
    const payload = await openApiJson<JsonObject>(
        {
            host,
            path: CLI_TOKEN_PATH,
            action: CLI_TOKEN_ACTION,
            method: "POST",
        },
        credential,
        fetchImpl,
        signal,
    );
    const token = asString(payload.cliAccessToken)?.trim() ?? "";
    if (!token) throw new Error("CLI token response is missing cliAccessToken");
    return token;
}

// pi-lens-ignore: long-parameter-list -- internal console call mirrors the gateway arguments
async function callConsole(
    target: ConsoleTarget,
    token: string,
    api: string,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<JsonObject> {
    const gateway = gatewayFor(target.region)[target.site];
    const params = JSON.stringify({
        Api: api,
        V: "1.0",
        Data: {
            cornerstoneParam: {
                protocol: "V2",
                console: "ONE_CONSOLE",
                productCode: "p_efm",
                switchUserType: 3,
                consoleSite: "BAILIAN_ALIYUN",
            },
        },
    });
    const body = new URLSearchParams({
        params,
        region: target.region,
    }).toString();
    const endpoint = `https://${gateway.host}/cli/api.json?action=${gateway.action}&product=sfm_bailian&api=${encodeURIComponent(api)}`;
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
            accept: "*/*",
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Bearer ${token}`,
        },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    let payload: JsonObject;
    try {
        payload = JSON.parse(text) as JsonObject;
    } catch {
        throw new Error(
            `console gateway returned non-JSON HTTP ${response.status}`,
        );
    }
    const data = asObject(payload.data);
    if (data?.success === false) {
        const code = asString(data.errorCode) ?? JSON.stringify(data.errorCode);
        if (code.includes("NotLogined"))
            throw new ConsoleExpiredError("console session expired");
        const message =
            asString(data.errorMsg) || asString(data.message) || code;
        throw new Error(message);
    }
    if (!response.ok)
        throw new Error(`console gateway HTTP ${response.status}`);
    return payload;
}

/** Console call with one transparent token refresh on an expired session. */
async function consoleCall({
    target,
    config,
    credential,
    api,
    fetchImpl,
    signal,
    missingMessage,
    expiredMessage,
    renew,
}: {
    target: ConsoleTarget;
    config: JsonObject;
    credential: OpenApiCredential | undefined;
    api: string;
    fetchImpl: typeof fetch;
    signal?: AbortSignal;
    missingMessage: string;
    expiredMessage?: string;
    /** Shared renewal so parallel plan probes mint one console token. */
    renew?: () => Promise<string>;
}): Promise<JsonObject> {
    let token = resolveConsoleToken(config);
    if (!token) {
        if (!credential) throw new Error(missingMessage);
        token = renew
            ? await renew()
            : await generateConsoleToken(target, credential, fetchImpl, signal);
    }
    try {
        return await callConsole(target, token, api, fetchImpl, signal);
    } catch (error) {
        if (!(error instanceof ConsoleExpiredError)) throw error;
        if (!credential) {
            if (expiredMessage) throw new ConsoleExpiredError(expiredMessage);
            throw error;
        }
        const fresh = renew
            ? await renew()
            : await generateConsoleToken(target, credential, fetchImpl, signal);
        return callConsole(target, fresh, api, fetchImpl, signal);
    }
}

// ── Parsers ───────────────────────────────────────────────────────────

function collectWindowFields(
    node: JsonValue,
    depth: number,
    out: Map<string, number>,
): void {
    const object = asObject(node);
    if (!object || depth > 8) return;
    for (const [key, value] of Object.entries(object)) {
        if (WINDOW_FIELD.test(key)) {
            const number = asNumber(value);
            if (number !== undefined) out.set(key, number);
        } else if (asObject(value)) {
            collectWindowFields(value, depth + 1, out);
        }
    }
}

/** `per5HourPercentage` is the used fraction (0..1), matching the console contract. */
export function parseUsageWindows(payload: JsonValue): QuotaWindow[] {
    const fields = new Map<string, number>();
    collectWindowFields(payload, 0, fields);

    const grouped = new Map<
        string,
        { count: number; unit: Unit; percentage?: number; reset?: number }
    >();
    for (const [field, value] of fields) {
        const match = WINDOW_FIELD.exec(field);
        if (!match) continue;
        const [, countText, unit, suffix] = match;
        const count = Number(countText);
        const key = `per${count}${unit}`;
        const entry = grouped.get(key) ?? { count, unit: unit as Unit };
        if (suffix === "Percentage") entry.percentage = value;
        else entry.reset = value;
        grouped.set(key, entry);
    }

    const windows: QuotaWindow[] = [];
    for (const [key, entry] of grouped) {
        if (entry.percentage === undefined) continue;
        const used = Math.min(1, Math.max(0, entry.percentage));
        windows.push({
            key,
            count: entry.count,
            unit: entry.unit,
            percentRemaining: (1 - used) * 100,
            ...resetField(entry.reset),
        });
    }
    return sortWindows(windows);
}

function seatFromItem(item: JsonValue): QuotaSeat | undefined {
    const record = asObject(item);
    if (record?.Status !== "NORMAL") return undefined;
    const name = asString(record.AccountName) ?? "";
    if (!name) return undefined;
    const equity = asObject(
        Array.isArray(record.EquityList) ? record.EquityList[0] : undefined,
    );
    const total = asNumber(equity?.CycleTotalValue);
    const surplus = asNumber(equity?.CycleSurplusValue);
    const percentRemaining =
        total !== undefined && total > 0 && surplus !== undefined
            ? Math.min(100, Math.max(0, (surplus / total) * 100))
            : undefined;
    const seat: QuotaSeat = { name };
    const spec = asString(record.SpecType);
    if (spec) seat.spec = spec;
    if (surplus !== undefined) seat.surplus = surplus;
    if (total !== undefined) seat.total = total;
    if (percentRemaining !== undefined)
        seat.percentRemaining = percentRemaining;
    Object.assign(seat, resetField(asNumber(equity?.CycleEndTime)));
    return seat;
}

/** Seats from `GetSubscriptionSeatDetails`; RELEASE seats have no cycle and are skipped. */
export function parseSeats(payload: JsonValue): QuotaSeat[] {
    const data = asObject(payload)?.Data ?? asObject(payload)?.data;
    const items = asObject(data)?.Items;
    if (!Array.isArray(items)) return [];
    return items
        .map(seatFromItem)
        .filter((seat): seat is QuotaSeat => seat !== undefined);
}

// ── Refresh ───────────────────────────────────────────────────────────

async function fetchSeats(
    credential: OpenApiCredential,
    target: ConsoleTarget,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
): Promise<QuotaSeat[]> {
    const host = modelStudioHost(target);
    const seats: QuotaSeat[] = [];
    for (let page = 1; page <= MAX_SEAT_PAGES; page++) {
        const payload = await openApiJson<JsonObject>(
            {
                host,
                path: SEAT_PATH,
                action: SEAT_ACTION,
                method: "GET",
                query: {
                    PageNo: String(page),
                    PageSize: "100",
                    StatusList: ["NORMAL"],
                    QueryAssigned: "true",
                },
            },
            credential,
            fetchImpl,
            signal,
        );
        const data = asObject(payload.Data);
        const items = Array.isArray(data?.Items) ? data.Items : [];
        seats.push(...parseSeats(payload));
        const total = asNumber(data?.Total);
        if (items.length === 0 || total === undefined || page * 100 >= total)
            break;
    }
    return seats;
}

/** Probe result: `value` is empty when the key has no such plan. */
type PlanProbe<T> = { value?: T[]; error?: string };

async function probePlan<T>(
    label: string,
    run: () => Promise<T[]>,
): Promise<PlanProbe<T>> {
    try {
        return { value: await run() };
    } catch (error) {
        return { error: `${label}: ${errorMessage(error)}` };
    }
}

function mergeQuota(
    at: number,
    personal: PlanProbe<QuotaWindow>,
    team: PlanProbe<QuotaSeat>,
): QuotaReport {
    const windows = sortWindows(personal.value ?? []);
    const seats = team.value ?? [];
    const plans: QuotaPlan[] = [];
    if (windows.length > 0) plans.push("personal");
    if (seats.length > 0) plans.push("team");

    // Errors only matter when nothing answered; otherwise they are just plans
    // this key does not have.
    const errors =
        plans.length > 0
            ? []
            : [personal.error, team.error].filter(
                  (error): error is string => error !== undefined,
              );
    const report: QuotaReport = { at, plans, windows, seats, errors };
    if (windows.length > 0) report.source = "token-plan";
    else if (seats.length > 0) report.source = "seats";
    return report;
}

/**
 * One refresh. A key can carry several subscriptions, so every plan is probed;
 * an empty answer means the key has no such plan, not that something failed.
 */
export async function fetchQuota({
    baseUrl,
    fetchImpl = fetch,
    signal,
    config = readBailianConfig(),
    credential = resolveOpenApi(config),
}: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    config?: JsonObject;
    credential?: OpenApiCredential;
}): Promise<QuotaReport> {
    const at = Date.now();
    const target = resolveConsoleTarget(baseUrl, config);
    if (signal?.aborted)
        return { at, plans: [], windows: [], seats: [], errors: ["aborted"] };

    let minted: Promise<string> | undefined;
    const renew = (): Promise<string> => {
        if (!credential)
            return Promise.reject(
                new Error("no AK/SK to renew the console token"),
            );
        minted ??= generateConsoleToken(target, credential, fetchImpl, signal);
        return minted;
    };

    const [personal, team] = await Promise.all([
        probePlan("personal", async () =>
            parseUsageWindows(
                await consoleCall({
                    target,
                    config,
                    credential,
                    api: TOKEN_PLAN_USAGE_API,
                    fetchImpl,
                    signal,
                    missingMessage:
                        "no console token or AK/SK; quota needs a console login or AK/SK",
                    expiredMessage:
                        "console token expired and no AK/SK to renew it",
                    renew,
                }),
            ),
        ),
        credential && !signal?.aborted
            ? probePlan("team seats", () =>
                  fetchSeats(credential, target, fetchImpl, signal),
              )
            : Promise.resolve({ value: [] }),
    ]);

    return mergeQuota(at, personal, team);
}

export {
    countdown,
    formatQuota,
    statusText,
    usage,
    windowLabel,
} from "./quota-format.ts";
