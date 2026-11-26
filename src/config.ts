import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
    DEFAULT_PROMPT_CACHE,
    normalizePromptCache,
    type PromptCacheRetention,
} from "./cache.ts";
import {
    DEFAULT_IMAGE_MODEL,
    DEFAULT_VIDEO_FAMILY,
    normalizeImageModel,
    normalizeImageSize,
    normalizeVideoFamily,
    normalizeVideoResolution,
} from "./media-models.ts";

export type QwenSettings = {
    quota: {
        /** Footer visibility. The `/qwen-quota` command always works. */
        show: boolean;
        /** How many quota lines the footer shows (1-3). */
        windows: number;
        refreshMinutes: number;
        /** Show a colored usage bar in the footer. */
        bar: boolean;
        /** Comma-separated team-seat names; empty shows every seat. */
        seatFilter: string;
    };
    hostedTools: boolean;
    /** Local `web_fetch` tool backed by the provider's web_extractor. */
    webFetch: boolean;
    /** Text-to-speech and speech-to-text tools. */
    speech: boolean;
    /** Image description tool for text-only models. */
    vision: boolean;
    imageGeneration: boolean;
    videoGeneration: boolean;
    /** Default image model for the tool and image-model calls. */
    imageModel: string;
    /** Default image size; `auto` lets the model pick. */
    imageSize: string;
    /** Default video family: happyhorse or wan. */
    videoModel: string;
    /** Default video resolution; `auto` keeps the provider default (1080P). */
    videoResolution: string;
    /** Explicit prompt cache on qwen4 family Responses requests. */
    promptCache: PromptCacheRetention;
    /** 0 = refresh the catalog on every startup. */
    modelSyncHours: number;
};

export const DEFAULT_SETTINGS: QwenSettings = {
    quota: {
        show: true,
        windows: 2,
        refreshMinutes: 5,
        bar: false,
        seatFilter: "",
    },
    hostedTools: true,
    webFetch: true,
    speech: true,
    vision: true,
    imageGeneration: true,
    videoGeneration: true,
    imageModel: DEFAULT_IMAGE_MODEL,
    imageSize: "auto",
    videoModel: DEFAULT_VIDEO_FAMILY,
    videoResolution: "auto",
    promptCache: DEFAULT_PROMPT_CACHE,
    modelSyncHours: 6,
};

export function agentDir(): string {
    // pi's own override; the older PI_CONFIG_DIR is kept as a fallback.
    const override =
        process.env.PI_CODING_AGENT_DIR ?? process.env.PI_CONFIG_DIR;
    if (override) return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
    return resolve(homedir(), ".pi", "agent");
}

export function settingsPath(): string {
    return resolve(agentDir(), "qwen-token-plan-config.json");
}

export function mediaDir(): string {
    return resolve(agentDir(), "qwen-token-plan-media");
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function booleanOr(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function numberIn(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
): number {
    let parsed = NaN;
    if (typeof value === "number") parsed = value;
    else if (typeof value === "string") parsed = Number(value);
    return Number.isFinite(parsed)
        ? Math.min(max, Math.max(min, Math.round(parsed)))
        : fallback;
}

export function normalizeSettings(raw: unknown): QwenSettings {
    const value = record(raw);
    const quota = record(value.quota);
    return {
        quota: {
            show: booleanOr(quota.show, DEFAULT_SETTINGS.quota.show),
            windows: numberIn(
                quota.windows,
                DEFAULT_SETTINGS.quota.windows,
                1,
                3,
            ),
            refreshMinutes: numberIn(
                quota.refreshMinutes,
                DEFAULT_SETTINGS.quota.refreshMinutes,
                1,
                1440,
            ),
            bar: booleanOr(quota.bar, DEFAULT_SETTINGS.quota.bar),
            seatFilter:
                typeof quota.seatFilter === "string"
                    ? quota.seatFilter.trim().slice(0, 200)
                    : "",
        },
        hostedTools: booleanOr(value.hostedTools, DEFAULT_SETTINGS.hostedTools),
        webFetch: booleanOr(value.webFetch, DEFAULT_SETTINGS.webFetch),
        speech: booleanOr(value.speech, DEFAULT_SETTINGS.speech),
        vision: booleanOr(value.vision, DEFAULT_SETTINGS.vision),
        imageGeneration: booleanOr(
            value.imageGeneration,
            DEFAULT_SETTINGS.imageGeneration,
        ),
        videoGeneration: booleanOr(
            value.videoGeneration,
            DEFAULT_SETTINGS.videoGeneration,
        ),
        imageModel: normalizeImageModel(value.imageModel),
        imageSize: normalizeImageSize(value.imageSize),
        videoModel: normalizeVideoFamily(value.videoModel),
        videoResolution: normalizeVideoResolution(value.videoResolution),
        promptCache: normalizePromptCache(value.promptCache),
        modelSyncHours: numberIn(
            value.modelSyncHours,
            DEFAULT_SETTINGS.modelSyncHours,
            0,
            720,
        ),
    };
}

/** Load our keys, keeping unrelated keys in the shared config file. */
export function loadSettings(): QwenSettings {
    try {
        return normalizeSettings(
            JSON.parse(readFileSync(settingsPath(), "utf8")),
        );
    } catch {
        return normalizeSettings(undefined);
    }
}

export function saveSettings(settings: QwenSettings): void {
    let raw: Record<string, unknown> = {};
    const path = settingsPath();
    try {
        raw = record(JSON.parse(readFileSync(path, "utf8")));
    } catch {
        if (existsSync(path)) {
            // Keep a recovery copy
            // instead of silently discarding other keys.
            try {
                renameSync(path, `${path}.corrupt-${Date.now()}`);
            } catch {
                // If the rename fails, do not overwrite the unreadable file.
                return;
            }
        }
    }
    mkdirSync(agentDir(), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(
        temporary,
        JSON.stringify({ ...raw, ...normalizeSettings(settings) }, null, 2) +
            "\n",
    );
    renameSync(temporary, path);
}
