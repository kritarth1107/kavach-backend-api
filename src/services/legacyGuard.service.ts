/**
 * The old (v1) ordering code can still be reached in two ways while Saheli v2 runs for a family: a v2 turn that fails
 * falls back to the v1 router, and a button from an old v1 message (not a "v2:" id) goes straight to v1. The v1 flow
 * places orders outside every current rule (no options list, no guard, no for_whom), so for a family on v2 it never
 * orders, books, cancels or relays a login code (Order Engineer's D2.3 step 1, 2026-10-13). Everything else v1 answers
 * (a Done tap, a question) still works.
 */

/** v1 router intents that act on an order, a ride or a store login. */
export const V1_COMMERCE_INTENTS: ReadonlySet<string> = new Set([
    "order_new", "order_modify", "order_control", "restaurant_list", "otp_code", "ride", "order_status_history",
]);

/** Button ids the v1 order and ride flows sent (whatsappMessageComposer, metaWhatsApp.client). */
const V1_COMMERCE_BUTTON =
    /^(confirm_order|add_more|cancel_order|approve_order|reject_order|order_help|order_status|quick_confirm:|quick_change_addr:|addr:|item:|restaurant:|recipient:|approve_order:|reject_order:)/i;

export type LegacyBlock = "old_button" | "send_again" | null;

export function v1MustNotOrder(input: {
    /** Saheli v2 answers this family (BRAIN_V2 live, or a live family). */
    live: boolean;
    /** A tapped button's id, if any. */
    interactiveId?: string;
    /** The v1 router understood the message (false: the model failed and only the old regex rules are left). */
    routed: boolean;
    intent?: string | null;
}): LegacyBlock {
    if (!input.live) return null;
    if (input.interactiveId) return V1_COMMERCE_BUTTON.test(input.interactiveId) ? "old_button" : null;
    // A text turn reaches v1 here only because the v2 turn failed.
    if (!input.routed) return "send_again"; // both models are down: the regex rules must not order on their own
    return input.intent && V1_COMMERCE_INTENTS.has(input.intent) ? "send_again" : null;
}

/** What the person hears instead, in their language when the v1 router knew it. */
export function legacyBlockReply(kind: Exclude<LegacyBlock, null>, language?: string | null): string {
    const lang = String(language || "").toLowerCase();
    if (kind === "old_button") {
        if (lang.startsWith("hinglish")) return "Yeh button purane message ka hai. Bataiye, abhi kya chahiye?";
        if (lang.startsWith("hi")) return "यह बटन पुराने संदेश का है। बताइए, अभी क्या चाहिए?";
        return "That button is from an older message. Tell me what you need now.";
    }
    if (lang.startsWith("hinglish")) return "Abhi yeh nahi ho paaya. Ek minute mein phir se bhejiye.";
    if (lang.startsWith("hi")) return "अभी यह नहीं हो पाया। एक मिनट में फिर से भेजिए।";
    return "I could not do that just now. Please send it again in a minute.";
}
