import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { agentDir } from "./config.ts";
import { asObject, asString, type JsonObject, type JsonValue } from "./json.ts";
import { PROVIDERS, providerEntry } from "./providers.ts";

/**
 * Where the account lives: pi's own `auth.json`, keyed by the provider id the
 * login selected. Nothing else is stored - the id already says which plan and
 * region the key belongs to.
 */
export type Account = {
    provider: string;
    access: string;
};

const STALE_MS = 30_000;
const MAX_EPERM_RETRIES = 5;

function authPath(): string {
    return resolve(agentDir(), "auth.json");
}

function readStore(): JsonObject {
    const path = authPath();
    if (!existsSync(path)) return {};
    try {
        return asObject(JSON.parse(readFileSync(path, "utf8"))) ?? {};
    } catch {
        return {};
    }
}

/** `api_key` entries keep the secret in `key`; oauth entries keep it in `access`. */
function keyOf(entry: JsonValue): string | undefined {
    const record = asObject(entry);
    return asString(record?.key) ?? asString(record?.access);
}

export function isCredential(entry: JsonValue): boolean {
    return keyOf(entry) !== undefined;
}

/**
 * The account is whichever Qwen provider id holds a credential. `/login` writes
 * exactly one, and `prune` keeps it that way, so this is unambiguous.
 */
export function readAccount(): Account | undefined {
    const store = readStore();
    const entries = PROVIDERS.map((spec) => {
        const record = asObject(store[spec.id]);
        return {
            provider: spec.id,
            access: keyOf(store[spec.id]),
            ours: record?.type === "api_key",
        };
    }).filter((entry) => entry.access !== undefined);
    if (entries.length === 0) return undefined;
    const chosen = entries.find((entry) => entry.ours) ?? entries[0];
    return { provider: chosen.provider, access: chosen.access as string };
}

/**
 * Same discipline as pi's FileAuthStorageBackend: a lockfile on the resolved
 * auth.json, retries with backoff inside a 30s deadline, a read-modify-write of
 * the whole file, 0600, and two-space JSON.
 */
async function withAuthLock<T>(fn: (store: JsonObject) => T): Promise<T> {
    const path = authPath();
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path))
        writeFileSync(path, "{}", { encoding: "utf8", mode: 0o600 });
    const release = await acquire(path);
    try {
        const store = readStore();
        const next = fn(store);
        writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
        return next;
    } finally {
        await release();
    }
}

async function acquire(path: string): Promise<() => Promise<void>> {
    const deadline = Date.now() + STALE_MS;
    let epermRetries = 0;
    for (let attempt = 0; ; attempt++) {
        try {
            return await lockfile.lock(path, { retries: 0, stale: STALE_MS });
        } catch (error) {
            const code = (error as { code?: string }).code;
            const retryable =
                code === "ELOCKED" ||
                (code === "EPERM" && process.platform === "win32");
            const remaining = deadline - Date.now();
            if (!retryable || remaining <= 0) throw error;
            if (code === "EPERM" && ++epermRetries > MAX_EPERM_RETRIES)
                throw error;
            const delay = Math.min(10 * 2 ** attempt, 500, remaining);
            await new Promise((done) => setTimeout(done, delay));
        }
    }
}

/**
 * Stores the key under the id the login selected and drops the other Qwen ids,
 * so a stale credential cannot resurrect a second catalog.
 */
export async function writeAccount(
    provider: string,
    access: string,
): Promise<void> {
    await withAuthLock((store) => {
        for (const spec of PROVIDERS) {
            if (spec.id !== provider) delete store[spec.id];
        }
        store[provider] = { type: "api_key", key: access };
    });
}

/** Drops duplicate Qwen credentials, keeping the one this extension wrote. */
export async function pruneAccounts(): Promise<void> {
    const store = readStore();
    const held = PROVIDERS.filter((spec) => isCredential(store[spec.id]));
    if (held.length <= 1) return;
    const keep = held.find(
        (spec) => asObject(store[spec.id])?.type === "api_key",
    );
    await withAuthLock((next) => {
        for (const spec of held) {
            if (spec.id !== (keep ?? held[0]).id) delete next[spec.id];
        }
    });
}

/**
 * pi only lists a provider's models when that provider has a credential, and it
 * resolves provider keys from these variables, so publishing the account into the
 * id's own variable makes pi treat the selected id as configured.
 */
export function adoptAccountEnv(account: Account): void {
    const [name] = providerEntry(account.provider).envKeys;
    if (name && !process.env[name]?.trim()) process.env[name] = account.access;
}
