import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
    ExtensionAPI,
    ExtensionContext,
    ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { getLastAssistantUsage } from "@earendil-works/pi-coding-agent";
import { adoptAccountEnv, pruneAccounts, readAccount } from "../src/account.ts";
import { injectAnthropicServerTools } from "../src/anthropic-tools.ts";
import { createTokenPlanOAuth } from "../src/auth.ts";
import { normalizePromptCache, PROMPT_CACHE_RETENTIONS } from "../src/cache.ts";
import {
    agentDir,
    loadSettings,
    type QwenSettings,
    saveSettings,
} from "../src/config.ts";
import { baseUrlFor, endpointsFor, parseEndpoints } from "../src/endpoints.ts";
import { toolUsage } from "../src/hosted.ts";
import { asNumber, asObject, asString, type JsonValue } from "../src/json.ts";
import { dashScopeRoot, qwenImagesApi, setMediaRoot } from "../src/media.ts";
import {
    type BuiltinMetadata,
    buildModels,
    fetchModelIds,
} from "../src/models.ts";
import {
    isOurProvider,
    LOGIN_PROVIDER,
    PROVIDERS,
    providerEntry,
} from "../src/providers.ts";
import {
    fetchQuota,
    formatQuota,
    type QuotaReport,
    statusText,
} from "../src/quota.ts";
import { createResponsesApi } from "../src/responses.ts";
import { settingsMenu } from "../src/settings.ts";
import { registerTools } from "../src/tools.ts";

const STATUS_KEY = "qwen-quota";
/** A failed probe is retried soon; a successful one is cached for the refresh TTL. */
const QUOTA_RETRY_TTL_MS = 10_000;

/** Pi's built-in Qwen Token Plan catalogs, used as the metadata source. */
function builtinCatalog(): Map<string, BuiltinMetadata> {
    const catalog = new Map<string, BuiltinMetadata>();
    // SAFETY: getBuiltinModels returns pi's built-in catalog entries; only the fields mirrored in BuiltinMetadata are read.
    const read = getBuiltinModels as unknown as (
        provider: string,
    ) => BuiltinMetadata[];
    for (const provider of [
        "qwen-token-plan",
        "qwen-token-plan-cn",
        "qwen-token-plan-individual",
        "qwen-token-plan-individual-cn",
    ]) {
        try {
            for (const model of read(provider)) catalog.set(model.id, model);
        } catch {
            // The built-in catalog is optional; the verified table still covers known ids.
        }
    }
    return catalog;
}

function readAuth(): Record<
    string,
    { access?: unknown; refresh?: unknown; key?: unknown }
> {
    try {
        return JSON.parse(
            readFileSync(resolve(agentDir(), "auth.json"), "utf8"),
        ) as Record<
            string,
            { access?: unknown; refresh?: unknown; key?: unknown }
        >;
    } catch {
        return {};
    }
}

/**
 * pi's own catalog cache (`models-store.json`) carries no schema version, so a
 * stale entry is detected by shape: one bad model discards the whole snapshot.
 */
function restoredModels(
    entry: { models?: unknown } | undefined,
    provider: string,
): ProviderModelConfig[] {
    const models = entry?.models;
    if (!Array.isArray(models) || models.length === 0) return [];
    const valid = models.every((model) => {
        const candidate = asObject(model);
        if (!candidate) return false;
        const id = asString(candidate.id);
        const api = asString(candidate.api);
        const owner = asString(candidate.provider);
        const type = asString(candidate.type);
        return (
            id !== undefined &&
            (owner === undefined || owner === provider) &&
            api !== undefined &&
            (type === undefined || type === "chat" || type === "image")
        );
    });
    return valid ? (models as ProviderModelConfig[]) : [];
}

/** Read pi's stored snapshot at registration, before any refresh context exists. */
function readStoredCatalog(provider: string): {
    models: ProviderModelConfig[];
    at: number;
} {
    try {
        const store = JSON.parse(
            readFileSync(resolve(agentDir(), "models-store.json"), "utf8"),
        ) as JsonValue;
        const entry = asObject(asObject(store)?.[provider]);
        const models = restoredModels(entry, provider);
        const checkedAt = asNumber(entry?.checkedAt);
        return {
            models,
            at: models.length > 0 && checkedAt !== undefined ? checkedAt : 0,
        };
    } catch {
        return { models: [], at: 0 };
    }
}

// pi-lens-ignore: high-complexity, high-fan-out -- provider wiring is a flat registration table
export default async function register(pi: ExtensionAPI): Promise<void> {
    const settings: QwenSettings = loadSettings();
    if (/^(0|off|false)$/i.test(process.env.QWEN_HOSTED_TOOLS ?? ""))
        settings.hostedTools = false;
    if (process.env.QWEN_PROMPT_CACHE)
        settings.promptCache = normalizePromptCache(
            process.env.QWEN_PROMPT_CACHE,
        );

    const responsesApi = createResponsesApi(
        () => settings.hostedTools,
        () => settings.promptCache,
    );
    type Endpoints = ReturnType<typeof endpointsFor>;
    type CatalogState = {
        models: ProviderModelConfig[];
        at: number;
        persisted: boolean;
        baseUrl: string;
    };
    const catalog = builtinCatalog();
    const initial = new Map<string, Endpoints>();
    const states = new Map<string, CatalogState>();
    // `/login` stores the account in pi's auth.json under the provider id the plan
    // and region resolved to; the id alone says which endpoints to use.
    await pruneAccounts();
    const account = readAccount();
    if (account) adoptAccountEnv(account);
    const sessionProvider = (): string => {
        if (account) return providerEntry(account.provider).id;
        const stored = readAuth();
        return (
            PROVIDERS.find((entry) => asString(stored[entry.id]?.access))?.id ??
            providerEntry(process.env.QWEN_PROVIDER).id
        );
    };
    let activeProvider = sessionProvider();

    for (const provider of PROVIDERS) {
        const owned = account?.provider === provider.id;
        const stored = readAuth()[provider.id];
        const endpoints = owned
            ? endpointsFor(baseUrlFor(provider.region))
            : (parseEndpoints(stored?.refresh) ??
              endpointsFor(baseUrlFor(provider.region)));
        initial.set(provider.id, endpoints);
        // Only the account's own id keeps a catalog: an id with no credential is
        // not listed by pi anyway, and a leftover one would show stale models.
        const authorized =
            owned ||
            (!account &&
                (asString(stored?.access) !== undefined ||
                    asString(stored?.key) !== undefined ||
                    envKeyName(provider.id) !== undefined));
        const seeded = authorized
            ? readStoredCatalog(provider.id)
            : { models: [], at: 0 };
        const state: CatalogState = {
            models: seeded.models,
            at: seeded.at,
            // A catalog seeded from the store is already persisted; a bootstrapped one is not.
            persisted: seeded.models.length > 0,
            baseUrl: endpoints.openai,
        };
        states.set(provider.id, state);
        if (state.models.length > 0) continue;
        const bootstrapKey = authorized ? activeKey(provider.id) : undefined;
        if (!bootstrapKey) continue;
        try {
            const ids = await fetchModelIds({
                baseUrl: endpoints.openai,
                apiKey: bootstrapKey,
            });
            state.models = buildModels(
                ids,
                endpoints.openai,
                catalog,
            ) as ProviderModelConfig[];
            state.at = Date.now();
        } catch {
            // Keep an empty catalog; the next refresh can retry.
        }
    }
    setMediaRoot(dashScopeRoot(initialFor(activeProvider).openai));

    function initialFor(id: string): Endpoints {
        return (
            initial.get(id) ??
            endpointsFor(baseUrlFor(providerEntry(id).region))
        );
    }

    function stateFor(id: string): CatalogState {
        const state = states.get(id);
        if (state) return state;
        const created: CatalogState = {
            models: [],
            at: 0,
            persisted: false,
            baseUrl: initialFor(id).openai,
        };
        states.set(id, created);
        return created;
    }

    function activeEndpoints(id: string = activeProvider): Endpoints {
        const current = readAuth()[id];
        return parseEndpoints(current?.refresh) ?? initialFor(id);
    }

    function mediaRoot(): string {
        return dashScopeRoot(activeEndpoints().openai);
    }

    /** pi owns the store (`models-store.json`); providers only publish into it. */
    async function persistCatalog(
        id: string,
        context: {
            // pi-lens-ignore: no-unknown-parameters -- ModelsPublication is not exported by pi
            publish(publication: unknown): Promise<boolean>;
        },
    ): Promise<boolean> {
        const state = stateFor(id);
        try {
            return await context.publish({
                persist: {
                    models: state.models.map((model) => ({
                        ...model,
                        provider: id,
                    })),
                    checkedAt: state.at,
                },
            });
        } catch {
            return false;
        }
    }

    function envKeyName(id: string): string | undefined {
        return providerEntry(id).envKeys.find((name) =>
            process.env[name]?.trim(),
        );
    }

    function activeKey(id: string = activeProvider): string | undefined {
        // A recorded account owns exactly one provider id; any other id has no key.
        if (account)
            return account.provider === id ? account.access : undefined;
        const access = asString(readAuth()[id]?.access);
        if (access) return access;
        const fallback = process.env.DASHSCOPE_API_KEY?.trim();
        if (fallback) return fallback;
        const envName = envKeyName(id);
        return envName ? process.env[envName]?.trim() : undefined;
    }

    function catalogFresh(id: string): boolean {
        const state = stateFor(id);
        const syncHours = settings.modelSyncHours;
        return (
            syncHours > 0 &&
            state.models.length > 0 &&
            state.at > 0 &&
            Date.now() - state.at < syncHours * 3_600_000
        );
    }

    async function refreshCatalog(
        id: string,
        context: RefreshModelsContext,
    ): Promise<ProviderModelConfig[]> {
        const state = stateFor(id);
        // Persist a bootstrapped catalog even on the offline pass, so the next
        // startup restores from the store instead of fetching again.
        if (!state.persisted && state.models.length > 0)
            state.persisted = await persistCatalog(id, context);
        const apiKey = activeKey(id);
        if (!apiKey || !context.allowNetwork) return state.models;
        if (!context.force && catalogFresh(id)) return state.models;
        const active = activeEndpoints(id);
        setMediaRoot(dashScopeRoot(active.openai));
        try {
            const ids = await fetchModelIds({
                baseUrl: active.openai,
                apiKey,
                signal: context.signal,
            });
            state.models = buildModels(
                ids,
                active.openai,
                catalog,
            ) as ProviderModelConfig[];
            state.at = Date.now();
            state.persisted = await persistCatalog(id, context);
            return state.models;
        } catch {
            // Keep the last known catalog instead of wiping it on a network blip.
            return state.models;
        }
    }

    for (const provider of PROVIDERS) {
        const state = stateFor(provider.id);
        // One login entry: the flow picks plan and region, and the account is
        // recorded against the provider id those resolve to.
        const oauth =
            provider.id === LOGIN_PROVIDER ? createTokenPlanOAuth() : undefined;
        pi.registerProvider(provider.id, {
            name: provider.name,
            baseUrl: initialFor(provider.id).openai,
            api: "openai-responses",
            apiKey: envKeyName(provider.id)
                ? `$${envKeyName(provider.id)}`
                : undefined,
            oauth,
            models: state.models,
            streamSimple: (model, context, options) =>
                responsesApi.streamSimple(model, context, options),
            images: { "qwen-images": qwenImagesApi },
            refreshModels: (context) => refreshCatalog(provider.id, context),
        });
    }

    // Server-side web tools ride on the Anthropic Messages request, so inject them
    // only for the chat-only models that the plan documents as supporting them.
    pi.on("before_provider_request", (event, ctx) => {
        const provider = ctx.model?.provider;
        if (!settings.hostedTools || !isOurProvider(provider)) return;
        const id = asString(asObject(event.payload)?.model);
        if (!id) return;
        if (
            !stateFor(providerEntry(provider).id).models.some(
                (model) =>
                    model.id === id && model.api === "anthropic-messages",
            )
        )
            return;
        return injectAnthropicServerTools(event.payload as JsonValue);
    });

    // ── Quota ──────────────────────────────────────────────────────────
    // Keyed by provider: the same key only answers for the region it belongs to.
    const quotaCache = new Map<
        string,
        { at: number; ttl: number; report: QuotaReport }
    >();
    const quotaInFlight = new Map<string, Promise<QuotaReport>>();
    // Last report with data, kept so a transient probe failure does not replace
    // the footer with an error line.
    const quotaLastGood = new Map<string, QuotaReport>();

    function hasQuotaData(report: QuotaReport): boolean {
        return report.windows.length > 0 || report.seats.length > 0;
    }

    async function getQuota(
        force = false,
        provider: string = activeProvider,
    ): Promise<QuotaReport> {
        const cached = quotaCache.get(provider);
        if (!force && cached && Date.now() - cached.at < cached.ttl) {
            return cached.report;
        }
        const pending = quotaInFlight.get(provider);
        if (pending) return pending;
        const request = fetchQuota({
            baseUrl: activeEndpoints(provider).openai,
        });
        quotaInFlight.set(provider, request);
        try {
            const report = await request;
            const hasData = hasQuotaData(report);
            if (hasData) quotaLastGood.set(provider, report);
            quotaCache.set(provider, {
                at: Date.now(),
                ttl: hasData
                    ? settings.quota.refreshMinutes * 60_000
                    : QUOTA_RETRY_TTL_MS,
                report,
            });
            return report;
        } finally {
            quotaInFlight.delete(provider);
        }
    }

    function safeStatus(
        ctx: ExtensionContext,
        value: string | undefined,
    ): void {
        try {
            ctx.ui.setStatus(STATUS_KEY, value);
        } catch {
            // The session may have been replaced/reloaded while quota was in flight.
        }
    }

    function applyStatus(
        ctx: ExtensionContext,
        report: QuotaReport | undefined,
    ): void {
        if (!settings.quota.show || !report) {
            safeStatus(ctx, undefined);
            return;
        }
        safeStatus(
            ctx,
            statusText(report, {
                now: Date.now(),
                windows: settings.quota.windows,
                seatFilter: settings.quota.seatFilter,
                bar: settings.quota.bar,
            }),
        );
    }

    async function updateStatus(
        ctx: ExtensionContext,
        force = false,
    ): Promise<void> {
        const provider = ctx.model?.provider;
        const id = isOurProvider(provider)
            ? providerEntry(provider).id
            : undefined;
        try {
            if (!id || !settings.quota.show) {
                safeStatus(ctx, undefined);
                return;
            }
            const report = await getQuota(force, id);
            if (hasQuotaData(report)) {
                applyStatus(ctx, report);
                return;
            }
            // A probe can fail for reasons that clear on their own (expired
            // console token, a cold network). Keep the last real numbers instead
            // of replacing them with the error text.
            if (report.errors.length > 0) {
                const lastGood = quotaLastGood.get(id);
                if (lastGood) applyStatus(ctx, lastGood);
                else safeStatus(ctx, "qwen ?");
                return;
            }
            applyStatus(ctx, report);
        } catch {
            const lastGood = id ? quotaLastGood.get(id) : undefined;
            if (lastGood) applyStatus(ctx, lastGood);
            else safeStatus(ctx, "qwen ?");
        }
    }

    function registerQuotaCommand(): void {
        pi.registerCommand("qwen-quota", {
            description: "Show Qwen Token Plan quota and team seats",
            handler: async (args, ctx) => {
                const command = args.trim().toLowerCase();
                const provider = isOurProvider(ctx.model?.provider)
                    ? providerEntry(ctx.model?.provider).id
                    : activeProvider;
                if (command === "refresh") quotaCache.delete(provider);
                const report = await getQuota(command === "refresh", provider);
                ctx.ui.notify(
                    formatQuota(report),
                    report.windows.length || report.seats.length
                        ? "info"
                        : "warning",
                );
                applyStatus(ctx, report);
            },
        });
    }
    registerQuotaCommand();
    // ── Settings ───────────────────────────────────────────────────────
    function persist(): void {
        saveSettings(settings);
    }

    pi.registerCommand("qwen-settings", {
        description:
            "Configure Qwen quota display, hosted tools and media generation",
        handler: async (_args, ctx) =>
            settingsMenu(ctx, {
                providerId: activeProvider,
                getSettings: () => settings,
                persistSettings: persist,
                updateStatus,
                modelCount: () => stateFor(activeProvider).models.length,
                listSeats: async (force) => {
                    const report = await getQuota(force);
                    return report.seats.map((seat) => seat.name);
                },
            }),
    });

    function registerCacheCommand(): void {
        pi.registerCommand("qwen-cache", {
            description: "Set qwen4 prompt cache TTL: /qwen-cache 5m or 1h",
            handler: async (args, ctx) => {
                const value = args.trim().toLowerCase();
                if (value === "5m" || value === "1h") {
                    settings.promptCache = normalizePromptCache(value);
                    persist();
                    ctx.ui.notify(
                        `qwen4 prompt cache: ${settings.promptCache}`,
                        "info",
                    );
                    return;
                }
                const next = await ctx.ui.select(
                    `qwen4 prompt cache (now ${settings.promptCache})`,
                    [...PROMPT_CACHE_RETENTIONS],
                );
                if (!next) return;
                settings.promptCache = normalizePromptCache(next);
                persist();
                ctx.ui.notify(
                    `qwen4 prompt cache: ${settings.promptCache}`,
                    "info",
                );
            },
        });
    }
    registerCacheCommand();
    // ── Tools ──────────────────────────────────────────────────────────
    const formatCount = (value: number | null | undefined) => {
        const number = asNumber(value);
        return number !== undefined ? number.toLocaleString("en-US") : "?";
    };

    function registerTokensCommand(): void {
        pi.registerCommand("qwen-tokens", {
            description:
                "Show estimated context tokens and the last response token usage",
            handler: (_args, ctx) => {
                const usage = ctx.getContextUsage();
                const last = getLastAssistantUsage(
                    ctx.sessionManager.getEntries(),
                );
                const model = ctx.model
                    ? `${ctx.model.provider}/${ctx.model.id}`
                    : "no model";
                const lines = [`Qwen token usage (${model})`];
                if (usage?.tokens != null) {
                    lines.push(
                        `  context estimate: ${formatCount(usage.tokens)} / ${formatCount(usage.contextWindow)} (${(usage.percent ?? 0).toFixed(1)}%)`,
                    );
                } else {
                    lines.push(
                        `  context estimate unavailable; window ${formatCount(usage?.contextWindow ?? ctx.model?.contextWindow)}`,
                    );
                }
                if (last) {
                    lines.push(
                        `  last response: input ${formatCount(last.input)} · cached ${formatCount(last.cacheRead)} · output ${formatCount(last.output)}` +
                            (last.reasoning
                                ? ` (reasoning ${formatCount(last.reasoning)})`
                                : "") +
                            ` · total ${formatCount(last.totalTokens)}`,
                    );
                } else {
                    lines.push("  no response usage yet");
                }
                const tools = toolUsage();
                if (tools)
                    lines.push(
                        `  built-in tools: ${Object.entries(tools)
                            .map(([name, count]) => `${name} ${count}`)
                            .join(" · ")}`,
                    );
                lines.push(
                    "  Credits are not derived from tokens; check the Bailian console usage analysis.",
                );
                ctx.ui.notify(lines.join("\n"), "info");
                return Promise.resolve();
            },
        });
    }
    registerTokensCommand();
    registerTools(pi, {
        getSettings: () => settings,
        activeKey: () => activeKey(),
        mediaRoot,
        baseUrl: () => activeEndpoints().openai,
    });

    function trackProvider(ctx: ExtensionContext): void {
        const provider = ctx.model?.provider;
        if (isOurProvider(provider))
            activeProvider = providerEntry(provider).id;
    }

    pi.on("session_start", (_event, ctx) => {
        trackProvider(ctx);
        void updateStatus(ctx);
    });
    pi.on("model_select", (_event, ctx) => {
        trackProvider(ctx);
        void updateStatus(ctx, true);
    });
    pi.on("agent_end", (_event, ctx) => {
        void updateStatus(ctx);
    });
}
