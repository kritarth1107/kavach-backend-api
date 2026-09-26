/**
 * Saheli's evolving elder profile: load / summary for prompts / caregiver edits / stated
 * preferences / retention. Family-scoped: every read and write is keyed by familyId +
 * recipientUserId. Prompt context only — safety rules are enforced in code elsewhere.
 */
import ElderProfile, { type IElderProfile, type ProfileFact } from "../../models/elderProfile.model";
import ElderWellbeingDay from "../../models/elderWellbeingDay.model";
import { applyReflection, detectStatedPreference, isActive, renderProfileSummary, weeklyMetrics } from "./profileCore";
import { istDayKey } from "../activityLog.service";

export type Who = { familyId: string; recipientUserId: string };

export async function loadProfile(w: Who): Promise<IElderProfile | null> {
    return (await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId }).lean().catch(() => null)) as IElderProfile | null;
}

async function loadOrCreate(w: Who) {
    return (
        (await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId })) ||
        new ElderProfile({ ...w, facts: [], careActions: [], deviations: [], tuning: {}, retentionDays: 365 })
    );
}

const cache = new Map<string, { at: number; short: string; full: string; tuning: IElderProfile["tuning"] }>();
export function forgetProfileCache(w: Who): void {
    cache.delete(`${w.familyId}|${w.recipientUserId}`);
}

/** Compact, care-first summary for prompts (cached 5 min; never throws). */
export async function profileSummary(w: Who, short = false): Promise<string> {
    const c = await cachedProfile(w);
    return short ? c.short : c.full;
}
export async function profileTuning(w: Who): Promise<IElderProfile["tuning"]> {
    return (await cachedProfile(w)).tuning || {};
}
async function cachedProfile(w: Who) {
    const k = `${w.familyId}|${w.recipientUserId}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit;
    const p = await loadProfile(w);
    const dayKey = istDayKey();
    const v = {
        at: Date.now(),
        short: p ? renderProfileSummary(p, { short: true }) : "",
        full: p ? renderProfileSummary(p, { dayKey }) : "",
        tuning: p?.tuning || {},
    };
    cache.set(k, v);
    return v;
}

/** "main sirf Amul leti hoon" → a profile fact + a brand preference on her usuals, right away. */
export async function captureStatedPreference(w: Who, text: string): Promise<string | null> {
    const pref = detectStatedPreference(text);
    if (!pref) return null;
    try {
        const doc = await loadOrCreate(w);
        const r = applyReflection((doc.facts || []) as ProfileFact[], [{ op: "add", category: pref.category, text: pref.text, confidence: 0.7 }], {
            now: new Date(),
            dayKey: istDayKey(),
            sourceKind: "chat",
        });
        doc.facts = r.facts;
        doc.markModified("facts");
        await doc.save();
        forgetProfileCache(w);
        if (pref.brand) {
            const { noteBrandPreference } = await import("../commerceAutomation/usuals/usuals.service");
            await noteBrandPreference(w, { brand: pref.brand, item: pref.item || "", text: pref.text });
        }
        return pref.text;
    } catch (err) {
        console.warn("[profile] stated preference failed:", err instanceof Error ? err.message : err);
        return null;
    }
}

// ── Caregiver controls (dashboard; family membership checked in the controller) ──
export async function confirmFact(w: Who, id: string, by: string) {
    return mutateFact(w, id, (f) => {
        f.status = "caregiver_confirmed";
        f.confidence = 1;
        f.lastConfirmed = new Date();
        f.editedBy = by;
    });
}
export async function editFact(w: Who, id: string, by: string, text: string, category?: string) {
    const { isUnsafeFact } = await import("./profileCore");
    if (isUnsafeFact(text)) throw Object.assign(new Error("That can't be saved: safety rules (COD, confirm, alerts, harmful items, addresses) aren't part of the profile."), { status: 400 });
    const { FACT_CATEGORIES } = await import("../../models/elderProfile.model");
    return mutateFact(w, id, (f) => {
        f.text = text.slice(0, 240);
        if (category && (FACT_CATEGORIES as readonly string[]).includes(category)) f.category = category as ProfileFact["category"];
        f.status = "caregiver_edited";
        f.confidence = 1;
        f.lastConfirmed = new Date();
        f.editedBy = by;
    });
}
/** Delete = rejected: hidden, and never re-learned. */
export async function rejectFact(w: Who, id: string, by: string) {
    return mutateFact(w, id, (f) => {
        f.status = "rejected";
        f.editedBy = by;
        f.lastConfirmed = new Date();
    });
}
async function mutateFact(w: Who, id: string, fn: (f: ProfileFact) => void): Promise<boolean> {
    const doc = await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId });
    const f = (doc?.facts || []).find((x) => x.id === id);
    if (!doc || !f) return false;
    fn(f);
    doc.markModified("facts");
    await doc.save();
    forgetProfileCache(w);
    const day = istDayKey();
    await ElderWellbeingDay.updateOne(
        { familyId: w.familyId, recipientUserId: w.recipientUserId, dayKey: day },
        { $inc: { caregiverEdits: 1 }, $setOnInsert: { messagesIn: 0 } },
        { upsert: true },
    ).catch(() => undefined);
    return true;
}
export async function setCareActionStatus(w: Who, id: string, status: "used" | "dismissed") {
    const r = await ElderProfile.updateOne({ familyId: w.familyId, recipientUserId: w.recipientUserId, "careActions.id": id }, { $set: { "careActions.$.status": status } });
    forgetProfileCache(w);
    return r.modifiedCount > 0;
}
export async function dismissDeviation(w: Who, id: string) {
    const r = await ElderProfile.updateOne({ familyId: w.familyId, recipientUserId: w.recipientUserId, "deviations.id": id }, { $set: { "deviations.$.dismissed": true } });
    return r.modifiedCount > 0;
}
export async function setRetention(w: Who, days: number) {
    const d = Math.max(30, Math.min(730, Math.round(days)));
    await ElderProfile.updateOne({ familyId: w.familyId, recipientUserId: w.recipientUserId }, { $set: { retentionDays: d }, $setOnInsert: { facts: [], careActions: [], deviations: [], tuning: {} } }, { upsert: true });
    await applyRetention(w);
    return d;
}

/** Retention: drop learned facts / wellbeing days older than the family's setting. */
export async function applyRetention(w: Who): Promise<{ facts: number; days: number }> {
    const doc = await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId });
    if (!doc) return { facts: 0, days: 0 };
    const cutoff = Date.now() - (doc.retentionDays || 365) * 86_400_000;
    const before = doc.facts.length;
    doc.facts = doc.facts.filter((f) => f.status === "rejected" || f.status === "caregiver_confirmed" || f.status === "caregiver_edited" || new Date(f.lastConfirmed).getTime() >= cutoff);
    doc.careActions = (doc.careActions || []).filter((a) => new Date(`${a.dayKey}T00:00:00+05:30`).getTime() >= Date.now() - 14 * 86_400_000);
    doc.deviations = (doc.deviations || []).filter((d) => new Date(d.at).getTime() >= cutoff).slice(-60);
    doc.markModified("facts");
    doc.markModified("careActions");
    doc.markModified("deviations");
    await doc.save();
    const cutKey = istDayKey(new Date(cutoff));
    const r = await ElderWellbeingDay.deleteMany({ familyId: w.familyId, recipientUserId: w.recipientUserId, dayKey: { $lt: cutKey } });
    return { facts: before - doc.facts.length, days: r.deletedCount };
}

/** Facts first learned in the last 7 days (for the daily snapshot's weekly line). */
export async function learnedThisWeek(w: Who): Promise<string> {
    const p = await loadProfile(w);
    if (!p) return "";
    const since = Date.now() - 7 * 86_400_000;
    const fresh = p.facts.filter((f) => isActive(f) && new Date(f.firstSeen).getTime() >= since && f.confidence >= 0.4);
    if (!fresh.length) return "";
    const { CARE_FIRST_ORDER } = await import("./profileCore");
    fresh.sort((a, b) => CARE_FIRST_ORDER.indexOf(a.category) - CARE_FIRST_ORDER.indexOf(b.category));
    return `What Saheli learned this week: ${fresh.slice(0, 4).map((f) => f.text.replace(/\s*\(said:.*\)$/, "")).join("; ")}.`;
}

/** Dashboard payload: care-first groups, care actions, deviations, metrics. */
export async function profileView(w: Who) {
    const p = await loadProfile(w);
    const days = await ElderWellbeingDay.find({ familyId: w.familyId, recipientUserId: w.recipientUserId }).sort({ dayKey: 1 }).limit(120).lean();
    const { CARE_FIRST_ORDER } = await import("./profileCore");
    const facts = (p?.facts || []).filter((f) => f.status !== "rejected" && f.status !== "faded");
    const groups = CARE_FIRST_ORDER.map((category) => ({
        category,
        facts: facts
            .filter((f) => f.category === category)
            .sort((a, b) => b.confidence - a.confidence)
            .map((f) => ({ id: f.id, text: f.text, confidence: Math.round(f.confidence * 100) / 100, status: f.status, firstSeen: f.firstSeen, lastConfirmed: f.lastConfirmed, sources: (f.sources || []).length })),
    })).filter((g) => g.facts.length);
    const today = istDayKey();
    return {
        groups,
        careActions: (p?.careActions || []).filter((a) => a.dayKey >= today && a.status !== "dismissed"),
        deviations: (p?.deviations || []).filter((d) => !d.dismissed).slice(-10).reverse(),
        unusual: (p?.alerts || []).filter((a) => !a.dismissed).slice(-12).reverse(),
        metrics: weeklyMetrics(days as never, facts.length).slice(-8),
        recentDays: days.slice(-14).map((d) => ({ dayKey: d.dayKey, mood: d.mood, moodWord: d.moodWord, messagesIn: d.messagesIn, medsDone: d.medsDone, medsMissed: d.medsMissed, lonely: d.lonely })),
        tuning: p?.tuning || {},
        retentionDays: p?.retentionDays ?? 365,
        lastReflection: p?.lastReflection || null,
        rejectedCount: (p?.facts || []).filter((f) => f.status === "rejected").length,
        baselineDays: days.length,
        // Baseline patterns may reach caregiver WhatsApp only when high-confidence and >= 7 baseline days.
        baselineWhatsAppReady: days.length >= 7,
    };
}

/** Today's first elder-facing care action (follow_up / reminder / company / offer) as one line; marks it used. */
export async function takeCareLine(w: Who): Promise<string> {
    const p = await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId });
    const today = istDayKey();
    const a = (p?.careActions || []).find((x) => x.dayKey === today && x.audience === "elder" && x.status === "planned" && x.say);
    if (!p || !a) return "";
    a.status = "used";
    p.markModified("careActions");
    await p.save();
    forgetProfileCache(w);
    return a.say!.slice(0, 220);
}
