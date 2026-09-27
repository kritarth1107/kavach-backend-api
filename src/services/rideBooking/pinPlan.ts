/**
 * A shared WhatsApp location is always the pickup (exact map point), whatever was said before:
 * it beats a saved home / an earlier typed pickup. The drop comes from the open ride ask, or the
 * last ride asked about in the last 30 minutes. Pure, so every order of messages is testable.
 */
import type { RideDraft, RidePlace } from "./types";

export const PIN_LAST_RIDE_MS = 30 * 60_000;

export function pinPlan(
    draft: Pick<RideDraft, "phase" | "drop"> | null,
    lastRide: { drop?: RidePlace; at?: Date | string } | null | undefined,
    pin: RidePlace,
    now = Date.now(),
    olaPreBookingPhases: readonly string[] = [],
): { pickup: RidePlace; drop?: RidePlace; releaseOla: boolean; phase: "confirming_route" | "need_drop" } {
    let drop = draft?.drop;
    if (!drop && lastRide?.drop && lastRide.at && now - new Date(lastRide.at).getTime() < PIN_LAST_RIDE_MS) drop = lastRide.drop;
    return {
        pickup: { ...pin, lat: pin.lat, lng: pin.lng },
        drop,
        releaseOla: Boolean(draft && olaPreBookingPhases.includes(draft.phase)),
        phase: drop ? "confirming_route" : "need_drop",
    };
}
