/**
 * "Why" memory: the reason behind an order / important request, kept per care recipient,
 * attached to her usuals and used later (follow-ups, reorder hints, order chat, new info).
 */
import { randomUUID } from "crypto";
import SaheliWhy, { type ISaheliWhy, type WhyUpdate } from "../../models/saheliWhy.model";
import ElderUsuals from "../../models/elderUsuals.model";

type Who = { familyId: string; recipientUserId: string };

const GENERIC = new Set([
    "tablet", "tablets", "tab", "tabs", "strip", "strips", "capsule", "capsules", "syrup", "medicine", "medicines", "dawai", "dawa", "goli",
    "the", "and", "for", "with", "pack", "packet", "bottle", "order", "mangwa", "chahiye", "please", "wali", "wala", "meri", "mera", "apni",
]);
/** First distinctive word ("Telma 40 tablets" → "telma"): how later messages find the memory. */
export function whyToken(s: string | null | undefined): string {
    const w = String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u097f\s]/g, " ")
        .split(/\s+/)
        .filter((x) => x.length >= 3 && !/^\d/.test(x) && !GENERIC.has(x));
    return w[0] || "";
}

export function textMentions(text: string, subject: string): boolean {
    const tok = whyToken(subject);
    if (!tok) return false;
    return new RegExp(`(^|[^a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text.toLowerCase());
}

function rupees(p: number): string {
    return `₹${Math.round(p / 100).toLocaleString("en-IN")}`;
}

export async function findWhy(w: Who, subject: string): Promise<ISaheliWhy | null> {
    const key = whyToken(subject);
    if (!key) return null;
    return (await SaheliWhy.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId, key }).sort({ updatedAt: -1 }).lean().catch(() => null)) as ISaheliWhy | null;
}

/**
 * Record (or refresh) the reason for an item. Returns the record + any change worth telling the
 * family about (price jump vs last time, re-ordered after a doctor stop).
 */
export async function upsertWhy(
    w: Who,
    input: { subject: string; reason?: string | null; category?: string | null; source: ISaheliWhy["source"]; importance?: "high" | "normal"; ownerUserId?: string; pricePaise?: number | null; partner?: string | null },
): Promise<{ why: ISaheliWhy | null; events: WhyUpdate[] }> {
    const key = whyToken(input.subject);
    if (!key) return { why: null, events: [] };
    const events: WhyUpdate[] = [];
    const now = new Date();
    const existing = await SaheliWhy.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId, key }).sort({ updatedAt: -1 });
    if (!existing) {
        if (!input.reason) return { why: null, events };
        const doc = await SaheliWhy.create({
            whyId: randomUUID(),
            ...w,
            ownerUserId: input.ownerUserId,
            subject: input.subject.slice(0, 140),
            key,
            category: input.category || undefined,
            reason: input.reason.slice(0, 400),
            source: input.source,
            importance: input.importance || "normal",
            status: "active",
            lastPricePaise: input.pricePaise ?? null,
            partner: input.partner || undefined,
            updates: [],
        });
        return { why: doc.toObject() as ISaheliWhy, events };
    }
    const updates = (existing.updates || []) as WhyUpdate[];
    // A placed order may refresh the reason; an in-progress request only fills a gap (never overwrites).
    if (input.reason && input.source !== "request" && input.reason.trim().toLowerCase() !== existing.reason.trim().toLowerCase()) {
        updates.push({ at: now, kind: "note", note: `Earlier reason: ${existing.reason}`.slice(0, 300), source: input.source });
        existing.reason = input.reason.slice(0, 400);
    }
    if (input.pricePaise && existing.lastPricePaise && input.pricePaise > existing.lastPricePaise * 1.2 && input.pricePaise - existing.lastPricePaise >= 2000) {
        const e: WhyUpdate = { at: now, kind: "price_up", note: `Price went up: ${rupees(existing.lastPricePaise)} → ${rupees(input.pricePaise)}${input.partner ? ` on ${input.partner}` : ""}`, source: "order" };
        updates.push(e);
        events.push(e);
    }
    if (input.source === "order" && existing.status === "stopped") {
        const e: WhyUpdate = { at: now, kind: "note", note: "Ordered again after it was marked stopped (she confirmed)", source: "order" };
        updates.push(e);
        events.push(e);
        existing.status = "active";
    }
    if (input.pricePaise) existing.lastPricePaise = input.pricePaise;
    if (input.partner) existing.partner = input.partner;
    if (input.importance === "high") existing.importance = "high";
    // Keep the short name she used ("Telma 40"); only fill in a missing / 1-word name.
    if (input.source === "order" && existing.subject.trim().split(/\s+/).length < 2 && input.subject.length > existing.subject.length) existing.subject = input.subject.slice(0, 140);
    existing.updates = updates.slice(-20);
    existing.markModified("updates");
    await existing.save();
    return { why: existing.toObject() as ISaheliWhy, events };
}

/** Attach the reason to the matching usual (after the order's usual row has been written). */
export async function attachWhyToUsual(w: Who, itemName: string, why: { whyId: string; reason: string; status?: string }): Promise<void> {
    const tok = whyToken(itemName);
    if (!tok) return;
    try {
        const doc = await ElderUsuals.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId });
        if (!doc) return;
        let hit = false;
        for (const u of (doc.items || []) as Array<Record<string, unknown>>) {
            if (whyToken(String(u.name || "")) === tok || whyToken(String(u.key || "")) === tok) {
                u.why = why.reason;
                u.whyId = why.whyId;
                u.whyStatus = why.status || "active";
                hit = true;
            }
        }
        if (hit) {
            doc.markModified("items");
            await doc.save();
        }
    } catch (err) {
        console.warn("[why] attach to usual failed:", err instanceof Error ? err.message : err);
    }
}

export async function listWhys(w: Who, limit = 30): Promise<ISaheliWhy[]> {
    return (await SaheliWhy.find({ familyId: w.familyId, recipientUserId: w.recipientUserId }).sort({ updatedAt: -1 }).limit(limit).lean().catch(() => [])) as ISaheliWhy[];
}

/** Whys this message mentions by name (retrieval only; Gemini decides what it means). */
export async function whysMentionedIn(w: Who, text: string): Promise<ISaheliWhy[]> {
    const all = await listWhys(w, 40);
    return all.filter((y) => textMentions(text, y.subject));
}

export async function applyWhyChange(w: Who, whyId: string, change: WhyUpdate["kind"], note: string, source = "chat"): Promise<ISaheliWhy | null> {
    const doc = await SaheliWhy.findOne({ whyId, familyId: w.familyId, recipientUserId: w.recipientUserId });
    if (!doc) return null;
    const updates = (doc.updates || []) as WhyUpdate[];
    updates.push({ at: new Date(), kind: change, note: note.slice(0, 300), source });
    doc.updates = updates.slice(-20);
    if (change === "stopped") doc.status = "stopped";
    if (change === "continue" || change === "started") doc.status = "active";
    doc.markModified("updates");
    await doc.save();
    await attachWhyToUsual(w, doc.subject, { whyId: doc.whyId, reason: doc.reason, status: doc.status });
    return doc.toObject() as ISaheliWhy;
}

export async function deleteWhy(w: Who, whyId: string): Promise<boolean> {
    const r = await SaheliWhy.deleteOne({ whyId, familyId: w.familyId, recipientUserId: w.recipientUserId });
    if (r.deletedCount) {
        await ElderUsuals.updateOne({ familyId: w.familyId, recipientUserId: w.recipientUserId }, { $unset: { "items.$[i].why": "", "items.$[i].whyId": "", "items.$[i].whyStatus": "" } } as never, { arrayFilters: [{ "i.whyId": whyId }] } as never).catch(() => undefined);
    }
    return r.deletedCount > 0;
}

/** Short text for prompts / hints: "Telma 40 — ran out of BP medicine; doctor said continue". */
export function whySentence(y: Pick<ISaheliWhy, "subject" | "reason" | "status" | "updates">): string {
    const last = (y.updates || []).slice(-1)[0];
    return `${y.subject} — ${y.reason}${y.status === "stopped" ? " [STOPPED" + (last?.kind === "stopped" ? `: ${last.note}` : "") + "]" : ""}`;
}

/** Block for the order chat prompt (why she orders things). */
export async function whyNotesForPrompt(w: Who): Promise<string> {
    const all = (await listWhys(w, 10)).slice(0, 8);
    if (!all.length) return "";
    return `Why she orders these (remembered; use gently, never lecture): ${all.map(whySentence).join("; ")}`;
}
