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
    | "unavailable";

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
    unavailableReason?: string;
};

export const RIDE_CANCEL_RE =
    /^(cancel|stop|never\s*mind|nope|nah|nahi|mat\s*karo|don't|dont)$/i;

export const RIDE_CONFIRM_RE =
    /^(confirm|book|yes|haan|ha|ok|okay|uberx|go|place)$/i;

export const RIDE_INTENT_RE =
    /\b(book\s+(a\s+)?(cab|taxi|uber|ola|rapido|ride)|want\s+a\s+ride|need\s+a\s+(cab|taxi|ride|uber)|call\s+(an?\s+)?(uber|ola|cab|taxi)|uber\s+(me|please|abhi)|ola\s+(me|please)|take\s+(me\s+)?(an?\s+)?uber|get\s+(me\s+)?(an?\s+)?uber)\b|\b(cab|taxi|uber|ola|rapido)\b.*\b(book|order|call|need|want)\b/i;
