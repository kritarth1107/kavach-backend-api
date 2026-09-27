/**
 * Durable open tasks (Mongo, not memory): what Saheli was in the middle of for this phone, so a
 * later "hi" / "haan wo kar do" (hours or days later, after restarts / the 24 h session TTL)
 * resumes it without re-briefing.
 */
import { randomUUID } from "crypto";
import SaheliTask, { type ISaheliTask } from "../../models/saheliTask.model";
import WhatsappSession from "../../models/whatsappSession.model";
import ActivityLog from "../../models/activityLog.model";

export const STALE_MS = () => (Number(process.env.DELEGATE_RESUME_STALE_MIN) || 40) * 60_000;
const TASK_TTL_H = (medicine: boolean) => (medicine ? Number(process.env.DELEGATE_MED_TASK_TTL_H) || 72 : Number(process.env.DELEGATE_TASK_TTL_H) || 48);

export type FlowSnapshot = {
    flow: "browser" | "pharmacy" | "ride" | "order_chat" | "offer" | "search";
    phase: string;
    item?: string;
    productQuery?: string;
    partner?: string;
    category?: ISaheliTask["category"];
    rideFrom?: string;
    rideTo?: string;
};

const live = (d: unknown): boolean => {
    const ph = d && typeof d === "object" ? (d as { phase?: string }).phase : undefined;
    return Boolean(ph) && ph !== "idle" && ph !== "done";
};
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 140) : undefined);
const cat = (v: unknown): ISaheliTask["category"] => (v === "grocery" || v === "food" || v === "pharmacy" || v === "ride" ? v : v ? "other" : undefined);

/** The one live flow in a WhatsApp session doc (priority: order draft > pharmacy > ride > chat > offer > search). */
export function snapshotSession(doc: Record<string, any> | null | undefined, familyId?: string): FlowSnapshot | null {
    if (!doc) return null;
    const bd: any = doc.browserTaskDraft;
    if (live(bd)) {
        return {
            flow: "browser",
            phase: bd.phase,
            item: str(bd.selectedSku?.name) || str(bd.mcpCard?.itemLine) || str(bd.productQuery) || str(bd.dishQuery) || str(bd.pendingRoute?.query),
            productQuery: str(bd.productQuery) || str(bd.dishQuery) || str(bd.pendingRoute?.query),
            partner: str(bd.selectedSku?.partner) || (bd.partner && bd.partner !== "generic" ? str(bd.partner) : undefined) || str(bd.pendingRoute?.partner),
            category: cat(bd.category || bd.pendingRoute?.category),
        };
    }
    const pd: any = doc.pharmacyDraft;
    if (live(pd)) {
        return {
            flow: "pharmacy",
            phase: pd.phase,
            item: str(pd.items?.[0]?.name) || str(pd.searchQuery),
            productQuery: str(pd.searchQuery) || str(pd.items?.[0]?.name),
            partner: str(pd.partner),
            category: "pharmacy",
        };
    }
    const rd: any = doc.rideDraft;
    if (live(rd)) {
        return {
            flow: "ride",
            phase: rd.phase,
            item: "ride",
            category: "ride",
            rideFrom: str(rd.pickup?.shortLabel) || str(rd.pickup?.text) || str(rd.pickup),
            rideTo: str(rd.drop?.shortLabel) || str(rd.drop?.text) || str(rd.drop),
            partner: "uber",
        };
    }
    const oc = doc.orderChat;
    if (oc?.updatedAt && Date.now() - Number(oc.updatedAt) < 25 * 60_000) {
        return { flow: "order_chat", phase: "choosing", category: cat(oc.category), partner: str(oc.partner) };
    }
    const po = doc.pendingOffer;
    if (po?.query && (!familyId || po.familyId === familyId) && po.at && Date.now() - new Date(po.at).getTime() < 6 * 3600_000) {
        return { flow: "offer", phase: "offer_waiting", item: str(po.query), productQuery: str(po.query), partner: str(po.partner) };
    }
    const ps = doc.pendingSearch;
    if (ps?.at && (!familyId || ps.familyId === familyId) && Date.now() - new Date(ps.at).getTime() < 10 * 60_000) {
        return { flow: "search", phase: "searching", item: str(ps.retry?.query), productQuery: str(ps.retry?.query), partner: str(ps.retry?.partner) };
    }
    return null;
}

export async function snapshotPhone(phone: string, familyId?: string): Promise<FlowSnapshot | null> {
    const doc = await WhatsappSession.findOne({ phone }).lean().catch(() => null);
    return snapshotSession(doc as Record<string, any> | null, familyId);
}

export function taskTitle(t: Pick<ISaheliTask, "item" | "productQuery" | "partner" | "category" | "rideFrom" | "rideTo" | "kind" | "flow">): string {
    const P: Record<string, string> = { instamart: "Instamart", zepto: "Zepto", blinkit: "Blinkit", swiggy: "Swiggy", zomato: "Zomato", apollo: "Apollo", pharmeasy: "PharmEasy", tata_1mg: "Tata 1mg", uber: "Uber" };
    if (t.category === "ride") return `Ride${t.rideFrom ? ` from ${t.rideFrom}` : ""}${t.rideTo ? ` to ${t.rideTo}` : ""}`;
    const what = t.item || t.productQuery || (t.category === "food" ? "food" : t.category === "pharmacy" ? "medicines" : "an order");
    return `${t.kind === "followup" ? "" : "Order "}${what}${t.partner && P[t.partner] ? ` (${P[t.partner]})` : ""}`.trim();
}

function sameThing(t: ISaheliTask, s: FlowSnapshot): boolean {
    if (s.flow === "ride" || t.category === "ride") return s.flow === "ride" && t.category === "ride";
    const a = (t.productQuery || t.item || "").toLowerCase();
    const b = (s.productQuery || s.item || "").toLowerCase();
    if (!a || !b) return true; // chat → search → card of the same ask
    const tok = (x: string) => x.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).find((w) => w.length >= 3) || x;
    return a.includes(tok(b)) || b.includes(tok(a));
}

export async function openTaskFor(phone: string): Promise<(ISaheliTask & { _id: unknown }) | null> {
    return (await SaheliTask.findOne({ phone, kind: "open_task", status: "open" }).sort({ updatedAt: -1 }).lean().catch(() => null)) as never;
}

type Who = { phone: string; familyId: string; recipientUserId: string; ownerUserId: string; role: "elder" | "caregiver" };

/**
 * After every inbound turn: keep the durable open task in step with the live flow.
 *  - live flow now → create / refresh (a different item replaces the old task)
 *  - flow was live before this turn and is gone now → this turn ended it (placed / cancelled)
 * A flow that disappears WITHOUT a turn (24 h session TTL, restart) keeps the task open.
 */
export async function syncOpenTask(
    who: Who,
    before: FlowSnapshot | null,
    after: FlowSnapshot | null,
    lines: { user?: string; saheli?: string; productQuery?: string | null; category?: string | null; language?: string | null },
): Promise<ISaheliTask | null> {
    const now = new Date();
    const cur = await openTaskFor(who.phone);
    if (after) {
        const pq = after.productQuery || lines.productQuery || undefined;
        const item = after.item || pq;
        if (cur && sameThing(cur as ISaheliTask, { ...after, productQuery: pq, item })) {
            // The turn that just offered to finish it didn't move the order on — keep the offer open.
            if (cur.resumeOfferedAt && now.getTime() - new Date(cur.resumeOfferedAt).getTime() < 5 * 60_000 && after.phase === cur.phase) return cur as ISaheliTask;
            const set: Record<string, unknown> = {
                flow: after.flow,
                phase: after.phase,
                lastActiveAt: now,
                lastSaheliLine: lines.saheli?.slice(0, 600),
                lastUserLine: lines.user?.slice(0, 300),
            };
            if (item && (!cur.item || after.item)) set.item = item;
            if (pq && !cur.productQuery) set.productQuery = pq;
            if (after.partner) set.partner = after.partner;
            if (after.category || lines.category) set.category = after.category || cat(lines.category);
            if (after.rideFrom) set.rideFrom = after.rideFrom;
            if (after.rideTo) set.rideTo = after.rideTo;
            if (lines.language) set.language = lines.language;
            const merged = { ...cur, ...set } as ISaheliTask;
            set.title = taskTitle(merged);
            await SaheliTask.updateOne({ taskId: cur.taskId }, { $set: set, $unset: { resumeOfferedAt: 1 } });
            return merged;
        }
        if (cur) await closeTask(cur.taskId, "cancelled", "replaced", `Moved on to ${item || "something else"}`);
        const category = after.category || cat(lines.category);
        const medicine = category === "pharmacy";
        const doc: Partial<ISaheliTask> = {
            taskId: randomUUID(),
            familyId: who.familyId,
            recipientUserId: who.recipientUserId,
            ownerUserId: who.ownerUserId,
            phone: who.phone,
            actorRole: who.role,
            kind: "open_task",
            status: "open",
            item,
            productQuery: pq,
            partner: after.partner,
            category,
            isMedicine: medicine,
            important: medicine,
            flow: after.flow,
            phase: after.phase,
            rideFrom: after.rideFrom,
            rideTo: after.rideTo,
            language: lines.language || undefined,
            lastActiveAt: now,
            lastSaheliLine: lines.saheli?.slice(0, 600),
            lastUserLine: lines.user?.slice(0, 300),
            history: [{ at: now, event: "started", note: lines.user?.slice(0, 160) }],
            expiresAt: new Date(now.getTime() + TASK_TTL_H(medicine) * 3600_000),
        };
        doc.title = taskTitle(doc as ISaheliTask);
        const created = (await SaheliTask.create(doc)).toObject() as ISaheliTask;
        return created;
    }
    if (before && cur) {
        // This turn ended the flow. A placement in the last minutes closes it as done (the
        // order hook also does); otherwise she cancelled / it finished without an order.
        const placed = await ActivityLog.findOne({ recipientUserId: who.recipientUserId, kind: { $in: ["order_placed", "ride"] }, createdAt: { $gte: new Date(now.getTime() - 5 * 60_000) } }).lean().catch(() => null);
        if (placed) await closeTask(cur.taskId, "done", "placed");
        else await SaheliTask.updateOne({ taskId: cur.taskId }, { $set: { phase: "ended_in_chat", lastActiveAt: now, lastUserLine: lines.user?.slice(0, 300) } });
        // Kept open for a short grace: a background checkout may still land (order hook closes it)
        // or fail (order hook re-opens it). Cancel intent is handled by the turn hook.
    }
    return null;
}

export async function closeTask(taskId: string, status: ISaheliTask["status"], outcome: string, note?: string): Promise<void> {
    await SaheliTask.updateOne(
        { taskId },
        { $set: { status, outcome, outcomeNote: note?.slice(0, 400), resolvedAt: new Date() }, $push: { history: { at: new Date(), event: status, note: note?.slice(0, 200) || outcome } } } as never,
    ).catch(() => undefined);
}

/** Open tasks worth offering to resume: quiet for a while, not expired. */
export async function resumableTasks(phone: string, now = Date.now()): Promise<ISaheliTask[]> {
    const rows = (await SaheliTask.find({ phone, kind: "open_task", status: "open", expiresAt: { $gt: new Date(now) } })
        .sort({ updatedAt: -1 })
        .limit(3)
        .lean()
        .catch(() => [])) as ISaheliTask[];
    // Stale (left a while ago) — or offered to finish in the last 30 min (her "yes" answers that offer,
    // even though the offer turn itself touched the task).
    const justOffered = (t: ISaheliTask) => Boolean(t.resumeOfferedAt) && now - new Date(t.resumeOfferedAt!).getTime() < 30 * 60_000;
    return rows.filter((t) => t.phase === "ended_in_chat" ? false : justOffered(t) || (t.lastActiveAt && now - new Date(t.lastActiveAt).getTime() >= STALE_MS()));
}

export function whenIST(d: Date | string | undefined, now = new Date()): string {
    if (!d) return "earlier";
    const at = new Date(d);
    const day = (x: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(x);
    const time = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(at);
    if (day(at) === day(now)) return `today ${time}`;
    if (day(at) === day(new Date(now.getTime() - 86_400_000))) return `yesterday ${time}`;
    return `${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }).format(at)} ${time}`;
}

const PHASE_WORDS: Record<string, string> = {
    awaiting_sku_confirm: "options were shown, nothing picked yet",
    awaiting_confirm: "confirm card was shown, waiting for *confirm*",
    awaiting_mcp_confirm: "confirm card was shown, waiting for *confirm*",
    awaiting_restaurant_pick: "restaurants were shown",
    awaiting_address: "waiting for the delivery address",
    awaiting_address_confirm: "waiting to confirm the delivery address",
    awaiting_otp: "waiting for a login code",
    searching: "search was running",
    offer_waiting: "Saheli had offered to try it and was waiting for a yes",
    choosing: "was helping choose",
    failed: "the order didn't go through",
    approved: "the caregiver approved it — waiting for the go-ahead",
    why_check: "asked if it's still wanted (doctor had stopped it)",
    store_alt: "the usual app is switched off; Saheli offered the allowed app",
    reorder: "Saheli offered to order it again",
    confirm_basket: "medicine options and price were shown, waiting for *confirm*",
    review_cart: "the cart was shown, waiting for *confirm*",
    select_address: "choosing the delivery address",
    browse: "was looking through options",
    running: "search was running",
    pick_partner: "choosing which app to use",
    ask_list_or_rx: "asked for the medicine list or prescription",
    awaiting_rx_photo: "waiting for a prescription photo",
    ask_uber_phone: "waiting for the Uber number",
    need_pickup: "waiting for the pickup place",
    need_drop: "waiting for where to go",
    need_slots: "waiting for ride details",
    confirming_route: "the ride route was shown, waiting for an OK",
    awaiting_book_confirm: "the ride fare was shown, waiting for *confirm*",
    post_otp: "signed in, finishing the order",
};
export function phaseWords(phase?: string): string {
    if (!phase) return "in progress";
    return PHASE_WORDS[phase] || phase.replace(/_/g, " ");
}

/** Recent chat for prompts: the router's turn buffer, else the durable activity log (elder). */
export async function recentChat(phone: string, recipientUserId: string, isElder: boolean, hours = 6): Promise<string> {
    const { recentTurns } = await import("../saheliRouter.service");
    const mem = recentTurns(phone);
    if (mem.split("\n").length >= 3 || !isElder) return mem;
    const rows = await ActivityLog.find({ recipientUserId, kind: { $in: ["message_in", "voice_note", "message_out", "nudge"] }, createdAt: { $gte: new Date(Date.now() - hours * 3600_000) } })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean()
        .catch(() => []);
    const lines = rows
        .reverse()
        .map((r) => `${r.kind === "message_in" || r.kind === "voice_note" ? "User" : "Saheli"}: ${String(r.detail || r.title || "").replace(/\s+/g, " ").slice(0, 240)}`);
    return lines.join("\n") || mem;
}
