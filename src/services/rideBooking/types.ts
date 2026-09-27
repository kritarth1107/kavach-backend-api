/**
 * Instinct-parity ride booking session (Uber web first).
 * Confirm-before-book; elder OTP paste; caregiver notify-only.
 */

export type RideProvider = "uber" | "ola" | "rapido";

export type RidePhase =
    | "idle"
    | "need_slots"
    | "need_pickup"
    | "need_drop"
    | "confirming_route"
    | "ask_uber_phone"
    | "awaiting_otp"
    | "showing_fares"
    | "awaiting_book_confirm"
    | "booking"
    | "done"
    | "unavailable"
    /** No app serves the area: she was offered "shall I message your family?". */
    | "offer_caregiver"
    // In-chat Ola booking (see ola/olaInChat.service.ts)
    | "ola_loading"
    | "ola_pick_type"
    | "ola_confirm_signin"
    | "ola_signing_in"
    | "ola_awaiting_otp"
    | "ola_checking_otp"
    | "ola_confirm_book"
    | "ola_booking"
    | "ola_searching"
    | "ola_assigned"
    | "ola_cancel_assigned_ask"
    | "ola_offer";

/** Ola steps before anything is booked (a newer ask may drop these). */
export const OLA_PRE_BOOKING_PHASES: RidePhase[] = [
    "ola_loading", "ola_pick_type", "ola_confirm_signin", "ola_signing_in", "ola_awaiting_otp", "ola_checking_otp", "ola_confirm_book", "ola_offer",
];

export type RidePlace = {
    raw?: string;
    address?: string;
    shortLabel?: string;
    lat?: number;
    lng?: number;
    source?: "text" | "location_pin" | "geocode" | "reverse_geocode";
};

export type RideFareOption = {
    id: string;
    label: string;
    estimateLabel: string;
    etaMinutes?: number;
};

export type RideDraft = {
    phase: RidePhase;
    provider: RideProvider;
    pickup?: RidePlace;
    drop?: RidePlace;
    routeSummary?: string;
    phoneE164?: string;
    otpChallengeId?: string;
    fares?: RideFareOption[];
    selectedFareId?: string;
    driver?: {
        name?: string;
        vehicle?: string;
        plate?: string;
        etaMinutes?: number;
    };
    lastMessage?: string;
    mode?: "playwright" | "dry_run";
    /** Cab / auto / bike she asked for (airport trips default to cab). */
    vehicle?: "cab" | "auto" | "bike";
    /** App she named ("Ola se"), honoured when it runs there. */
    requested?: "uber" | "ola" | "rapido" | "namma_yatri";
    unavailableReason?: string;
    ola?: {
        token: string;
        lang?: string | null;
        types?: Array<{ name: string; etaMin?: number; fare?: number }>;
        chosen?: string;
        confirm?: { pickup?: string; drop?: string; fare?: number; pay?: string; vehicle: string };
        otpTries?: number;
        phoneE164?: string;
        rideId?: string;
    };
};

export const RIDE_CANCEL_RE =
    /^(cancel|stop|never\s*mind|nope|nah|nahi|mat\s*karo|don't|dont)$/i;

export const RIDE_CONFIRM_RE =
    /^(confirm|book|yes|haan|ha|ok|okay|uberx|go|place)$/i;

export const RIDE_INTENT_RE =
    /\b(book\s+(a\s+)?(cab|taxi|uber|ola|rapido|ride)|want\s+a\s+ride|need\s+a\s+(cab|taxi|ride|uber)|call\s+(an?\s+)?(uber|ola|cab|taxi)|uber\s+(me|please|abhi)|ola\s+(me|please)|take\s+(me\s+)?(an?\s+)?uber|get\s+(me\s+)?(an?\s+)?uber)\b|\b(cab|taxi|uber|ola|rapido)\b.*\b(book|order|call|need|want)\b/i;
