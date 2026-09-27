/**
 * Proactive delegate messages (delivery check, medicine-start check, resume nudge, approval
 * result) through the SAME nudge system as check-ins: quiet hours, the nudge gate (no active
 * flow, quiet ≥ window), the silence streak (threaded follow-up quoting the last unanswered
 * nudge; counts toward the 3-unanswered caregiver alert). Only the message — no menus.
 */
import type { ISaheliTask } from "../../models/saheliTask.model";
import WhatsappSession from "../../models/whatsappSession.model";
import { writeProactiveLine } from "./delegateGemini";
import { recentChat } from "./tasks.service";

export type Purpose = Parameters<typeof writeProactiveLine>[0]["purpose"];

function istMinutes(at: Date): number {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(at);
    const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return (g("hour") % 24) * 60 + g("minute");
}
/** Caregivers have no companion profile: a fixed polite window (21:30–08:00 IST). */
export function caregiverQuiet(at = new Date()): boolean {
    const m = istMinutes(at);
    return m >= 21 * 60 + 30 || m < 8 * 60;
}

export async function elderLanguage(familyId: string, recipientUserId: string, fallback?: string | null): Promise<string | null> {
    try {
        const SaheliCompanion = (await import("../../models/saheliCompanion.model")).default;
        const c = await SaheliCompanion.findOne({ familyId, recipientUserId }).lean();
        return (c as { preferredLanguage?: string } | null)?.preferredLanguage || fallback || null;
    } catch {
        return fallback || null;
    }
}

export async function personName(familyId: string, userId: string): Promise<string | undefined> {
    try {
        const { getFamilyMembersList } = await import("../familyMember.service");
        const p = await getFamilyMembersList(familyId, userId);
        return p.members.find((m) => m.userId === userId)?.name?.trim() || undefined;
    } catch {
        return undefined;
    }
}

const FALLBACK: Record<string, (item: string) => string> = {
    delivery_check: (i) => `Aapka ${i} aa gaya? 🙂`,
    med_start_check: (i) => `${i} shuru kar di aapne? 🙂`,
    ride_check: () => "Aaram se pahunch gaye? 🙂",
    resume_nudge: (i) => `${i} ka order adhoora reh gaya tha — poora kar doon? 🙂`,
    approval_approved: (i) => `Haan ho gayi hai 🙂 ${i} mangwa doon?`,
    approval_denied: () => "Abhi ke liye rehne dete hain 🙏 Ek baar ghar pe baat kar lijiye.",
};

export type SendResult = { sent: boolean; reason?: string; text?: string };

export async function sendDelegateMessage(
    task: ISaheliTask,
    purpose: Purpose,
    facts: string,
    opts: { bypassGate?: boolean; bypassQuiet?: boolean; direct?: boolean } = {},
): Promise<SendResult> {
    const now = new Date();
    const isElder = task.actorRole !== "caregiver";
    let companion: import("../../models/saheliCompanion.model").ISaheliCompanion | null = null;
    if (isElder) {
        const { getCompanionProfile, isWithinQuietHours } = await import("../saheliCompanion.service");
        companion = await getCompanionProfile(task.familyId, task.recipientUserId).catch(() => null);
        if (!opts.bypassQuiet && companion && isWithinQuietHours(companion, now)) return { sent: false, reason: "quiet_hours" };
    } else if (!opts.bypassQuiet && caregiverQuiet(now)) {
        return { sent: false, reason: "quiet_hours" };
    }
    // Nudge gate (direct = an answer to her own request, e.g. the caregiver's approval: only
    // an active flow blocks it, not the quiet-window).
    if (!opts.bypassGate) {
        if (isElder && !opts.direct) {
            const { canSendProactiveNudge } = await import("../saheliNudgeGate.service");
            const g = await canSendProactiveNudge({ familyId: task.familyId, recipientUserId: task.recipientUserId });
            let ok = g.ok;
            // Resume nudge: the "active flow" IS the abandoned task (a stale draft still in the
            // session) — fine once the session has been untouched for a while; live pages still block.
            if (!ok && purpose === "resume_nudge" && /^active_flow:(browser_order|pharmacy|ride|order_session)/.test(String(g.reason))) {
                const row = await WhatsappSession.findOne({ phone: task.phone }).lean().catch(() => null);
                const idle = now.getTime() - new Date((row as { updatedAt?: Date } | null)?.updatedAt || 0).getTime();
                const lastIn = companion?.lastWhatsAppInboundAt ? now.getTime() - new Date(companion.lastWhatsAppInboundAt).getTime() : Infinity;
                ok = idle >= 60 * 60_000 && lastIn >= 60 * 60_000;
            }
            if (!ok) return { sent: false, reason: g.reason };
        } else {
            const { sessionHasActiveFlow } = await import("../saheliNudgeGate.service");
            const row = await WhatsappSession.findOne({ phone: task.phone }).lean().catch(() => null);
            const active = sessionHasActiveFlow(row as unknown as Record<string, unknown>);
            // Resume nudge: the stale draft is the abandoned task itself — fine once untouched for an hour.
            const idle = now.getTime() - new Date((row as { updatedAt?: Date } | null)?.updatedAt || 0).getTime();
            if (active && !(purpose === "resume_nudge" && idle >= 60 * 60_000)) return { sent: false, reason: `active_flow:${active}` };
        }
    }
    // Silence streak → threaded follow-up (elder only; caregivers have no check-in streak).
    let replyTo: string | undefined;
    let previous: string[] = [];
    let streakIndex = 1;
    let followUpOf: string | undefined;
    if (isElder) {
        const { loadStreak, planNextNudge } = await import("../saheliNudgeStreak.service");
        const st = await loadStreak(task.familyId, task.recipientUserId).catch(() => null);
        if (st) {
            const plan = planNextNudge(st.streak, now, { ignoreSpacing: opts.bypassGate || opts.direct });
            if (plan.mode === "skip") return { sent: false, reason: plan.reason };
            if (plan.mode === "followup") {
                replyTo = plan.replyTo;
                previous = plan.previous.map((n) => n.text);
                streakIndex = plan.unansweredCount + 1;
                followUpOf = plan.previous[plan.previous.length - 1]?.nudgeId;
            }
        }
    }
    // The language she actually used for this task wins over the profile default.
    const language = task.language || (isElder ? await elderLanguage(task.familyId, task.recipientUserId, null) : null);
    const name = await personName(task.familyId, task.ownerUserId);
    const chat = await recentChat(task.phone, task.recipientUserId, isElder, 24).catch(() => "");
    const item = task.item || task.productQuery || "order";
    const text =
        (await writeProactiveLine({ purpose, facts, language, name, previous, recentChat: chat }).catch(() => null)) ||
        (FALLBACK[purpose] || FALLBACK.delivery_check)(item);
    const { deliverOutboundMessage } = await import("../channelOutbound.service");
    const delivery = await deliverOutboundMessage({
        familyId: task.familyId,
        recipientUserId: task.recipientUserId,
        content: text,
        channel: "whatsapp",
        channelIdentifier: task.phone,
        replyToMessageId: replyTo,
    }).catch((err) => {
        console.warn("[delegate] send failed:", err instanceof Error ? err.message : err);
        return null;
    });
    if (!delivery?.delivered) return { sent: false, reason: delivery?.reason || "not_delivered" };
    const { rememberTurn } = await import("../saheliRouter.service");
    rememberTurn(task.phone, "saheli", text);
    if (isElder) {
        const { recordProactiveNudge } = await import("../saheliNudgeStreak.service");
        await recordProactiveNudge({
            familyId: task.familyId,
            recipientUserId: task.recipientUserId,
            text,
            wamid: delivery.messageIds?.[0],
            followUpOf,
            streakIndex,
            topicBucket: `delegate:${purpose}`,
            topicHint: item.slice(0, 80),
            channel: "whatsapp",
        }).catch(() => undefined);
    }
    const { logActivity } = await import("../activityLog.service");
    void logActivity({
        familyId: task.familyId,
        recipientUserId: task.recipientUserId,
        actorUserId: task.ownerUserId,
        kind: "nudge",
        title: `Saheli follow-through: ${purpose.replace(/_/g, " ")}${previous.length ? ` (after ${previous.length} unanswered)` : ""}`,
        detail: text,
        data: { source: "delegate", purpose, taskId: task.taskId, item, toCaregiver: !isElder, quotedPrevious: Boolean(replyTo) },
    });
    return { sent: true, text };
}
