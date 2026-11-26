import type { QuotaReport, QuotaSeat, QuotaWindow } from "./quota.ts";

export function windowLabel(window: QuotaWindow): string {
    if (window.count === 1 && window.unit === "Month") return "1mo";
    if (window.count === 1 && window.unit === "Week") return "1w";
    return `${window.count}${window.unit.charAt(0).toLowerCase()}`;
}

export function countdown(
    resetsAt: number | undefined,
    now = Date.now(),
): string | undefined {
    if (resetsAt === undefined) return undefined;
    const ms = resetsAt - now;
    if (ms <= 0) return "now";
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
    const days = Math.floor(hours / 24);
    return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

const BAR_WIDTH = 10;
const NO_COLOR = Boolean(process.env.NO_COLOR || process.env.TERM === "dumb");

/** Filled circle follows the lowest remaining percentage in the footer. */
function gauge(percent: number | undefined): string {
    if (percent === undefined) return "◔";
    if (percent >= 75) return "●";
    if (percent >= 50) return "◕";
    if (percent >= 25) return "◑";
    if (percent > 0) return "◔";
    return "○";
}

/** Green at 50%+ remaining, yellow at 20%+, red below. */
function bar(percent: number): string {
    const filled = Math.round(
        (Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH,
    );
    let color = 31;
    if (percent >= 50) color = 32;
    else if (percent >= 20) color = 33;
    const empty = "░".repeat(BAR_WIDTH - filled);
    return `\x1b[${color}m${"█".repeat(filled)}\x1b[39m${empty}`;
}

/** `82%`, or a colored bar followed by the percentage when `barEnabled`. */
export function usage(percent: number, barEnabled = false): string {
    const rounded = `${Math.round(percent)}%`;
    if (!barEnabled || NO_COLOR) return rounded;
    return `${bar(percent)} ${rounded}`;
}

export type StatusOptions = {
    now?: number;
    windows?: number;
    seatFilter?: string;
    bar?: boolean;
};

function lowestRemaining(values: (number | undefined)[]): number | undefined {
    const numbers = values.filter(
        (value): value is number => value !== undefined,
    );
    return numbers.length > 0 ? Math.min(...numbers) : undefined;
}

function nearestReset(
    values: (number | undefined)[],
    now: number,
): string | undefined {
    const sorted = values
        .filter((value): value is number => value !== undefined)
        .sort((left, right) => left - right);
    return countdown(sorted[0], now);
}

function footerLine(
    icon: string,
    parts: string[],
    reset: string | undefined,
): string {
    return [icon, ...parts, ...(reset ? [`· ${reset}`] : [])].join(" ");
}

function windowsFooter(
    report: QuotaReport,
    options: StatusOptions,
): string | undefined {
    if (report.windows.length === 0) return undefined;
    const { now = Date.now(), windows = 2, bar: barEnabled = false } = options;
    const shown = report.windows.slice(0, Math.max(1, Math.min(3, windows)));
    const parts = shown.map(
        (window) =>
            `${windowLabel(window)} ${usage(window.percentRemaining, barEnabled)}`,
    );
    const reset = countdown(report.windows[0]?.resetsAt, now);
    const icon = gauge(
        lowestRemaining(shown.map((window) => window.percentRemaining)),
    );
    return footerLine(icon, parts, reset);
}

/** A stale seat name must not blank the footer, so an unmatched filter falls back to all. */
function matchingSeats(seats: QuotaSeat[], filter: string): QuotaSeat[] {
    const filters = filter
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    if (filters.length === 0) return seats;
    const matched = seats.filter((seat) =>
        filters.some((entry) => seat.name.toLowerCase().includes(entry)),
    );
    return matched.length > 0 ? matched : seats;
}

function seatsFooter(
    report: QuotaReport,
    options: StatusOptions,
): string | undefined {
    if (report.seats.length === 0) return undefined;
    const {
        now = Date.now(),
        seatFilter = "",
        bar: barEnabled = false,
    } = options;
    const seats = matchingSeats(report.seats, seatFilter);
    const reset = nearestReset(
        seats.map((seat) => seat.resetsAt),
        now,
    );
    const parts = seats.map((seat) =>
        [
            seat.name,
            ...(seat.percentRemaining === undefined
                ? []
                : [usage(seat.percentRemaining, barEnabled)]),
        ].join(" "),
    );
    const icon = gauge(
        lowestRemaining(seats.map((seat) => seat.percentRemaining)),
    );
    return footerLine(icon, [parts.join(" · ")], reset);
}

/**
 * Compact footer text. `seatFilter` is a comma-separated list of seat names
 * (case-insensitive substring); empty shows every seat. `bar` draws a colored
 * usage bar, skipped when the terminal asks for no colors.
 */
export function statusText(
    report: QuotaReport,
    options: StatusOptions = {},
): string | undefined {
    return windowsFooter(report, options) ?? seatsFooter(report, options);
}

function credits(value: number | undefined): string {
    if (value === undefined) return "?";
    return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function quotaTitle(report: QuotaReport): string {
    const base =
        report.source === "seats"
            ? "Qwen Token Plan seats"
            : "Qwen Token Plan quota";
    const plans = report.plans ?? [];
    return plans.length > 1 ? `${base} (${plans.join(", ")})` : base;
}

function windowLines(report: QuotaReport, now: number): string[] {
    return report.windows.map((window) => {
        const reset = countdown(window.resetsAt, now);
        const label = windowLabel(window).padEnd(4);
        const left = `${window.percentRemaining.toFixed(1).padStart(5)}% left`;
        const tail = reset ? `    resets in ${reset}` : "";
        return `  ${label} ${left}${tail}`;
    });
}

function seatLines(report: QuotaReport, now: number): string[] {
    const lines: string[] = [];
    if (report.windows.length > 0) lines.push("  seats");
    for (const seat of report.seats) {
        const reset = countdown(seat.resetsAt, now);
        const amount =
            seat.surplus !== undefined && seat.total !== undefined
                ? `  ${credits(seat.surplus)} / ${credits(seat.total)} credits`
                : "";
        const percent =
            seat.percentRemaining === undefined
                ? "no ratio"
                : `${seat.percentRemaining.toFixed(1)}% left`;
        const spec = seat.spec ? ` (${seat.spec})` : "";
        const tail = reset ? `    resets in ${reset}` : "";
        lines.push(`  ${seat.name}${spec}  ${percent}${amount}${tail}`);
    }
    return lines;
}

/** Detailed report for `/qwen-quota`. */
export function formatQuota(report: QuotaReport, now = Date.now()): string {
    const lines = [quotaTitle(report), ...windowLines(report, now)];
    if (report.seats.length > 0) lines.push(...seatLines(report, now));
    if (report.windows.length === 0 && report.seats.length === 0)
        lines.push(
            "  No plan answered for this key. Check the Bailian console subscription.",
        );
    if (report.errors.length > 0)
        lines.push("", ...report.errors.map((error) => `  ! ${error}`));
    return lines.join("\n");
}
