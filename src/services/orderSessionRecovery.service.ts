import OrderSession from "../models/orderSession.model";

const ACTIVE_PHASES = ["select_address", "browse", "review_cart"] as const;

export async function isActiveOrderSession(
    sessionId: string,
    familyId: string,
): Promise<boolean> {
    const session = await OrderSession.findOne({ sessionId, familyId }).lean();
    if (!session) return false;
    if (session.phase === "expired" || session.phase === "submitted") return false;
    if (!ACTIVE_PHASES.includes(session.phase as (typeof ACTIVE_PHASES)[number])) {
        return false;
    }
    if (session.expiresAt && session.expiresAt < new Date()) return false;
    return true;
}

export function sessionExpiredPayload(message?: string): Record<string, unknown> {
    return {
        status: "session_expired",
        kind: "prompt",
        message:
            message ??
            "That order basket timed out. Tell me again what you'd like to order and I'll start a fresh basket.",
        action: "call ensure_order_session with the full order request — do not reuse the old sessionId",
    };
}
