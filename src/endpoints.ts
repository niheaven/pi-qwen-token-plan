// Token Plan endpoints. Keys are region-specific: a key from one region is
// rejected (401) by the other, so the region travels with the credential.
export type Region = "cn" | "global";

export const REGIONS: Record<Region, { label: string; baseUrl: string }> = {
    cn: {
        label: "China",
        baseUrl: "https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1",
    },
    global: {
        label: "International",
        baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
    },
};

export const DEFAULT_REGION: Region = "cn";
export const REGION_ENV = "QWEN_TOKEN_PLAN_REGION";

export function resolveRegion(value: unknown): Region {
    // `sg` was the earlier name for the international host.
    if (value === "sg") return "global";
    return value === "global" || value === "cn" ? value : DEFAULT_REGION;
}

export function baseUrlFor(region: Region): string {
    return REGIONS[region].baseUrl;
}

export type Endpoints = { openai: string; anthropic: string };

export function endpointsFor(baseUrl: string): Endpoints {
    const openai = baseUrl.replace(/\/+$/, "");
    return {
        openai,
        anthropic: openai.replace(/\/compatible-mode\/v1$/, "/apps/anthropic"),
    };
}

/** The credential stores its endpoints as JSON in the `refresh` field. */
export function parseEndpoints(refresh: unknown): Endpoints | undefined {
    if (typeof refresh !== "string" || !refresh) return undefined;
    try {
        const value = JSON.parse(refresh) as {
            openai?: unknown;
            anthropic?: unknown;
        };
        if (typeof value?.openai !== "string" || !value.openai)
            return undefined;
        const endpoints = endpointsFor(value.openai);
        return typeof value.anthropic === "string" && value.anthropic
            ? { ...endpoints, anthropic: value.anthropic }
            : endpoints;
    } catch {
        return undefined;
    }
}
