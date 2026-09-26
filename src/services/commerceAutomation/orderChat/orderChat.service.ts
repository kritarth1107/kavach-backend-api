/**
 * Conversational ordering (product rule): Saheli never jumps from a vague ask ("something to eat",
 * "kuch mangwa do", "bhook lagi hai") straight into a store search. Gemini drives a short, warm
 * chat — one question at a time, 2–3 suggestions — until the ask is specific; it also checks the
 * item against the elder's Kavach health profile and gently offers alternatives (her choice wins,
 * blocked items excepted). Code keeps every guardrail (blocked list, confirm card, COD, address
 * book, one placement) — this step only decides WHAT to search.
 */
import { vertexGenerateText, parseJsonLoose, vertexFlashModel } from "../../../clients/vertexGemini.client";
import WhatsappSession from "../../../models/whatsappSession.model";
import { logActivity } from "../../activityLog.service";
import { recentTurns } from "../../saheliRouter.service";
import { loadHealthProfile, healthProfileText } from "./healthProfile";

export type OrderChatState = {
    startedAt: number;
    updatedAt: number;
    turns: Array<{ who: "elder" | "saheli"; text: string }>;
    category?: "food" | "grocery" | "pharmacy" | null;
    partner?: string | null;
    addressNickname?: string | null;
    /** Last numbered suggestions Saheli offered (for "2" / "pehla wala"). */
    suggestions?: string[];
    /** A health note already raised for this item (so it's never repeated). */
    healthRaised?: { item: string; note: string } | null;
    questions: number;
    /** Not-found alternatives offered after a search. */
    alternativesFor?: string | null;
};

export type OrderChatDecision =
    | { action: "reply"; text: string }
    | {
          action: "search";
          query: string;
          category: "food" | "grocery" | "pharmacy";
          partner: string | null;
          restaurantName: string | null;
          addressNickname: string | null;
          intent: string;
          lead?: string;
      }
    | { action: "restaurants"; addressNickname: string | null; lead?: string }
    | { action: "pass" };

const TTL_MS = 25 * 60_000;

export function orderChatActive(s: unknown): s is OrderChatState {
    const st = s as OrderChatState | undefined;
    return Boolean(st && typeof st.updatedAt === "number" && Date.now() - st.updatedAt < TTL_MS);
}

export async function loadOrderChat(phone: string): Promise<OrderChatState | null> {
    const doc = (await WhatsappSession.findOne({ phone }).lean()) as { orderChat?: OrderChatState } | null;
    return orderChatActive(doc?.orderChat) ? doc!.orderChat! : null;
}

export async function saveOrderChat(phone: string, s: OrderChatState | null): Promise<void> {
    await WhatsappSession.updateOne({ phone }, s ? { $set: { orderChat: s } } : { $unset: { orderChat: 1 } }, { upsert: Boolean(s) }).catch(() => undefined);
}

/** The latest intent per phone, for the relevance filter after the search. */
const lastIntent = new Map<string, { intent: string; at: number }>();
export function orderIntentFor(phone: string): string | null {
    const x = lastIntent.get(phone);
    return x && Date.now() - x.at < 15 * 60_000 ? x.intent : null;
}

const SCHEMA = {
    type: "OBJECT",
    properties: {
        action: { type: "STRING", enum: ["ask", "health_check", "search", "restaurants", "cancel", "not_order"] },
        reply: { type: "STRING", nullable: true },
        suggestions: { type: "ARRAY", items: { type: "STRING" } },
        query: { type: "STRING", nullable: true },
        category: { type: "STRING", enum: ["food", "grocery", "pharmacy"], nullable: true },
        partner: { type: "STRING", enum: ["swiggy", "instamart", "zepto", "blinkit", "apollo"], nullable: true },
        restaurantName: { type: "STRING", nullable: true },
        intent: { type: "STRING", nullable: true },
        healthGuided: { type: "BOOLEAN" },
        healthNote: { type: "STRING", nullable: true },
    },
    required: ["action", "suggestions", "healthGuided"],
};

const SYSTEM = `You are Saheli, a warm WhatsApp companion for an elderly Indian person, helping her order food, groceries or medicines. You decide the NEXT step of the ordering chat. Never answer as a search engine; be a caring friend.

Actions:
- ask: the request is too vague to search well. Ask ONE short, warm question (1–2 lines), with 2–3 concrete suggestions in "suggestions" (short item names). Good questions: meal or snack? sweet or savoury (meetha ya namkeen)? veg? any craving? budget? Use what she already said; never re-ask. After 3 questions total, stop asking and choose the best specific search.
  Vague examples: "something to eat", "kuch mangwa do", "kuch khana hai", "bhook lagi hai", "good food", "find good food", "kuch achha", "kuch meetha" (still vague: which sweet?), "snacks".
- search: the ask is specific enough to search a store: a concrete dish/product/type ("paneer butter masala", "amul milk", "masala dosa", "chocolate cake", "samosa", "dolo 650", "banana"). A brand is optional. A picked suggestion ("2", "pehla wala", or its name) makes it specific → search it. Fill query (just the product words, English/Hinglish item name, no filler), category (food = restaurant dishes; grocery = packaged/fresh groceries & household; pharmacy = medicines/OTC/health products), partner if she named a platform or it's obvious from context, restaurantName if she named a restaurant, intent = one line describing what she wants (e.g. "a savoury veg snack under ₹200, samosa").
- health_check: BEFORE a search, if the specific item conflicts with her health profile (below) and this conflict was NOT already raised in this chat, gently mention it in one line referring to her record ("aapke record mein diabetes likha hai"), offer 2–3 better-suited alternatives in "suggestions", and say she can still have the original. Examples: milk/paneer/curd with lactose intolerance → lactose-free milk, soy milk, almond milk; sweets/mithai/cake with diabetes → sugar-free version, a fruit, dark chocolate; salty/fried food with high BP → a lighter option; grapefruit with statins/BP meds; OTC painkillers with BP/blood thinners (pharmacy: a gentle flag only, never medical advice, suggest checking with her doctor). ONLY use conditions/medicines actually listed in the profile — if the profile has nothing relevant, never mention health. Allergies to an ingredient in the item are always worth one gentle line.
- After a health_check, her reply decides: she picks an alternative → search it with healthGuided=true and healthNote = "chose <alt> instead of <item> (<condition>)"; she insists on the original ("normal hi", "haan wahi", "koi baat nahi") → search the original with healthGuided=true and healthNote = "chose <item> despite <condition> note". Her choice wins — never argue or repeat the warning.
- restaurants: ONLY when she explicitly asks to see a list of restaurants ("restaurants dikhao", "which restaurants are open").
- cancel: she doesn't want to order anymore ("rehne do", "nahi chahiye", "cancel").
- not_order: the message is not about this order at all (small talk, health complaint, reminders, emergency).

Style for reply: her language (Hinglish if she writes Hinglish/Hindi; English if English), short, warm, one question, max one emoji, no lectures. Put numbered suggestions in the reply text as "1. …  2. …  3. …" on separate lines, and end with how to answer (e.g. "Number ya naam bata dijiye 🙂"). Never mention OTPs, prices you don't know, or store search results.`;

type Raw = {
    action?: string;
    reply?: string | null;
    suggestions?: string[];
    query?: string | null;
    category?: "food" | "grocery" | "pharmacy" | null;
    partner?: string | null;
    restaurantName?: string | null;
    intent?: string | null;
    healthGuided?: boolean;
    healthNote?: string | null;
};

export async function orderChatTurn(input: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    language?: string | null;
    routeHint: { category?: string | null; productQuery?: string | null; partners?: string[]; restaurantName?: string | null; addressNickname?: string | null; intent?: string };
    state: OrderChatState | null;
    /** A search came back empty — offer close alternatives instead of a chat question. */
    notFound?: { query: string; category: "food" | "grocery" | "pharmacy"; partner?: string | null };
}): Promise<OrderChatDecision> {
    const now = Date.now();
    const st: OrderChatState = input.state ?? { startedAt: now, updatedAt: now, turns: [], questions: 0 };
    if (input.routeHint.category === "food" || input.routeHint.category === "grocery" || input.routeHint.category === "pharmacy") st.category ??= input.routeHint.category;
    if (input.routeHint.partners?.length) st.partner = input.routeHint.partners[0];
    if (input.routeHint.addressNickname) st.addressNickname = input.routeHint.addressNickname;
    if (!input.notFound) st.turns.push({ who: "elder", text: input.text.slice(0, 300) });

    const profile = await loadHealthProfile(input.familyId, input.recipientUserId).catch(() => null);
    const prompt = [
        `Health profile (from Kavach):\n${profile ? healthProfileText(profile) : "(unavailable — do NOT assume any condition)"}`,
        `Known so far: category=${st.category || "?"} platform=${st.partner || "?"} questions_asked=${st.questions}${st.healthRaised ? ` health_note_already_raised_for="${st.healthRaised.item}" (${st.healthRaised.note})` : ""}${st.suggestions?.length ? ` last_suggestions=${st.suggestions.map((s, i) => `${i + 1}.${s}`).join(" ")}` : ""}${st.alternativesFor ? ` (those were alternatives because "${st.alternativesFor}" wasn't found)` : ""}`,
        `Router read of the latest message: intent=${input.routeHint.intent || "?"} product=${input.routeHint.productQuery || "none"} restaurant=${input.routeHint.restaurantName || "none"} language=${input.language || "?"}`,
        `Wider recent WhatsApp turns:\n${recentTurns(input.phone) || "(none)"}`,
        `This ordering chat:\n${st.turns.map((t) => `${t.who}: ${t.text}`).join("\n") || "(just started)"}`,
        input.notFound
            ? `SEARCH RESULT: nothing relevant found for "${input.notFound.query}" (${input.notFound.category}${input.notFound.partner ? ` on ${input.notFound.partner}` : ""}). Use action=ask: say kindly it isn't available and offer 2–3 CLOSELY related items that are likely available (e.g. no Theobroma chocolate cake → chocolate truffle pastry, brownie, chocolate cake from another bakery). Respect her health profile in what you suggest. If there is exactly ONE obvious close match (same product in another size/variant/brand, e.g. "amul taaza 1 litre" → "amul taaza 500 ml"), use action=search with that query instead of asking.`
            : `Latest message: ${input.text.slice(0, 400)}`,
    ].join("\n\n");

    const raw = await vertexGenerateText({
        model: process.env.VERTEX_ORDER_CHAT_MODEL?.trim() || vertexFlashModel(),
        system: SYSTEM,
        responseSchema: SCHEMA,
        prompt,
        timeoutMs: 9000,
        maxOutputTokens: 2048,
        thinkingLevel: "low",
    }).catch(() => null);
    const p = parseJsonLoose<Raw>(raw);
    if (!p?.action) {
        // Model unavailable: a specific product from the router still searches; vague asks get one plain question.
        if (input.routeHint.productQuery && !input.notFound && !/^(something|anything|kuch|food|khana)\b/i.test(input.routeHint.productQuery)) {
            await saveOrderChat(input.phone, null);
            const category = (st.category as "food" | "grocery" | "pharmacy") || "grocery";
            return { action: "search", query: input.routeHint.productQuery, category, partner: st.partner || null, restaurantName: input.routeHint.restaurantName || null, addressNickname: st.addressNickname || null, intent: input.routeHint.productQuery };
        }
        st.updatedAt = now;
        await saveOrderChat(input.phone, st);
        return { action: "reply", text: input.notFound ? `"${input.notFound.query}" nahi mila 🙏 Kuch aur batayein?` : "Zaroor 🙂 Kya khane ka mann hai — koi dish ya item ka naam bata dijiye?" };
    }

    const suggestions = (p.suggestions || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
    const log = (title: string, detail: string, data: Record<string, unknown> = {}) =>
        void logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            kind: "order_step",
            title,
            detail: detail.slice(0, 400),
            data: { source: "order_chat", ...data },
        });

    switch (p.action) {
        case "ask":
        case "health_check": {
            const text = (p.reply || "").trim() || "Kya mangwaun aapke liye? 🙂";
            st.questions += 1;
            st.suggestions = suggestions;
            st.alternativesFor = input.notFound ? input.notFound.query : null;
            if (input.notFound) st.category = input.notFound.category;
            if (p.action === "health_check") {
                st.healthRaised = { item: p.query || input.routeHint.productQuery || input.text.slice(0, 60), note: p.healthNote || text.slice(0, 160) };
                log(`Health note raised: ${st.healthRaised.item}`, text, { health: true, suggestions });
            }
            st.turns.push({ who: "saheli", text: text.slice(0, 400) });
            st.updatedAt = now;
            await saveOrderChat(input.phone, st);
            return { action: "reply", text };
        }
        case "search": {
            const query = (p.query || input.routeHint.productQuery || "").trim().slice(0, 80);
            if (!query) {
                st.updatedAt = now;
                await saveOrderChat(input.phone, st);
                return { action: "reply", text: "Kaunsi cheez mangwaun? Naam bata dijiye 🙂" };
            }
            const category = p.category || (st.category as "food" | "grocery" | "pharmacy") || "grocery";
            if (p.healthGuided && p.healthNote) {
                void logActivity({
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                    actorUserId: input.actorUserId,
                    kind: "order_step",
                    title: `Health-guided choice: ${query}`,
                    detail: p.healthNote.slice(0, 300),
                    data: { source: "order_chat", intent: "health_guided_choice", query },
                });
            }
            lastIntent.set(input.phone, { intent: (p.intent || query).slice(0, 200), at: now });
            await saveOrderChat(input.phone, null);
            return {
                action: "search",
                query,
                category,
                partner: p.partner || st.partner || null,
                restaurantName: p.restaurantName || input.routeHint.restaurantName || null,
                addressNickname: st.addressNickname || null,
                intent: p.intent || query,
            };
        }
        case "restaurants":
            await saveOrderChat(input.phone, null);
            return { action: "restaurants", addressNickname: st.addressNickname || null };
        case "cancel":
            await saveOrderChat(input.phone, null);
            return { action: "reply", text: input.language === "en" ? "Okay, no problem 🙂 Tell me whenever you'd like something." : "Theek hai, koi baat nahi 🙂 Jab mann ho bata dijiye." };
        default:
            // Unrelated message: keep the ordering chat for when she comes back to it.
            return { action: "pass" };
    }
}
