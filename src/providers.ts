import { baseUrlFor, type Region } from "./endpoints.ts";

/** Team or individual subscription; the two are metered and cataloged separately. */
export type Plan = "team" | "individual";

export type ProviderSpec = {
    id: string;
    plan: Plan;
    region: Region;
    name: string;
    envKeys: readonly string[];
};

/**
 * pi's own Qwen Token Plan provider ids, one per plan and region. Registering
 * these ids reuses the account slots pi already writes, and the login flow below
 * decides which id an entered key belongs to.
 */
export const PROVIDERS: readonly ProviderSpec[] = [
    {
        id: "qwen-token-plan-cn",
        plan: "team",
        region: "cn",
        name: "Qwen Token Plan",
        envKeys: [
            "QWEN_TOKEN_PLAN_TEAM_CN_API_KEY",
            "QWEN_TOKEN_PLAN_CN_API_KEY",
        ],
    },
    {
        id: "qwen-token-plan",
        plan: "team",
        region: "global",
        name: "Qwen Token Plan (International)",
        envKeys: ["QWEN_TOKEN_PLAN_TEAM_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"],
    },
    {
        id: "qwen-token-plan-individual-cn",
        plan: "individual",
        region: "cn",
        name: "Qwen Token Plan Individual",
        envKeys: [
            "QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY",
            "QWEN_TOKEN_PLAN_CN_API_KEY",
        ],
    },
    {
        id: "qwen-token-plan-individual",
        plan: "individual",
        region: "global",
        name: "Qwen Token Plan Individual (International)",
        envKeys: [
            "QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY",
            "QWEN_TOKEN_PLAN_API_KEY",
        ],
    },
];

/** The provider the single login entry lives on. */
export const LOGIN_PROVIDER = "qwen-token-plan-cn";

export function providerEntry(id: string | undefined): ProviderSpec {
    return PROVIDERS.find((entry) => entry.id === id) ?? PROVIDERS[0];
}

export function isOurProvider(provider: string | undefined): boolean {
    return PROVIDERS.some((entry) => entry.id === provider);
}

export function providerIdFor(plan: Plan, region: Region): string {
    return providerEntry(
        PROVIDERS.find(
            (entry) => entry.plan === plan && entry.region === region,
        )?.id,
    ).id;
}

export function baseUrlForProvider(id: string): string {
    return baseUrlFor(providerEntry(id).region);
}
