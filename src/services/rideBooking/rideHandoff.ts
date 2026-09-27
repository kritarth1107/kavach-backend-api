/** Honest ride hand-off: open the cab app with the route pre-filled (pure — no heavy imports). */
import type { RideDraft, RidePlace } from "./types";

function providerLabel(p: RideDraft["provider"]): string {
    return p === "ola" ? "Ola" : p === "rapido" ? "Rapido" : "Uber";
}
function placeText(p: RidePlace | undefined): string {
    return p?.shortLabel || p?.address || p?.raw || "";
}

/** Deep link that opens the provider app / mobile site with the route already filled in. */
export function rideDeepLink(draft: RideDraft): string | null {
    const p = draft.pickup;
    const d = draft.drop;
    if (draft.provider === "uber") {
        const q = new URLSearchParams({ action: "setPickup" });
        if (p?.lat != null && p?.lng != null) {
            q.set("pickup[latitude]", String(p.lat));
            q.set("pickup[longitude]", String(p.lng));
            const a = p.shortLabel || p.address;
            if (a) q.set("pickup[nickname]", a.slice(0, 60));
        } else q.set("pickup", "my_location");
        if (d?.lat != null && d?.lng != null) {
            q.set("dropoff[latitude]", String(d.lat));
            q.set("dropoff[longitude]", String(d.lng));
        }
        const da = d?.address || d?.shortLabel || d?.raw;
        if (da) q.set("dropoff[formatted_address]", da.slice(0, 120));
        return `https://m.uber.com/ul/?${q.toString()}`;
    }
    if (draft.provider === "ola" && p?.lat != null && p?.lng != null && d?.lat != null && d?.lng != null) {
        return `https://book.olacabs.com/?pickup_lat=${p.lat}&pickup_lng=${p.lng}&drop_lat=${d.lat}&drop_lng=${d.lng}`;
    }
    return null;
}

export function rideAppHandoffMessage(draft: RideDraft, lang?: string | null): string {
    const label = providerLabel(draft.provider);
    const link = rideDeepLink(draft);
    const from = short(placeText(draft.pickup)) || "your pickup";
    const to = short(placeText(draft.drop)) || "your drop";
    if (/^hi/i.test(String(lang || ""))) {
        return [
            link ? `Aapki ${label} ride tayyar hai — is link par tap kijiye, route pehle se bhara hai:\n${link}` : `${label} app kholkar yeh route daaliye:`,
            ``,
            `*${from}* → *${to}*`,
            ``,
            `Gaadi chunkar ${label} app mein hi book kijiye — fare wahin booking se pehle dikhega.`,
            `Main aapke liye ${label} mein sign in nahi kar sakti — woh automatic sign-in ko security puzzle se rok deta hai, isliye koi login code nahi aayega. Abhi kuch book nahi hua hai.`,
        ].join("\n");
    }
    return [
        link ? `Your ${label} ride is ready — tap this link and the route is already filled in:\n${link}` : `Please open the ${label} app and enter this route:`,
        ``,
        `*${from}* → *${to}*`,
        ``,
        `Pick the car and book it in the ${label} app — you'll see the fare there before booking.`,
        `I can't sign in to ${label} for you: it blocks automated sign-in with a security puzzle, so no login code is sent. Nothing has been booked.`,
    ].join("\n");
}

function short(s: string): string {
    const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
    const v = parts.slice(0, 2).join(", ");
    return v.length > 60 ? `${v.slice(0, 59)}…` : v;
}
