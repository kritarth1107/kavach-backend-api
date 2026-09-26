/**
 * Saheli "instinct": the elder's usuals (family-scoped). Learned from placed orders, rides and
 * her declines; turns a familiar ask into one confirm card. Money/health guardrails are unchanged:
 * every usual still goes through the health check, the live cart price and a literal *confirm*.
 */
import ElderUsuals, { type UsualItem, type UsualRejection } from "../../../models/elderUsuals.model";
import { conceptKey, matchUsual, recentlyRejected, shapeChoices, usualAck, usualEmoji } from "./usualsCore";

export { conceptKey, matchUsual, shapeChoices, usualAck, usualEmoji };
type Who = { familyId: string; recipientUserId: string };

const MAX_ITEMS = 60;
const MAX_REJ = 40;

export async function loadUsuals(w: Who) {
    return ElderUsuals.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId }).lean().catch(() => null);
}

/** Per-phone context for the turn in flight: which usual we're fetching + her declines. */
type Ctx = { usual: UsualItem | null; rejections: UsualRejection[]; query: string; at: number; ackSent: boolean };
const ctxByPhone = new Map<string, Ctx>();
export function setUsualCtx(phone: string, c: Omit<Ctx, "at">): void {
    ctxByPhone.set(phone, { ...c, at: Date.now() });
}
export function usualCtx(phone: string): Ctx | null {
    const c = ctxByPhone.get(phone);
    if (!c || Date.now() - c.at > 10 * 60_000) return null;
    return c;
}
export function clearUsualCtx(phone: string): void {
    ctxByPhone.delete(phone);
}

export async function resolveUsual(
    w: Who,
    ask: { query?: string | null; text: string; category?: string | null; partners?: string[] },
): Promise<{ usual: UsualItem | null; rejections: UsualRejection[] }> {
    const doc = await loadUsuals(w);
    if (!doc) return { usual: null, rejections: [] };
    return { usual: matchUsual(doc.items || [], doc.rejections || [], ask), rejections: doc.rejections || [] };
}

function istHour(d = new Date()): number {
    return Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(d)) % 24;
}

/** A placed order → the usual for that concept (count, cadence, last price, place, app). */
export async function recordUsualFromOrder(
    w: Who,
    o: { query?: string | null; name: string; partner: string; category: "food" | "grocery" | "pharmacy"; pricePaise?: number; placeNickname?: string | null; restaurantName?: string | null },
): Promise<void> {
    try {
        const key = conceptKey(o.query || o.name);
        if (!key || !o.name) return;
        const doc = (await ElderUsuals.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId })) || new ElderUsuals({ ...w, items: [], rides: [], rejections: [], preferredApp: {} });
        const items: UsualItem[] = (doc.items || []) as UsualItem[];
        const now = new Date();
        const i = items.findIndex((u) => u.name.toLowerCase() === o.name.toLowerCase() && u.partner === o.partner);
        const alias = String(o.query || "").trim().toLowerCase().slice(0, 40);
        if (i >= 0) {
            const u = items[i]!;
            const gap = (now.getTime() - new Date(u.lastAt).getTime()) / 86_400_000;
            if (gap >= 0.5) u.intervalDays = u.intervalDays ? Math.round((u.intervalDays * 2 + gap) / 3 * 10) / 10 : Math.round(gap * 10) / 10;
            u.count += 1;
            u.lastAt = now;
            if (o.pricePaise) u.pricePaise = o.pricePaise;
            if (o.placeNickname) u.placeNickname = o.placeNickname;
            if (alias && !u.aliases.includes(alias)) u.aliases = [...u.aliases, alias].slice(-6);
        } else {
            items.push({ key, category: o.category, name: o.name.slice(0, 120), partner: o.partner, restaurantName: o.restaurantName || undefined, pricePaise: o.pricePaise, placeNickname: o.placeNickname || undefined, aliases: alias ? [alias] : [], count: 1, lastAt: now });
        }
        doc.items = items.sort((a, b) => +new Date(b.lastAt) - +new Date(a.lastAt)).slice(0, MAX_ITEMS);
        const byApp: Record<string, number> = {};
        for (const u of doc.items.filter((x) => x.category === o.category)) byApp[u.partner] = (byApp[u.partner] || 0) + u.count;
        doc.preferredApp = { ...(doc.preferredApp || {}), [o.category]: Object.entries(byApp).sort((a, b) => b[1] - a[1])[0]?.[0] };
        const hours = doc.orderHours?.length === 24 ? [...doc.orderHours] : Array(24).fill(0);
        hours[istHour(now)] += 1;
        doc.orderHours = hours;
        doc.markModified("items");
        doc.markModified("preferredApp");
        await doc.save();
    } catch (err) {
        console.warn("[usuals] record failed:", err instanceof Error ? err.message : err);
    }
}

export async function recordRide(w: Who, destination: string | null | undefined): Promise<void> {
    const d = String(destination || "").trim().slice(0, 80);
    if (!d) return;
    try {
        const doc = (await ElderUsuals.findOne(w)) || new ElderUsuals({ ...w, items: [], rides: [], rejections: [], preferredApp: {} });
        const rides = (doc.rides || []) as Array<{ destination: string; count: number; lastAt: Date }>;
        const r = rides.find((x) => x.destination.toLowerCase() === d.toLowerCase());
        if (r) {
            r.count += 1;
            r.lastAt = new Date();
        } else rides.push({ destination: d, count: 1, lastAt: new Date() });
        doc.rides = rides.sort((a, b) => b.count - a.count).slice(0, 15);
        doc.markModified("rides");
        await doc.save();
    } catch (err) {
        console.warn("[usuals] ride failed:", err instanceof Error ? err.message : err);
    }
}

/** She declined / swapped an option → remember why, so it isn't offered the same way again. */
export async function noteDecline(w: Who, r: { item: string; partner?: string | null; reason?: string | null; replacedWith?: string | null }): Promise<void> {
    const item = String(r.item || "").trim().slice(0, 120);
    if (!item) return;
    try {
        const entry: UsualRejection = { item, partner: r.partner || undefined, reason: String(r.reason || "declined").trim().slice(0, 160), replacedWith: r.replacedWith || undefined, at: new Date() };
        await ElderUsuals.updateOne(
            { familyId: w.familyId, recipientUserId: w.recipientUserId },
            { $push: { rejections: { $each: [entry], $slice: -MAX_REJ } }, $setOnInsert: { items: [], rides: [], preferredApp: {} } },
            { upsert: true },
        );
    } catch (err) {
        console.warn("[usuals] decline failed:", err instanceof Error ? err.message : err);
    }
}

/** Short prompt block for the order chat: her usuals and why she said no before. */
export async function preferenceNotes(w: Who): Promise<string> {
    const doc = await loadUsuals(w);
    if (!doc) return "";
    const items = (doc.items || []).slice(0, 8).map((u) => `${u.key} → usually "${u.name}" from ${u.partner}${u.count > 1 ? ` (${u.count}×)` : ""}`);
    const cutoff = Date.now() - 60 * 86_400_000;
    const rej = (doc.rejections || []).filter((r) => new Date(r.at).getTime() > cutoff).slice(-6).map((r) => `declined "${r.item}"${r.partner ? ` on ${r.partner}` : ""}: ${r.reason}${r.replacedWith ? ` → chose ${r.replacedWith}` : ""}`);
    if (!items.length && !rej.length) return "";
    return [items.length ? `Her usuals: ${items.join("; ")}` : "", rej.length ? `Past declines (respect these, don't re-offer the same thing for the same reason): ${rej.join("; ")}` : ""].filter(Boolean).join("\n");
}

export { recentlyRejected };

/** Due items for proactive nudges: repeat purchases (≥2) whose cadence has elapsed. */
export async function dueUsuals(w: Who, now = Date.now()): Promise<UsualItem[]> {
    const doc = await loadUsuals(w);
    if (!doc) return [];
    return (doc.items || []).filter((u) => u.count >= 2 && u.intervalDays && u.intervalDays >= 1 && now - new Date(u.lastAt).getTime() >= u.intervalDays * 86_400_000 * 0.95);
}

/** Dashboard view (no prices of other members, family-scoped). */
export async function usualsSummary(w: Who) {
    const doc = await loadUsuals(w);
    if (!doc) return { items: [], preferredApp: {}, rides: [], rejections: [], typicalHours: [] };
    const hours = (doc.orderHours || []).map((n, h) => ({ h, n })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map((x) => x.h);
    return {
        items: (doc.items || []).map((u) => ({ key: u.key, name: u.name, partner: u.partner, category: u.category, pricePaise: u.pricePaise ?? null, count: u.count, lastAt: u.lastAt, intervalDays: u.intervalDays ?? null, placeNickname: u.placeNickname ?? null })),
        preferredApp: doc.preferredApp || {},
        rides: doc.rides || [],
        rejections: (doc.rejections || []).slice(-10),
        typicalHours: hours,
    };
}

/** One line for the morning message when a usual is due (most overdue first). */
export async function reorderOfferLine(w: Who, lang?: string | null): Promise<string> {
    const due = await dueUsuals(w);
    if (!due.length) return "";
    const u = due.sort((a, b) => +new Date(a.lastAt) + (a.intervalDays || 0) * 86_400_000 - (+new Date(b.lastAt) + (b.intervalDays || 0) * 86_400_000))[0]!;
    const hindi = /hindi|hinglish/i.test(lang || "");
    const ask = u.aliases.find((a) => !a.includes(" ")) || u.key;
    const e = usualEmoji(u.key, u.category);
    return hindi
        ? `${e} Aapka *${u.name}* khatam hone wala hoga — mangwana ho to bas "${ask} mangwa do" likh dijiye.`
        : `${e} Your *${u.name}* is probably running low — just say "${ask}" and I'll get your usual.`;
}

/** Caregiver/dashboard: forget one usual (by name + app). */
export async function removeUsualItem(w: Who, name: string, partner: string): Promise<boolean> {
    const r = await ElderUsuals.updateOne({ familyId: w.familyId, recipientUserId: w.recipientUserId }, { $pull: { items: { name, partner } } } as never);
    return r.modifiedCount > 0;
}

/** Caregiver/dashboard: forget one recorded decline (by item + time). */
export async function removeDecline(w: Who, item: string, at: string): Promise<boolean> {
    const doc = await ElderUsuals.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId });
    if (!doc) return false;
    const t = new Date(at).getTime();
    const before = (doc.rejections || []).length;
    doc.rejections = (doc.rejections || []).filter((r) => !(r.item === item && Math.abs(new Date(r.at).getTime() - t) < 1000));
    if (doc.rejections.length === before) return false;
    doc.markModified("rejections");
    await doc.save();
    return true;
}

/** Stated brand preference ("main sirf Amul leti hoon") → preferred in her options for that item. */
export async function noteBrandPreference(w: Who, p: { brand: string; item: string; text: string }): Promise<void> {
    // No item named ("main sirf Amul leti hoon") → a general brand preference ("*").
    const key = (p.item && conceptKey(p.item)) || "*";
    const entry = { key, brand: p.brand.slice(0, 40), text: p.text.slice(0, 160), at: new Date() };
    await ElderUsuals.updateOne(
        { familyId: w.familyId, recipientUserId: w.recipientUserId },
        { $pull: { brandPrefs: { key } } } as never,
    ).catch(() => undefined);
    await ElderUsuals.updateOne(
        { familyId: w.familyId, recipientUserId: w.recipientUserId },
        { $push: { brandPrefs: { $each: [entry], $slice: -20 } }, $setOnInsert: { items: [], rides: [], rejections: [], preferredApp: {} } } as never,
        { upsert: true },
    );
}

export async function brandPreferenceFor(w: Who, query: string): Promise<string | null> {
    const doc = (await loadUsuals(w)) as unknown as { brandPrefs?: Array<{ key: string; brand: string }> } | null;
    const key = conceptKey(query);
    const prefs = doc?.brandPrefs || [];
    const hit = prefs.filter((b) => b.key === key || (key && b.key !== "*" && b.key.includes(key))).pop() || prefs.filter((b) => b.key === "*").pop();
    return hit?.brand || null;
}
