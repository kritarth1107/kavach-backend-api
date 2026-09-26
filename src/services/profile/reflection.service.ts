/**
 * Nightly reflection (per elder): read one IST day of her timeline + the current profile (and
 * the ai-engine memory profile written by the "dream" job), ask Gemini what was learned, and
 * update: care-first facts (reinforce / decay / never-relearn rejected), tomorrow's care actions,
 * the wellbeing day, and watch-only baseline deviations. Nothing here sends WhatsApp, orders or
 * books anything — care actions are suggestions woven into nudges / shown on the dashboard.
 */
import ActivityLog from "../../models/activityLog.model";
import ElderProfile, { type CareAction, type ProfileFact } from "../../models/elderProfile.model";
import ElderWellbeingDay from "../../models/elderWellbeingDay.model";
import { parseJsonLoose, vertexFlashModel, vertexGenerateText, vertexProModel } from "../../clients/vertexGemini.client";
import { istDayKey } from "../activityLog.service";
import { applyReflection, detectDeviations, isActive, isUnsafeFact, newActionId, type ReflectionOp } from "./profileCore";
import { applyRetention, forgetProfileCache, type Who } from "./elderProfile.service";

const SYSTEM = `You are Saheli's nightly reflection for ONE elderly person in India. Saheli is her caring companion who talks to her like her own child, keeps her daily routine (medicines, meals, walks, sleep, appointments) and helps with whatever she needs. Read the day's timeline and the current profile, then decide what Saheli should REMEMBER and what she should DO tomorrow.

CARE FIRST. Learn in this priority: health concerns & symptoms she mentions; pain / sleep / appetite / energy; mood & loneliness; medicine adherence and side effects she reports; routine (walks, meals, sleep/wake, prayer, TV); family & relationships (names, who visits, how she likes to be addressed); memory/cognition cues (observations only, never a diagnosis); what comforts her and topics she enjoys; what works in communication (time of day she replies, tone, language); and only last, food/shopping preferences.

Facts ("ops"):
- op=add for something new; op=reinforce (with the existing id) when today repeats/confirms a known fact; op=revise (with id) when today clearly updates it.
- Only what the timeline supports. Quote her words briefly in "evidence". Never diagnose, never interpret labs, never invent.
- Short third-person facts ("Knee pain in the mornings; worse after climbing stairs", "Daughter Meena calls on Sundays", "Enjoys old Kishore Kumar songs", "Usually replies to reminders after 9 am").
- NEVER output anything about payment methods, skipping confirmations/checks, disabling alerts, ordering without asking, tobacco/alcohol, or addresses — safety rules are fixed and not part of the profile.
- confidence: 0.3 (single passing mention) … 0.8 (clear, repeated today).

Care actions for tomorrow (0–4, most useful first):
- follow_up: gently ask about something she mentioned (knee pain, a bad night, a family visit).
- reminder: a gentle routine reminder grounded in what she said (water if she felt tired, her evening walk).
- company: if she sounded lonely/low, talk about a topic she enjoys.
- offer: an unmet need phrased as an OFFER she can accept (medicine running out → "offer to reorder when she's ready"; needs a ride to the clinic → "offer to book a cab if she wants"). Never state that anything will be ordered or booked.
- caregiver_suggestion (audience caregiver): something the family may want to do (e.g. "She mentioned knee pain 3 days running — consider a doctor visit").
Red-flag symptoms are handled elsewhere immediately; do not downplay them.

Unusual activity (0–3, only if the timeline shows it; judge against the profile / her usual pattern): same item ordered repeatedly in a short time (possible forgetting), unusually large quantity or spend, risky medicines in bulk (sleeping pills, painkillers), orders at odd hours vs her routine, sudden change in what she orders (stopped food / medicines), confusion or memory lapses (repeating questions, forgetting she ordered, wrong names/dates), marked mood drop, not taking medicines several days, possible scam/fraud (someone asking her for OTP / money / bank details). confidence 0.9 only when clearly shown; 0.5–0.7 when it could be innocent. Write "text" for the caregiver: calm, specific, what Saheli saw + a suggestion, max 2 sentences.

Day signals: mood 1–5 (null if unclear), moodWord, lonely, and whether she mentioned pain / sleep / appetite / activity (walk, exercise) / tiredness.
Tuning (only if clearly shown): addressAs (how she likes to be called), preferredNudgeHour (6–11, hour she actually replies in the morning), maxOptions (1–3 if she gets confused by choices), language (hi|en|hinglish).

Reply ONLY JSON:
{"ops":[{"op":"add|reinforce|revise","id":null,"category":"health|wellbeing|mood|medicines|routine|people|cognition|comfort|communication|preferences","text":"…","confidence":0.6,"evidence":"…"}],
 "careActions":[{"kind":"follow_up|reminder|company|offer|caregiver_suggestion","text":"…","say":"one short line Saheli can send her, in her language, warm like her own child (null for caregiver_suggestion)","why":"…","audience":"elder|caregiver"}],
 "unusual":[{"category":"repeat_order|bulk_quantity|large_spend|risky_meds|odd_hours|order_change|confusion|mood_drop|meds_missed|scam|other","confidence":0.6,"text":"…","evidence":"…"}],
 "day":{"mood":3,"moodWord":"…","lonely":false,"mentions":{"pain":false,"sleep":false,"appetite":false,"activity":false,"tired":false}},
 "tuning":{"addressAs":null,"preferredNudgeHour":null,"maxOptions":null,"language":null}}`;

function istTime(d: Date): string {
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }).format(d);
}

type Raw = {
    ops?: ReflectionOp[];
    unusual?: Array<{ category?: string; confidence?: number; text?: string; evidence?: string }>;
    careActions?: Array<{ kind?: string; text?: string; say?: string | null; why?: string; audience?: string }>;
    day?: { mood?: number | null; moodWord?: string | null; lonely?: boolean; mentions?: Record<string, boolean> };
    tuning?: { addressAs?: string | null; preferredNudgeHour?: number | null; maxOptions?: number | null; language?: string | null };
};

async function memoryProfileMd(w: Who): Promise<string> {
    try {
        const { ensureAiContext } = await import("../aiTenant.service");
        const { aiGetMemoryProfile } = await import("../../clients/aiEngine.client");
        const ctx = await ensureAiContext(w.familyId, w.recipientUserId, "Care recipient");
        const r = await Promise.race([aiGetMemoryProfile({ aiFamilyId: ctx.aiFamilyId, aiElderId: ctx.aiElderId }), new Promise<null>((res) => setTimeout(() => res(null), 6000))]);
        return (r?.profile_md || "").slice(0, 2500);
    } catch {
        return "";
    }
}

/** Day metrics straight from the logs (counts; Gemini adds mood / mentions). */
async function dayCounts(w: Who, dayKey: string, rows: Array<{ kind: string; createdAt?: Date; data?: Record<string, unknown>; title?: string }>) {
    const at = (r: { createdAt?: Date }) => new Date(r.createdAt as Date).getTime();
    const ins = rows.filter((r) => r.kind === "message_in" || r.kind === "voice_note");
    const nudges = rows.filter((r) => r.kind === "nudge");
    let replied = 0;
    const lat: number[] = [];
    for (const n of nudges) {
        const reply = ins.find((m) => at(m) > at(n) && at(m) - at(n) < 3 * 3600_000);
        if (reply) {
            replied++;
            lat.push((at(reply) - at(n)) / 60_000);
        }
    }
    let medsDone = 0, medsMissed = 0;
    try {
        const { getScheduleDayStatuses } = await import("../careScheduleCompletion.service");
        const day = await getScheduleDayStatuses(w.familyId, w.recipientUserId, w.recipientUserId, dayKey);
        medsDone = day.items.filter((i) => i.status === "completed").length;
        medsMissed = day.items.filter((i) => i.status === "missed").length;
    } catch {
        /* no schedule */
    }
    const cards = rows.filter((r) => r.kind === "order_confirm_card");
    const placed = rows.filter((r) => r.kind === "order_placed");
    // "first card" = an order placed after exactly one confirm card that day (no re-search / swap).
    const firstCardOrders = placed.length && cards.length <= placed.length ? placed.length : placed.filter((_, i) => i === 0 && cards.length === 1).length;
    const corrections = rows.filter((r) => r.kind === "order_cancelled" || r.kind === "order_interrupt").length;
    return {
        messagesIn: rows.filter((r) => r.kind === "message_in").length,
        voiceNotes: rows.filter((r) => r.kind === "voice_note").length,
        nudgesSent: nudges.length,
        nudgesReplied: replied,
        nudgeReplyMinutes: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
        medsDone,
        medsMissed,
        orders: placed.length,
        rides: rows.filter((r) => r.kind === "ride").length,
        cards: cards.length,
        firstCardOrders,
        corrections,
    };
}

export async function reflectElderDay(w: Who, dayKey = istDayKey(new Date(Date.now() - 86_400_000)), opts: { model?: string } = {}) {
    const rows = await ActivityLog.find({ familyId: w.familyId, recipientUserId: w.recipientUserId, dayKey }).sort({ createdAt: 1 }).limit(1500).lean();
    const doc =
        (await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId })) ||
        new ElderProfile({ ...w, facts: [], careActions: [], deviations: [], tuning: {}, retentionDays: 365 });
    const counts = await dayCounts(w, dayKey, rows as never);
    const lines = rows
        .filter((r) => r.kind !== "diag" && r.kind !== "order_step")
        .map((r) => `${istTime(new Date(r.createdAt as Date))} [${r.kind}] ${r.title}${r.detail ? ` — ${String(r.detail).replace(/\s+/g, " ").slice(0, 280)}` : ""}`)
        .slice(-350);
    let declines = "";
    try {
        const { loadUsuals } = await import("../commerceAutomation/usuals/usuals.service");
        const u = await loadUsuals(w);
        declines = (u?.rejections || []).filter((r) => istDayKey(new Date(r.at)) === dayKey).map((r) => `declined "${r.item}": ${r.reason}`).join("; ");
    } catch {
        /* none */
    }
    const current = (doc.facts || []).filter((f) => f.status !== "faded").map((f) => `${f.id} [${f.category}] (${f.status}${f.status === "learned" ? ` ${f.confidence}` : ""}) ${f.text}`);
    const memory = await memoryProfileMd(w);
    let ops: ReflectionOp[] = [];
    let actions: CareAction[] = [];
    let day: Raw["day"] = {};
    let tuning: Raw["tuning"] = {};
    let model = "none";
    let unusual: Raw["unusual"] = [];
    if (lines.length) {
        const prompt = [
            `Day: ${dayKey} (IST)`,
            `Medicines/schedule today: ${counts.medsDone} done, ${counts.medsMissed} missed. Nudges: ${counts.nudgesSent} sent, ${counts.nudgesReplied} replied.`,
            declines ? `Declined options today: ${declines}` : "",
            `Current profile facts (id [category] (status) text). Caregiver-confirmed/edited facts are fixed; REJECTED ones must never be re-learned:\n${current.join("\n") || "(none yet)"}`,
            memory ? `Long-term memory notes (from Saheli's memory):\n${memory}` : "",
            `Timeline:\n${lines.join("\n")}`,
        ]
            .filter(Boolean)
            .join("\n\n");
        const tryModel = async (m: string) => {
            const raw = await vertexGenerateText({ model: m, system: SYSTEM, json: true, prompt, timeoutMs: 90_000, maxOutputTokens: 4096, temperature: 0.2 });
            return parseJsonLoose<Raw>(raw);
        };
        const pro = opts.model || process.env.VERTEX_REFLECTION_MODEL?.trim() || vertexProModel();
        let parsed = await tryModel(pro).catch(() => null);
        model = pro;
        if (!parsed?.ops && !parsed?.day) {
            model = vertexFlashModel();
            parsed = await tryModel(model).catch(() => null);
        }
        if (parsed) {
            ops = Array.isArray(parsed.ops) ? parsed.ops : [];
            day = parsed.day || {};
            tuning = parsed.tuning || {};
            unusual = Array.isArray(parsed.unusual) ? parsed.unusual.slice(0, 3) : [];
            const next = istDayKey(new Date(new Date(`${dayKey}T12:00:00+05:30`).getTime() + 86_400_000));
            actions = (parsed.careActions || [])
                .filter((a) => a.text && !isUnsafeFact(a.text) && ["follow_up", "reminder", "company", "offer", "caregiver_suggestion"].includes(String(a.kind)))
                // Offers stay offers: never "I ordered / booked".
                .filter((a) => !/\b(will order|will book|auto[- ]?(order|book|place))\b/i.test(`${a.text} ${a.say || ""}`) && !/\b(i (have )?(ordered|booked|placed)|order kar diya|book kar di|mangwa diya|mangwa di)\b/i.test(String(a.say || "")))
                .slice(0, 4)
                .map((a) => ({
                    id: newActionId(),
                    dayKey: next,
                    kind: a.kind as CareAction["kind"],
                    text: String(a.text).slice(0, 200),
                    say: a.say && a.kind !== "caregiver_suggestion" && !isUnsafeFact(String(a.say)) ? String(a.say).slice(0, 220) : undefined,
                    why: String(a.why || "").slice(0, 200),
                    audience: a.kind === "caregiver_suggestion" || a.audience === "caregiver" ? "caregiver" : "elder",
                    status: "planned" as const,
                }));
        } else model = "failed";
    }
    const merged = applyReflection((doc.facts || []) as ProfileFact[], ops, { now: new Date(), dayKey });
    doc.facts = merged.facts;
    doc.careActions = [...(doc.careActions || []).filter((a) => !actions.length || a.dayKey !== actions[0]!.dayKey), ...actions].slice(-40);
    const t = { ...(doc.tuning || {}) };
    if (tuning?.addressAs && !isUnsafeFact(tuning.addressAs)) t.addressAs = String(tuning.addressAs).slice(0, 30);
    if (tuning?.preferredNudgeHour && tuning.preferredNudgeHour >= 6 && tuning.preferredNudgeHour <= 11) t.preferredNudgeHour = Math.round(tuning.preferredNudgeHour);
    if (tuning?.maxOptions && tuning.maxOptions >= 1 && tuning.maxOptions <= 3) t.maxOptions = Math.round(tuning.maxOptions);
    if (tuning?.language && ["hi", "en", "hinglish"].includes(tuning.language)) t.language = tuning.language;
    doc.tuning = t;
    doc.markModified("tuning");
    // Wellbeing day + watch-only deviations (dashboard only; no caregiver WhatsApp).
    const mentions = { pain: false, sleep: false, appetite: false, activity: false, tired: false, ...(day?.mentions || {}) };
    await ElderWellbeingDay.updateOne(
        { familyId: w.familyId, recipientUserId: w.recipientUserId, dayKey },
        {
            $set: {
                ...counts,
                mood: typeof day?.mood === "number" && day.mood >= 1 && day.mood <= 5 ? day.mood : null,
                moodWord: day?.moodWord ? String(day.moodWord).slice(0, 30) : null,
                lonely: Boolean(day?.lonely),
                mentions,
            },
        },
        { upsert: true },
    );
    const days = await ElderWellbeingDay.find({ familyId: w.familyId, recipientUserId: w.recipientUserId, dayKey: { $lte: dayKey } }).sort({ dayKey: 1 }).limit(40).lean();
    const devs = detectDeviations(days as never);
    const known = new Set((doc.deviations || []).map((d) => `${d.dayKey}|${d.metric}`));
    for (const d of devs) {
        if (known.has(`${d.dayKey}|${d.metric}`)) continue;
        doc.deviations = [...(doc.deviations || []), { ...d, id: newActionId(), at: new Date() }].slice(-60);
        const { logActivity } = await import("../activityLog.service");
        void logActivity({ familyId: w.familyId, recipientUserId: w.recipientUserId, kind: "mood", severity: "warn", title: `Watch: ${d.text}`, data: { source: "baseline", metric: d.metric, watchOnly: true } });
    }
    // Unusual activity: baseline deviations (WhatsApp only when high-confidence AND >= 7 baseline days)
    // + Gemini's judgement against the profile. Tiered + 24h-deduped in raiseUnusual.
    const raised: Array<{ category: string; tier: string; text: string }> = [];
    if (doc.isNew) await doc.save(); // raiseUnusual reads/writes the same document
    const { raiseUnusual } = await import("./unusualActivity.service");
    const { deviationToFinding } = await import("./unusualCore");
    const CATS = ["repeat_order", "bulk_quantity", "large_spend", "risky_meds", "odd_hours", "order_change", "confusion", "mood_drop", "meds_missed", "scam", "other"];
    const findings = [
        ...devs.map((d) => ({ f: deviationToFinding(d), src: "baseline" as const })),
        ...(unusual || [])
            .filter((u) => u.text && CATS.includes(String(u.category)) && !isUnsafeFact(String(u.text)))
            .map((u) => ({
                f: { category: u.category as never, key: `${u.category}:${dayKey}`, confidence: Math.max(0, Math.min(1, Number(u.confidence) || 0.5)), text: String(u.text).slice(0, 300), evidence: u.evidence ? String(u.evidence) : undefined },
                src: "gemini" as const,
            })),
    ];
    for (const { f, src } of findings) {
        if (!f) continue;
        const a = await raiseUnusual(w, f, src).catch(() => null);
        if (a) raised.push({ category: a.category, tier: a.tier, text: a.text });
    }
    doc.markModified("facts");
    doc.markModified("careActions");
    doc.markModified("deviations");
    doc.lastReflectedDay = dayKey;
    doc.lastReflection = { at: new Date(), model, added: merged.added, reinforced: merged.reinforced, faded: merged.faded, actions: actions.length };
    await doc.save();
    forgetProfileCache(w);
    await applyRetention(w).catch(() => undefined);
    return { dayKey, model, rows: rows.length, ...merged, facts: undefined, activeFacts: merged.facts.filter(isActive).length, actions, deviations: devs, unusual: raised };
}

/** Nightly: every elder with activity yesterday (or who has a profile). */
export async function reflectAll(dayKey = istDayKey(new Date(Date.now() - 86_400_000))) {
    const pairs = (await ActivityLog.aggregate([{ $match: { dayKey } }, { $group: { _id: { r: "$recipientUserId", f: "$familyId" } } }, { $limit: 1000 }])) as Array<{ _id: { r: string; f: string } }>;
    let ok = 0, failed = 0;
    for (const p of pairs) {
        try {
            await reflectElderDay({ familyId: p._id.f, recipientUserId: p._id.r }, dayKey);
            ok++;
        } catch (err) {
            failed++;
            console.warn("[reflection] failed:", err instanceof Error ? err.message : err);
        }
    }
    console.log(`[reflection] ${dayKey}: ${ok} elders reflected, ${failed} failed`);
    return { dayKey, elders: pairs.length, ok, failed };
}
