/**
 * Silence streak for proactive companion nudges.
 *  - A nudge is "unanswered" when the elder has sent nothing on WhatsApp since it went out.
 *  - While the previous nudge is unanswered, the next one is a gentle follow-up that quotes it
 *    (WhatsApp reply via `context.message_id`) and continues the same topic (Gemini writes it).
 *  - After NUDGE_SILENCE_ALERT_COUNT (default 3) unanswered nudges — or 2 across a very long gap
 *    (NUDGE_SILENCE_LONG_GAP_HOURS, default 24) — caregivers get ONE WhatsApp alert per streak.
 *  - Any elder message resets the streak (lastWhatsAppInboundAt moves past every nudge).
 * Code only counts/compares timestamps here; all wording/interpretation is the model's job.
 */
import { randomUUID } from "crypto";
import SaheliProactiveNudge from "../models/saheliProactiveNudge.model";
import SaheliCompanion, { type ISaheliCompanion } from "../models/saheliCompanion.model";

export type StreakNudge = {
    nudgeId: string;
    sentAt: Date;
    text: string;
    wamid?: string;
    topicBucket?: string;
    topicHint?: string;
};

function envNum(name: string, fallback: number): number {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function streakConfig() {
    return {
        alertCount: Math.max(2, Math.round(envNum("NUDGE_SILENCE_ALERT_COUNT", 3))),
        graceMs: envNum("NUDGE_SILENCE_GRACE_MINUTES", 60) * 60_000,
        longGapMs: envNum("NUDGE_SILENCE_LONG_GAP_HOURS", 24) * 3_600_000,
        followupMinGapMs: envNum("NUDGE_FOLLOWUP_MIN_GAP_MINUTES", 180) * 60_000,
    };
}

/** Pure: nudges sent after the elder's last message, oldest first. */
export function unansweredStreak(nudges: StreakNudge[], lastElderAt?: Date | null): StreakNudge[] {
    const since = lastElderAt ? new Date(lastElderAt).getTime() : -Infinity;
    return nudges
        .filter((n) => new Date(n.sentAt).getTime() > since)
        .sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
}

function istDay(d: Date): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);
}

export type NudgePlan =
    | { mode: "fresh" }
    | { mode: "followup"; replyTo?: string; previous: StreakNudge[]; unansweredCount: number }
    | { mode: "skip"; reason: string };

/** Pure: what the next proactive nudge should be, given the current streak. */
export function planNextNudge(
    streak: StreakNudge[],
    now: Date,
    opts: { followupMinGapMs?: number; alertCount?: number; ignoreSpacing?: boolean } = {},
): NudgePlan {
    if (!streak.length) return { mode: "fresh" };
    const cfg = streakConfig();
    const gap = opts.followupMinGapMs ?? cfg.followupMinGapMs;
    const alertCount = opts.alertCount ?? cfg.alertCount;
    const last = streak[streak.length - 1]!;
    if (!opts.ignoreSpacing) {
        if (now.getTime() - new Date(last.sentAt).getTime() < gap) return { mode: "skip", reason: "followup_too_soon" };
        // Past the alert threshold: at most one gentle follow-up per day (no piling on).
        if (streak.length >= alertCount && istDay(new Date(last.sentAt)) === istDay(now)) {
            return { mode: "skip", reason: "silence_daily_cap" };
        }
    }
    return { mode: "followup", replyTo: last.wamid, previous: streak.slice(-3), unansweredCount: streak.length };
}

export type SilenceDecision = { alert: boolean; reason: string; key?: string; unanswered: number };

/** Pure: should caregivers be alerted about this streak now? (once per streak) */
export function silenceAlertDecision(
    streak: StreakNudge[],
    now: Date,
    alreadyAlertedKey: string | undefined | null,
    opts: { alertCount?: number; graceMs?: number; longGapMs?: number } = {},
): SilenceDecision {
    const cfg = streakConfig();
    const alertCount = opts.alertCount ?? cfg.alertCount;
    const graceMs = opts.graceMs ?? cfg.graceMs;
    const longGapMs = opts.longGapMs ?? cfg.longGapMs;
    const n = streak.length;
    if (n === 0) return { alert: false, reason: "no_streak", unanswered: 0 };
    const key = streak[0]!.nudgeId;
    if (alreadyAlertedKey && alreadyAlertedKey === key) return { alert: false, reason: "already_alerted", key, unanswered: n };
    const last = streak[n - 1]!;
    // The latest check-in only counts as unanswered after a grace period.
    if (now.getTime() - new Date(last.sentAt).getTime() < graceMs) {
        return { alert: false, reason: "grace", key, unanswered: n };
    }
    if (n >= alertCount) return { alert: true, reason: "count", key, unanswered: n };
    if (n >= 2 && now.getTime() - new Date(streak[0]!.sentAt).getTime() >= longGapMs) {
        return { alert: true, reason: "long_gap", key, unanswered: n };
    }
    return { alert: false, reason: "below_threshold", key, unanswered: n };
}

/** "today, 9:12 AM" / "yesterday, 8:40 PM" / "24 Sep, 7:05 PM" (IST). */
export function formatWhenIST(at: Date | null | undefined, now: Date): string {
    if (!at) return "not yet on WhatsApp";
    const d = new Date(at);
    const time = new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
    })
        .format(d)
        .replace(/\s?(am|pm)$/i, (m) => ` ${m.trim().toUpperCase()}`);
    const day = istDay(d);
    if (day === istDay(now)) return `today, ${time}`;
    if (day === istDay(new Date(now.getTime() - 86_400_000))) return `yesterday, ${time}`;
    const date = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(d);
    return `${date}, ${time}`;
}

export function formatSilenceAlert(input: {
    elderName?: string;
    lastReplyAt?: Date | null;
    unanswered: number;
    firstUnansweredAt: Date;
    now: Date;
}): string {
    const who = input.elderName?.trim() || "Your family member";
    return [
        `⚠️ ${who} hasn't replied to Saheli's last ${input.unanswered} check-ins (since ${formatWhenIST(input.firstUnansweredAt, input.now)}).`,
        `Last reply: ${formatWhenIST(input.lastReplyAt, input.now)}.`,
        `Maybe give them a quick call.`,
    ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// DB helpers

export async function loadStreak(familyId: string, recipientUserId: string) {
    const companion = await SaheliCompanion.findOne({ familyId, recipientUserId }).lean<ISaheliCompanion>();
    const lastElderAt = companion?.lastWhatsAppInboundAt ?? null;
    const rows = await SaheliProactiveNudge.find({
        familyId,
        recipientUserId,
        ...(lastElderAt ? { sentAt: { $gt: lastElderAt } } : {}),
    })
        .sort({ sentAt: -1 })
        .limit(20)
        .lean();
    const streak = unansweredStreak(
        rows.map((r) => ({
            nudgeId: r.nudgeId,
            sentAt: r.sentAt,
            text: r.text,
            wamid: r.wamid,
            topicBucket: r.topicBucket,
            topicHint: r.topicHint,
        })),
        lastElderAt,
    );
    return { companion, lastElderAt, streak };
}

export async function recordProactiveNudge(input: {
    familyId: string;
    recipientUserId: string;
    text: string;
    wamid?: string;
    followUpOf?: string;
    streakIndex: number;
    topicBucket?: string;
    topicHint?: string;
    channel: string;
    sentAt?: Date;
}): Promise<string> {
    const nudgeId = randomUUID();
    await SaheliProactiveNudge.create({ nudgeId, ...input, text: input.text.slice(0, 2000), sentAt: input.sentAt ?? new Date() });
    return nudgeId;
}

/**
 * Alert caregivers once per silence streak (explicit exception to the dashboard-only rule).
 * Atomic claim on the companion row, so ticks / restarts never double-send.
 */
export async function checkSilenceAndAlert(
    familyId: string,
    recipientUserId: string,
    opts: { now?: Date; graceMs?: number; respectQuietHours?: boolean } = {},
): Promise<SilenceDecision & { notified?: number }> {
    const now = opts.now ?? new Date();
    const { companion, lastElderAt, streak } = await loadStreak(familyId, recipientUserId);
    if (!companion) return { alert: false, reason: "no_companion", unanswered: 0 };
    if (opts.respectQuietHours !== false) {
        const { isWithinQuietHours } = await import("./saheliCompanion.service");
        if (isWithinQuietHours(companion, now)) return { alert: false, reason: "quiet_hours", unanswered: streak.length };
    }
    const decision = silenceAlertDecision(streak, now, companion.silenceAlertStreakKey, { graceMs: opts.graceMs });
    if (!decision.alert || !decision.key) return decision;

    const claim = await SaheliCompanion.updateOne(
        { familyId, recipientUserId, silenceAlertStreakKey: { $ne: decision.key } },
        { $set: { silenceAlertStreakKey: decision.key, silenceAlertAt: now } },
    );
    if (claim.modifiedCount !== 1) return { ...decision, alert: false, reason: "already_alerted" };

    const { getFamilyMembersList } = await import("./familyMember.service");
    const elderName = await getFamilyMembersList(familyId, recipientUserId)
        .then((p) => p.members.find((m) => m.userId === recipientUserId)?.name)
        .catch(() => undefined);
    const message = formatSilenceAlert({
        elderName: elderName || undefined,
        lastReplyAt: lastElderAt,
        unanswered: decision.unanswered,
        firstUnansweredAt: new Date(streak[0]!.sentAt),
        now,
    });
    const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
    const res = await notifyCaregivers({
        familyId,
        recipientUserId,
        actorUserId: recipientUserId,
        message,
        urgency: "medium",
        kind: "nudge_silence",
    });
    console.log(
        `Silence alert (${decision.reason}, ${decision.unanswered} unanswered) → ${res.notifiedCount} caregiver(s) for …${recipientUserId.slice(-4)}`,
    );
    return { ...decision, notified: res.notifiedCount };
}
