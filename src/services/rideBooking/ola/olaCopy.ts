/**
 * In-chat Ola booking: page-text parsing and every message Saheli sends (English + Hinglish).
 * Pure (no I/O) so each lifecycle state is unit-tested.
 */

export type OlaRideType = { name: string; etaMin?: number; fare?: number };
export type OlaConfirmInfo = { pickup?: string; drop?: string; fare?: number; pay?: string; vehicle: string };
export type OlaDriverInfo = { name?: string; vehicle?: string; plate?: string; etaMin?: number; otp?: string };
export type OlaPageState = "searching" | "assigned" | "no_driver" | "driver_cancelled" | "cancelled" | "started" | "unknown";

/** Ride categories Ola web lists (cab types first). */
export const OLA_TYPES = ["Mini", "Prime Sedan", "Prime SUV", "Prime Plus", "Electric", "Kaali Peeli", "Lux", "Auto", "Bike"] as const;
const CAB_TYPES = new Set(["Mini", "Prime Sedan", "Prime SUV", "Prime Plus", "Electric", "Kaali Peeli", "Lux"]);

const hiOf = (lang?: string | null) => /^hi/i.test(String(lang || ""));

/** "₹312" / "₹ 1,204" → 312 / 1204 */
export function parseRupees(s: string): number | undefined {
    const m = s.match(/₹\s?([\d,]{2,7})/);
    return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
}

/** Ride list from the booking page's text lines (name, then "4 min", then "₹312" nearby). */
export function parseRideTypes(lines: string[]): OlaRideType[] {
    // Live Ola web order (27 Sep 2026): "<N min>" (ETA of the row below) → name → description → fare.
    // So a row's ETA is the line just before its name; its fare sits after the name, before the next row's ETA/name.
    const isName = (l: string) => OLA_TYPES.some((t) => l.trim().toLowerCase() === t.toLowerCase());
    const etaOf = (l: string) => l.trim().match(/^(\d{1,2})\s*mins?$/i);
    const out: OlaRideType[] = [];
    for (let i = 0; i < lines.length; i++) {
        const name = OLA_TYPES.find((t) => lines[i]!.trim().toLowerCase() === t.toLowerCase());
        if (!name || out.some((o) => o.name === name)) continue;
        const r: OlaRideType = { name };
        const prev = i > 0 ? etaOf(lines[i - 1]!) : null;
        if (prev) r.etaMin = Number(prev[1]);
        for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
            if (isName(lines[j]!) || etaOf(lines[j]!)) break;
            const f = parseRupees(lines[j]!);
            if (f) { r.fare = f; break; }
        }
        out.push(r);
    }
    return out;
}

/** Cab types first for a cab / airport ask, the asked vehicle first otherwise. */
export function orderRideTypes(types: OlaRideType[], vehicle: "cab" | "auto" | "bike"): OlaRideType[] {
    const rank = (t: OlaRideType) =>
        vehicle === "cab" ? (CAB_TYPES.has(t.name) ? 0 : 1) : t.name.toLowerCase() === vehicle ? 0 : CAB_TYPES.has(t.name) ? 1 : 2;
    return [...types].sort((a, b) => rank(a) - rank(b));
}

/** "2" / "mini" / "prime sedan wali" / "sedan" → the chosen type. */
export function pickRideType(text: string, shown: OlaRideType[]): OlaRideType | null {
    const t = text.trim().toLowerCase();
    const n = t.match(/^(\d)\b/);
    if (n) return shown[Number(n[1]) - 1] || null;
    const exact = shown.find((s) => t.includes(s.name.toLowerCase()));
    if (exact) return exact;
    const alias: Array<[RegExp, string]> = [
        [/\bsedan\b/, "Prime Sedan"], [/\bsuv\b/, "Prime SUV"], [/\b(auto|rickshaw)\b/, "Auto"], [/\b(bike|moto)\b/, "Bike"],
        [/\b(chhoti|small|sasti|cheap)/, "Mini"], [/\b(badi|big|bigger)/, "Prime SUV"],
    ];
    for (const [re, name] of alias) if (re.test(t)) return shown.find((s) => s.name === name) || null;
    return null;
}

/** Confirm-ride page: PICKUP / DROP / FARE / PAY BY labels followed by their values. */
export function parseConfirm(lines: string[], vehicle: string): OlaConfirmInfo {
    const after = (label: RegExp) => {
        const i = lines.findIndex((l) => label.test(l.trim()));
        return i >= 0 ? lines.slice(i + 1).find((l) => l.trim()) : undefined;
    };
    const fareLine = after(/^fare$/i);
    return {
        vehicle,
        pickup: after(/^pickup$/i)?.trim(),
        drop: after(/^drop$/i)?.trim(),
        fare: fareLine ? parseRupees(fareLine) : undefined,
        pay: after(/^pay by$/i)?.trim(),
    };
}

const PLATE = /\b([A-Z]{2}[\s-]?\d{1,2}[\s-]?[A-Z]?[\s-]?[A-Z]{0,3}[\s-]?\d{3,4})\b/;

/** What the booked-ride page shows right now. Order matters: a cancel notice beats a stale driver card. */
export function classifyRidePage(text: string): OlaPageState {
    const t = text.replace(/\s+/g, " ");
    if (/\b(driver|captain|partner)\b[^.]{0,30}\bcancel+ed\b/i.test(t)) return "driver_cancelled";
    if (/\b(ride|booking|trip|request)\b[^.]{0,25}\bcancel+ed\b|\bcancel+ed successfully\b/i.test(t)) return "cancelled";
    if (/\bno (cabs?|drivers?|rides?|captains?) (are |is )?(currently )?available\b|\bcould ?n[o']?t find (a |any )?(driver|cab|ride)|\ball (our )?(cabs|drivers) are busy|\bunable to (find|allot)/i.test(t)) return "no_driver";
    if (/\b(trip|ride) (has )?started\b|\benjoy your ride\b|\btrip completed\b/i.test(t)) return "started";
    if ((/\b(otp|pin)\s*[:\-]?\s*\d{4}\b/i.test(t) || /\b(arriving|is on the way|reach(es|ing)? (you )?in|will reach)\b/i.test(t)) && PLATE.test(t)) return "assigned";
    if (/\b(finding|searching|looking for|allott?ing|connecting you|please wait while|request(ing)? (sent|nearby))\b/i.test(t)) return "searching";
    return "unknown";
}

export function parseDriver(lines: string[]): OlaDriverInfo {
    const text = lines.join("\n");
    const out: OlaDriverInfo = {};
    const plateIdx = lines.findIndex((l) => PLATE.test(l));
    if (plateIdx >= 0) out.plate = lines[plateIdx]!.match(PLATE)![1]!.replace(/[\s-]+/g, " ").trim();
    const otp = text.match(/\b(?:otp|pin)\s*[:\-]?\s*(\d{4})\b/i);
    if (otp) out.otp = otp[1];
    const eta = text.match(/\b(\d{1,2})\s*min(?:s|utes)?\b/i);
    if (eta) out.etaMin = Number(eta[1]);
    const MODEL = /\b(dzire|etios|wagon ?r|swift|indica|innova|ertiga|aura|xcent|amaze|city|verna|ciaz|celerio|alto|tiago|nexon|tigor|punch|kwid|santro|creta|xylo|marazzo|auto|rickshaw|bike|scooty|activa|splendor|pulsar)\b/i;
    const vIdx = lines.findIndex((l) => MODEL.test(l) && !PLATE.test(l) && l.length < 40);
    if (vIdx >= 0) out.vehicle = lines[vIdx]!.trim();
    const near = plateIdx >= 0 ? lines.slice(Math.max(0, plateIdx - 4), plateIdx + 4) : lines;
    const name = near.find((l) => /^[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}$/.test(l.trim()) && !MODEL.test(l) && !/^(Cash|Pickup|Drop|Fare|Cancel|Call|Share|Support|Help|Mini|Auto|Bike|Prime \w+)$/i.test(l.trim()));
    if (name) out.name = name.trim();
    return out;
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────

const rs = (n?: number) => (n != null ? `₹${n}` : "");
export const maskPhone = (e164: string) => `+91……${e164.replace(/\D/g, "").slice(-4)}`;

export const OlaMsg = {
    checking: (lang?: string | null) => (hiOf(lang) ? "Ola par gaadiyan dekh rahi hoon 🙏" : "Checking Ola for rides 🙏"),

    types(lang: string | null | undefined, drop: string, types: OlaRideType[], appLink: string | null): string {
        const hi = hiOf(lang);
        const rows = types.slice(0, 6).map((t, i) => `${i + 1}. *${t.name}*${t.fare ? ` — ${rs(t.fare)}` : ""}${t.etaMin != null ? (hi ? ` · ${t.etaMin} min door` : ` · ${t.etaMin} min away`) : ""}`);
        const priced = types.some((t) => t.fare);
        return [
            hi ? `Ola par *${drop}* ke liye:` : `On Ola to *${drop}*:`,
            ...rows,
            "",
            hi ? "Kaunsi chahiye? Number ya naam likhiye." : "Which one? Reply with the number or name.",
            priced ? "" : hi ? "(Ola kiraya sign in ke baad dikhata hai.)" : "(Ola shows the exact fare after sign-in.)",
            appLink ? (hi ? `Khud app mein karna ho to: ${appLink}` : `Prefer the app yourself? ${appLink}`) : "",
        ].filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i < a.length - 1)).join("\n").trim();
    },

    confirmSignIn(lang: string | null | undefined, type: string, phoneE164: string): string {
        return hiOf(lang)
            ? `*${type}* ✅ Aage badhne ke liye *confirm* likhiye — main Ola mein aapke number (${maskPhone(phoneE164)}) se sign in karungi; Ola sign in ke liye SMS par ek code bhejta hai. Abhi kuch book nahi hoga. Rokna ho to *cancel*.`
            : `*${type}* ✅ Reply *confirm* to go ahead — I'll sign in to Ola with your number (${maskPhone(phoneE164)}); Ola sends a sign-in code by SMS. Nothing is booked yet. Say *cancel* to stop.`;
    },
    softYesSignIn: (lang?: string | null) =>
        hiOf(lang) ? "Aage badhne ke liye *confirm* likhiye, ya *cancel*." : "To go ahead, reply *confirm* — or *cancel*.",
    openingSignIn: (lang?: string | null) => (hiOf(lang) ? "Theek hai, Ola khol rahi hoon 🙏" : "Okay, opening Ola 🙏"),
    otpSent: (lang: string | null | undefined, phoneE164: string) =>
        hiOf(lang)
            ? `Ola ne ${maskPhone(phoneE164)} par 4 ank ka code bheja hai — yahan likh dijiye. Rokna ho to *cancel*.`
            : `Ola has sent a 4-digit code to ${maskPhone(phoneE164)} — please type it here. Say *cancel* to stop.`,
    otpChecking: (lang?: string | null) => (hiOf(lang) ? "Code mil gaya 👍 Ola mein daal rahi hoon…" : "Got the code 👍 Entering it on Ola…"),
    otpWrong: (lang?: string | null) =>
        hiOf(lang) ? "Ola ne yeh code nahi maana 🙏 SMS wala 4 ank ka code phir se likhiye." : "Ola didn't accept that code 🙏 Please type the 4-digit code from the SMS again.",
    otpNeedDigits: (lang?: string | null) => (hiOf(lang) ? "Ola ka 4 ank ka code likhiye (sirf number)." : "Please type Ola's 4-digit code (numbers only)."),
    fetchingFare: (lang?: string | null) => (hiOf(lang) ? "Ola par kiraya dekh rahi hoon…" : "Getting the fare on Ola…"),

    confirmBook(lang: string | null | undefined, c: OlaConfirmInfo): string {
        const hi = hiOf(lang);
        return [
            `Ola *${c.vehicle}* · *${rs(c.fare)}* · ${hi ? "Cash" : "Cash"}`,
            `*${c.pickup || "—"}* → *${c.drop || "—"}*`,
            "",
            hi ? "Book karne ke liye *confirm* likhiye. Rokna ho to *cancel*." : "Reply *confirm* to book it. Say *cancel* to stop.",
        ].join("\n");
    },
    softYesBook: (lang?: string | null) =>
        hiOf(lang) ? "Book karne ke liye *confirm* likhiye, ya *cancel*." : "To book, reply *confirm* — or *cancel*.",
    booking: (lang?: string | null) => (hiOf(lang) ? "Ola par book kar rahi hoon…" : "Booking on Ola…"),
    searching: (lang?: string | null) =>
        hiOf(lang)
            ? "Ola par request chali gayi hai. Driver dhoondh rahi hoon 🙏 Kuch minute lag sakte hain — rokna ho to kabhi bhi *cancel* likhiye."
            : "Your request is in on Ola. Finding you a driver 🙏 This can take a few minutes — say *cancel* anytime to stop.",
    bookUnverified: (lang?: string | null) =>
        hiOf(lang)
            ? "Maine Ola par book dabaya, par page par abhi pushti nahi dikh rahi. Main dekh rahi hoon aur turant bataungi 🙏"
            : "I pressed book on Ola but the page hasn't confirmed it yet. I'm checking and will tell you right away 🙏",

    /** Non-repeating progress lines, one every ~2–3 min. */
    update(lang: string | null | undefined, idx: number): string {
        const hi = hiOf(lang);
        const en = [
            "Still looking for a driver on Ola 🙏",
            "A little longer — Ola is still asking drivers nearby.",
            "Still searching. Say *cancel* anytime if you'd like to stop.",
        ];
        const hn = [
            "Abhi bhi Ola par driver dhoondh rahi hoon 🙏",
            "Thoda aur intezaar — Ola aas-paas ke drivers se pooch raha hai.",
            "Search abhi chal rahi hai. Rokna ho to kabhi bhi *cancel* likhiye.",
        ];
        const arr = hi ? hn : en;
        return arr[Math.min(idx, arr.length - 1)]!;
    },

    assigned(lang: string | null | undefined, d: OlaDriverInfo, fare?: number): string {
        const hi = hiOf(lang);
        return [
            hi ? "Driver mil gaya! 🚕" : "Driver found! 🚕",
            [d.name ? `*${d.name}*` : "", d.vehicle || "", d.plate ? `*${d.plate}*` : ""].filter(Boolean).join(" · "),
            d.etaMin != null ? (hi ? `Pahunchenge: ~${d.etaMin} min` : `Arriving in ~${d.etaMin} min`) : "",
            d.otp ? (hi ? `Ride OTP: *${d.otp}* (gaadi mein baithte waqt driver ko batayein)` : `Ride OTP: *${d.otp}* (tell the driver when you get in)`) : "",
            fare ? (hi ? `Driver ko cash dena hai: ${rs(fare)}` : `Pay the driver in cash: ${rs(fare)}`) : "",
        ].filter(Boolean).join("\n");
    },

    options(lang: string | null | undefined): string {
        return hiOf(lang)
            ? "Kya karein?\n1. Phir se dhoondhein\n2. Doosri gaadi chunein\n3. Uber / Rapido ka link"
            : "What would you like?\n1. Search again\n2. Pick a different ride\n3. Uber / Rapido link";
    },
    noDriverTimeout: (lang: string | null | undefined, minutes: number) =>
        hiOf(lang)
            ? `Ola par ${minutes} minute mein koi driver nahi mila, isliye maine search band kar di 🙏\n\n${OlaMsg.options(lang)}`
            : `No driver accepted on Ola in ${minutes} minutes, so I've stopped the search 🙏\n\n${OlaMsg.options(lang)}`,
    olaNoDriver: (lang?: string | null) =>
        hiOf(lang)
            ? `Ola ke paas abhi koi driver khaali nahi hai 🙏 Maine search band kar di.\n\n${OlaMsg.options(lang)}`
            : `Ola says no drivers are free right now 🙏 I've stopped the search.\n\n${OlaMsg.options(lang)}`,
    driverCancelled: (lang?: string | null) =>
        hiOf(lang)
            ? `Driver ne ride cancel kar di 🙏\n\n${OlaMsg.options(lang)}`
            : `The driver cancelled the ride 🙏\n\n${OlaMsg.options(lang)}`,
    cancelledByUser: (lang?: string | null) => (hiOf(lang) ? "Ola par ride cancel ho gayi ✅" : "Cancelled on Ola ✅"),
    cancelAssignedAsk: (lang?: string | null) =>
        hiOf(lang)
            ? "Driver raaste mein hai. Ab cancel karne par Ola cancellation fee le sakta hai. Phir bhi cancel karein? *haan* ya *nahi*."
            : "The driver is on the way. Ola may charge a cancellation fee now. Cancel anyway? Reply *yes* or *no*.",
    cancelKeep: (lang?: string | null) => (hiOf(lang) ? "Theek hai, ride chalu hai 🙏" : "Okay, the ride stays on 🙏"),
    cancelling: (lang?: string | null) => (hiOf(lang) ? "Ola par cancel kar rahi hoon…" : "Cancelling on Ola…"),
    cancelRetrying: (lang?: string | null) =>
        hiOf(lang) ? "Ola par cancel abhi nahi ho paaya 🙏 Main phir koshish kar rahi hoon." : "Cancelling on Ola didn't go through yet 🙏 I'm trying again.",
    cancelStuck: (lang: string | null | undefined, link: string) =>
        hiOf(lang)
            ? `Ola par cancel nahi ho pa raha 🙏 Kripya Ola app mein ride kholkar cancel kar dijiye: ${link}\nMain bhi koshish karti rahungi.`
            : `I can't get the cancel through on Ola 🙏 Please open the ride in the Ola app and cancel it there: ${link}\nI'll keep trying too.`,
    stillSearching: (lang?: string | null) =>
        hiOf(lang) ? "Aapki Ola search abhi chal rahi hai 🙏 Rokna ho to *cancel* likhiye." : "Your Ola search is still running 🙏 Say *cancel* to stop it.",
    rideOn: (lang: string | null | undefined, d: OlaDriverInfo) =>
        hiOf(lang)
            ? `Aapki Ola ride chalu hai${d.plate ? ` — *${d.plate}*` : ""}${d.otp ? `, OTP *${d.otp}*` : ""}. Cancel karna ho to *cancel* likhiye.`
            : `Your Ola ride is on${d.plate ? ` — *${d.plate}*` : ""}${d.otp ? `, OTP *${d.otp}*` : ""}. Say *cancel* to cancel it.`,

    failed(lang: string | null | undefined, olaLink: string | null, uberLink: string | null, rapidoLink: string | null = null): string {
        const hi = hiOf(lang);
        return [
            hi ? "Ola par yeh abhi nahi ho paaya 🙏" : "I couldn't get this done on Ola right now 🙏",
            olaLink ? (hi ? `Ola app mein seedha: ${olaLink}` : `Book directly in the Ola app: ${olaLink}`) : "",
            uberLink ? (hi ? `Ya Uber: ${uberLink}` : `Or Uber: ${uberLink}`) : "",
            rapidoLink ? (hi ? `Ya Rapido: ${rapidoLink}` : `Or Rapido: ${rapidoLink}`) : "",
            hi ? "Jab tak aap app mein confirm nahi karte, kuch book nahi hota." : "Nothing is booked until you confirm in the app.",
        ].filter(Boolean).join("\n");
    },
    notCash: (lang?: string | null) =>
        hiOf(lang) ? "Ola par cash payment chun nahi paayi, isliye book nahi kiya 🙏" : "I couldn't set cash payment on Ola, so I didn't book 🙏",
    links(lang: string | null | undefined, uber: string | null, rapido: string | null): string {
        const hi = hiOf(lang);
        return [
            uber ? (hi ? `*Uber* (route bhara hua): ${uber}` : `*Uber* (route filled in): ${uber}`) : "",
            rapido ? (hi ? `*Rapido*: ${rapido}` : `*Rapido*: ${rapido}`) : "",
            hi ? "Jab tak aap app mein confirm nahi karte, kuch book nahi hota." : "Nothing is booked until you confirm in the app.",
        ].filter(Boolean).join("\n");
    },
    caregiverBooked(who: string, c: OlaConfirmInfo, d: OlaDriverInfo): string {
        return [
            `🚕 ${who} booked an *Ola ${c.vehicle}* via Saheli`,
            `• ${c.pickup || "Pickup"} → ${c.drop || "Drop"}`,
            `• ${c.fare ? `₹${c.fare} · ` : ""}Cash`,
            `• Driver: ${[d.name, d.vehicle, d.plate].filter(Boolean).join(" · ") || "assigned"}${d.etaMin != null ? ` · ~${d.etaMin} min away` : ""}`,
        ].join("\n");
    },
};
