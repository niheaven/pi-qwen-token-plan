export type JsonValue =
    | string
    | number
    | boolean
    | null
    | JsonValue[]
    | JsonObject;

export type JsonObject = { [key: string]: JsonValue };

// pi-lens-ignore: no-runtime-typeof, no-unknown-parameters -- JSON wire boundary
export function asObject(value: unknown): JsonObject | undefined {
    // pi-lens-ignore: no-runtime-typeof -- JSON boundary
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value as JsonObject;
}

// pi-lens-ignore: no-runtime-typeof, no-unknown-parameters -- JSON wire boundary
export function asString(value: unknown): string | undefined {
    // pi-lens-ignore: no-runtime-typeof -- JSON boundary
    return typeof value === "string" ? value : undefined;
}

// pi-lens-ignore: no-runtime-typeof, no-unknown-parameters -- JSON wire boundary
export function asNumber(value: unknown): number | undefined {
    // pi-lens-ignore: no-runtime-typeof -- JSON boundary
    if (typeof value === "number" && Number.isFinite(value)) return value;
    // pi-lens-ignore: no-runtime-typeof -- JSON boundary
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
