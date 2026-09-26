/**
 * Ride browser tasks — Uber web via existing private-browser worker.
 * Dry-run returns fake fares / driver; playwright uses Gemini computer-use on m.uber.com.
 */
import { runBrowserTask, type BrowserTaskResult } from "../commerceAutomation/browserWorker.service";
import type { RideDraft, RideFareOption, RidePlace, RideProvider } from "./types";

const UBER_START = "https://m.uber.com/";

export function rideStartUrl(provider: RideProvider): string {
    if (provider === "ola") return "https://book.olacabs.com/";
    if (provider === "rapido") return "https://www.rapido.bike/";
    return UBER_START;
}

export function rideGoal(draft: RideDraft): string {
    const from = draft.pickup?.address || draft.pickup?.shortLabel || draft.pickup?.raw || "pickup";
    const to = draft.drop?.address || draft.drop?.shortLabel || draft.drop?.raw || "drop";
    return [
        `BOOK_RIDE provider=${draft.provider}`,
        `pickup=${from}`,
        draft.pickup?.lat != null ? `pickup_lat=${draft.pickup.lat}` : "",
        draft.pickup?.lng != null ? `pickup_lng=${draft.pickup.lng}` : "",
        `drop=${to}`,
        draft.drop?.lat != null ? `drop_lat=${draft.drop.lat}` : "",
        draft.drop?.lng != null ? `drop_lng=${draft.drop.lng}` : "",
        draft.selectedFareId ? `ride_type=${draft.selectedFareId}` : "ride_type=UberX",
        "Confirm-before-book. Never pay silently. Ask OTP via WhatsApp paste.",
    ]
        .filter(Boolean)
        .join(" | ");
}

export function dryRunFares(pickup?: RidePlace, drop?: RidePlace): RideFareOption[] {
    void pickup;
    void drop;
    return [
        { id: "uberx", label: "UberX", estimateLabel: "≈ ₹180–220", etaMinutes: 8 },
        { id: "comfort", label: "Comfort", estimateLabel: "≈ ₹240–280", etaMinutes: 10 },
        { id: "premier", label: "Premier", estimateLabel: "≈ ₹320–380", etaMinutes: 12 },
    ];
}

export function formatFareCard(fares: RideFareOption[], provider: RideProvider): string {
    const lines = fares.map((f) => `• *${f.label}* ${f.estimateLabel}${f.etaMinutes ? ` · ${f.etaMinutes} min` : ""}`);
    return [
        `*${providerLabel(provider)} fares* (confirm before book):`,
        ...lines,
        ``,
        `Reply *book* / *confirm* for ${fares[0]?.label || "UberX"}, or *cancel*.`,
        `_No silent book — nothing is booked until you confirm._`,
    ].join("\n");
}

export function providerLabel(provider: RideProvider): string {
    if (provider === "ola") return "Ola";
    if (provider === "rapido") return "Rapido";
    return "Uber";
}

export function parseFaresFromBrowserResult(result: BrowserTaskResult): RideFareOption[] | undefined {
    const items = result.confirm?.items;
    if (!items?.length) return undefined;
    return items.map((label, i) => ({
        id: `opt_${i}`,
        label: label.split(/≈|·|-/)[0]?.trim() || label,
        estimateLabel: label.includes("₹") ? label : result.confirm?.totalLabel || label,
    }));
}

export async function startRideBrowserLogin(input: {
    familyId: string;
    userId: string;
    draft: RideDraft;
}): Promise<BrowserTaskResult> {
    return runBrowserTask({
        familyId: input.familyId,
        userId: input.userId,
        goal: rideGoal(input.draft),
        partner: input.draft.provider === "uber" ? "uber" : "generic",
        startUrl: rideStartUrl(input.draft.provider),
        // No short deadline — the worker stops on stall detection / runaway ceiling.
    });
}

export async function submitRideOtp(input: {
    familyId: string;
    userId: string;
    draft: RideDraft;
    otp: string;
}): Promise<BrowserTaskResult> {
    return runBrowserTask({
        familyId: input.familyId,
        userId: input.userId,
        goal: rideGoal(input.draft),
        partner: input.draft.provider === "uber" ? "uber" : "generic",
        startUrl: rideStartUrl(input.draft.provider),
        otp: input.otp,
        // No short deadline — the worker stops on stall detection / runaway ceiling.
    });
}

export async function confirmRideBook(input: {
    familyId: string;
    userId: string;
    draft: RideDraft;
}): Promise<BrowserTaskResult> {
    return runBrowserTask({
        familyId: input.familyId,
        userId: input.userId,
        goal: rideGoal(input.draft),
        partner: input.draft.provider === "uber" ? "uber" : "generic",
        startUrl: rideStartUrl(input.draft.provider),
        userConfirmed: true,
        // No fixed step cap / deadline: stall detection + runaway ceiling in the worker.
    });
}

export function dryRunDriverMessage(draft: RideDraft): string {
    const fare = draft.fares?.find((f) => f.id === draft.selectedFareId) || draft.fares?.[0];
    return [
        `Booked *${fare?.label || "UberX"}* — driver on the way.`,
        `• Driver: *Ravi K.*`,
        `• Car: White Swift Dzire`,
        `• Plate: *KA-01-AB-4231*`,
        `• ETA: ~${fare?.etaMinutes ?? 8} min`,
        ``,
        `_Dry-run: no real Uber trip was created. Production uses live Chromium when BROWSER_WORKER_MODE=auto|playwright._`,
    ].join("\n");
}
