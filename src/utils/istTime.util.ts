/** Kavach care schedules and adherence use India Standard Time. */
export const KAVACH_TIMEZONE = process.env.KAVACH_TIMEZONE?.trim() || "Asia/Kolkata";

export type ISTParts = {
    year: number;
    month: number;
    day: number;
    dayOfWeek: number;
    hours: number;
    minutes: number;
    minutesSinceMidnight: number;
};

const WEEKDAY_TO_INDEX: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
};

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
    return parts.find((p) => p.type === type)?.value ?? "";
}

export function getISTParts(at: Date = new Date()): ISTParts {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone: KAVACH_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const parts = dtf.formatToParts(at);
    const year = Number(part(parts, "year"));
    const month = Number(part(parts, "month"));
    const day = Number(part(parts, "day"));
    const hours = Number(part(parts, "hour"));
    const minutes = Number(part(parts, "minute"));
    const weekday = part(parts, "weekday").replace(/\./g, "");
    const dayOfWeek = WEEKDAY_TO_INDEX[weekday] ?? 0;

    return {
        year,
        month,
        day,
        dayOfWeek,
        hours,
        minutes,
        minutesSinceMidnight: hours * 60 + minutes,
    };
}

export function toDateKeyIST(at: Date = new Date()): string {
    const p = getISTParts(at);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function parseDateKeyIST(dateKey: string): ISTParts | null {
    const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) return null;

    const noonIst = new Date(`${dateKey}T12:00:00+05:30`);
    if (Number.isNaN(noonIst.getTime())) return null;

    const dow = getISTParts(noonIst).dayOfWeek;
    return {
        year,
        month,
        day,
        dayOfWeek: dow,
        hours: 0,
        minutes: 0,
        minutesSinceMidnight: 0,
    };
}

export function isSameDayIST(dateKey: string, at: Date = new Date()): boolean {
    return dateKey === toDateKeyIST(at);
}

export function isPastDayIST(dateKey: string, at: Date = new Date()): boolean {
    return dateKey < toDateKeyIST(at);
}
