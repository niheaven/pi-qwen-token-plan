// Selectable media families. The plan catalog is dynamic, but these ids are the
// verified defaults; unknown ids still pass through so a new model works before
// the next catalog sync.

export const IMAGE_MODELS = [
    "qwen-image-3.0-pro",
    "qwen-image-2.0-pro",
    "qwen-image-2.0",
    "wan2.7-image-pro",
    "wan2.7-image",
] as const;

export const DEFAULT_IMAGE_MODEL = "qwen-image-3.0-pro";

export const VIDEO_FAMILIES = ["happyhorse", "wan"] as const;
export type VideoFamily = (typeof VIDEO_FAMILIES)[number];
export const DEFAULT_VIDEO_FAMILY: VideoFamily = "happyhorse";

const HAPPYHORSE_VERSION = "happyhorse-1.1";
const WAN_VIDEO_MODEL = "wan3.0-video";

export function normalizeImageModel(value: unknown): string {
    return typeof value === "string" &&
        (IMAGE_MODELS as readonly string[]).includes(value)
        ? value
        : DEFAULT_IMAGE_MODEL;
}

export function normalizeVideoFamily(value: unknown): VideoFamily {
    return typeof value === "string" &&
        (VIDEO_FAMILIES as readonly string[]).includes(value)
        ? (value as VideoFamily)
        : DEFAULT_VIDEO_FAMILY;
}

export type VideoMode = "t2v" | "i2v" | "r2v";

export type VideoSelection = {
    family: VideoFamily;
    model: string;
    mode: VideoMode;
};

/**
 * Pick t2v/i2v/r2v from the supplied media, then map it to the family's model.
 * Reference images win over a first frame because r2v is the more specific intent.
 */
export function resolveVideoSelection({
    family,
    hasImage = false,
    referenceCount = 0,
}: {
    family: unknown;
    hasImage?: boolean;
    referenceCount?: number;
}): VideoSelection {
    const selected = normalizeVideoFamily(family);
    let mode: VideoMode = "t2v";
    if (referenceCount > 0) mode = "r2v";
    else if (hasImage) mode = "i2v";
    return {
        family: selected,
        mode,
        model:
            selected === "wan"
                ? WAN_VIDEO_MODEL
                : `${HAPPYHORSE_VERSION}-${mode}`,
    };
}

/** Image sizes offered by the plan docs; `auto` lets the model choose. */
export const IMAGE_SIZES = [
    "auto",
    "1024*1024",
    "1328*1328",
    "1664*928",
    "928*1664",
] as const;

export const VIDEO_RESOLUTIONS = ["auto", "480P", "720P", "1080P"] as const;

export function normalizeImageSize(value: unknown): string {
    return typeof value === "string" &&
        (IMAGE_SIZES as readonly string[]).includes(value)
        ? value
        : "auto";
}

export function normalizeVideoResolution(value: unknown): string {
    return typeof value === "string" &&
        (VIDEO_RESOLUTIONS as readonly string[]).includes(value)
        ? value
        : "auto";
}
