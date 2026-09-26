/**
 * WhatsApp ride-booking state machine (Instinct parity).
 * Slot-fill from/to (text + location pin) → route confirm → Uber-on-this-number →
 * OTP paste → fare confirm-before-book → driver/car/plate. Cancel clears session.
 * Never block WA on Chromium — kick browser async + immediate OTP ask.
 */
import WhatsappSession from "../../models/whatsappSession.model";
import User from "../../models/users.model";
import { FamilyRole } from "../../types/family.types";
import { notifyCaregivers } from "../saheliCaregiverAlert.service";
import { resolveRidePlace } from "./geoResolve.service";
import {
    confirmRideBook,
    dryRunDriverMessage,
    dryRunFares,
    formatFareCard,
    parseFaresFromBrowserResult,
    providerLabel,
    startRideBrowserLogin,
    submitRideOtp,
} from "./rideBrowser.service";
import {
    formatRouteSummary,
    isBareAffirmation,
    isRideCancel,
    messageLooksLikeRideIntent,
    parseFromTo,
    parseLocationPin,
    placeFromText,
    providerFromText,
} from "./slotParse";
import { RIDE_CONFIRM_RE, type RideDraft, type RidePlace } from "./types";

export { messageLooksLikeRideIntent, isRideCancel } from "./slotParse";
export type { RideDraft } from "./types";


function parseDriverFromMessage(message: string): RideDraft["driver"] | undefined {
    const name =
        message.match(/Driver:\s*\*?([^*\n]+)\*?/i)?.[1]?.trim() ||
        message.match(/driver\s+([A-Z][a-zA-Z.\s]{1,40})/i)?.[1]?.trim();
    const vehicle =
        message.match(/Car:\s*\*?([^*\n]+)\*?/i)?.[1]?.trim() ||
        message.match(/vehicle:\s*([^\n]+)/i)?.[1]?.trim();
    const plate =
        message.match(/Plate:\s*\*?([^*\n]+)\*?/i)?.[1]?.trim() ||
        message.match(/\b([A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{1,2}[-\s]?\d{1,4})\b/)?.[1];
    const etaRaw = message.match(/ETA:\s*~?(\d+)/i)?.[1];
    if (!name && !vehicle && !plate) return undefined;
    return {
        name,
        vehicle,
        plate,
        etaMinutes: etaRaw ? Number(etaRaw) : undefined,
    };
}

async function loadDraft(phone: string): Promise<RideDraft | null> {
    const row = await WhatsappSession.findOne({ phone }).lean();
    const raw = (row as { rideDraft?: RideDraft } | null)?.rideDraft;
    return raw ?? null;
}

async function saveDraft(phone: string, draft: RideDraft | null): Promise<void> {
    if (!draft) {
        await WhatsappSession.findOneAndUpdate(
            { phone },
            { $unset: { rideDraft: 1 }, $set: { updatedAt: new Date() } },
        );
        return;
    }
    await WhatsappSession.findOneAndUpdate(
        { phone },
        { $set: { rideDraft: draft, updatedAt: new Date() } },
        { upsert: true },
    );
}

async function actorPhoneE164(userId: string, fallbackPhone: string): Promise<string> {
    try {
        const user = await User.findById(userId).lean();
        const cc = (user as { phone?: { countryCode?: string; number?: string } } | null)?.phone
            ?.countryCode;
        const num = (user as { phone?: { countryCode?: string; number?: string } } | null)?.phone
            ?.number;
        if (cc && num) return `${cc}${num}`;
    } catch {
        /* ignore */
    }
    const digits = fallbackPhone.replace(/\D/g, "");
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length >= 11) return `+${digits}`;
    return fallbackPhone.startsWith("+") ? fallbackPhone : `+${fallbackPhone}`;
}

function maskE164(e164: string): string {
    const d = e164.replace(/\D/g, "");
    if (d.length < 6) return e164;
    const cc = d.length > 10 ? d.slice(0, d.length - 10) : "91";
    const last4 = d.slice(-4);
    return `+${cc}•••••${last4}`;
}

async function enrichPlace(place: RidePlace): Promise<RidePlace> {
    try {
        return await resolveRidePlace(place);
    } catch {
        return place;
    }
}

function askSlotsMessage(): string {
    return "Where from, and where to? You can share a WhatsApp *location pin* for pickup or drop, or type a place (e.g. Ritz-Carlton Bangalore).";
}

function routeConfirmMessage(draft: RideDraft): string {
    const summary =
        draft.routeSummary ||
        formatRouteSummary(draft.pickup || {}, draft.drop || {});
    return `${summary}\n\nReply *yes* if that looks right, or send a new from/to. Reply *cancel* to stop.`;
}

async function maybeCompleteSlots(
    draft: RideDraft,
    text: string,
): Promise<{ draft: RideDraft; reply?: string }> {
    const pin = parseLocationPin(text);
    const parsed = parseFromTo(text);

    if (pin) {
        if (!draft.pickup) {
            draft.pickup = await enrichPlace(pin);
        } else if (!draft.drop) {
            draft.drop = await enrichPlace(pin);
        } else {
            // Extra pin replaces drop
            draft.drop = await enrichPlace(pin);
        }
    } else if (parsed.pickup || parsed.drop) {
        if (parsed.pickup) draft.pickup = await enrichPlace(placeFromText(parsed.pickup));
        if (parsed.drop) draft.drop = await enrichPlace(placeFromText(parsed.drop));
    } else if (parsed.bare) {
        const place = await enrichPlace(placeFromText(parsed.bare));
        if (!draft.pickup) draft.pickup = place;
        else if (!draft.drop) draft.drop = place;
        else draft.drop = place;
    }

    if (draft.pickup && draft.drop) {
        draft.routeSummary = formatRouteSummary(draft.pickup, draft.drop);
        draft.phase = "confirming_route";
        return { draft, reply: routeConfirmMessage(draft) };
    }
    if (draft.pickup && !draft.drop) {
        draft.phase = "need_drop";
        return {
            draft,
            reply: `Pickup noted: *${draft.pickup.shortLabel || draft.pickup.address || "pin"}*. Where to?`,
        };
    }
    if (!draft.pickup && draft.drop) {
        draft.phase = "need_pickup";
        return {
            draft,
            reply: `Drop noted: *${draft.drop.shortLabel || draft.drop.address}*. Where from? Share a pin or type the place.`,
        };
    }
    draft.phase = "need_slots";
    return { draft, reply: askSlotsMessage() };
}

async function maybeNotifyCaregivers(input: {
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole | null;
    draft: RideDraft;
}): Promise<void> {
    if (input.actorRole !== FamilyRole.CARE_RECIPIENT) return;
    if (input.draft.phase !== "done") return;
    void import("../commerceAutomation/usuals/usuals.service").then(({ recordRide }) =>
        recordRide({ familyId: input.familyId, recipientUserId: input.recipientUserId }, input.draft.drop?.shortLabel),
    );
    void import("../activityLog.service").then(({ logActivity }) =>
        logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            kind: "ride",
            title: `${providerLabel(input.draft.provider)} ride booked`,
            detail: `${input.draft.pickup?.shortLabel || "pickup"} → ${input.draft.drop?.shortLabel || "drop"}`,
            data: {
                provider: input.draft.provider || null,
                from: input.draft.pickup?.shortLabel || null,
                to: input.draft.drop?.shortLabel || null,
            },
        }),
    );
    const from = input.draft.pickup?.shortLabel || "pickup";
    const to = input.draft.drop?.shortLabel || "drop";
    void notifyCaregivers({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: `Booked a ${providerLabel(input.draft.provider)} ride: ${from} → ${to}.`,
        urgency: "low",
        // Dashboard activity feed only (caregiver WhatsApp = orders + health red flags).
        kind: "ride",
    });
}

/**
 * Handle ride WhatsApp turns. Returns reply or null if not a ride turn.
 */
export async function handleRideWhatsAppTurn(input: {
    phone: string;
    text: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole | null;
}): Promise<{ text: string; draft?: RideDraft } | null> {
    const text = input.text.trim();
    let draft = await loadDraft(input.phone);

    if (draft && isRideCancel(text)) {
        await saveDraft(input.phone, null);
        return { text: "Okay — cancelled. Nothing was booked or paid." };
    }

    // Active mid-flow (including OTP / fare confirm)
    if (draft && draft.phase !== "idle" && draft.phase !== "done") {
        // OTP paste
        if (draft.phase === "awaiting_otp" && /^\d{4,8}$/.test(text)) {
            draft.lastMessage = "Got the code — checking fares…";
            await saveDraft(input.phone, draft);

            const result = await submitRideOtp({
                familyId: input.familyId,
                userId: input.actorUserId,
                draft,
                otp: text,
            });
            draft.mode = result.mode;

            if (result.status === "error") {
                draft.phase = "unavailable";
                draft.unavailableReason = result.message;
                await saveDraft(input.phone, null);
                return {
                    text:
                        `Couldn't continue on ${providerLabel(draft.provider)} right now. ` +
                        `${result.message.slice(0, 180)}\n` +
                        `Nothing was booked. Local taxi options (GoaMiles / TaxiBazaar) are coming later — try again shortly or book in the Uber app.`,
                    draft,
                };
            }

            // Live Chromium still waiting on OTP / login — stay in awaiting_otp
            if (result.status === "need_otp" && result.mode === "playwright") {
                const msg =
                    result.message ||
                    `${providerLabel(draft.provider)} still needs the login code — *paste the OTP here*, or *cancel*.`;
                draft.lastMessage = msg;
                await saveDraft(input.phone, draft);
                return { text: msg, draft };
            }

            const scraped = parseFaresFromBrowserResult(result);
            const liveOk =
                result.mode === "playwright" &&
                (result.status === "need_user_confirm" || Boolean(scraped?.length));

            // Live mode: never invent stub fares if scrape failed
            if (result.mode === "playwright" && !scraped?.length && result.status !== "need_user_confirm") {
                draft.phase = "unavailable";
                draft.unavailableReason = result.message;
                await saveDraft(input.phone, null);
                return {
                    text:
                        `Couldn't read live fares from ${providerLabel(draft.provider)} yet. ` +
                        `${(result.message || "").slice(0, 160)}\n` +
                        `Nothing was booked — try again or use the Uber app.`,
                    draft,
                };
            }

            const fares =
                scraped ||
                (result.mode === "dry_run"
                    ? dryRunFares(draft.pickup, draft.drop)
                    : undefined);
            if (!fares?.length) {
                draft.phase = "unavailable";
                await saveDraft(input.phone, null);
                return {
                    text: `No fare options came back from ${providerLabel(draft.provider)}. Nothing was booked — try again shortly.`,
                    draft,
                };
            }
            draft.fares = fares;
            draft.selectedFareId = fares[0]?.id;
            draft.phase = "awaiting_book_confirm";
            const card =
                liveOk && /₹|fare|UberX|confirm|book/i.test(result.message)
                    ? result.message
                    : formatFareCard(fares, draft.provider);
            draft.lastMessage = card;
            await saveDraft(input.phone, draft);
            return { text: card, draft };
        }

        if (draft.phase === "awaiting_otp") {
            return {
                text:
                    draft.lastMessage ||
                    `${providerLabel(draft.provider)} will text a 4-digit code — *forward or paste it here*.`,
                draft,
            };
        }

        // Confirm book
        if (
            draft.phase === "awaiting_book_confirm" &&
            RIDE_CONFIRM_RE.test(text)
        ) {
            draft.phase = "booking";
            draft.selectedFareId = draft.selectedFareId || draft.fares?.[0]?.id;
            await saveDraft(input.phone, draft);

            const result = await confirmRideBook({
                familyId: input.familyId,
                userId: input.actorUserId,
                draft,
            });
            draft.mode = result.mode;

            if (result.status === "done" || (result.mode === "dry_run" && result.status !== "error")) {
                draft.phase = "done";
                if (result.mode === "dry_run") {
                    draft.driver = {
                        name: "Ravi K.",
                        vehicle: "White Swift Dzire",
                        plate: "KA-01-AB-4231",
                        etaMinutes: draft.fares?.[0]?.etaMinutes ?? 8,
                    };
                    const msg = dryRunDriverMessage(draft);
                    draft.lastMessage = msg;
                    await saveDraft(input.phone, null);
                    await maybeNotifyCaregivers({ ...input, draft });
                    return { text: msg, draft };
                }
                // Live: trust browser message; parse driver fields best-effort
                const msg =
                    result.message?.trim() ||
                    `Ride requested on ${providerLabel(draft.provider)}. Watch the Uber app for driver details.`;
                draft.driver = parseDriverFromMessage(msg) || {
                    name: undefined,
                    vehicle: undefined,
                    plate: undefined,
                    etaMinutes: draft.fares?.[0]?.etaMinutes,
                };
                draft.lastMessage = msg;
                await saveDraft(input.phone, null);
                await maybeNotifyCaregivers({ ...input, draft });
                return { text: msg, draft };
            }

            // Still asking confirm mid-book (shouldn't silent-book)
            if (result.status === "need_user_confirm") {
                draft.phase = "awaiting_book_confirm";
                draft.lastMessage = result.message;
                await saveDraft(input.phone, draft);
                return { text: result.message, draft };
            }

            draft.phase = "unavailable";
            await saveDraft(input.phone, null);
            return {
                text:
                    `Booking didn't complete: ${result.message.slice(0, 180)}. ` +
                    `Nothing was booked or paid. You can try again or use the Uber app.`,
                draft,
            };
        }

        if (draft.phase === "awaiting_book_confirm") {
            return {
                text: draft.lastMessage || formatFareCard(draft.fares || dryRunFares(), draft.provider),
                draft,
            };
        }

        // Route confirm → ask Uber phone
        if (draft.phase === "confirming_route" && RIDE_CONFIRM_RE.test(text)) {
            const phoneE164 = await actorPhoneE164(input.actorUserId, input.phone);
            draft.phoneE164 = phoneE164;
            draft.phase = "ask_uber_phone";
            const masked = maskE164(phoneE164);
            const msg =
                `Is your ${providerLabel(draft.provider)} account on this number (${masked})? ` +
                `If yes, ${providerLabel(draft.provider)} will send a 4-digit code — *forward it here*.\n` +
                `Reply *yes* to continue, or *cancel*.`;
            draft.lastMessage = msg;
            await saveDraft(input.phone, draft);
            return { text: msg, draft };
        }

        if (draft.phase === "confirming_route") {
            // Allow re-slotting
            const updated = await maybeCompleteSlots(draft, text);
            draft = updated.draft;
            await saveDraft(input.phone, draft);
            return { text: updated.reply || routeConfirmMessage(draft), draft };
        }

        // Uber phone yes → kick browser async + await OTP
        if (draft.phase === "ask_uber_phone" && RIDE_CONFIRM_RE.test(text)) {
            const challenge = `ride-${draft.provider}-${Date.now()}`;
            draft.otpChallengeId = challenge;
            draft.phase = "awaiting_otp";
            const phoneE164 = draft.phoneE164 || (await actorPhoneE164(input.actorUserId, input.phone));
            draft.phoneE164 = phoneE164;

            await saveDraft(input.phone, draft);

            // Async — do not block WhatsApp typing on Chromium
            void startRideBrowserLogin({
                familyId: input.familyId,
                userId: input.actorUserId,
                draft,
            }).catch((err) => {
                console.warn(
                    "ride browser login background failed:",
                    err instanceof Error ? err.message : err,
                );
            });

            const msg = [
                `Opening *${providerLabel(draft.provider)}* for:`,
                `${draft.routeSummary || formatRouteSummary(draft.pickup || {}, draft.drop || {})}`,
                ``,
                `${providerLabel(draft.provider)} may text a login code to ${maskE164(phoneE164)} — *paste or forward the 4-digit OTP here*.`,
                `(I never read your device SMS — only what you send on WhatsApp.)`,
                ``,
                `Reply *cancel* to stop — nothing is booked yet.`,
            ].join("\n");
            draft.lastMessage = msg;
            await saveDraft(input.phone, draft);
            return { text: msg, draft };
        }

        if (draft.phase === "ask_uber_phone") {
            return {
                text:
                    draft.lastMessage ||
                    `Is your ${providerLabel(draft.provider)} account on this WhatsApp number? Reply *yes* or *cancel*.`,
                draft,
            };
        }

        // Still collecting slots
        if (
            draft.phase === "need_slots" ||
            draft.phase === "need_pickup" ||
            draft.phase === "need_drop"
        ) {
            const updated = await maybeCompleteSlots(draft, text);
            draft = updated.draft;
            await saveDraft(input.phone, draft);
            return { text: updated.reply || askSlotsMessage(), draft };
        }
    }

    // Fresh ride intent (or bare "Yeah" is NOT enough alone — Instinct asks from/to after Yeah
    // only when ride already implied; we treat Yeah after companion offer via intent phrases)
    const starting =
        messageLooksLikeRideIntent(text) ||
        // "Yeah" alone after no draft should NOT start — but "Yeah book a cab" / ride words do.
        (isBareAffirmation(text) && /\b(ride|cab|taxi|uber|ola)\b/i.test(text));

    // Instinct: user says "Yeah" to a ride offer — if text is bare Yeah we still need prior context.
    // Heuristic: bare affirmation + no draft → ask from/to only when message also glances ride,
    // OR when they said only "Yeah"/"Yes" we do NOT hijack general chat.
    // Product: "Yeah" alone → ask "Where from, and where to?" — that implies ride context already.
    // We support that when they previously got a ride prompt OR messageLooksLikeRideIntent.
    // For explicit product criterion: treat bare Yeah as ride start ONLY if the word Yeah arrives
    // with ride nearby in same message OR we expose startRideFromAffirmation via companion tool.
    // Practical v1: messageLooksLikeRideIntent OR "yeah" when text matches /yeah.*ride|ride.*yeah/i
    // PLUS: if text is exactly Yeah/Yes and no other draft — start ride (Instinct screenshot).
    const bareYeahStartsRide = isBareAffirmation(text) && text.length <= 8;

    if (!starting && !bareYeahStartsRide && !(draft && draft.phase !== "idle" && draft.phase !== "done")) {
        return null;
    }

    if (starting || bareYeahStartsRide) {
        // Avoid stealing general "yes" when pharmacy/browser drafts active — caller should
        // check those first. Here: only start if no ride draft.
        draft = {
            phase: "need_slots",
            provider: providerFromText(text),
        };
        const updated = await maybeCompleteSlots(draft, text);
        draft = updated.draft;
        // Bare Yeah with no places → ask slots (Instinct)
        if (!draft.pickup && !draft.drop) {
            draft.phase = "need_slots";
            await saveDraft(input.phone, draft);
            return { text: askSlotsMessage(), draft };
        }
        await saveDraft(input.phone, draft);
        return { text: updated.reply || askSlotsMessage(), draft };
    }

    return null;
}

/** Tool entry: start or advance a ride from AI tool args (no WA session phone? use actor phone). */
export async function bookRideTool(input: {
    phone: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole | null;
    message: string;
    pickup?: string;
    drop?: string;
    otp?: string;
    userConfirmed?: boolean;
}): Promise<{ ok: boolean; phase?: string; message: string; draft?: RideDraft }> {
    let text = input.message.trim();
    if (input.pickup && input.drop) {
        text = `from ${input.pickup} to ${input.drop}`;
    } else if (input.otp) {
        text = input.otp;
    } else if (input.userConfirmed) {
        text = "confirm";
    }
    const result = await handleRideWhatsAppTurn({
        phone: input.phone,
        text: text || "book a cab",
        familyId: input.familyId,
        actorUserId: input.actorUserId,
        recipientUserId: input.recipientUserId,
        actorRole: input.actorRole,
    });
    if (!result) {
        return { ok: false, message: "Could not start ride flow." };
    }
    return {
        ok: true,
        phase: result.draft?.phase,
        message: result.text,
        draft: result.draft,
    };
}

export async function cancelRideTool(phone: string): Promise<{ ok: boolean; message: string }> {
    await saveDraft(phone, null);
    return { ok: true, message: "Okay — cancelled. Nothing was booked or paid." };
}

export async function rideStatusTool(phone: string): Promise<{
    ok: boolean;
    phase?: string;
    message: string;
    draft?: RideDraft;
}> {
    const draft = await loadDraft(phone);
    if (!draft) {
        return { ok: true, phase: "idle", message: "No active ride." };
    }
    return {
        ok: true,
        phase: draft.phase,
        message: draft.lastMessage || `Ride status: ${draft.phase}`,
        draft,
    };
}
