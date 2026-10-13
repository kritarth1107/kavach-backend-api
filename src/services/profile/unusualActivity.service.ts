/**
 * Unusual-activity alerts from the old order flow's code backstops (risky medicines in bulk, repeats, large spend):
 * caregiver WhatsApp only for the high tier, the same key at most once per 24 h. Since the memory move (trust plan A1)
 * nothing is written to the retired Mongo profile: each finding goes to Saheli's care ledger in the engine (a care event,
 * deduped by key and day), where the brain and the dashboard see it. The backend runs as one instance, so the 24 h
 * dedupe can live in memory (the ledger's ref dedupes across restarts).
 */
import User from "../../models/users.model";
import { formatUnusualAlert, inQuietHours, tierFor, type UnusualFinding } from "./unusualCore";

export type Who = { familyId: string; recipientUserId: string };
type Alert = { at: Date; key: string; category: UnusualFinding["category"]; confidence: number; tier: "whatsapp" | "dashboard"; text: string; status: "sent" | "logged" };

const recent = new Map<string, number>();
const DAY_MS = 24 * 3600_000;

async function elderName(recipientUserId: string): Promise<string> {
    const u = await User.findOne({ userId: recipientUserId }).lean().catch(() => null);
    return (u as { firstName?: string } | null)?.firstName || "Your family member";
}

async function send(w: Who, a: Alert): Promise<void> {
    const { notifyCaregivers } = await import("../saheliCaregiverAlert.service");
    await notifyCaregivers({
        familyId: w.familyId,
        recipientUserId: w.recipientUserId,
        actorUserId: w.recipientUserId,
        message: formatUnusualAlert(await elderName(w.recipientUserId), a),
        urgency: a.category === "scam" || a.category === "risky_meds" ? "high" : "medium",
        kind: "unusual_activity",
    });
}

export async function raiseUnusual(w: Who, f: UnusualFinding, source: "code" | "gemini" | "baseline" = "code", now = new Date()): Promise<Alert | null> {
    const k = `${w.familyId}|${w.recipientUserId}|${f.key}`;
    const last = recent.get(k);
    if (last && now.getTime() - last < DAY_MS) return null;
    recent.set(k, now.getTime());
    const tier = tierFor({ category: f.category, confidence: f.confidence, source }, 0);
    const urgent = f.category === "scam" || f.category === "risky_meds";
    const a: Alert = {
        at: now, key: f.key, category: f.category, confidence: Math.round(f.confidence * 100) / 100, tier, text: f.text.slice(0, 400),
        status: tier === "whatsapp" && (urgent || !inQuietHours(now)) ? "sent" : "logged",
    };
    const { aiPushCareEvent } = await import("../../clients/aiEngine.client");
    const day = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    void aiPushCareEvent({
        family_id: w.familyId, subject_id: w.recipientUserId, kind: "unusual_activity", summary: `Unusual: ${a.text.slice(0, 200)}`,
        payload: { category: a.category, confidence: a.confidence, tier, status: a.status, source }, ref: `unusual:${f.key}:${day}`.slice(0, 160),
        at: now.toISOString(),
    });
    const { logActivity } = await import("../activityLog.service");
    void logActivity({
        familyId: w.familyId,
        recipientUserId: w.recipientUserId,
        kind: "mood",
        severity: tier === "whatsapp" ? "error" : "warn",
        title: `Unusual: ${a.text.slice(0, 120)}`,
        data: { source: "unusual", category: a.category, confidence: a.confidence, tier, status: a.status },
    });
    if (a.status === "sent") await send(w, a).catch((e) => console.warn("[unusual] send failed:", e instanceof Error ? e.message : e));
    return a;
}

/** Tests only. */
export function resetUnusualDedupe(): void {
    recent.clear();
}

/** Her recent orders / spend / usual hours for the order-risk backstops. */
async function orderHistory(w: Who) {
    const ActivityLogM = (await import("../../models/activityLog.model")).default;
    const since = new Date(Date.now() - 14 * 86_400_000);
    const placed = await ActivityLogM.find({ familyId: w.familyId, recipientUserId: w.recipientUserId, kind: "order_placed", createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(40).lean();
    const recent = placed.map((o) => ({
        item: String(o.detail || o.title || "").split(" → ")[0]!,
        at: o.createdAt as Date,
        totalRupees: (() => {
            const m = String((o.data as Record<string, unknown> | undefined)?.totalLabel || o.title || "").match(/₹\s?([\d,]+)/);
            return m ? Number(m[1]!.replace(/,/g, "")) : null;
        })(),
    }));
    const spends = recent.map((r) => r.totalRupees).filter((x): x is number => typeof x === "number" && x > 0).sort((a, b) => a - b);
    const medianSpend = spends.length >= 3 ? spends[Math.floor(spends.length / 2)]! : null;
    const msgs = await ActivityLogM.find({ familyId: w.familyId, recipientUserId: w.recipientUserId, kind: "message_in", createdAt: { $gte: since } }).select({ createdAt: 1 }).limit(300).lean();
    const usualHours = msgs.map((m) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date(m.createdAt as Date))) % 24);
    return { recent, medianSpend, usualHours };
}

/**
 * Order-risk gate for the elder (code backstop; runs at request time and at the confirm card).
 * Returns pause=true for risky meds in bulk: Saheli asks her gently instead of showing a card,
 * and caregivers get the (tiered, deduped) alert. Other findings add a gentle note to the card.
 */
export async function gateElderOrder(
    w: Who,
    input: { item: string; qty?: number; totalRupees?: number | null; stage: "request" | "card" },
): Promise<{ pause: boolean; elderLine?: string; note?: string; findings: string[] }> {
    const { checkOrderRisk } = await import("./unusualCore");
    const h = await orderHistory(w).catch(() => ({ recent: [], medianSpend: null, usualHours: [] as number[] }));
    const all = checkOrderRisk({ item: input.item, qty: input.qty, totalRupees: input.totalRupees, recent: h.recent, medianSpend: h.medianSpend, usualHours: h.usualHours, stage: "card" });
    // At request time only the risky-meds pause matters (no price/item yet); repeats etc. at the card.
    const findings = input.stage === "request" ? all.filter((f) => f.pauseOrder) : all;
    for (const f of findings) await raiseUnusual(w, f).catch(() => null);
    const pause = findings.find((f) => f.pauseOrder);
    if (pause) return { pause: true, elderLine: pause.elderLine, findings: findings.map((f) => f.category) };
    const repeat = findings.find((f) => f.category === "repeat_order");
    return { pause: false, note: repeat?.elderLine, findings: findings.map((f) => f.category) };
}
