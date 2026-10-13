/**
 * Regular nudges (Kavach NUdge's plan §4.2, 2026-10-13): the engine keeps the silence clock and writes the nudge; it asks
 * here, in one call, for what only the backend knows about this person right now: is their chat open, is Saheli paused,
 * is an order, ride or login code in flight for them, when did they last write, and what went out to them lately
 * (reminders, dose nudges, the morning schedule), so the engine's "last 5 messages" and its clock see every message.
 */
import OutboundMessage from "../models/outboundMessage.model";
import WhatsAppWindow from "../models/whatsappWindow.model";
import { isSaheliPaused, mealNudgeMode, regularNudgeMode } from "./featureFlags.service";

export type NudgeGate = {
    ok: boolean;
    reason: string | null;
    mode: string;
    meals_mode: string;
    window_open: boolean;
    paused: boolean;
    active_flow: string | null;
    last_inbound_at: string | null;
    last_outbound_at: string | null;
    last_outbound_preview: Array<{ text: string; at: string }>;
};

export async function nudgeGate(familyId: string, userId: string, now: Date = new Date()): Promise<NudgeGate> {
    const paused = isSaheliPaused(familyId);
    const mode = regularNudgeMode();
    // An order, ride or login page in progress (fresh ones only). It fails closed: an error reads as a flow in progress.
    const { activeFlowFor } = await import("./saheliNudgeGate.service");
    const activeFlow = await activeFlowFor({ familyId, recipientUserId: userId, now })
        .then((f) => (f ? `active_flow:${f}` : null))
        .catch(() => "gate_error");

    const { familyMemberPhone } = await import("./careMemorySync.service");
    const found = await familyMemberPhone(familyId, userId);
    let open = false;
    let lastInbound: Date | null = null;
    if (!("reason" in found)) {
        const { phoneKey, windowOpen } = await import("./whatsappWindow.service");
        const row = await WhatsAppWindow.findOne({ phone: phoneKey(found.phone) }).lean<{ lastInboundAt?: Date }>();
        lastInbound = row?.lastInboundAt && new Date(row.lastInboundAt).getTime() > 0 ? new Date(row.lastInboundAt) : null;
        // Strict for a nudge: a number with no record of a message from them is not an open chat (other sends try it and
        // let Meta close it; a nudge has no template to fall back on).
        open = lastInbound !== null && (await windowOpen(found.phone, now));
    }
    // What went out to THIS person's number (recipientUserId on these rows is the person cared for, so messages to a
    // caregiver about her carry her id too).
    const digits = "reason" in found ? "" : String(found.phone).replace(/\D/g, "");
    const outs = !digits ? [] : await OutboundMessage.find({ familyId, channelIdentifier: { $in: [`+${digits}`, digits] }, direction: "outbound" })
        .sort({ deliveredAt: -1 })
        .limit(5)
        .select({ content: 1, deliveredAt: 1 })
        .lean<Array<{ content: string; deliveredAt?: Date }>>();
    const preview = outs
        .filter((o) => o.deliveredAt)
        .map((o) => ({ text: String(o.content || "").slice(0, 300), at: new Date(o.deliveredAt as Date).toISOString() }));
    const reason = paused
        ? "paused"
        : activeFlow
          ? activeFlow
          : "reason" in found
            ? found.reason
            : !open
              ? "window_closed"
              : null;
    return {
        ok: reason === null,
        reason,
        mode,
        meals_mode: mealNudgeMode(),
        window_open: open,
        paused,
        active_flow: activeFlow,
        last_inbound_at: lastInbound ? lastInbound.toISOString() : null,
        last_outbound_at: preview[0]?.at ?? null,
        last_outbound_preview: preview,
    };
}
