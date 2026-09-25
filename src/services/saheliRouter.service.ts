/**
 * Saheli's single understanding step for every WhatsApp turn (Gemini structured output).
 * It sees the message, the last few turns and the active flow state and returns intent +
 * slots. Code keeps the guardrails (money / OTP / safety); regex routers are only the
 * fallback when this returns null (model unavailable / timeout).
 *
 * Model: Gemini 3.5 Flash (VERTEX_ROUTER_MODEL) — Pro adds ~3–6 s per turn, too slow for a
 * router that runs on every message under the 35 s WhatsApp SLA.
 */
import { vertexGenerateText, parseJsonLoose, vertexFlashModel } from "../clients/vertexGemini.client";

export const ROUTER_INTENTS = [
    "order_new",
    "order_modify",
    "order_control",
    "restaurant_list",
    "otp_code",
    "ride",
    "reminder_or_meds",
    "language_change",
    "presence_check",
    "caregiver_share",
    "health_concern",
    "emergency",
    "order_status_history",
    "account_info",
    "companion_chat",
] as const;
export type RouterIntent = (typeof ROUTER_INTENTS)[number];

export const ORDER_CONTROLS = ["confirm", "cancel", "status", "retry", "order_again", "pick", "none"] as const;
export type OrderControl = (typeof ORDER_CONTROLS)[number];

export type SaheliRoute = {
    intent: RouterIntent;
    language: "en" | "hi" | "hinglish" | "other";
    /** language_change: the language they asked Saheli to use. */
    newLanguage: string | null;
    category: "food" | "grocery" | "pharmacy" | "ride" | "other" | null;
    /** What to buy, in the user's words minus chatter / platform / address (null if none). */
    productQuery: string | null;
    quantity: number | null;
    /** Platforms explicitly named in THIS message (lowercase keys). */
    partners: string[];
    /** The message is only a platform name / "on X" answer for a pending product. */
    partnerOnly: boolean;
    restaurantName: string | null;
    control: OrderControl;
    pickIndex: number | null;
    /** Delivery-address talk: same = their saved/home address; other = a different one. */
    addressKind: "same" | "other" | null;
    addressText: string | null;
    otpCode: string | null;
    confidence: number;
    source: "gemini";
    latencyMs: number;
};

const PARTNERS = ["instamart", "swiggy", "zepto", "blinkit", "zomato", "apollo", "pharmeasy", "tata_1mg", "uber", "amazon", "flipkart", "bigbasket"];

const SCHEMA = {
    type: "OBJECT",
    properties: {
        intent: { type: "STRING", enum: [...ROUTER_INTENTS] },
        language: { type: "STRING", enum: ["en", "hi", "hinglish", "other"] },
        newLanguage: { type: "STRING", nullable: true },
        category: { type: "STRING", enum: ["food", "grocery", "pharmacy", "ride", "other"], nullable: true },
        productQuery: { type: "STRING", nullable: true },
        quantity: { type: "INTEGER", nullable: true },
        partners: { type: "ARRAY", items: { type: "STRING", enum: PARTNERS } },
        partnerOnly: { type: "BOOLEAN" },
        restaurantName: { type: "STRING", nullable: true },
        control: { type: "STRING", enum: [...ORDER_CONTROLS] },
        pickIndex: { type: "INTEGER", nullable: true },
        addressKind: { type: "STRING", enum: ["same", "other"], nullable: true },
        addressText: { type: "STRING", nullable: true },
        otpCode: { type: "STRING", nullable: true },
        confidence: { type: "NUMBER" },
    },
    required: ["intent", "language", "partners", "partnerOnly", "control", "confidence"],
};

const SYSTEM = `You are the understanding step of Saheli, a WhatsApp companion for elderly Indians (English / Hindi / Hinglish, typos, voice transcripts). Read the message IN CONTEXT (recent turns + active flow state) and fill the JSON. Never answer the user.

Intents:
- order_new: wants to buy something new (groceries, food, medicines, household). Also "can you order me X", "X chahiye", "mangwa do".
- restaurant_list: wants to see restaurants / order restaurant food without naming a dish or restaurant ("show open restaurants", "khana order karna hai").
- order_modify: changes the CURRENT order: different item/quantity, delivery address, or naming a platform for the pending product.
- order_control: controls the current order: confirm / cancel / status / retry / order again / picking an option number or name.
- otp_code: pasting a login/verification code (4–8 digits) while a flow is waiting for an OTP.
- ride: cab/auto booking. reminder_or_meds: medicine reminders, schedules, "did I take my pill". language_change: asks Saheli to speak another language. presence_check: "hello?", "are you there", "sun rahe ho". caregiver_share: asks to tell/inform family. health_concern: symptoms / feeling unwell. emergency: fell, chest pain, can't breathe, needs help now. order_status_history: past orders / bills ("what did I order last week", "how much was my last bill", "where is my order" when NO order draft is active). account_info: Kavach account / family things — connecting a delivery app, caregiver approving/rejecting a pending order ("approve", "reject"), quiet hours / do-not-disturb, family brief/update about the elder, lab reports, today's schedule, who is in my family. companion_chat: everything else (greetings, feelings, stories, questions, advice).
- Nudge replies: when Saheli's last turn was a check-in or medicine nudge, answers like "haan le li", "not yet", "done" are reminder_or_meds.

Slots:
- category: food (restaurant dishes, Swiggy/Zomato), grocery (packaged food, snacks, protein bars, milk, fruits, household — Instamart/Zepto/Blinkit), pharmacy (medicines, vitamins, health products — Apollo/PharmEasy/1mg), ride.
- productQuery: ONLY the product words ("rite bite protein bar", "amul milk 1 litre", "paneer butter masala"). Never include platform names, delivery/address words, filler ("can u order me"). null if no product in this message.
- partners: platforms explicitly named in THIS message. A bare platform name reply ("Instamart", "on zepto", "apollo se") → partnerOnly=true, productQuery=null, intent=order_modify (it fills the platform for the pending product).
- addressKind/addressText: message is about WHERE to deliver ("deliver to my home", "ghar pe bhejna", "my Bhopal address") → intent=order_modify, addressKind=same for home/saved/own address, other for a clearly different address; addressText = the address words. Address words are NEVER a productQuery.
- control/pickIndex: "1", "2nd one", "pehla wala" while options are shown → order_control, control=pick, pickIndex. "confirm"/"yes place it" → confirm. "cancel"/"rehne do"/"nahi chahiye" → cancel. "what's happening with my order" → status.
- otpCode: the digits, only for otp_code.
- During an active order flow, small talk / health / reminders are NOT order intents.
Return confidence 0..1.`;

/** Per-phone ring buffer of recent turns (never shared across phones). */
const turns = new Map<string, Array<{ who: "user" | "saheli"; text: string; at: number }>>();
const TURN_TTL_MS = 30 * 60_000;

const keyOf = (phone: string) => String(phone || "").replace(/\D/g, "");

export function rememberTurn(phone: string, who: "user" | "saheli", text: string): void {
    phone = keyOf(phone);
    if (!phone || !text?.trim()) return;
    const now = Date.now();
    const rows = (turns.get(phone) || []).filter((r) => now - r.at < TURN_TTL_MS);
    const last = rows[rows.length - 1];
    // Replies are remembered by the router AND by the Meta send path — keep one copy.
    if (last && last.who === who && last.text === text.slice(0, 400) && now - last.at < 120_000) return;
    rows.push({ who, text: text.slice(0, 400), at: now });
    turns.set(phone, rows.slice(-8));
    if (turns.size > 5000) turns.delete(turns.keys().next().value as string);
}

export function recentTurns(phone: string): string {
    const now = Date.now();
    return (turns.get(keyOf(phone)) || [])
        .filter((r) => now - r.at < TURN_TTL_MS)
        .slice(-6)
        .map((r) => `${r.who === "user" ? "User" : "Saheli"}: ${r.text.replace(/\s+/g, " ").slice(0, 300)}`)
        .join("\n");
}

const cache = new Map<string, { at: number; route: SaheliRoute | null }>();
const lastRoutes = new Map<string, { at: number; route: SaheliRoute | null; state: string[] }>();

/** Secret-gated mock/debug only: this phone's last route (never another phone's). */
export function lastRouteFor(phone: string) {
    return lastRoutes.get(keyOf(phone)) ?? null;
}

export async function routeSaheliTurn(input: {
    phone: string;
    text: string;
    role: "elder" | "caregiver";
    /** One-line summaries of active flows (order draft phase/partner/options, pharmacy, ride, pending OTP). */
    state: string[];
}): Promise<SaheliRoute | null> {
    const text = input.text.trim();
    if (!text) return null;
    const key = `${input.phone}|${text.toLowerCase()}|${input.state.join(";")}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 20_000) return hit.route;
    const started = Date.now();
    const raw = await vertexGenerateText({
        model: process.env.VERTEX_ROUTER_MODEL?.trim() || vertexFlashModel(),
        system: SYSTEM,
        responseSchema: SCHEMA,
        timeoutMs: Number(process.env.VERTEX_ROUTER_TIMEOUT_MS) || 6000,
        maxOutputTokens: 400,
        prompt: [
            `Sender: ${input.role}`,
            `Active flows: ${input.state.length ? input.state.join(" | ") : "none"}`,
            `Recent turns:\n${recentTurns(input.phone) || "(none)"}`,
            `Message: ${text.slice(0, 600)}`,
        ].join("\n\n"),
    });
    const p = parseJsonLoose<Partial<SaheliRoute>>(raw);
    let route: SaheliRoute | null = null;
    if (p && typeof p.intent === "string" && (ROUTER_INTENTS as readonly string[]).includes(p.intent)) {
        const control = (ORDER_CONTROLS as readonly string[]).includes(String(p.control)) ? (p.control as OrderControl) : "none";
        route = {
            intent: p.intent as RouterIntent,
            language: (["en", "hi", "hinglish", "other"] as const).includes(p.language as "en") ? (p.language as SaheliRoute["language"]) : "en",
            newLanguage: p.newLanguage || null,
            category: p.category ?? null,
            productQuery: p.productQuery?.trim() || null,
            quantity: typeof p.quantity === "number" && p.quantity > 0 ? Math.floor(p.quantity) : null,
            partners: Array.isArray(p.partners) ? p.partners.filter((x) => PARTNERS.includes(String(x))).map(String) : [],
            partnerOnly: Boolean(p.partnerOnly),
            restaurantName: p.restaurantName?.trim() || null,
            control,
            pickIndex: typeof p.pickIndex === "number" && p.pickIndex > 0 ? Math.floor(p.pickIndex) : null,
            addressKind: p.addressKind === "same" || p.addressKind === "other" ? p.addressKind : null,
            addressText: p.addressText?.trim() || null,
            otpCode: p.otpCode?.replace(/\D/g, "") || null,
            confidence: typeof p.confidence === "number" ? p.confidence : 0.5,
            source: "gemini",
            latencyMs: Date.now() - started,
        };
    }
    cache.set(key, { at: Date.now(), route });
    lastRoutes.set(keyOf(input.phone), { at: Date.now(), route, state: input.state });
    if (lastRoutes.size > 2000) lastRoutes.delete(lastRoutes.keys().next().value as string);
    if (cache.size > 1000) cache.delete(cache.keys().next().value as string);
    return route;
}
