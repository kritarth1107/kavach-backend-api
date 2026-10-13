/**
 * The old (v1) order flow's usuals, read only: the ElderUsuals store is retired (trust plan A1) and nothing writes it;
 * what she usually orders moved into the care record (preference:usual_<item> facts), which the engine's product picker
 * reads. Kept only for the v1 order flow, which never orders for a family on Saheli v2.
 */
import ElderUsuals, { type UsualItem, type UsualRejection } from "../../../models/elderUsuals.model";
import { conceptKey, matchUsual, recentlyRejected, shapeChoices, usualAck, usualEmoji } from "./usualsCore";

export { conceptKey, matchUsual, shapeChoices, usualAck, usualEmoji };
type Who = { familyId: string; recipientUserId: string };

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




/** Short prompt block for the order chat: her usuals and why she said no before. */
export async function preferenceNotes(w: Who): Promise<string> {
    const doc = await loadUsuals(w);
    if (!doc) return "";
    const items = (doc.items || []).slice(0, 8).map((u) => `${u.key} → usually "${u.name}" from ${u.partner}${u.count > 1 ? ` (${u.count}×)` : ""}`);
    const cutoff = Date.now() - 60 * 86_400_000;
    const rej = (doc.rejections || []).filter((r) => new Date(r.at).getTime() > cutoff).slice(-6).map((r) => `declined "${r.item}"${r.partner ? ` on ${r.partner}` : ""}: ${r.reason}${r.replacedWith ? ` → chose ${r.replacedWith}` : ""}`);
    // Why memory: the reason behind her orders (doctor said continue / stopped, guests, …).
    const whys = await import("../../delegate/why.service").then((W) => W.whyNotesForPrompt(w)).catch(() => "");
    if (!items.length && !rej.length && !whys) return "";
    return [items.length ? `Her usuals: ${items.join("; ")}` : "", rej.length ? `Past declines (respect these, don't re-offer the same thing for the same reason): ${rej.join("; ")}` : "", whys].filter(Boolean).join("\n");
}

export { recentlyRejected };







export async function brandPreferenceFor(w: Who, query: string): Promise<string | null> {
    const doc = (await loadUsuals(w)) as unknown as { brandPrefs?: Array<{ key: string; brand: string }> } | null;
    const key = conceptKey(query);
    const prefs = doc?.brandPrefs || [];
    const hit = prefs.filter((b) => b.key === key || (key && b.key !== "*" && b.key.includes(key))).pop() || prefs.filter((b) => b.key === "*").pop();
    return hit?.brand || null;
}
