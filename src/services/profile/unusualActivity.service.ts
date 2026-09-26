/**
 * Unusual-activity alerts: record every finding on the elder profile (dashboard + snapshot), and
 * send caregiver WhatsApp only for the high tier. Same key → at most once per 24h. Non-urgent
 * WhatsApp during quiet hours (22:00–08:00 IST) is queued and flushed by the care-nudge tick.
 */
import ElderProfile, { type UnusualAlert } from "../../models/elderProfile.model";
import ElderWellbeingDay from "../../models/elderWellbeingDay.model";
import User from "../../models/users.model";
import { newActionId } from "./profileCore";
import { formatUnusualAlert, inQuietHours, isDuplicate, tierFor, type UnusualFinding } from "./unusualCore";
import type { Who } from "./elderProfile.service";

async function elderName(recipientUserId: string): Promise<string> {
    const u = await User.findOne({ userId: recipientUserId }).lean().catch(() => null);
    return (u as { firstName?: string } | null)?.firstName || "Your family member";
}

export async function baselineDays(w: Who): Promise<number> {
    return ElderWellbeingDay.countDocuments({ familyId: w.familyId, recipientUserId: w.recipientUserId }).catch(() => 0);
}

async function send(w: Who, a: UnusualAlert): Promise<boolean> {
    const { notifyCaregivers } = await import("../saheliCaregiverAlert.service");
    const r = await notifyCaregivers({
        familyId: w.familyId,
        recipientUserId: w.recipientUserId,
        actorUserId: w.recipientUserId,
        message: formatUnusualAlert(await elderName(w.recipientUserId), a),
        urgency: a.category === "scam" || a.category === "risky_meds" ? "high" : "medium",
        kind: "unusual_activity",
    });
    return r.notifiedCount > 0 || r.channels.length > 0 || true;
}

export async function raiseUnusual(w: Who, f: UnusualFinding, source: UnusualAlert["source"] = "code", now = new Date()): Promise<UnusualAlert | null> {
    const doc =
        (await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId })) ||
        new ElderProfile({ ...w, facts: [], careActions: [], deviations: [], alerts: [], tuning: {}, retentionDays: 365 });
    const alerts = (doc.alerts || []) as UnusualAlert[];
    if (isDuplicate(alerts, f.key, now)) return null;
    const tier = tierFor({ category: f.category, confidence: f.confidence, source }, await baselineDays(w));
    const urgent = f.category === "scam" || f.category === "risky_meds";
    const a: UnusualAlert = {
        id: newActionId(),
        at: now,
        key: f.key,
        category: f.category,
        confidence: Math.round(f.confidence * 100) / 100,
        tier,
        text: f.text.slice(0, 400),
        evidence: f.evidence?.slice(0, 300),
        source,
        status: tier === "whatsapp" ? (urgent || !inQuietHours(now) ? "sent" : "queued") : "logged",
    };
    doc.alerts = [...alerts, a].slice(-80);
    doc.markModified("alerts");
    await doc.save();
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

/** Morning flush of queued (quiet-hours) alerts. Called from the care-nudge tick. */
export async function flushQueuedUnusualAlerts(now = new Date()): Promise<number> {
    if (inQuietHours(now)) return 0;
    const docs = await ElderProfile.find({ "alerts.status": "queued" }).limit(200);
    let n = 0;
    for (const doc of docs) {
        const w = { familyId: doc.familyId, recipientUserId: doc.recipientUserId };
        for (const a of (doc.alerts || []) as UnusualAlert[]) {
            if (a.status !== "queued") continue;
            a.status = "sent";
            await send(w, a).catch(() => undefined);
            n++;
        }
        doc.markModified("alerts");
        await doc.save();
    }
    return n;
}

export async function dismissAlert(w: Who, id: string) {
    const r = await ElderProfile.updateOne({ familyId: w.familyId, recipientUserId: w.recipientUserId, "alerts.id": id }, { $set: { "alerts.$.dismissed": true } });
    return r.modifiedCount > 0;
}

/** Lower-tier findings from the last 24h for the daily snapshot. */
export async function unusualForSnapshot(w: Who, since = new Date(Date.now() - 24 * 3600_000)): Promise<string[]> {
    const p = await ElderProfile.findOne({ familyId: w.familyId, recipientUserId: w.recipientUserId }).lean();
    return ((p?.alerts || []) as UnusualAlert[]).filter((a) => new Date(a.at) >= since && !a.dismissed).map((a) => `${a.tier === "whatsapp" ? "Alerted" : "Noticed"}: ${a.text.slice(0, 140)}`).slice(0, 3);
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
