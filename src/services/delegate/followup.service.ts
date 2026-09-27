import { isTestPhone } from "../smokeFixtures.service";
/**
 * Post-action follow-through. A placed order / booked ride becomes a durable follow-up that
 * Saheli checks at a sensible time after the ETA ("Did your Telma arrive? 🙂"; for medicines
 * "Have you started it?"). Outcomes go to the dashboard (activity + daily snapshot); caregiver
 * WhatsApp stays reserved for the existing cases (placed orders, red flags, 3 unanswered
 * nudges, unusual/scam) — unanswered follow-ups count toward that silence streak.
 */
import { randomUUID } from "crypto";
import SaheliTask, { type ISaheliTask } from "../../models/saheliTask.model";
import ChannelIdentity from "../../models/channelIdentity.model";
import { ChannelType } from "../../types/careRecord.types";
import { FamilyRole } from "../../types/family.types";
import { extractOrderContext } from "./delegateGemini";
import { closeTask, recentChat, taskTitle, whenIST, phaseWords } from "./tasks.service";
import { findWhy, upsertWhy, attachWhyToUsual } from "./why.service";
import { getPermissions, paiseFromLabel } from "./permissions.service";
import { sendDelegateMessage, type Purpose } from "./send.service";

type Row = { _id?: unknown; familyId: string; recipientUserId: string; actorUserId?: string; kind: string; title: string; detail?: string; data?: Record<string, unknown>; createdAt?: Date };

const QUICK = new Set(["instamart", "zepto", "blinkit"]);
const FOOD = new Set(["swiggy", "zomato"]);
const PHARMA_ONLINE = new Set(["apollo", "pharmeasy", "tata_1mg"]);

function istParts(d: Date) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(d);
    const g = (t: string) => p.find((x) => x.type === t)?.value || "00";
    return { day: `${g("year")}-${g("month")}-${g("day")}`, hour: Number(g("hour")) % 24 };
}
function istAt(day: string, hh: number, mm = 0): Date {
    return new Date(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+05:30`);
}

/** When to ask: a sensible time after the ETA (quick commerce ≈ 1¼ h, food ≈ 1½ h, online pharmacy next late morning). */
export function followupDueAt(placedAt: Date, o: { partner?: string | null; category?: string | null; etaMinutes?: number | null }): Date {
    const partner = String(o.partner || "");
    if (o.etaMinutes) {
        const buffer = o.etaMinutes <= 60 ? 45 : o.etaMinutes <= 240 ? 90 : 180;
        return new Date(placedAt.getTime() + (o.etaMinutes + buffer) * 60_000);
    }
    if (QUICK.has(partner)) return new Date(placedAt.getTime() + 75 * 60_000);
    if (FOOD.has(partner) || o.category === "food") return new Date(placedAt.getTime() + 90 * 60_000);
    if (o.category === "ride") return new Date(placedAt.getTime() + 90 * 60_000);
    if (PHARMA_ONLINE.has(partner) || o.category === "pharmacy") {
        const { day, hour } = istParts(placedAt);
        // Early-morning order: same evening; otherwise next day 11 AM (typical next-day delivery).
        if (hour < 8) return istAt(day, 18);
        const next = istParts(new Date(placedAt.getTime() + 24 * 3600_000)).day;
        return istAt(next, 11);
    }
    return new Date(placedAt.getTime() + 120 * 60_000);
}

async function ownerPhone(familyId: string, userId: string): Promise<{ phone: string; role: "elder" | "caregiver" } | null> {
    const row = await ChannelIdentity.findOne({ familyId, userId, channelType: ChannelType.WHATSAPP, active: true }).sort({ updatedAt: -1 }).lean().catch(() => null);
    if (row?.channelIdentifier) {
        const { normalizeChannelIdentifier } = await import("../identityResolver.service");
        return { phone: normalizeChannelIdentifier(ChannelType.WHATSAPP, row.channelIdentifier), role: row.role === FamilyRole.CARE_RECIPIENT ? "elder" : "caregiver" };
    }
    const { resolveRecipientWhatsAppPhone } = await import("../identityResolver.service");
    const p = await resolveRecipientWhatsAppPhone(userId, familyId).catch(() => null);
    return p ? { phone: p, role: "elder" } : null;
}

async function log(t: Pick<ISaheliTask, "familyId" | "recipientUserId" | "ownerUserId" | "taskId">, title: string, detail?: string, severity: "info" | "warn" = "info", data: Record<string, unknown> = {}) {
    const { logActivity } = await import("../activityLog.service");
    await logActivity({ familyId: t.familyId, recipientUserId: t.recipientUserId, actorUserId: t.ownerUserId, kind: "followup", title, detail, severity, data: { source: "delegate", taskId: t.taskId, ...data } });
}

/** Hook: an order_placed / ride booking was logged (every placement path writes one). */
export async function onOrderPlaced(row: Row): Promise<void> {
    if (/dry-run/i.test(row.title)) return;
    const isRide = row.kind === "ride";
    const jobId = String(row.data?.jobId || row.data?.orderId || "") || undefined;
    const since3m = new Date(Date.now() - 3 * 60_000);
    if (jobId && (await SaheliTask.exists({ kind: "followup", orderRef: jobId }))) return;
    if (await SaheliTask.exists({ kind: "followup", familyId: row.familyId, recipientUserId: row.recipientUserId, createdAt: { $gte: since3m }, category: isRide ? "ride" : { $ne: "ride" } })) return;
    const ownerUserId = row.actorUserId || row.recipientUserId;
    const who = await ownerPhone(row.familyId, ownerUserId);
    if (!who) return;
    const open = (await SaheliTask.findOne({ phone: who.phone, kind: "open_task", $or: [{ status: "open" }, { resolvedAt: { $gte: new Date(Date.now() - 15 * 60_000) } }] })
        .sort({ updatedAt: -1 })
        .lean()
        .catch(() => null)) as ISaheliTask | null;
    const chat = await recentChat(who.phone, row.recipientUserId, who.role === "elder", 6).catch(() => "");
    const guessItem = open?.item || open?.productQuery || "";
    const known = guessItem ? await findWhy({ familyId: row.familyId, recipientUserId: row.recipientUserId }, guessItem) : null;
    // A resumed / re-run order starts a fresh task without the reason: carry it from the earlier
    // task for the same item (last 3 days) so the delivery check still knows why it mattered.
    let carriedWhy: string | undefined;
    if (!open?.why && !known?.reason) {
        const { textMentions } = await import("./why.service");
        const itemText = `${guessItem} ${row.title} ${row.detail || ""}`;
        const prior = (await SaheliTask.find({ phone: who.phone, kind: "open_task", why: { $nin: [null, ""] }, updatedAt: { $gte: new Date(Date.now() - 3 * 86_400_000) } })
            .sort({ updatedAt: -1 })
            .limit(10)
            .lean()
            .catch(() => [])) as ISaheliTask[];
        carriedWhy = prior.find((p) => (p.item || p.productQuery) && textMentions(itemText, String(p.item || p.productQuery)))?.why || undefined;
    }
    const ctx = await extractOrderContext({
        orderLog: `${row.title}\n${row.detail || ""}\n${JSON.stringify({ ...(row.data || {}), jobId: undefined, orderId: undefined, orderIds: undefined }).slice(0, 400)}`,
        openTask: open ? `${open.title}; ${phaseWords(open.phase)}${open.why ? `; why: ${open.why}` : ""}` : undefined,
        recentChat: chat,
        knownWhy: known?.reason || carriedWhy,
    }).catch(() => null);
    const category = isRide ? "ride" : ctx?.category || open?.category || undefined;
    const item = isRide ? `ride to ${String(row.data?.to || open?.rideTo || "destination")}` : ctx?.item || open?.item || String(row.detail || row.title).slice(0, 80);
    const partner = (isRide ? String(row.data?.provider || "uber") : ctx?.partner || open?.partner || String(row.data?.store || "")) || undefined;
    const isMedicine = !isRide && (ctx?.isMedicine ?? category === "pharmacy");
    const why = ctx?.why || open?.why || known?.reason || carriedWhy || undefined;
    const placedAt = row.createdAt ? new Date(row.createdAt) : new Date();
    const w = { familyId: row.familyId, recipientUserId: row.recipientUserId };
    if (open && open.status === "open") await closeTask(open.taskId, "done", "placed", `Placed: ${item}`);
    // WHY memory: attach the reason to this item (and her usual), note price jumps.
    let whyId: string | undefined;
    if (!isRide && item) {
        const pricePaise = paiseFromLabel(row.data?.totalLabel) ?? (typeof row.data?.totalPaise === "number" ? (row.data.totalPaise as number) : null);
        const r = await upsertWhy(w, { subject: item, reason: why, category, source: "order", importance: ctx?.importance || (isMedicine ? "high" : "normal"), ownerUserId, pricePaise, partner }).catch(() => ({ why: null, events: [] }));
        whyId = r.why?.whyId;
        if (r.why) setTimeout(() => void attachWhyToUsual(w, item, { whyId: r.why!.whyId, reason: r.why!.reason, status: r.why!.status }), 8000).unref?.();
        for (const e of r.events) {
            void log({ ...w, ownerUserId, taskId: "" }, e.kind === "price_up" ? `${item}: costs more than last time` : `${item}: ${e.note}`, e.note, e.kind === "price_up" ? "warn" : "info", { whyId });
        }
    }
    const perms = await getPermissions(row.familyId);
    if (!perms.deliveryFollowUps) {
        void log({ ...w, ownerUserId, taskId: "" }, `Order noted: ${item}`, "Delivery check-ins are switched off in 'What Saheli can do'.");
        return;
    }
    const dueAt = followupDueAt(placedAt, { partner, category, etaMinutes: ctx?.etaMinutes });
    const doc: Partial<ISaheliTask> = {
        taskId: randomUUID(),
        familyId: row.familyId,
        recipientUserId: row.recipientUserId,
        ownerUserId,
        phone: who.phone,
        actorRole: who.role,
        kind: "followup",
        status: "open",
        stage: isRide ? "ride" : "delivery",
        item,
        productQuery: open?.productQuery || ctx?.item || undefined,
        partner,
        category: category as ISaheliTask["category"],
        isMedicine,
        important: isMedicine || ctx?.importance === "high",
        why,
        whyId,
        language: open?.language || ctx?.language || undefined,
        placedAt,
        etaText: ctx?.etaText || undefined,
        totalLabel: typeof row.data?.totalLabel === "string" ? row.data.totalLabel : undefined,
        orderRef: jobId,
        dueAt,
        askCount: 0,
        history: [{ at: new Date(), event: "scheduled", note: `Check ${whenIST(dueAt)}` }],
        expiresAt: new Date(dueAt.getTime() + 4 * 86_400_000),
    };
    doc.title = isRide ? taskTitle({ kind: "followup", category: "ride", rideTo: String(row.data?.to || "") } as ISaheliTask) : `${item}${partner ? ` (${partner})` : ""}`;
    const created = (await SaheliTask.create(doc)).toObject() as ISaheliTask;
    // A re-order replaces the earlier delivery check for the same thing.
    const same: Record<string, unknown>[] = [{ item }];
    if (whyId) same.push({ whyId });
    await SaheliTask.updateMany(
        { phone: who.phone, kind: "followup", taskId: { $ne: created.taskId }, status: { $in: ["open", "asked"] }, $or: same },
        { $set: { status: "done", outcome: "reordered", resolvedAt: new Date() }, $push: { history: { at: new Date(), event: "reordered", note: `New order placed ${whenIST(placedAt)}` } } } as never,
    ).catch(() => undefined);
    // The unfinished order this placement completes is no longer unfinished.
    if (open && open.status === "open" && (open.category === "ride") === isRide) {
        await SaheliTask.updateOne(
            { taskId: open.taskId, status: "open" },
            { $set: { status: "done", outcome: "placed", resolvedAt: new Date() }, $push: { history: { at: new Date(), event: "placed", note: `Placed ${whenIST(placedAt)}` } } } as never,
        ).catch(() => undefined);
    }
    void log(created, isRide ? `Saheli will check she reached (${whenIST(dueAt)})` : `Saheli will check ${item} arrived (${whenIST(dueAt)})`, why ? `Why: ${why}` : undefined, "info", { dueAt, whyId });
}

/** Hook: a checkout failed → the open task stays open (resumable: "Kal wala order ho nahi paya — phir try karoon?"). */
export async function onOrderFailed(row: Row): Promise<void> {
    const ownerUserId = row.actorUserId || row.recipientUserId;
    const who = await ownerPhone(row.familyId, ownerUserId);
    if (!who) return;
    const t = (await SaheliTask.findOne({ phone: who.phone, kind: "open_task", $or: [{ status: "open" }, { status: "done", outcome: "placed", resolvedAt: { $gte: new Date(Date.now() - 15 * 60_000) } }] }).sort({ updatedAt: -1 }).lean()) as ISaheliTask | null;
    if (!t) return;
    await SaheliTask.updateOne(
        { taskId: t.taskId },
        { $set: { status: "open", phase: "failed", lastActiveAt: new Date(), outcomeNote: String(row.detail || row.title).slice(0, 300) }, $unset: { resolvedAt: 1, outcome: 1 }, $push: { history: { at: new Date(), event: "failed", note: String(row.title).slice(0, 160) } } } as never,
    );
    if (t.whyId && /out of stock|not available|unavailable|sold out/i.test(`${row.title} ${row.detail} ${row.data?.failureReason || ""}`)) {
        const { applyWhyChange } = await import("./why.service");
        await applyWhyChange({ familyId: t.familyId, recipientUserId: t.recipientUserId }, t.whyId, "out_of_stock", `Out of stock${t.partner ? ` on ${t.partner}` : ""} (${whenIST(new Date())})`, "order").catch(() => undefined);
    }
}

// ── Scheduler tick (1-minute care-nudge scheduler) ─────────────────────────────────────────────
function factsFor(t: ISaheliTask, extra = ""): string {
    return [
        `Item: ${t.item || t.productQuery || "order"}`,
        t.partner ? `App: ${t.partner}` : "",
        t.placedAt ? `Ordered: ${whenIST(t.placedAt)}` : "",
        t.etaText ? `ETA said: ${t.etaText}` : "",
        t.isMedicine ? "It is a medicine" : "",
        t.why ? `Why it matters: ${t.why}` : "",
        t.category === "ride" ? `Ride${t.rideTo ? ` to ${t.rideTo}` : ""}` : "",
        extra,
    ]
        .filter(Boolean)
        .join(". ");
}

async function markAsked(t: ISaheliTask, text: string): Promise<void> {
    await SaheliTask.updateOne(
        { taskId: t.taskId },
        { $set: { status: "asked", askedAt: new Date(), lastSaheliLine: text.slice(0, 600) }, $inc: { askCount: 1 }, $push: { history: { at: new Date(), event: "asked", note: text.slice(0, 200) } } } as never,
    );
}

export async function sendFollowupNow(t: ISaheliTask, opts: { bypassGate?: boolean; bypassQuiet?: boolean } = {}) {
    const purpose: Purpose = t.stage === "ride" ? "ride_check" : t.stage === "started" ? "med_start_check" : "delivery_check";
    const r = await sendDelegateMessage(t, purpose, factsFor(t, t.askCount ? "You asked once already and got no answer — keep it light." : ""), opts);
    if (r.sent && r.text) await markAsked(t, r.text);
    return r;
}

export async function sendResumeNudge(t: ISaheliTask, opts: { bypassGate?: boolean; bypassQuiet?: boolean } = {}) {
    const r = await sendDelegateMessage(t, "resume_nudge", `${taskTitle(t)}. Left ${whenIST(t.lastActiveAt)}; ${phaseWords(t.phase)}.${t.why ? ` Why: ${t.why}.` : ""}`, opts);
    if (r.sent) {
        await SaheliTask.updateOne({ taskId: t.taskId }, { $set: { nudgedAt: new Date(), resumeOfferedAt: new Date() }, $inc: { resumeOfferCount: 1 }, $push: { history: { at: new Date(), event: "nudged", note: r.text?.slice(0, 200) } } } as never);
    }
    return r;
}

let ticking = false;
export async function runDelegateTick(opts: { now?: Date; onlyPhone?: string; bypassGate?: boolean; bypassQuiet?: boolean } = {}): Promise<Record<string, number>> {
    if (process.env.DELEGATE_ENABLED === "false") return {};
    if ((opts.bypassGate || opts.bypassQuiet) && !(opts.onlyPhone && isTestPhone(opts.onlyPhone))) {
        opts = { ...opts, bypassGate: false, bypassQuiet: false };
    }
    if (ticking && !opts.onlyPhone) return {};
    if (!opts.onlyPhone) ticking = true;
    const now = opts.now ?? new Date();
    const scope = opts.onlyPhone ? { phone: opts.onlyPhone } : {};
    const out: Record<string, number> = { asked: 0, reasked: 0, unanswered: 0, nudged: 0, expired: 0, approvals: 0 };
    try {
        // 1) Due follow-ups.
        const due = (await SaheliTask.find({ ...scope, kind: "followup", status: "open", dueAt: { $lte: now } }).sort({ dueAt: 1 }).limit(20).lean()) as ISaheliTask[];
        for (const t of due) {
            const r = await sendFollowupNow(t, opts).catch(() => ({ sent: false }));
            if (r.sent) out.asked++;
        }
        // 2) One gentle re-ask after 6 h without an answer; then "unanswered" (dashboard).
        const reask = (await SaheliTask.find({ ...scope, kind: "followup", status: "asked", askCount: { $lt: 2 }, askedAt: { $lte: new Date(now.getTime() - 6 * 3600_000) } }).limit(20).lean()) as ISaheliTask[];
        for (const t of reask) {
            const r = await sendFollowupNow(t, opts).catch(() => ({ sent: false }));
            if (r.sent) out.reasked++;
        }
        const stale = (await SaheliTask.find({
            ...scope,
            kind: "followup",
            status: "asked",
            $or: [{ askCount: { $gte: 2 }, askedAt: { $lte: new Date(now.getTime() - 12 * 3600_000) } }, { askedAt: { $lte: new Date(now.getTime() - 36 * 3600_000) } }],
        }).limit(50).lean()) as ISaheliTask[];
        for (const t of stale) {
            await closeTask(t.taskId, "unanswered", "no_answer", "No answer to Saheli's check");
            void log(t, `No answer yet: did ${t.item} ${t.stage === "started" ? "get started" : "arrive"}?`, t.why ? `Why it mattered: ${t.why}` : undefined, t.isMedicine ? "warn" : "info");
            out.unanswered++;
        }
        // 3) One gentle proactive nudge for an abandoned IMPORTANT task (e.g. a medicine).
        const nudgeAfter = (Number(process.env.DELEGATE_NUDGE_AFTER_MIN) || 180) * 60_000;
        const abandoned = (await SaheliTask.find({
            ...scope,
            kind: "open_task",
            status: "open",
            important: true,
            nudgedAt: { $exists: false },
            phase: { $ne: "ended_in_chat" },
            lastActiveAt: { $lte: new Date(now.getTime() - nudgeAfter) },
            expiresAt: { $gt: now },
        }).limit(20).lean()) as ISaheliTask[];
        for (const t of abandoned) {
            if (t.resumeOfferedAt && now.getTime() - new Date(t.resumeOfferedAt).getTime() < 6 * 3600_000) continue;
            const perms = await getPermissions(t.familyId);
            if (!perms.resumeNudges) continue;
            const r = await sendResumeNudge(t, opts).catch(() => ({ sent: false }));
            if (r.sent) out.nudged++;
        }
        // 4) Caregiver decisions not yet told to her (quiet hours / active flow at decision time).
        const decided = (await SaheliTask.find({ ...scope, kind: "approval", status: { $in: ["approved", "denied"] }, "approval.notifiedAt": { $exists: false }, updatedAt: { $gte: new Date(now.getTime() - 24 * 3600_000) } }).limit(20).lean()) as ISaheliTask[];
        for (const t of decided) {
            const { notifyApprovalDecision } = await import("./approvals.service");
            if (await notifyApprovalDecision(t, opts).catch(() => false)) out.approvals++;
        }
        // 5) Expiry.
        const exp = (await SaheliTask.find({ ...scope, kind: { $in: ["open_task", "approval"] }, status: "open", expiresAt: { $lte: now } }).limit(50).lean()) as ISaheliTask[];
        for (const t of exp) {
            await closeTask(t.taskId, "expired", "expired", t.kind === "approval" ? "No caregiver decision in time" : "Not finished; Saheli stopped carrying it");
            if (t.kind === "open_task" && t.important) void log(t, `Unfinished and dropped: ${t.title}`, t.why ? `Why it mattered: ${t.why}` : undefined, "warn");
            out.expired++;
        }
        await SaheliTask.updateMany(
            { ...scope, kind: "open_task", status: "open", phase: "ended_in_chat", lastActiveAt: { $lte: new Date(now.getTime() - 30 * 60_000) } },
            { $set: { status: "cancelled", outcome: "ended", resolvedAt: now } },
        ).catch(() => undefined);
    } catch (err) {
        console.warn("[delegate] tick failed:", err instanceof Error ? err.message : err);
    } finally {
        if (!opts.onlyPhone) ticking = false;
    }
    if (out.asked || out.reasked || out.nudged || out.approvals) console.log(`[delegate] tick ${JSON.stringify(out)}`);
    return out;
}
