/**
 * A reminder button's id (we set it; it is not the person's words).
 *   done:<scheduleId>                         a dose, the v1 button
 *   done|later|skip : dose|habit|reminder|appointment : <ref>
 * A habit ref is activity:<key>@<date>. A custom reminder ref is <id>@<date>@<HH:MM>.
 */

export type ReminderTapAction = "done" | "later" | "skip";
export type ReminderTapKind = "dose" | "habit" | "reminder" | "appointment";

export type ReminderTap = {
    action: ReminderTapAction;
    kind: ReminderTapKind;
    ref: string;
};

const KINDS = new Set<ReminderTapKind>(["dose", "habit", "reminder", "appointment"]);

/** The button id Meta sends back, or null when it is not one of ours. */
export function parseReminderTap(id: string): ReminderTap | null {
    const raw = String(id ?? "").trim();
    const typed = raw.match(/^(done|later|skip):(dose|habit|reminder|appointment):(.+)$/i);
    if (typed?.[3] && KINDS.has(typed[2].toLowerCase() as ReminderTapKind)) {
        return {
            action: typed[1].toLowerCase() as ReminderTapAction,
            kind: typed[2].toLowerCase() as ReminderTapKind,
            ref: typed[3],
        };
    }
    const dose = raw.match(/^done:([\w-]+)$/i);
    if (dose?.[1]) return { action: "done", kind: "dose", ref: dose[1] };
    return null;
}

/** The sentence the inbound normaliser hands the recorder. A dose Done stays the old sentence. */
export function tapSentence(tap: ReminderTap): string {
    if (tap.action === "done" && tap.kind === "dose") return `I completed schedule ${tap.ref}`;
    if (tap.action === "later") return `Later reminder ${tap.kind} ${tap.ref}`;
    if (tap.action === "skip") return `Skip reminder ${tap.kind} ${tap.ref}`;
    return `Record ${tap.kind} ${tap.ref}`;
}

/** The sentence back into a tap. Null when this message is not a reminder button. */
export function tapFromSentence(text: string): ReminderTap | null {
    const t = String(text ?? "").trim();
    const dose = t.match(/^I completed schedule ([\w-]+)$/i);
    if (dose?.[1]) return { action: "done", kind: "dose", ref: dose[1] };
    const moved = t.match(/^(Later|Skip) reminder (dose|habit|reminder|appointment) (.+)$/i);
    if (moved?.[3]) {
        return {
            action: moved[1].toLowerCase() === "later" ? "later" : "skip",
            kind: moved[2].toLowerCase() as ReminderTapKind,
            ref: moved[3],
        };
    }
    const recorded = t.match(/^Record (habit|reminder|appointment) (.+)$/i);
    if (recorded?.[2]) return { action: "done", kind: recorded[1].toLowerCase() as ReminderTapKind, ref: recorded[2] };
    return null;
}

/** Three payloads; a one-button template keeps only the first (Done). */
export function reminderPayloads(kind: ReminderTapKind, ref: string): string[] {
    return [`done:${kind}:${ref}`, `later:${kind}:${ref}`, `skip:${kind}:${ref}`];
}

/** A dose keeps `done:<scheduleId>` first, so the approved one-button template still marks it taken. */
export function dosePayloads(scheduleId: string): string[] {
    return [`done:${scheduleId}`, ...reminderPayloads("dose", scheduleId).slice(1)];
}
