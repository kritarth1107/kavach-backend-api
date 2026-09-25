/**
 * Food vs grocery intent + WhatsApp copy for the Swiggy restaurant → dish flow.
 * Pure helpers (unit-tested); the state machine lives in browserTaskWhatsApp.service.ts.
 */
import type { GuestDish, GuestRestaurant } from "./swiggyGuest.service";
import { stripAddressPhrases, targetTokens } from "./kavachAddress";

export const FOOD_PARTNERS = new Set(["swiggy", "zomato"]);
export const GROCERY_PARTNERS = new Set(["instamart", "zepto", "blinkit"]);

const FOOD_FILLER = new Set(
    (
        "lets let's let us try trying ordering order orders buy get want wanna need i me my we please kindly can could would you show list find see search " +
        "some something any from on via at in near nearby around to for the a an of and or with food foods khana restaurant restaurants resto hotel hotels dhaba " +
        "open opened now currently today tonight available delivering delivery deliver swiggy zomato app online good best nice place places options option " +
        "home address ghar mujhe chahiye dikhao batao kuch hai"
    ).split(/\s+/),
);

/** "show me open restaurants", "order from swiggy food", "khana mangwa do" → restaurant list intent. */
export function wantsRestaurantList(text: string): boolean {
    return /\b(restaurants?|resto|hotels?|dhaba|khana|food|dinner|lunch|breakfast|meal|eat|kha(?:na|ne))\b/i.test(text);
}

/** Dish / cuisine words left after removing chatter, partner, address and filler ("" = none). */
export function extractFoodQuery(text: string, homeAddress?: string | null): string {
    const own = new Set(targetTokens(homeAddress));
    const cleaned = stripAddressPhrases(text, homeAddress)
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, " ")
        .split(/\s+/)
        .filter((w) => w && !FOOD_FILLER.has(w) && !own.has(w) && !/^\d+$/.test(w) && !/^[a-z]?\d+[a-z]?$/.test(w));
    return cleaned.join(" ").trim().slice(0, 60);
}

/** Order text with no product left after removing address/filler words → it's about the address. */
export function isAddressOnlyMessage(text: string, homeAddress?: string | null): boolean {
    const t = text.toLowerCase();
    const own = new Set(targetTokens(homeAddress));
    if (!/\b(deliver(?:ed|y)?|address|home|ghar|bhej|send|pincode|pin\s*code|location)\b/.test(t)) return false;
    const rest = t
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .filter(
            (w) =>
                !FOOD_FILLER.has(w) &&
                !own.has(w) &&
                !/^(inwant|iwant|want|it|is|be|should|will|shall|there|this|that|deliver|delivered|delivery|send|sent|bhej|bhejo|bhejna|do|karo|kar|pe|par|mera|mere|meri|instamart|zepto|blinkit|apollo|pharmeasy|city|flat|house|pincode|pin|code|location|india|area|near|same|saved|usual)$/.test(w) &&
                !/^[a-z]?-?\d+[a-z]?$/.test(w),
        );
    return rest.length === 0;
}

function num(n: number): string {
    return `*${n}*`;
}

/** "Reply 1 or 2" / "Reply 1, 2 or 3" / "Reply 1–5" — always matches the options shown. */
export function replyPickCopy(count: number): string {
    if (count <= 1) return "Reply *1*";
    if (count === 2) return `Reply ${num(1)} or ${num(2)}`;
    if (count === 3) return `Reply ${num(1)}, ${num(2)} or ${num(3)}`;
    return `Reply a number ${num(1)}–${num(count)}`;
}

export function restaurantListCopy(opts: GuestRestaurant[], addrShort: string, dishQuery?: string): string {
    const lines = opts.map((r, i) => {
        const meta = [r.cuisines, r.rating ? `⭐ ${r.rating}` : "", r.eta ? `🕒 ${r.eta}` : ""].filter(Boolean).join(" · ");
        return `${i + 1}. *${r.name}*${meta ? `\n   ${meta}` : ""}`;
    });
    return [
        `Open now on *Swiggy* near 📍 ${addrShort}${dishQuery ? ` for "${dishQuery}"` : ""}:`,
        ...lines,
        "",
        `${replyPickCopy(opts.length)} to see the menu, or *cancel*.`,
    ].join("\n");
}

export function noOpenRestaurantsCopy(closed: GuestRestaurant[], addrShort: string, dishQuery?: string): string {
    const withTimes = closed.filter((r) => r.closedNote && /opens/i.test(r.closedNote)).slice(0, 3);
    const lines = withTimes.map((r) => `• ${r.name} — ${r.closedNote!.replace(/^closed now — /, "")}`);
    return [
        `Swiggy doesn't show any restaurant taking orders at 📍 ${addrShort}${dishQuery ? ` for "${dishQuery}"` : ""} right now 🌙`,
        ...(lines.length ? ["", "Opening later:", ...lines] : []),
        "",
        `Ask me again when they're open, or I can look for groceries on *Instamart*.`,
    ].join("\n");
}

export function dishListCopy(restaurant: string, dishes: GuestDish[], addrShort: string, dishQuery?: string): string {
    const lines = dishes.map((d, i) => {
        const price = typeof d.pricePaise === "number" ? ` — *₹${Math.round(d.pricePaise / 100)}*` : "";
        return `${i + 1}. ${d.veg === true ? "🟢 " : d.veg === false ? "🔴 " : ""}${d.name}${price}`;
    });
    return [
        `*${restaurant}* ${dishQuery ? `— "${dishQuery}"` : "— popular dishes"} 🍽️`,
        ...lines,
        `📍 ${addrShort}`,
        "",
        `${replyPickCopy(dishes.length)} to pick a dish, send a dish name, or *cancel*. Cash on Delivery only.`,
    ].join("\n");
}
