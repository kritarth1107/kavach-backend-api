/**
 * Proactive nudge gate (care nudges + random/memory/slot outreach).
 * A nudge may go out ONLY when:
 *   1. there has been NO conversation (elder inbound, or Saheli outbound other than nudges)
 *      for at least NUDGE_QUIET_MINUTES (default 60), AND
 *   2. no job/flow is active for the recipient (browser order, OTP wait, confirm card,
 *      checkout in flight, pharmacy draft, ride booking, order session, pending OTP relay…).
 * Call it at scheduling time AND again right before sending.
 */
import ActivityLog from "../models/activityLog.model";
import SaheliCompanion from "../models/saheliCompanion.model";
import WhatsappSession from "../models/whatsappSession.model";
import User from "../models/users.model";
import {
    hasParkedBrowserOtpSession,
    isCheckoutInFlight,
    peekParkedCheckout,
} from "./commerceAutomation/parkedOtpSession.service";

export function nudgeQuietMs(): number {
    const n = Number(process.env.NUDGE_QUIET_MINUTES);
    return (Number.isFinite(n) && n > 0 ? n : 60) * 60_000;
}

const IDLE_PHASES = new Set(["idle", "done", "", undefined, null]);

/** Pure: is any draft in this WhatsApp session mid-flow? */
export function sessionHasActiveFlow(row: Record<string, unknown> | null | undefined): string | null {
    if (!row) return null;
    const phase = (d: unknown) => (d && typeof d === "object" ? (d as { phase?: string }).phase : undefined);
    const bd = row.browserTaskDraft;
    if (bd && !IDLE_PHASES.has(phase(bd))) return `browser_order:${phase(bd)}`;
    const pd = row.pharmacyDraft;
    if (pd && !IDLE_PHASES.has(phase(pd))) return `pharmacy:${phase(pd)}`;
    const rd = row.rideDraft;
    if (rd && !IDLE_PHASES.has(phase(rd))) return `ride:${phase(rd)}`;
    if (row.pendingCommerceOtp) return "otp_wait";
    if (row.orderSessionId && row.orderPhase !== "completed") return `order_session:${String(row.orderPhase || "open")}`;
    if (row.pendingOrderSwitchText) return "order_switch_pending";
    return null;
}

/** Pure: minutes-quiet check. */
export function quietLongEnough(lastConversationAt: Date | null | undefined, now: number, quietMs: number): boolean {
    if (!lastConversationAt) return true;
    return now - new Date(lastConversationAt).getTime() >= quietMs;
}

export async function canSendProactiveNudge(input: {
    familyId: string;
    recipientUserId: string;
    now?: Date;
}): Promise<{ ok: boolean; reason?: string }> {
    const now = (input.now ?? new Date()).getTime();
    const quietMs = nudgeQuietMs();
    try {
        // (2) active jobs/flows — in-memory browser state first (cheap, authoritative for live pages)
        const actorIds = new Set<string>([input.recipientUserId]);
        const user = await User.findOne({ userId: input.recipientUserId }).lean();
        const phoneDigits =
            user?.phone?.countryCode && user.phone.number
                ? `${user.phone.countryCode}${user.phone.number}`.replace(/\D/g, "")
                : "";
        const or: Record<string, unknown>[] = [
            { userId: input.recipientUserId },
            { pendingRecipientUserId: input.recipientUserId },
        ];
        if (phoneDigits) {
            or.push({ phone: phoneDigits }, { phone: `+${phoneDigits}` });
        }
        const sessions = await WhatsappSession.find({ $or: or }).lean();
        for (const s of sessions) {
            if (s.userId) actorIds.add(String(s.userId));
            const active = sessionHasActiveFlow(s as unknown as Record<string, unknown>);
            if (active) return { ok: false, reason: `active_flow:${active}` };
        }
        for (const actor of actorIds) {
            if (isCheckoutInFlight(input.familyId, actor)) return { ok: false, reason: "active_flow:checkout_in_flight" };
            if (hasParkedBrowserOtpSession(input.familyId, actor)) return { ok: false, reason: "active_flow:otp_page_open" };
            if (peekParkedCheckout(input.familyId, actor)) return { ok: false, reason: "active_flow:confirm_card_open" };
        }

        // (1) last conversation (inbound or non-nudge outbound) ≥ quiet window
        const companion = await SaheliCompanion.findOne({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
        }).lean();
        if (!quietLongEnough(companion?.lastWhatsAppInboundAt, now, quietMs)) {
            return { ok: false, reason: "recent_inbound" };
        }
        const recent = await ActivityLog.findOne({
            recipientUserId: input.recipientUserId,
            kind: { $in: ["message_in", "voice_note", "message_out", "order_step", "order_confirm_card", "order_interrupt"] },
            createdAt: { $gte: new Date(now - quietMs) },
        })
            .select({ _id: 1, kind: 1 })
            .lean();
        if (recent) return { ok: false, reason: `recent_conversation:${recent.kind}` };
        return { ok: true };
    } catch (err) {
        // Fail closed — a missed nudge is better than one in the middle of an order.
        console.warn("nudge gate check failed (skipping nudge):", err instanceof Error ? err.message : err);
        return { ok: false, reason: "gate_error" };
    }
}
