/**
 * Runs before every tool. On failure the tool is not called.
 * called only from the agent loop.
 */

const CONFIRM_TOOLS = new Set(["place_order", "ride_book", "start_sign_in"]);
const ALERT_REASONS = new Set(["placed_order", "red_flag", "no_reply_3", "unusual"]);

/** The note must quote a fact or a line the family already said. */
export function citesMemory(note: string, bits: string[]): boolean {
    const hay = note.toLowerCase();
    for (const bit of bits) {
        const parts = bit.split(/[.\n]/);
        for (const part of parts) {
            const spoken = part.includes(": ") ? part.slice(part.indexOf(": ") + 2) : part;
            const text = spoken.trim().toLowerCase();
            if (text.length >= 8 && hay.includes(text)) return true;
        }
    }
    return false;
}

export function isLiteralConfirm(text: string): boolean {
    return text.trim().toLowerCase() === "confirm";
}

export function lockTool(input: {
    tool: string;
    args: Record<string, unknown>;
    lastInbound: string;
    goalStatus: string;
    knownTools: Set<string>;
    toldFare?: number | null;
    toldPickup?: string | null;
    userMessage: string;
    toolTexts?: string[];
    factOk?: (text: string) => boolean;
    /** Facts and earlier lines. When set, an alert must quote one of them. */
    knownBits?: string[];
}): { ok: true } | { ok: false; error: string } {
    if (input.goalStatus === "dropped") return { ok: false, error: "goal_dropped" };
    if (!input.knownTools.has(input.tool)) return { ok: false, error: "unknown_tool" };
    if (CONFIRM_TOOLS.has(input.tool) && !isLiteralConfirm(input.lastInbound)) {
        return { ok: false, error: "needs_confirm" };
    }
    if (input.tool === "place_order") {
        const pay = String(input.args.payment || "cash").toLowerCase();
        if (pay !== "cash") return { ok: false, error: "not_cash" };
    }
    if (input.tool === "ride_book") {
        if (input.args.robot === true) return { ok: false, error: "robot_check" };
        const fare = Number(input.args.fare);
        if (input.toldFare != null && Number.isFinite(fare) && fare > input.toldFare) return { ok: false, error: "changed" };
        if (input.toldPickup && input.args.pickup && String(input.args.pickup) !== input.toldPickup) return { ok: false, error: "changed" };
    }
    if (input.tool === "alert_caregiver") {
        if (!ALERT_REASONS.has(String(input.args.reason || ""))) return { ok: false, error: "bad_reason" };
        const note = String(input.args.note || input.args.text || "").trim();
        if (!note) return { ok: false, error: "bad_note" };
        if (input.knownBits && !citesMemory(note, input.knownBits)) return { ok: false, error: "fact_not_cited" };
    }
    if (input.tool === "save_fact" || input.tool === "save_preference") {
        const text = String(input.args.text || "");
        const ok = input.factOk ? input.factOk(text) : false;
        if (!ok) return { ok: false, error: "fact_not_in_message" };
    }
    return { ok: true };
}
