/** Dashboard view of Saheli-as-delegate for one care recipient (family-scoped). */
import SaheliTask, { type ISaheliTask } from "../../models/saheliTask.model";
import { PERMISSION_STORES } from "../../models/saheliPermissions.model";
import { getPermissions, describePermissions, LOCKED_RULES, STORE_LABEL, STORE_CATEGORY } from "./permissions.service";
import { listWhys } from "./why.service";
import { phaseWords, whenIST } from "./tasks.service";

function taskView(t: ISaheliTask) {
    return {
        taskId: t.taskId,
        kind: t.kind,
        status: t.status,
        title: t.title,
        item: t.item ?? null,
        partner: t.partner ?? null,
        category: t.category ?? null,
        isMedicine: Boolean(t.isMedicine),
        important: Boolean(t.important),
        why: t.why ?? null,
        whyId: t.whyId ?? null,
        byCaregiver: t.actorRole === "caregiver",
        flow: t.flow ?? null,
        phase: t.phase ?? null,
        whereStopped: t.kind === "open_task" ? phaseWords(t.phase) : null,
        stage: t.stage ?? null,
        lastActiveAt: t.lastActiveAt ?? null,
        resumeOfferedAt: t.resumeOfferedAt ?? null,
        nudgedAt: t.nudgedAt ?? null,
        placedAt: t.placedAt ?? null,
        dueAt: t.dueAt ?? null,
        askedAt: t.askedAt ?? null,
        askCount: t.askCount ?? 0,
        lastSaheliLine: t.lastSaheliLine ?? null,
        outcome: t.outcome ?? null,
        outcomeNote: t.outcomeNote ?? null,
        resolvedAt: t.resolvedAt ?? null,
        approval: t.approval
            ? { reason: t.approval.reason, detail: t.approval.detail, amountPaise: t.approval.amountPaise ?? null, decidedByName: t.approval.decidedByName ?? null, decidedAt: t.approval.decidedAt ?? null, notifiedAt: t.approval.notifiedAt ?? null }
            : null,
        expiresAt: t.expiresAt,
        createdAt: t.createdAt ?? null,
        history: (t.history || []).slice(-8),
    };
}

export async function delegateSummary(familyId: string, recipientUserId: string) {
    const perms = await getPermissions(familyId);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const rows = (await SaheliTask.find({ familyId, recipientUserId, updatedAt: { $gte: since } }).sort({ updatedAt: -1 }).limit(120).lean()) as ISaheliTask[];
    const openTasks = rows.filter((t) => t.kind === "open_task" && t.status === "open" && t.phase !== "ended_in_chat");
    const followups = rows.filter((t) => t.kind === "followup" && (t.status === "open" || t.status === "asked"));
    const approvals = rows.filter((t) => t.kind === "approval" && t.status === "open");
    const recent = rows.filter((t) => !openTasks.includes(t) && !followups.includes(t) && !approvals.includes(t) && !(t.kind === "open_task" && t.outcome === "replaced")).slice(0, 20);
    const whys = await listWhys({ familyId, recipientUserId }, 20);
    return {
        permissions: {
            groceries: perms.groceries,
            food: perms.food,
            medicines: perms.medicines,
            rides: perms.rides,
            spendSoftLimitInr: perms.spendSoftLimitInr,
            deliveryFollowUps: perms.deliveryFollowUps,
            medicineStartCheck: perms.medicineStartCheck,
            resumeNudges: perms.resumeNudges,
            stores: PERMISSION_STORES.map((s) => ({ key: s, label: STORE_LABEL[s], category: STORE_CATEGORY[s], allowed: perms.stores[s] })),
            locked: LOCKED_RULES,
            summary: describePermissions(perms),
            history: perms.history.slice(-8).reverse(),
            updatedAt: perms.updatedAt ?? null,
        },
        openTasks: openTasks.map(taskView),
        followups: followups.map(taskView),
        approvals: approvals.map(taskView),
        recent: recent.map(taskView),
        whys: whys.map((y) => ({
            whyId: y.whyId,
            subject: y.subject,
            reason: y.reason,
            category: y.category ?? null,
            status: y.status,
            importance: y.importance,
            source: y.source,
            partner: y.partner ?? null,
            updates: (y.updates || []).slice(-6).reverse(),
            createdAt: y.createdAt ?? null,
            updatedAt: y.updatedAt ?? null,
        })),
    };
}

/** Lines for the daily snapshot (what's still open, what Saheli checked, what needs a caregiver). */
export async function delegateSnapshotLines(familyId: string, recipientUserId: string, dayKey: string): Promise<{ highlights: string[]; concerns: string[] }> {
    const start = new Date(`${dayKey}T00:00:00+05:30`);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = (await SaheliTask.find({ familyId, recipientUserId, updatedAt: { $gte: new Date(start.getTime() - 2 * 86_400_000) } }).lean().catch(() => [])) as ISaheliTask[];
    const highlights: string[] = [];
    const concerns: string[] = [];
    for (const t of rows) {
        const resolvedToday = t.resolvedAt && new Date(t.resolvedAt) >= start && new Date(t.resolvedAt) < end;
        if (t.kind === "approval" && t.status === "open") concerns.push(`Waiting for your OK: ${t.approval?.detail || t.item}`);
        else if (t.kind === "open_task" && t.status === "open" && t.phase !== "ended_in_chat") concerns.push(`Unfinished with Saheli: ${t.title} (left ${whenIST(t.lastActiveAt)}${t.why ? ` — ${t.why}` : ""})`);
        else if (t.kind === "followup" && resolvedToday && ["arrived", "started", "reached"].includes(String(t.outcome))) highlights.push(`Saheli checked: ${t.item} — ${t.outcome === "started" ? "started ✓" : t.outcome === "reached" ? "reached safely ✓" : "arrived ✓"}`);
        else if (t.kind === "followup" && resolvedToday && ["wrong_item", "damaged", "not_started", "unanswered", "no_answer"].includes(String(t.outcome || t.status))) concerns.push(`Follow-up: ${t.item} — ${String(t.outcome || t.status).replace(/_/g, " ")}${t.outcomeNote ? ` (${t.outcomeNote})` : ""}`);
        else if (t.kind === "followup" && t.outcome === "not_arrived" && t.status === "open") concerns.push(`Delivery issue: ${t.item} hadn't arrived when Saheli checked`);
    }
    return { highlights: highlights.slice(0, 3), concerns: concerns.slice(0, 4) };
}
