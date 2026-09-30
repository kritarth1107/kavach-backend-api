/**
 * yes / confirm / 1 / retry / cancel belong to the newest open question.
 * A stuck order (phase running, "reply retry or cancel") must keep those words.
 * They must never fall through to the care-record lookup.
 */

export type ShortControl = "retry" | "cancel" | "confirm" | "pick";

const RETRY_PHASES = new Set(["running", "awaiting_otp", "awaiting_confirm", "awaiting_sku_confirm", "awaiting_mcp_confirm"]);
const CONFIRM_PHASES = new Set(["awaiting_confirm", "awaiting_mcp_confirm", "awaiting_sku_confirm", "awaiting_address_confirm", "running"]);
const PICK_PHASES = new Set(["awaiting_sku_confirm", "awaiting_mcp_confirm", "awaiting_restaurant_pick", "awaiting_address_confirm"]);

export function parseShortReply(text: string): { control: ShortControl; pickIndex: number | null } | null {
    const t = String(text || "").trim().replace(/[.!]+$/g, "").replace(/\s+/g, " ");
    if (/^(retry|try again|again)$/i.test(t)) return { control: "retry", pickIndex: null };
    if (/^(cancel|stop)$/i.test(t)) return { control: "cancel", pickIndex: null };
    const pick = t.match(/^([1-9])$/);
    if (pick) return { control: "pick", pickIndex: Number(pick[1]) };
    if (/^(confirm|yes|haan|ha|ok|okay|place|place order)$/i.test(t)) return { control: "confirm", pickIndex: null };
    return null;
}

export function phaseAcceptsShortReply(phase: string | undefined | null, control: ShortControl): boolean {
    if (!phase || phase === "idle" || phase === "done") return false;
    if (control === "cancel") return true;
    if (control === "retry") return RETRY_PHASES.has(phase);
    if (control === "confirm") return CONFIRM_PHASES.has(phase);
    if (control === "pick") return PICK_PHASES.has(phase);
    return false;
}

/** Stuck Instamart (phase running) and the OTP / confirm stalls all resume on retry. */
export function browserPhaseResumesOnRetry(phase: string | undefined | null): boolean {
    return phase === "running" || phase === "awaiting_otp" || phase === "awaiting_confirm";
}

export function bindLatestQuestion(
    text: string,
    flows: {
        browserPhase?: string | null;
        browserAt?: number;
        pharmacyPhase?: string | null;
        pharmacyAt?: number;
        ridePhase?: string | null;
        rideAt?: number;
    },
): { control: ShortControl; pickIndex: number | null; owner: "browser" | "pharmacy" } | null {
    const parsed = parseShortReply(text);
    if (!parsed) return null;
    const live = (phase?: string | null) => Boolean(phase && phase !== "idle" && phase !== "done");
    const rows: Array<{ owner: "browser" | "pharmacy" | "ride"; phase: string; at: number }> = [];
    if (live(flows.browserPhase)) rows.push({ owner: "browser", phase: flows.browserPhase!, at: flows.browserAt || 0 });
    if (live(flows.pharmacyPhase)) rows.push({ owner: "pharmacy", phase: flows.pharmacyPhase!, at: flows.pharmacyAt || 0 });
    if (live(flows.ridePhase)) rows.push({ owner: "ride", phase: flows.ridePhase!, at: flows.rideAt || 0 });
    if (!rows.length) return null;
    rows.sort((a, b) => b.at - a.at);
    const newest = rows[0]!;
    if (newest.owner === "ride") return null;
    if (!phaseAcceptsShortReply(newest.phase, parsed.control)) return null;
    return { control: parsed.control, pickIndex: parsed.pickIndex, owner: newest.owner };
}

/** "retry" / "yes" / "cancel" after "the stores didn't answer" reruns that search, not the care record. */
export function bindOfferReply(text: string, offerQuery: string | null | undefined): ShortControl | null {
    if (!offerQuery) return null;
    const parsed = parseShortReply(text);
    if (!parsed) return null;
    if (parsed.control === "retry" || parsed.control === "cancel" || parsed.control === "confirm") return parsed.control;
    return null;
}
