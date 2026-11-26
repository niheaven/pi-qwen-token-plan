import type {
    OAuthCredentials,
    OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { writeAccount } from "./account.ts";
import {
    baseUrlFor,
    endpointsFor,
    REGIONS,
    type Region,
    resolveRegion,
} from "./endpoints.ts";
import type { Plan } from "./providers.ts";
import { PROVIDERS, providerIdFor } from "./providers.ts";

export interface TokenPlanOAuth {
    name: string;
    isSubscription: boolean;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
}

const YEAR_MS = 365 * 86_400_000;
const CHECK_TIMEOUT_MS = 10_000;

const PLAN_CHOICES: { id: Plan; label: string }[] = [
    { id: "team", label: "Team" },
    { id: "individual", label: "Individual" },
];

const REGION_CHOICES: { id: Region; label: string }[] = [
    { id: "cn", label: "China (Beijing)" },
    { id: "global", label: "International" },
];

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function choose<T extends string>(
    callbacks: OAuthLoginCallbacks,
    message: string,
    choices: { id: T; label: string }[],
): Promise<T> {
    const chosen = await callbacks.onSelect?.({
        message,
        options: choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
        })),
    });
    const match = choices.find((choice) => choice.id === chosen);
    if (!match)
        throw new Error(
            `A choice is required. Set a QWEN_TOKEN_PLAN_*_API_KEY environment variable to skip this login.`,
        );
    return match.id;
}

/**
 * The plan decides which provider id the key belongs to, so the flow asks for it
 * before the key and writes the account record for that id.
 */
export function createTokenPlanOAuth({
    fetchImpl = fetch,
    timeoutMs = CHECK_TIMEOUT_MS,
}: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
} = {}): TokenPlanOAuth {
    return {
        name: "Qwen Token Plan",
        isSubscription: true,

        async login(callbacks) {
            const plan = await choose<Plan>(
                callbacks,
                "Which Qwen Token Plan subscription is this key for?",
                PLAN_CHOICES,
            );
            const region = resolveRegion(
                await choose<Region>(
                    callbacks,
                    "Where was the Token Plan purchased?",
                    REGION_CHOICES,
                ),
            );
            const answer = await callbacks.onPrompt({
                message: `Enter the ${plan} Token Plan API key (sk-sp-…)`,
            });
            const key = answer.trim();
            if (!key) throw new Error("API key is empty");

            const endpoints = endpointsFor(baseUrlFor(region));
            const response = await fetchImpl(`${endpoints.openai}/models`, {
                headers: {
                    authorization: `Bearer ${key}`,
                    accept: "application/json",
                },
                signal: withTimeout(callbacks.signal, timeoutMs),
            });
            if (response.status === 401 || response.status === 403) {
                throw new Error(
                    `This key was rejected for ${REGIONS[region].label}. Pick the region where the Token Plan was purchased.`,
                );
            }
            if (!response.ok)
                throw new Error(
                    `Token Plan key check failed with HTTP ${response.status}`,
                );

            // pi writes the credential under the id it was clicked on; this puts it
            // under the id the plan and region actually resolved to, with pi's own
            // lock-and-read-modify-write discipline.
            const provider = providerIdFor(plan, region);
            await writeAccount(provider, key);

            return {
                access: key,
                refresh: JSON.stringify(endpoints),
                expires: Date.now() + YEAR_MS,
            };
        },

        // Token Plan keys do not expire on their own; there is nothing to refresh.
        async refreshToken(credentials) {
            return credentials;
        },

        getApiKey(credentials) {
            return credentials.access;
        },
    };
}

export { PROVIDERS };
