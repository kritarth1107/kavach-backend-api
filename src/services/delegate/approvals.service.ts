/**
 * Outside-permission requests: Saheli asks a caregiver (dashboard + daily snapshot — not a
 * WhatsApp push, per the caregiver-alert rules), tells the elder, and follows through when the
 * caregiver decides (approved → she offers to finish it; denied → gentle word).
 */
import { randomUUID } from "crypto";
import SaheliTask, { type ISaheliTask } from "../../models/saheliTask.model";
import { STALE_MS, taskTitle, whenIST } from "./tasks.service";
import { sendDelegateMessage } from "./send.service";
import { whyToken } from "./why.service";

type Who = { phone: string; familyId: string; recipientUserId: string; ownerUserId: string };

export async function createApproval(
    who: Who,
    a: { reason: "category_off" | "store_off" | "over_limit"; detail: string; amountPaise?: number | null; requestedText?: string; item?: string | null; productQuery?: string | null; partner?: string | null; category?: string | null; why?: string | null; language?: string | null },
): Promise<ISaheliTask> {
    const recent = (await SaheliTask.findOne({ phone: who.phone, kind: "approval", status: "open", createdAt: { $gte: new Date(Date.now() - 2 * 3600_000) } }).sort({ createdAt: -1 }).lean()) as ISaheliTask | null;
    if (recent && whyToken(recent.item || "") === whyToken(a.item || "") && recent.approval?.reason === a.reason) return recent;
    const doc: Partial<ISaheliTask> = {
        taskId: randomUUID(),
        ...who,
        actorRole: "elder",
        kind: "approval",
        status: "open",
        item: a.item || a.productQuery || undefined,
        productQuery: a.productQuery || a.item || undefined,
        partner: a.partner || undefined,
        category: (a.category as ISaheliTask["category"]) || undefined,
        why: a.why || undefined,
        language: a.language || undefined,
        approval: { reason: a.reason, detail: a.detail.slice(0, 300), amountPaise: a.amountPaise ?? null, requestedText: a.requestedText?.slice(0, 300) },
        history: [{ at: new Date(), event: "requested", note: a.detail.slice(0, 200) }],
        expiresAt: new Date(Date.now() + 24 * 3600_000),
    };
    doc.title = `Approve: ${taskTitle({ ...doc, kind: "open_task" } as ISaheliTask).replace(/^Order /, "")}`;
    const created = (await SaheliTask.create(doc)).toObject() as ISaheliTask;
    const { logActivity } = await import("../activityLog.service");
    void logActivity({
        familyId: who.familyId,
        recipientUserId: who.recipientUserId,
        actorUserId: who.ownerUserId,
        kind: "followup",
        severity: "warn",
        title: `Waiting for your OK: ${created.item || "a request"}`,
        detail: a.detail,
        data: { source: "delegate", taskId: created.taskId, approval: true },
    });
    return created;
}

/** An approval that already covers this pending order (same item, or amount within what was approved). */
export async function approvedCover(phone: string, item: string | null, paise: number | null): Promise<ISaheliTask | null> {
    const rows = (await SaheliTask.find({ phone, kind: "approval", status: "approved", "approval.decidedAt": { $gte: new Date(Date.now() - 24 * 3600_000) } }).lean()) as ISaheliTask[];
    const tok = whyToken(item || "");
    return (
        rows.find((r) => (tok && whyToken(r.item || "") === tok) || (paise != null && r.approval?.amountPaise != null && paise <= r.approval.amountPaise * 1.1)) || null
    );
}

export async function decideApproval(taskId: string, familyId: string, decision: "approve" | "deny", actor: { userId: string; name?: string }): Promise<ISaheliTask | null> {
    const t = (await SaheliTask.findOne({ taskId, familyId, kind: "approval" }).lean()) as ISaheliTask | null;
    if (!t || t.status !== "open") return t;
    const now = new Date();
    await SaheliTask.updateOne(
        { taskId },
        {
            $set: { status: decision === "approve" ? "approved" : "denied", resolvedAt: now, "approval.decidedBy": actor.userId, "approval.decidedByName": actor.name, "approval.decidedAt": now },
            $push: { history: { at: now, event: decision === "approve" ? "approved" : "denied", note: actor.name } },
        } as never,
    );
    const { logActivity } = await import("../activityLog.service");
    void logActivity({
        familyId: t.familyId,
        recipientUserId: t.recipientUserId,
        actorUserId: actor.userId,
        kind: "followup",
        title: `${actor.name || "Caregiver"} ${decision === "approve" ? "approved" : "said no to"}: ${t.item || "request"}`,
        detail: t.approval?.detail,
        data: { source: "delegate", taskId, approval: true, decision },
    });
    if (decision === "approve") {
        // She can now finish it: a resumable open task already "offered" by the approval message.
        await SaheliTask.updateMany({ phone: t.phone, kind: "open_task", status: "open" }, { $set: { status: "cancelled", outcome: "replaced", resolvedAt: now } });
        await SaheliTask.create({
            taskId: randomUUID(),
            familyId: t.familyId,
            recipientUserId: t.recipientUserId,
            ownerUserId: t.ownerUserId,
            phone: t.phone,
            actorRole: "elder",
            kind: "open_task",
            status: "open",
            title: taskTitle({ ...t, kind: "open_task" }),
            item: t.item,
            productQuery: t.productQuery,
            partner: t.partner,
            category: t.category,
            isMedicine: t.category === "pharmacy",
            important: true,
            why: t.why,
            language: t.language,
            flow: "approval",
            phase: "approved",
            lastActiveAt: new Date(now.getTime() - STALE_MS() - 60_000),
            resumeOfferedAt: now,
            resumeOfferCount: 1,
            nudgedAt: now,
            history: [{ at: now, event: "approved", note: `${actor.name || "Caregiver"} approved` }],
            expiresAt: new Date(now.getTime() + 48 * 3600_000),
        });
    }
    const fresh = (await SaheliTask.findOne({ taskId }).lean()) as ISaheliTask;
    await notifyApprovalDecision(fresh).catch(() => false);
    return (await SaheliTask.findOne({ taskId }).lean()) as ISaheliTask;
}

/** Tell her the caregiver's answer (quiet hours respected; a direct answer, so no 60-min window). */
export async function notifyApprovalDecision(t: ISaheliTask, opts: { bypassGate?: boolean; bypassQuiet?: boolean } = {}): Promise<boolean> {
    if (t.approval?.notifiedAt) return false;
    const approved = t.status === "approved";
    const facts = `Caregiver: ${t.approval?.decidedByName || "your family"}. What she asked for: ${t.item || "the order"}${t.partner ? ` on ${t.partner}` : ""}. Asked ${whenIST(t.createdAt)}. Reason it needed a yes: ${t.approval?.detail || ""}.`;
    const r = await sendDelegateMessage(t, approved ? "approval_approved" : "approval_denied", facts, { ...opts, direct: true });
    if (!r.sent) return false;
    await SaheliTask.updateOne({ taskId: t.taskId }, { $set: { "approval.notifiedAt": new Date() } });
    return true;
}
