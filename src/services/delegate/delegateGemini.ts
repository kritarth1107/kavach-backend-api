/**
 * Gemini calls for Saheli-as-delegate (follow-through, why memory, resume, approvals).
 * All understanding of what people said is the model's job; code only keeps the guardrails.
 * Model: the router's Gemini 3.5 Flash (fast; structured output).
 */
import { parseJsonLoose, vertexFlashModel, vertexGenerateText } from "../../clients/vertexGemini.client";

const model = () => process.env.VERTEX_DELEGATE_MODEL?.trim() || process.env.VERTEX_ROUTER_MODEL?.trim() || vertexFlashModel();

export const PERSONA = `You are Saheli, a WhatsApp companion for an Indian family. With an elder you talk like their own caring son or daughter: warm, respectful ("aap"), simple everyday words. With a caregiver you are a warm, practical helper.
Style: 1–2 short lines, at most ONE tasteful emoji. Reply in the SAME language and script the person uses (Hindi in Devanagari → Devanagari; Hinglish in Latin letters → Hinglish; English → English). With a caregiver: first name or neutral, never "Maa"/"Papa"/"beta". Address an elder the way their own child would — follow the form the recent chat uses ("Maa", "Amma", "Papa", "Babuji"); if none, "Maa" for a woman / "Papa" for a man; never "Aunty", "Uncle", "Ma'am", "Sir" or their first name. Never say "Anything else I can help with?", never list menus, never mention being an AI.
What you can really do: search and order again (groceries / food / medicines on the family's allowed apps — always cash on delivery and only after she types *confirm*), book rides, remind, and tell her family on the dashboard. You CANNOT track a courier live, call a store, or process a refund yourself — never promise that.`;

async function call<T>(system: string, prompt: string, schema: Record<string, unknown>, timeoutMs = 9000): Promise<T | null> {
    const raw = await vertexGenerateText({
        model: model(),
        system,
        prompt,
        responseSchema: schema,
        timeoutMs,
        maxOutputTokens: 2048,
        thinkingLevel: process.env.VERTEX_DELEGATE_THINKING?.trim() || "low",
    }).catch(() => null);
    return parseJsonLoose<T>(raw);
}

// ── Order context + WHY at placement ───────────────────────────────────────────────────────────
export type OrderContext = {
    item: string | null;
    partner: string | null;
    category: "grocery" | "food" | "pharmacy" | "ride" | "other" | null;
    isMedicine: boolean;
    etaMinutes: number | null;
    etaText: string | null;
    why: string | null;
    importance: "high" | "normal";
    language: string | null;
};

const LANGUAGE_RULE = `- language: the language the PERSON (not Saheli) writes in: "hinglish" (Hindi in Latin letters), "hindi" (Devanagari), "english", or another language name in lowercase. null if they wrote nothing.`;
const cleanLang = (v: unknown) => (typeof v === "string" && /^[a-z ]{3,20}$/.test(v.trim().toLowerCase()) ? v.trim().toLowerCase() : null);

export async function extractOrderContext(input: { orderLog: string; openTask?: string; recentChat: string; knownWhy?: string }): Promise<OrderContext | null> {
    const p = await call<Partial<OrderContext>>(
        `You read one placed order (from Saheli's activity log) plus the chat that led to it, and extract structured facts. Never invent: null when unknown.
- item: the product(s) in plain words, short ("Telma 40 tablets", "Amul Taaza milk 1L"), no prices.
- partner: store key (instamart, zepto, blinkit, swiggy, zomato, apollo, pharmeasy, tata_1mg, uber) or null.
- isMedicine: true for medicines/tablets/syrups/insulin (not vitamins-only snacks).
- etaMinutes / etaText: only if the log or chat states a delivery time ("arriving in 25 mins", "delivery by tomorrow").
- why: the REASON / CONTEXT in one short line of plain English (translate Hindi/Hinglish to English; no names or pronouns — e.g. 'bad headache since morning', 'ran out of BP medicine; doctor said continue'), from what the person said ("ran out of BP medicine; doctor said continue", "grandchildren visiting on Sunday", "fever since yesterday"). Only reasons the PERSON (User lines) actually said or clearly implied — never Saheli's own words or guesses; null if none. If an earlier known reason is given and nothing new was said, reuse it.
- importance: high for regular/critical medicines, health needs, or anything she said is urgent; else normal.
${LANGUAGE_RULE}`,
        [`Order log:\n${input.orderLog.slice(0, 1200)}`, input.openTask ? `What she was doing: ${input.openTask.slice(0, 400)}` : "", input.knownWhy ? `Known earlier reason: ${input.knownWhy}` : "", `Recent chat:\n${input.recentChat.slice(0, 2500) || "(none)"}`].filter(Boolean).join("\n\n"),
        {
            type: "OBJECT",
            properties: {
                item: { type: "STRING", nullable: true },
                partner: { type: "STRING", nullable: true },
                category: { type: "STRING", enum: ["grocery", "food", "pharmacy", "ride", "other"], nullable: true },
                isMedicine: { type: "BOOLEAN" },
                etaMinutes: { type: "INTEGER", nullable: true },
                etaText: { type: "STRING", nullable: true },
                why: { type: "STRING", nullable: true },
                importance: { type: "STRING", enum: ["high", "normal"] },
                language: { type: "STRING", nullable: true },
            },
            required: ["isMedicine", "importance"],
        },
    );
    if (!p) return null;
    return {
        item: p.item?.trim() || null,
        partner: p.partner?.trim().toLowerCase() || null,
        category: p.category ?? null,
        isMedicine: Boolean(p.isMedicine),
        etaMinutes: typeof p.etaMinutes === "number" && p.etaMinutes > 0 && p.etaMinutes < 7 * 24 * 60 ? Math.round(p.etaMinutes) : null,
        etaText: p.etaText?.trim() || null,
        why: p.why?.trim().slice(0, 300) || null,
        importance: p.importance === "high" ? "high" : "normal",
        language: cleanLang(p.language),
    };
}

/** The reason behind an important request still in progress (open task). */
export async function extractWhy(input: { item: string; recentChat: string }): Promise<{ why: string | null; importance: "high" | "normal"; isMedicine: boolean; language: string | null } | null> {
    const p = await call<{ why?: string | null; importance?: string; isMedicine?: boolean; language?: string | null }>(
        `From the chat, extract WHY the person wants this item: one short plain-English line (translate Hindi/Hinglish to English; no names or pronouns — e.g. 'bad headache since morning', 'ran out of BP medicine; doctor said continue') of the reason/context the PERSON (User lines) actually said or clearly implied ("ran out of BP medicine; doctor said continue", "guests coming tonight") — never Saheli's own words or guesses. null if the person gave no reason. importance=high for regular/critical medicines or health needs or stated urgency. isMedicine=true for medicines.\n${LANGUAGE_RULE}`,
        `Item: ${input.item}\n\nRecent chat:\n${input.recentChat.slice(0, 2500) || "(none)"}`,
        {
            type: "OBJECT",
            properties: { why: { type: "STRING", nullable: true }, importance: { type: "STRING", enum: ["high", "normal"] }, isMedicine: { type: "BOOLEAN" }, language: { type: "STRING", nullable: true } },
            required: ["importance", "isMedicine"],
        },
        7000,
    );
    if (!p) return null;
    return { why: p.why?.trim().slice(0, 300) || null, importance: p.importance === "high" ? "high" : "normal", isMedicine: Boolean(p.isMedicine), language: cleanLang(p.language) };
}

// ── One interpretation step for a returning / answering person ────────────────────────────────
export const FOLLOWUP_OUTCOMES = ["arrived", "not_arrived", "wrong_item", "damaged", "started", "not_started", "doctor_stopped", "wait_more", "reached", "ride_issue", "other"] as const;
export type FollowupOutcome = (typeof FOLLOWUP_OUTCOMES)[number];
export type DelegateDecision = {
    target: "followup" | "resume" | "approval" | "none";
    taskId: string | null;
    outcome: FollowupOutcome | null;
    resumeAction: "offer" | "resume" | "decline" | "later" | null;
    approvalDecision: "approve" | "deny" | null;
    wantsReorder: boolean;
    note: string | null;
    reply: string | null;
};

export async function interpretDelegateTurn(input: {
    role: "elder" | "caregiver";
    name?: string;
    message: string;
    recentChat: string;
    followups: string[];
    openTasks: string[];
    approvals: string[];
    now: string;
}): Promise<DelegateDecision | null> {
    const p = await call<Partial<DelegateDecision>>(
        `${PERSONA}

You are Saheli's follow-through step. Saheli is carrying unfinished things for this person (listed below). Decide whether THIS message is about one of them, and if so write Saheli's reply. Output JSON only.

target:
- "followup": the message answers one of the PENDING FOLLOW-UP QUESTIONS (e.g. "haan aa gayi", "abhi tak nahi aayi", "galat dawai aa gayi", "packet phata hua tha", "shuru kar di", "abhi nahi li", "doctor ne band kar di", "pahunch gayi"). Set outcome:
  arrived | not_arrived | wrong_item | damaged | started | not_started | doctor_stopped | wait_more (she says it's on the way / will come later; or, for stage=started, she will start it later today/tonight) | reached (ride) | ride_issue | other.
  wantsReorder=true only if she asks to order it again in this message.
- "resume": about an UNFINISHED TASK. resumeAction:
  "offer" — a greeting / return / vague opener ("hi", "namaste", "main aa gayi", "suno") while a task has NOT been offered yet (offered=no): reply = ONE warm line naming what was left and when, asking if you should finish it (e.g. "Namaste 🙂 Kal hum Dolo 650 order kar rahe the — poora kar doon?"). If every task was already offered, use target "none" for greetings.
  "resume" — she agrees to continue (after an offer: "haan", "kar do", "theek hai") or refers to the unfinished thing ("haan wo kar do", "wo dawai wala order", "Dolo ka kya hua?", "wo cab book kar do"): reply = a very short lead-in ("Theek hai Maa 👍 abhi dekhti hoon") — you search and show her the item and price first, so never say "order kar deti/karti hoon".
  "decline" — leave it / not needed / already got it: reply = short warm acknowledgement.
  "later" — not now / baad mein: reply = short "theek hai, baad mein" line.
- "approval": (caregiver only) approving or refusing a PENDING APPROVAL ("haan mangwa do", "approve", "theek hai", "nahi", "mat karo"). approvalDecision approve|deny; reply = short confirmation to the caregiver: on approve, you'll tell her now and she confirms the order herself (nothing is ordered until she types *confirm*, cash on delivery) — never say you are ordering it right away; on deny, you'll tell her gently.
- "none": anything else — a NEW different request ("doodh mangwa do" while the task was Dolo), symptoms, emergencies, unrelated chat, or unsure. reply=null.

Replies for follow-up outcomes (short, like her own child; use the WHY when it helps):
- arrived + medicine + stage=delivery → glad, and ask if she has started taking it. arrived (other) → glad, one line.
- not_arrived → empathise; offer to order it again right now (she just has to say haan) or to wait a little and you will ask again.
- wrong_item / damaged → sorry; ask her to keep it aside and offer to order the right one now; say you've told the family on the dashboard.
- started → warm encouragement. not_started → gentle, no lecture; if the WHY says the doctor asked to continue, remind softly; ask if anything is stopping her.
- doctor_stopped → acknowledge simply; you have noted it and won't suggest it again.
- wait_more → fine, you'll check again later. reached → glad she reached safely. ride_issue → sorry, ask what happened.
note: one short plain-English line of what she said (for the family dashboard), or null.
taskId: the id of the item you picked (exactly as listed), else null.`,
        [
            `Now (IST): ${input.now}`,
            `Person: ${input.role}${input.name ? ` (${input.name})` : ""}`,
            input.followups.length ? `PENDING FOLLOW-UP QUESTIONS:\n${input.followups.join("\n")}` : "PENDING FOLLOW-UP QUESTIONS: none",
            input.openTasks.length ? `UNFINISHED TASKS:\n${input.openTasks.join("\n")}` : "UNFINISHED TASKS: none",
            input.approvals.length ? `PENDING APPROVALS:\n${input.approvals.join("\n")}` : "",
            `Recent chat:\n${input.recentChat || "(none)"}`,
            `Message: ${input.message.slice(0, 600)}`,
        ]
            .filter(Boolean)
            .join("\n\n"),
        {
            type: "OBJECT",
            properties: {
                target: { type: "STRING", enum: ["followup", "resume", "approval", "none"] },
                taskId: { type: "STRING", nullable: true },
                outcome: { type: "STRING", enum: [...FOLLOWUP_OUTCOMES], nullable: true },
                resumeAction: { type: "STRING", enum: ["offer", "resume", "decline", "later"], nullable: true },
                approvalDecision: { type: "STRING", enum: ["approve", "deny"], nullable: true },
                wantsReorder: { type: "BOOLEAN" },
                note: { type: "STRING", nullable: true },
                reply: { type: "STRING", nullable: true },
            },
            required: ["target", "wantsReorder"],
        },
        9000,
    );
    if (!p || !p.target) return null;
    return {
        target: (["followup", "resume", "approval", "none"] as const).includes(p.target as "none") ? (p.target as DelegateDecision["target"]) : "none",
        taskId: p.taskId?.trim() || null,
        outcome: (FOLLOWUP_OUTCOMES as readonly string[]).includes(String(p.outcome)) ? (p.outcome as FollowupOutcome) : null,
        resumeAction: (["offer", "resume", "decline", "later"] as const).includes(p.resumeAction as "offer") ? (p.resumeAction as DelegateDecision["resumeAction"]) : null,
        approvalDecision: p.approvalDecision === "approve" || p.approvalDecision === "deny" ? p.approvalDecision : null,
        wantsReorder: Boolean(p.wantsReorder),
        note: p.note?.trim().slice(0, 300) || null,
        reply: p.reply?.trim().slice(0, 600) || null,
    };
}

// ── Proactive lines (follow-up question, resume nudge, approval result) ───────────────────────
export async function writeProactiveLine(input: {
    purpose: "delivery_check" | "med_start_check" | "ride_check" | "resume_nudge" | "approval_approved" | "approval_denied" | "outside_permission" | "why_stopped_check" | "store_off_offer";
    facts: string;
    language?: string | null;
    name?: string;
    previous?: string[];
    recentChat?: string;
}): Promise<string | null> {
    const GOALS: Record<string, string> = {
        delivery_check: "Ask, like her own child, whether the order arrived (name the item). One short question.",
        med_start_check: "Ask gently whether she has started taking the medicine (name it). One short question.",
        ride_check: "Ask whether she reached safely. One short question.",
        resume_nudge: "Gently mention the unfinished task (name it and when) and ask if you should pick it up again (show it again). Never offer to confirm or place it yourself — she always confirms. One short question; no pressure.",
        approval_approved: "Tell her the caregiver said yes, naming them (e.g. 'Rahul ne haan bol diya 🙂'), name what she asked for, and ask if you should go ahead now.",
        approval_denied: "Tell her softly that the caregiver (name them) said not right now for this item, and suggest she talks to them. No blame.",
        outside_permission: "Tell her kindly that for this you first check with the caregiver (named), that you've asked them on the family dashboard, and you'll tell her as soon as they reply. No jargon like 'permission settings'.",
        why_stopped_check: "Remind her gently that (per what she told you) the doctor stopped this medicine, and ask if she still wants you to order it.",
        store_off_offer: "Tell her kindly that this app is switched off by her family, and offer the allowed alternative app for the same item (she just says haan).",
    };
    const p = await call<{ text?: string }>(
        `${PERSONA}\n\nWrite ONE WhatsApp message. Goal: ${GOALS[input.purpose]}${input.previous?.length ? "\nIt continues an earlier unanswered message of yours (quoted) — don't repeat it word for word; keep it light." : ""}\nPreferred language: ${input.language || "match the recent chat; default Hinglish in Latin letters"}. Output JSON {"text": "..."}.`,
        [input.name ? `Her/his name: ${input.name}` : "", `Facts: ${input.facts.slice(0, 800)}`, input.previous?.length ? `Earlier unanswered: ${input.previous.join(" | ").slice(0, 500)}` : "", input.recentChat ? `Recent chat:\n${input.recentChat.slice(0, 1200)}` : ""].filter(Boolean).join("\n"),
        { type: "OBJECT", properties: { text: { type: "STRING" } }, required: ["text"] },
        7000,
    );
    const t = p?.text?.trim();
    return t ? t.slice(0, 500) : null;
}

// ── New information connecting to a remembered WHY ─────────────────────────────────────────────
export type WhyChange = { whyId: string | null; change: "stopped" | "dose_changed" | "continue" | "price_up" | "out_of_stock" | "note" | "none"; note: string | null; ack: string | null };

export async function connectWhy(input: { message: string; role: "elder" | "caregiver"; whys: Array<{ id: string; subject: string; reason: string; status: string }>; recentChat: string }): Promise<WhyChange | null> {
    const p = await call<Partial<WhyChange>>(
        `${PERSONA}

Saheli remembers WHY items matter (listed). Decide if THIS message gives NEW information that changes one of them:
- stopped: a doctor/family stopped or replaced it ("doctor ne Telma band kar di", "ab Telma nahi leni").
- dose_changed: dose/strength/timing changed. continue: doctor said keep taking it (confirms).
- price_up: she says it became expensive. out_of_stock: she says it's not available anywhere.
- note: other genuinely relevant new context about that item. none: no new info (just mentioning it, ordering it, asking about it).
If not none: note = one short plain-English line for the family ("Doctor stopped Telma 40 on 27 Sep, per Amma"); ack = Saheli's short warm acknowledgement in her language (you've noted it; for stopped: you won't suggest it again). Output JSON.`,
        `Remembered:\n${input.whys.map((w) => `[${w.id}] ${w.subject} — why: ${w.reason} (status ${w.status})`).join("\n")}\n\nSender: ${input.role}\nRecent chat:\n${input.recentChat.slice(0, 1000) || "(none)"}\n\nMessage: ${input.message.slice(0, 500)}`,
        {
            type: "OBJECT",
            properties: {
                whyId: { type: "STRING", nullable: true },
                change: { type: "STRING", enum: ["stopped", "dose_changed", "continue", "price_up", "out_of_stock", "note", "none"] },
                note: { type: "STRING", nullable: true },
                ack: { type: "STRING", nullable: true },
            },
            required: ["change"],
        },
        7000,
    );
    if (!p?.change) return null;
    return { whyId: p.whyId?.trim() || null, change: p.change as WhyChange["change"], note: p.note?.trim().slice(0, 300) || null, ack: p.ack?.trim().slice(0, 400) || null };
}
