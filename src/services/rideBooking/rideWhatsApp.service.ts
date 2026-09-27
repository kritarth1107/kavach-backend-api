/**
 * WhatsApp ride-booking state machine (Instinct parity).
 * Slot-fill from/to (text + location pin) → route confirm → pre-filled Uber / Ola / Rapido app
 * links (chosen by city tier, vehicle and live availability). Nothing is booked in chat: the user
 * books in the app. Cancel clears the draft.
 */
import { isSoftYes } from "../commerceAutomation/literalConfirm";
import WhatsappSession from "../../models/whatsappSession.model";
import User from "../../models/users.model";
import { FamilyRole } from "../../types/family.types";
import { notifyCaregivers } from "../saheliCaregiverAlert.service";
import { GENERIC_PLACE, resolveRidePlace } from "./geoResolve.service";
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
import {
    chooseServices,
    cityKey,
    cityOfPlaces,
    handoffMessage,
    isAirport,
    isHindi,
    nameFor,
    noServiceMessage,
    serviceFromText,
    vehicleFromText,
} from "./rideServices";
import { awaitRideAvailability, readAvailability, warmRideAvailability } from "./rideAvailability";
import { loadRideConfig } from "./rideConfig";

export { messageLooksLikeRideIntent, isRideCancel } from "./slotParse";
export type { RideDraft } from "./types";


async function loadDraft(phone: string): Promise<RideDraft | null> {
    const row = await WhatsappSession.findOne({ phone }).lean();
    const raw = (row as { rideDraft?: RideDraft } | null)?.rideDraft;
    return raw && !isStaleRideDraft(raw) ? raw : null;
}

/** A ride still collecting pickup/drop that nobody touched for 30 min is abandoned — a later
 *  "haan" / "ok" must never resume it ("Where from, and where to?" out of nowhere). */
export function isStaleRideDraft(d: { phase?: string; savedAt?: string | Date } | null | undefined): boolean {
    // Every pre-booking step goes stale (a 2-hour-old "Got the route… reply yes" must not eat a later "haan").
    if (!d?.phase || !["need_slots", "need_pickup", "need_drop", "confirming_route", "ask_uber_phone", "awaiting_book_confirm", "awaiting_otp", "unavailable", "offer_caregiver"].includes(d.phase)) return false;
    const at = d.savedAt ? new Date(d.savedAt).getTime() : 0;
    return !at || Date.now() - at > 30 * 60_000;
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
        { $set: { rideDraft: { ...draft, savedAt: new Date() }, updatedAt: new Date() } },
        { upsert: true },
    );
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
        // "from home" with no saved home: ask for it instead of guessing a place with that name.
        if (parsed.pickup && GENERIC_PLACE.test(parsed.pickup.trim())) {
            if (parsed.drop && !GENERIC_PLACE.test(parsed.drop.trim())) draft.drop = await enrichPlace(placeFromText(parsed.drop));
            draft.phase = draft.drop ? "need_pickup" : "need_slots";
            return {
                draft,
                reply: draft.drop
                    ? `Drop noted: *${draft.drop.shortLabel || draft.drop.address}*. I don't have your ${parsed.pickup.trim()} address saved yet — share a WhatsApp *location pin* or type the full address for pickup.`
                    : `I don't have that address saved yet — share a WhatsApp *location pin* or type the full pickup and drop addresses.`,
            };
        }
        if (parsed.pickup) draft.pickup = await enrichPlace(placeFromText(parsed.pickup));
        if (parsed.drop) {
            if (GENERIC_PLACE.test(parsed.drop.trim())) {
                draft.phase = "need_drop";
                return { draft, reply: `Pickup noted: *${draft.pickup?.shortLabel || draft.pickup?.address || "pin"}*. I don't have that drop address saved — share a *location pin* or type the full address.` };
            }
            draft.drop = await enrichPlace(placeFromText(parsed.drop));
        }
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

/**
 * Handle ride WhatsApp turns. Returns reply or null if not a ride turn.
 */
type RideTurnInput = {
    phone: string;
    text: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole | null;
    /** Her original words (the router may have rewritten `text` into "from X to Y"). */
    hintText?: string;
    /** The router decided this is a ride ask — start one even if the words look plain. */
    forceStart?: boolean;
    /** She typed a place in this message (so it is a new route, not "same ride, other app"). */
    newPlacesTyped?: boolean;
};

export async function handleRideWhatsAppTurn(input: RideTurnInput): Promise<{ text: string; draft?: RideDraft } | null> {
    const r = await handleRideWhatsAppTurnInner(input);
    // Route shown → check Ola / Rapido for this city in the background, so "yes" is instant.
    const d = r?.draft;
    if (d?.phase === "confirming_route" && d.pickup && d.drop) {
        void loadRideConfig()
            .then((cfg) => warmRideAvailability(cityKey(cityOfPlaces(d.pickup, d.drop, cfg).city, d.pickup), cfg, d.pickup, d.drop))
            .catch(() => undefined);
    }
    return r;
}

async function rideLang(phone: string): Promise<string | null> {
    const { lastRouteFor } = await import("../saheliRouter.service");
    return lastRouteFor(phone)?.route?.language || null;
}

/** Route confirmed → the best app link for this city (plus one alternative), or the no-service offer. */
async function multiAppHandoff(input: RideTurnInput, draft: RideDraft): Promise<{ text: string; draft: RideDraft }> {
    // Links need coordinates; a saved address without them is geocoded.
    for (const k of ["pickup", "drop"] as const) {
        const pl = draft[k];
        if (pl && (pl.lat == null || pl.lng == null) && (pl.address || pl.raw)) {
            const r = await resolveRidePlace({ raw: pl.address || pl.raw }).catch(() => null);
            if (r?.lat != null && r?.lng != null) draft[k] = { ...pl, lat: r.lat, lng: r.lng };
        }
    }
    const started = Date.now();
    const lang = await rideLang(input.phone);
    const cfg = await loadRideConfig();
    const { city, tier } = cityOfPlaces(draft.pickup, draft.drop, cfg);
    const key = cityKey(city, draft.pickup);
    // Probes normally ran while she read the route; wait briefly for any still running, never long.
    void warmRideAvailability(key, cfg, draft.pickup, draft.drop);
    await awaitRideAvailability(key, 6000);
    const avail = await readAvailability(key);
    const vehicle = draft.vehicle || "cab";
    const airport = isAirport(draft.pickup) || isAirport(draft.drop);
    const placeText = `${draft.pickup?.address || ""} ${draft.pickup?.raw || ""}`;
    const choice = chooseServices({ tier, vehicle, requested: draft.requested, status: (s) => (s === "uber" ? "unknown" : avail[s]), airport, placeText, cfg });
    const reason = choice.requestedUnavailable
        ? "requested_unavailable"
        : draft.requested && choice.primary === draft.requested
          ? "requested"
          : choice.primary
            ? "chain"
            : "no_service";
    console.log(
        JSON.stringify({
            evt: "ride_handoff",
            cityKey: key,
            tier,
            vehicle,
            airport,
            requested: draft.requested || null,
            primary: choice.primary,
            alt: choice.alt,
            reason,
            ola: avail.ola,
            rapido: avail.rapido,
            lang: lang || null,
            ms: Date.now() - started,
        }),
    );
    await WhatsappSession.updateOne(
        { phone: input.phone },
        { $set: { lastRide: { pickup: draft.pickup, drop: draft.drop, at: new Date() } } },
    ).catch(() => undefined);
    const msg = handoffMessage({ choice, vehicle, pickup: draft.pickup, drop: draft.drop, lang, tier });
    if (msg) {
        await saveDraft(input.phone, null);
        void import("../activityLog.service").then(({ logActivity }) =>
            logActivity({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind: "ride",
                title: `Ride link sent (${choice.primary})`,
                data: { primary: choice.primary, alt: choice.alt, tier, vehicle, reason },
                detail: `${nameFor(draft.pickup)} → ${nameFor(draft.drop)} · not booked until opened in the app`,
            }),
        ).catch(() => undefined);
        return { text: msg, draft: { ...draft, phase: "done", lastMessage: msg } };
    }
    const elder = input.actorRole === FamilyRole.CARE_RECIPIENT;
    const text = noServiceMessage({ pickup: draft.pickup, lang, canOfferFamily: elder });
    if (elder) {
        draft.phase = "offer_caregiver";
        draft.lastMessage = text;
        await saveDraft(input.phone, draft);
    } else await saveDraft(input.phone, null);
    return { text, draft };
}

async function handleRideWhatsAppTurnInner(input: RideTurnInput): Promise<{ text: string; draft?: RideDraft } | null> {
    const text = input.text.trim();
    let draft = await loadDraft(input.phone);

    const hint = `${input.hintText || ""} ${text}`;
    const hv = vehicleFromText(hint);
    const hs = serviceFromText(hint);

    if (draft?.phase === "offer_caregiver") {
        const hi = isHindi(await rideLang(input.phone));
        if (RIDE_CONFIRM_RE.test(text) || isSoftYes(text)) {
            const u = (await User.findById(input.recipientUserId).lean().catch(() => null)) as { firstName?: string } | null;
            const who = u?.firstName || "Your family member";
            await notifyCaregivers({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind: "elder_share",
                urgency: "medium",
                message: `${who} needs a ride from ${nameFor(draft.pickup) || "home"} to ${nameFor(draft.drop) || "their destination"} — Uber, Ola and Rapido don't serve that area right now. Could you help arrange one?`,
            }).catch(() => undefined);
            await saveDraft(input.phone, null);
            return { text: hi ? "Maine parivaar ko message kar diya hai 🙏 Woh ride ka intezaam kar denge." : "I've messaged your family 🙏 They'll help arrange a ride." };
        }
        await saveDraft(input.phone, null);
        if (isRideCancel(text) || /^(no|nahi|nahin|mat|rehne do)$/i.test(text)) return { text: hi ? "Theek hai 🙏" : "Okay 🙏" };
        draft = null; // anything else moves on
    }

    if (draft && isRideCancel(text)) {
        await saveDraft(input.phone, null);
        return { text: "Okay — cancelled. Nothing was booked or paid." };
    }
    if (draft && draft.phase !== "done") {
        if (hv) draft.vehicle = hv;
        if (hs) draft.requested = hs;
    }

    // Active mid-flow (including OTP / fare confirm)
    if (draft && draft.phase !== "idle" && draft.phase !== "done") {
        // Drafts left in the retired in-chat sign-in steps (before the link hand-off) finish as a hand-off.
        if (["ask_uber_phone", "awaiting_otp", "awaiting_book_confirm", "booking", "showing_fares", "unavailable"].includes(draft.phase) && draft.pickup && draft.drop) {
            return await multiAppHandoff(input, draft);
        }

        // Route confirm → honest app hand-off. Uber answers every automated web sign-in with an
        // Arkose "Protecting your account — Start Puzzle" check (verified 27 Sep 2026), so NO login
        // SMS is ever sent; we never solve captchas. Claiming "Uber may text a code" was false.
        if (draft.phase === "confirming_route" && RIDE_CONFIRM_RE.test(text)) {
            return await multiAppHandoff(input, draft);
        }
        if (draft.phase === "confirming_route") {
            // Allow re-slotting
            const updated = await maybeCompleteSlots(draft, text);
            draft = updated.draft;
            await saveDraft(input.phone, draft);
            return { text: updated.reply || routeConfirmMessage(draft), draft };
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

    if (!starting && !bareYeahStartsRide && !input.forceStart && !(draft && draft.phase !== "idle" && draft.phase !== "done")) {
        return null;
    }

    // "cab chahiye" / "Ola se" right after a ride link: same route, new app or vehicle.
    if ((starting || input.forceStart) && (hv || hs)) {
        // Judge by what she actually typed: the router may have re-filled the old route from context.
        const pf = parseFromTo(input.hintText || text);
        const row = (await WhatsappSession.findOne({ phone: input.phone }, { lastRide: 1 }).lean().catch(() => null)) as {
            lastRide?: { pickup?: RidePlace; drop?: RidePlace; at?: Date };
        } | null;
        const lr = row?.lastRide;
        if (!input.newPlacesTyped && !pf.pickup && !pf.drop && lr?.pickup && lr?.drop && lr.at && Date.now() - new Date(lr.at).getTime() < 30 * 60_000) {
            const again: RideDraft = { phase: "confirming_route", provider: providerFromText(text), pickup: lr.pickup, drop: lr.drop, vehicle: hv || undefined, requested: hs || undefined };
            again.routeSummary = formatRouteSummary(lr.pickup, lr.drop);
            return await multiAppHandoff(input, again);
        }
    }

    if (starting || bareYeahStartsRide || input.forceStart) {
        // Avoid stealing general "yes" when pharmacy/browser drafts active — caller should
        // check those first. Here: only start if no ride draft.
        draft = {
            phase: "need_slots",
            provider: providerFromText(text),
            vehicle: hv || undefined,
            requested: hs || undefined,
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
