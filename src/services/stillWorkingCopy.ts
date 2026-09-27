/**
 * The ONE progress line sent when a WhatsApp reply takes too long. It names only the single
 * task that is actually running (newest flow wins) — never a generic menu, never tech words.
 */
type Flow = { at: number; en: string; hi: string };

const t = (v: unknown): number => {
    const n = v ? new Date(v as string).getTime() : 0;
    return Number.isFinite(n) ? n : 0;
};
const LABELS: Record<string, string> = {
    swiggy: "Swiggy", instamart: "Instamart", zepto: "Zepto", blinkit: "Blinkit", zomato: "Zomato",
    apollo: "Apollo Pharmacy", pharmeasy: "PharmEasy", uber: "Uber", ola: "Ola", rapido: "Rapido",
};
const label = (k: unknown): string => LABELS[String(k || "").toLowerCase()] || "";
const short = (s: unknown, n = 40): string => {
    const v = String(s || "").split(",")[0]!.trim();
    return v.length > n ? `${v.slice(0, n - 1)}…` : v;
};

export function stillWorkingLine(session: Record<string, unknown> | null | undefined, lang?: string | null): string {
    const s = (session || {}) as Record<string, Record<string, unknown> | undefined>;
    const flows: Flow[] = [];
    const ride = s.rideDraft;
    if (ride?.phase && ride.phase !== "done" && ride.phase !== "idle") {
        const app = label(ride.provider) || "Uber";
        const drop = short((ride.drop as Record<string, unknown> | undefined)?.shortLabel || (ride.drop as Record<string, unknown> | undefined)?.address || (ride.drop as Record<string, unknown> | undefined)?.raw);
        flows.push({
            at: t(ride.savedAt),
            en: drop ? `Still on your ${app} ride to ${drop}, one moment 🙏` : `Still on your ${app} ride, one moment 🙏`,
            hi: drop ? `${drop} ke liye ${app} ride par kaam chal raha hai, bas ek pal 🙏` : `${app} ride par kaam chal raha hai, bas ek pal 🙏`,
        });
    }
    const ph = s.pharmacyDraft;
    if (ph?.phase) {
        const store = label(ph.partner) || "the pharmacy";
        const q = short(ph.searchQuery || ((ph.items as Array<{ name?: string }> | undefined)?.[0]?.name));
        flows.push({
            at: t(ph.savedAt),
            en: q ? `Still checking ${store} for ${q}, one moment 🙏` : `Still checking ${store} for your medicines, one moment 🙏`,
            hi: q ? `${store} par ${q} dekh rahi hoon, bas ek pal 🙏` : `${store} par aapki dawai dekh rahi hoon, bas ek pal 🙏`,
        });
    }
    const bd = s.browserTaskDraft;
    if (bd?.phase) {
        const store = label(bd.partner);
        const q = short((bd as Record<string, unknown>).query || (bd as Record<string, unknown>).dishQuery);
        flows.push({
            at: t(bd.savedAt),
            en: store && q ? `Still checking ${store} for ${q}, one moment 🙏` : store ? `Still working on your ${store} order, one moment 🙏` : "Still working on your order, one moment 🙏",
            hi: store && q ? `${store} par ${q} dekh rahi hoon, bas ek pal 🙏` : store ? `${store} order par kaam chal raha hai, bas ek pal 🙏` : "Aapke order par kaam chal raha hai, bas ek pal 🙏",
        });
    }
    const ps = s.pendingSearch;
    if (ps?.at) {
        flows.push({ at: t(ps.at), en: "Still looking that up for you, one moment 🙏", hi: "Abhi dhoondh rahi hoon, bas ek pal 🙏" });
    }
    flows.sort((a, b) => b.at - a.at);
    const f = flows[0] || { at: 0, en: "One moment, still on it 🙏", hi: "Bas ek pal, abhi kar rahi hoon 🙏" };
    return /^(hi|hinglish|hi-latn|hindi)/i.test(String(lang || "")) ? f.hi : f.en;
}
