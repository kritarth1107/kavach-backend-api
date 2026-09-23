import OrderSession from "../models/orderSession.model";

const ACTIVE_PHASES = ["select_address", "browse", "review_cart"] as const;

export type SessionErrorReason = "expired" | "not_found" | "partner_error" | "catalog_error" | "address_error";

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

export async function getSessionWithReason(
    sessionId: string,
    familyId: string,
): Promise<{ active: boolean; reason?: SessionErrorReason }> {
    const session = await OrderSession.findOne({ sessionId, familyId }).lean();
    if (!session) return { active: false, reason: "not_found" };
    if (session.phase === "expired") return { active: false, reason: "expired" };
    if (session.phase === "submitted") return { active: false, reason: "expired" };
    if (!ACTIVE_PHASES.includes(session.phase as (typeof ACTIVE_PHASES)[number])) {
        return { active: false, reason: "expired" };
    }
    if (session.expiresAt && session.expiresAt < new Date()) {
        return { active: false, reason: "expired" };
    }
    return { active: true };
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

export function partnerErrorPayload(partner: string, errorType: "catalog" | "address" | "general"): Record<string, unknown> {
    const partnerLabel = partner === "swiggy" ? "Swiggy Food" : partner === "instamart" ? "Instamart" : "Zepto";
    const messages: Record<string, string> = {
        catalog: `${partnerLabel} search is slow right now. Your basket is still open — reply *retry* to try again.`,
        address: `Couldn't load your saved ${partnerLabel} addresses. Your basket is still open — reply *retry* or try again in a moment.`,
        general: `${partnerLabel} is having trouble. Your basket is still open — reply *retry* to try again.`,
    };
    return {
        status: "partner_error",
        kind: "prompt",
        partner,
        partnerLabel,
        message: messages[errorType] ?? messages.general,
        action: "the session is still active — do not create a new one. Retry or wait.",
        retryable: true,
    };
}

export function isPartnerError(error: unknown): boolean {
    if (!error) return false;
    const message = error instanceof Error ? error.message : String(error);
    return (
        /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(message) ||
        /partner.*(unavailable|error|failed)/i.test(message) ||
        /mcp.*(error|failed|timeout)/i.test(message) ||
        /search.*(failed|error)/i.test(message)
    );
}
