import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { normalizePromptCache, PROMPT_CACHE_RETENTIONS } from "./cache.ts";
import { DEFAULT_SETTINGS, type QwenSettings } from "./config.ts";
import {
    IMAGE_MODELS,
    IMAGE_SIZES,
    VIDEO_FAMILIES,
    VIDEO_RESOLUTIONS,
} from "./media-models.ts";

export type SettingsHost = {
    providerId: string;
    getSettings(): QwenSettings;
    persistSettings(): void;
    updateStatus(ctx: ExtensionCommandContext, force?: boolean): Promise<void>;
    modelCount(): number;
    /** Live team seat names from the quota API. */
    listSeats(force?: boolean): Promise<string[]>;
};

type MenuEntry = { label: string; edit(): Promise<boolean> };

async function editChoice(
    ctx: ExtensionCommandContext,
    title: string,
    options: string[],
    apply: (value: string) => void,
): Promise<boolean> {
    const next = await ctx.ui.select(title, options);
    if (!next) return false;
    apply(next);
    return true;
}

function selectedSeats(seatFilter: string): string[] {
    return seatFilter
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/** Checkbox loop over the live seat names; empty selection means every seat. */
async function pickSeats(
    ctx: ExtensionCommandContext,
    host: SettingsHost,
    settings: QwenSettings,
): Promise<boolean> {
    let names: string[];
    try {
        names = await host.listSeats(true);
    } catch (error) {
        ctx.ui.notify(
            `Could not read team seats: ${error instanceof Error ? error.message : String(error)}`,
            "error",
        );
        return false;
    }
    if (names.length === 0) {
        ctx.ui.notify("The quota API returned no seats.", "warning");
        return false;
    }

    const chosen = new Set(selectedSeats(settings.quota.seatFilter));
    for (;;) {
        const choice = await ctx.ui.select(
            `Team seats (${chosen.size}/${names.length} selected)`,
            [
                ...names.map((name) =>
                    chosen.has(name) ? `[x] ${name}` : `[ ] ${name}`,
                ),
                "Select all",
                "Clear selection",
                "Done",
            ],
        );
        if (!choice || choice === "Done") break;
        if (choice === "Select all") {
            for (const name of names) chosen.add(name);
            continue;
        }
        if (choice === "Clear selection") {
            chosen.clear();
            continue;
        }
        const name = choice.slice(4);
        if (chosen.has(name)) chosen.delete(name);
        else chosen.add(name);
    }

    settings.quota.seatFilter = [...chosen].join(",");
    return true;
}

function menuEntries(
    ctx: ExtensionCommandContext,
    host: SettingsHost,
    settings: QwenSettings,
): MenuEntry[] {
    const syncLabels = [
        "every startup",
        "every 6h",
        "every 12h",
        "every 24h",
        "every 7 days",
    ];
    const syncHours = [0, 6, 12, 24, 168];
    return [
        {
            label: `Quota footer: ${settings.quota.show ? "shown" : "hidden"}`,
            edit: () =>
                editChoice(
                    ctx,
                    "Quota footer",
                    ["shown", "hidden"],
                    (value) => {
                        settings.quota.show = value === "shown";
                    },
                ),
        },
        {
            label: `Quota footer lines: ${settings.quota.windows}`,
            edit: () =>
                editChoice(
                    ctx,
                    "Quota footer lines",
                    ["1", "2", "3"],
                    (value) => {
                        settings.quota.windows = Number(value);
                    },
                ),
        },
        {
            label: `Quota cache TTL: ${settings.quota.refreshMinutes} min`,
            edit: () =>
                editChoice(
                    ctx,
                    "Quota cache TTL",
                    ["1", "5", "15", "30", "60"],
                    (value) => {
                        settings.quota.refreshMinutes = Number(value);
                    },
                ),
        },
        {
            label: `Quota bar: ${settings.quota.bar ? "on" : "off"}`,
            edit: () =>
                editChoice(ctx, "Quota bar", ["on", "off"], (value) => {
                    settings.quota.bar = value === "on";
                }),
        },
        {
            label: `Team seats: ${settings.quota.seatFilter || "all seats"}`,
            edit: () => pickSeats(ctx, host, settings),
        },
        {
            label: `Hosted tools: ${settings.hostedTools ? "on" : "off"}`,
            edit: () =>
                editChoice(ctx, "Hosted tools", ["on", "off"], (value) => {
                    settings.hostedTools = value === "on";
                }),
        },
        {
            label: `Web fetch tool: ${settings.webFetch ? "on" : "off"}`,
            edit: () =>
                editChoice(ctx, "Web fetch tool", ["on", "off"], (value) => {
                    settings.webFetch = value === "on";
                }),
        },
        {
            label: `Speech tools: ${settings.speech ? "on" : "off"}`,
            edit: () =>
                editChoice(ctx, "Speech tools", ["on", "off"], (value) => {
                    settings.speech = value === "on";
                }),
        },
        {
            label: `Vision tool: ${settings.vision ? "on" : "off"}`,
            edit: () =>
                editChoice(ctx, "Vision tool", ["on", "off"], (value) => {
                    settings.vision = value === "on";
                }),
        },
        {
            label: `Image generation: ${settings.imageGeneration ? "on" : "off"}`,
            edit: () =>
                editChoice(ctx, "Image generation", ["on", "off"], (value) => {
                    settings.imageGeneration = value === "on";
                }),
        },
        {
            label: `Image model: ${settings.imageModel}`,
            edit: () =>
                editChoice(ctx, "Image model", [...IMAGE_MODELS], (value) => {
                    settings.imageModel = value;
                }),
        },
        {
            label: `Image size: ${settings.imageSize}`,
            edit: () =>
                editChoice(ctx, "Image size", [...IMAGE_SIZES], (value) => {
                    settings.imageSize = value;
                }),
        },
        {
            label: `Video generation: ${settings.videoGeneration ? "on" : "off"}`,
            edit: () =>
                editChoice(ctx, "Video generation", ["on", "off"], (value) => {
                    settings.videoGeneration = value === "on";
                }),
        },
        {
            label: `Video model: ${settings.videoModel}`,
            edit: () =>
                editChoice(ctx, "Video model", [...VIDEO_FAMILIES], (value) => {
                    settings.videoModel = value;
                }),
        },
        {
            label: `Video resolution: ${settings.videoResolution}`,
            edit: () =>
                editChoice(
                    ctx,
                    "Video resolution",
                    [...VIDEO_RESOLUTIONS],
                    (value) => {
                        settings.videoResolution = value;
                    },
                ),
        },
        {
            label: `Prompt cache (qwen4): ${settings.promptCache}`,
            edit: () =>
                editChoice(
                    ctx,
                    "Prompt cache (qwen4)",
                    [...PROMPT_CACHE_RETENTIONS],
                    (value) => {
                        settings.promptCache = normalizePromptCache(value);
                    },
                ),
        },
        {
            label: `Model sync: ${settings.modelSyncHours === 0 ? "every startup" : `every ${settings.modelSyncHours}h`}`,
            edit: () =>
                editChoice(ctx, "Model sync", syncLabels, (value) => {
                    const index = syncLabels.indexOf(value);
                    if (index >= 0) settings.modelSyncHours = syncHours[index];
                }),
        },
    ];
}

async function syncModels(
    ctx: ExtensionCommandContext,
    host: SettingsHost,
): Promise<void> {
    try {
        await ctx.modelRegistry.refresh({
            force: true,
            providers: [host.providerId],
        });
        ctx.ui.notify(`Qwen models refreshed (${host.modelCount()})`, "info");
    } catch (error) {
        ctx.ui.notify(
            `Model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
        );
    }
    void host.updateStatus(ctx, true);
}

function resetDefaults(settings: QwenSettings): void {
    Object.assign(settings, DEFAULT_SETTINGS, {
        quota: { ...DEFAULT_SETTINGS.quota },
    });
}

export async function settingsMenu(
    ctx: ExtensionCommandContext,
    host: SettingsHost,
): Promise<void> {
    const settings = host.getSettings();
    for (;;) {
        const entries = menuEntries(ctx, host, settings);
        const choice = await ctx.ui.select("Qwen settings", [
            ...entries.map((entry) => entry.label),
            "Sync models now",
            "Reset defaults",
            "Close",
        ]);
        if (!choice || choice === "Close") return;
        if (choice === "Sync models now") {
            await syncModels(ctx, host);
            continue;
        }
        if (choice === "Reset defaults") {
            resetDefaults(settings);
            host.persistSettings();
            ctx.ui.notify("Qwen settings reset", "info");
            void host.updateStatus(ctx, true);
            continue;
        }

        const entry = entries.find((item) => item.label === choice);
        if (!entry || !(await entry.edit())) continue;

        host.persistSettings();
        // A seat picker already refreshed its data; re-render from the cache.
        if (choice.startsWith("Quota bar") || choice.startsWith("Team seats")) {
            void host.updateStatus(ctx, false);
        } else if (choice.startsWith("Quota")) {
            void host.updateStatus(ctx, true);
        }
        ctx.ui.notify("Qwen settings saved", "info");
    }
}
