/**
 * Saheli as a persistent delegate — the WhatsApp turn hook.
 *   before routing : interpretEarly() runs IN PARALLEL with the router (no added latency) when
 *                    something is pending: an asked follow-up, a resumable task, a caregiver
 *                    approval, or a remembered WHY this message mentions.
 *   after routing  : preDispatch() applies it (follow-up answers, resume / offer, approvals, why
 *                    updates) and enforces the family's permissions on the route.
 *   after the reply: afterTurn() keeps the durable open task in step with the live flow.
 */
import SaheliTask, { type ISaheliTask } from "../../models/saheliTask.model";
import WhatsappSession from "../../models/whatsappSession.model";
import type { SaheliRoute } from "../saheliRouter.service";
import { interpretDelegateTurn, connectWhy, writeProactiveLine, type DelegateDecision, type WhyChange } from "./delegateGemini";
import { closeTask, phaseWords, recentChat, resumableTasks, snapshotSession, syncOpenTask, taskTitle, whenIST, STALE_MS, type FlowSnapshot } from "./tasks.service";
import { applyWhyChange, findWhy, whysMentionedIn, whySentence } from "./why.service";
import { allowedAlternative, categoryAllowed, getPermissions, pendingOrderTotal, STORE_LABEL, storeAllowed, isKnownStore } from "./permissions.service";
import { approvedCover, createApproval, decideApproval } from "./approvals.service";
import type { ISaheliWhy } from "../../models/saheliWhy.model";

type Identity = { familyId: string; userId: string; role: string };
const isCaregiverRole = (r: string) => r === "PRIMARY_CAREGIVER" || r === "CO_CAREGIVER";

export type EarlyCtx = {
    decision: DelegateDecision | null;
    followups: ISaheliTask[];
    tasks: ISaheliTask[];
    approvals: ISaheliTask[];
    whyChange: WhyChange | null;
    whys: ISaheliWhy[];
    subjectUserId: string;
};

async function subjectFor(identity: Identity): Promise<string> {
    if (!isCaregiverRole(identity.role)) return identity.userId;
    try {
        const Family = (await import("../../models/family.model")).default;
        const fam = await Family.findOne({ familyId: identity.familyId }).lean();
        const rec = (fam?.members || []).filter((m: { role?: string; userId?: string; status?: string }) => m.role === "CARE_RECIPIENT" && m.userId);
        return rec.length === 1 ? String(rec[0]!.userId) : identity.userId;
    } catch {
        return identity.userId;
    }
}

function nowIST(): string {
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date());
}

/** Kick off BEFORE the router; resolves to null quickly when nothing is pending. */
export async function interpretEarly(input: { phone: string; text: string; identity: Identity }): Promise<EarlyCtx | null> {
    if (process.env.DELEGATE_ENABLED === "false") return null;
    const { phone, text, identity } = input;
    if (!text.trim() || /^\[(image|document|video|audio|voice|sticker)/i.test(text)) return null;
    const role = isCaregiverRole(identity.role) ? "caregiver" : "elder";
    const now = Date.now();
    const [followups, allTasks, approvals, subjectUserId, session] = await Promise.all([
        SaheliTask.find({
            phone,
            kind: "followup",
            $or: [
                { status: "asked", askedAt: { $gte: new Date(now - 36 * 3600_000) } },
                // She already said it hadn't come: "pehle wali aa gayi" must still land here.
                { status: "open", outcome: "not_arrived", askedAt: { $gte: new Date(now - 72 * 3600_000) } },
            ],
        })
            .sort({ askedAt: -1 })
            .limit(3)
            .lean() as Promise<ISaheliTask[]>,
        resumableTasks(phone, now),
        role === "caregiver"
            ? (SaheliTask.find({ familyId: identity.familyId, kind: "approval", status: "open", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).limit(3).lean() as Promise<ISaheliTask[]>)
            : Promise.resolve([] as ISaheliTask[]),
        subjectFor(identity),
        WhatsappSession.findOne({ phone }).lean().catch(() => null),
    ]);
    // A flow that is still alive in the session (touched recently — e.g. options just pushed, a
    // confirm card waiting) belongs to the normal flow, not to "resume".
    const sessionFresh =
        Boolean(snapshotSession(session as Record<string, any> | null, identity.familyId)) &&
        now - new Date((session as { updatedAt?: Date } | null)?.updatedAt || 0).getTime() < STALE_MS();
    const tasks = sessionFresh ? allTasks.filter((t) => ["approval", "reorder", "why_check", "store_alt"].includes(String(t.flow))) : allTasks;
    const whys = await whysMentionedIn({ familyId: identity.familyId, recipientUserId: subjectUserId }, text).catch(() => [] as ISaheliWhy[]);
    if (!followups.length && !tasks.length && !approvals.length && !whys.length) return null;
    const chat = await recentChat(phone, subjectUserId, role === "elder", 24).catch(() => "");
    const [decision, whyChange] = await Promise.all([
        followups.length || tasks.length || approvals.length
            ? interpretDelegateTurn({
                  role,
                  message: text,
                  recentChat: chat,
                  now: nowIST(),
                  followups: followups.map(
                      (t) =>
                          `[${t.taskId}] asked ${whenIST(t.askedAt)}: "${(t.lastSaheliLine || "").slice(0, 160)}" — item: ${t.item}; stage=${t.stage}; medicine=${t.isMedicine ? "yes" : "no"}${t.outcome === "not_arrived" ? "; she said earlier it had NOT arrived" : ""}${reorderStarted(t) ? "; a re-order search was started (NOT placed) — if the first one has now arrived, say you won't order the new one" : ""}${t.why ? `; WHY: ${t.why}` : ""}`,
                  ),
                  openTasks: tasks.map((t) => `[${t.taskId}] ${taskTitle(t)} — left ${whenIST(t.lastActiveAt)}; where it stopped: ${phaseWords(t.phase)}; offered=${t.resumeOfferedAt ? `yes (${whenIST(t.resumeOfferedAt)})` : "no"}${t.why ? `; WHY: ${t.why}` : ""}`),
                  approvals: approvals.map((t) => `[${t.taskId}] ${t.item || "request"}${t.partner ? ` on ${t.partner}` : ""} — ${t.approval?.detail || ""} (asked ${whenIST(t.createdAt)})`),
              }).catch(() => null)
            : Promise.resolve(null),
        whys.length ? connectWhy({ message: text, role, whys: whys.map((y) => ({ id: y.whyId, subject: y.subject, reason: y.reason, status: y.status })), recentChat: chat }).catch(() => null) : Promise.resolve(null),
    ]);
    return { decision, followups, tasks, approvals, whyChange, whys, subjectUserId };
}

export type PreDispatchResult = { reply: string } | { reroute: SaheliRoute; text: string; lead?: string } | { lead: string } | null;

function baseRoute(r: SaheliRoute | null, language?: string | null): SaheliRoute {
    return {
        intent: "order_new",
        language: (r?.language || (language === "english" || language === "en" ? "en" : "hinglish")) as SaheliRoute["language"],
        newLanguage: null,
        category: null,
        productQuery: null,
        quantity: null,
        partners: [],
        partnerOnly: false,
        restaurantName: null,
        control: "none",
        pickIndex: null,
        addressKind: null,
        addressText: null,
        addressNickname: null,
        placeName: null,
        otpCode: null,
        ridePickup: null,
        rideDrop: null,
        blockedItem: null,
        confidence: 0.9,
        source: "gemini",
        latencyMs: r?.latencyMs ?? 0,
    };
}

async function clearStaleDrafts(phone: string): Promise<void> {
    await WhatsappSession.updateOne({ phone }, { $unset: { browserTaskDraft: 1, pharmacyDraft: 1, rideDraft: 1, orderChat: 1, pendingOffer: 1, pendingSearch: 1 } }).catch(() => undefined);
}

async function logFollow(t: Pick<ISaheliTask, "familyId" | "recipientUserId" | "ownerUserId" | "taskId">, title: string, detail?: string | null, severity: "info" | "warn" = "info", data: Record<string, unknown> = {}) {
    const { logActivity } = await import("../activityLog.service");
    void logActivity({ familyId: t.familyId, recipientUserId: t.recipientUserId, actorUserId: t.ownerUserId, kind: "followup", title, detail: detail || undefined, severity, data: { source: "delegate", taskId: t.taskId, ...data } });
}

const reorderStarted = (t: ISaheliTask) => (t.history || []).some((h) => h.event === "reorder_started");

function nextMorning(hh = 10): Date {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + 20 * 3600_000));
    return new Date(`${day}T${String(hh).padStart(2, "0")}:00:00+05:30`);
}

/** A reorder offer she can accept with "haan" (resumable open task, already offered). */
async function offerReorder(t: ISaheliTask, note: string, opts: { flow?: string; partner?: string } = {}): Promise<void> {
    await SaheliTask.updateMany({ phone: t.phone, kind: "open_task", status: "open" }, { $set: { status: "cancelled", outcome: "replaced", resolvedAt: new Date() } });
    const { randomUUID } = await import("crypto");
    await SaheliTask.create({
        taskId: randomUUID(),
        familyId: t.familyId,
        recipientUserId: t.recipientUserId,
        ownerUserId: t.ownerUserId,
        phone: t.phone,
        actorRole: t.actorRole,
        kind: "open_task",
        status: "open",
        title: taskTitle({ ...t, partner: opts.partner || t.partner, kind: "open_task" }),
        item: t.item,
        productQuery: t.productQuery || t.item,
        partner: opts.partner || t.partner,
        category: t.category,
        isMedicine: t.isMedicine,
        important: t.important,
        why: t.why,
        whyId: t.whyId,
        language: t.language,
        flow: opts.flow || "reorder",
        phase: opts.flow || "reorder",
        orderRef: opts.flow ? undefined : t.taskId,
        lastActiveAt: new Date(Date.now() - STALE_MS() - 60_000),
        resumeOfferedAt: new Date(),
        resumeOfferCount: 1,
        nudgedAt: new Date(),
        history: [{ at: new Date(), event: "reorder_offered", note: note.slice(0, 200) }],
        expiresAt: new Date(Date.now() + 24 * 3600_000),
    });
}

async function applyFollowup(t: ISaheliTask, d: DelegateDecision, route: SaheliRoute | null): Promise<PreDispatchResult> {
    const w = { familyId: t.familyId, recipientUserId: t.recipientUserId };
    const now = new Date();
    const say = (fallback: string) => ({ reply: d.reply || fallback });
    const note = d.note || undefined;
    const hist = (event: string) => ({ $push: { history: { at: now, event, note: note?.slice(0, 200) } } });
    const perms = await getPermissions(t.familyId);
    switch (d.outcome) {
        case "arrived": {
            // The first one came after all: drop the redundant re-order search (never placed).
            if (reorderStarted(t)) await clearStaleDrafts(t.phone);
            if (t.isMedicine && t.stage === "delivery" && perms.medicineStartCheck) {
                await SaheliTask.updateOne({ taskId: t.taskId }, { $set: { stage: "started", status: "asked", askedAt: now, askCount: 1, lastSaheliLine: d.reply || "" }, ...hist("arrived") } as never);
            } else {
                await closeTask(t.taskId, "done", "arrived", note);
            }
            void logFollow(t, `${t.item} arrived ✓`, note ? `She said: ${note}` : undefined);
            return say("Achha hua 🙂");
        }
        case "started":
            await closeTask(t.taskId, "done", "started", note);
            if (t.whyId) void applyWhyChange(w, t.whyId, "started", `Started ${whenIST(now)}`, "followup").catch(() => undefined);
            void logFollow(t, `Started ${t.item} ✓`, note);
            return say("Bahut badhiya 🙂");
        case "not_started": {
            const again = (t.askCount || 0) < 3;
            await SaheliTask.updateOne({ taskId: t.taskId }, { $set: again ? { stage: "started", status: "open", dueAt: nextMorning(10) } : { status: "done", outcome: "not_started", resolvedAt: now }, ...hist("not_started") } as never);
            if (t.whyId) void applyWhyChange(w, t.whyId, "not_started", `Not started yet (${whenIST(now)})${note ? `: ${note}` : ""}`, "followup").catch(() => undefined);
            void logFollow(t, `Hasn't started ${t.item} yet`, [note, t.why ? `Why it matters: ${t.why}` : ""].filter(Boolean).join(" · "), t.important ? "warn" : "info");
            return say("Koi baat nahi 🙏");
        }
        case "doctor_stopped":
            await closeTask(t.taskId, "done", "doctor_stopped", note);
            if (t.whyId) void applyWhyChange(w, t.whyId, "stopped", note || `Doctor stopped it (${whenIST(now)})`, "followup").catch(() => undefined);
            void logFollow(t, `Doctor stopped ${t.item}`, note);
            return say("Theek hai, maine note kar liya 🙏");
        case "not_arrived":
        case "wrong_item":
        case "damaged": {
            const label = d.outcome === "not_arrived" ? "hasn't arrived" : d.outcome === "wrong_item" ? "wrong item delivered" : "arrived damaged";
            void logFollow(t, `Delivery issue: ${t.item} ${label}`, [note, t.placedAt ? `Ordered ${whenIST(t.placedAt)}${t.partner ? ` on ${t.partner}` : ""}` : "", t.why ? `Why it matters: ${t.why}` : ""].filter(Boolean).join(" · "), "warn", { issue: d.outcome });
            if (t.whyId) void applyWhyChange(w, t.whyId, "delivery_issue", `${label} (${whenIST(now)})`, "followup").catch(() => undefined);
            if (d.outcome === "not_arrived") {
                await SaheliTask.updateOne({ taskId: t.taskId }, { $set: { status: "open", dueAt: new Date(now.getTime() + 3 * 3600_000), outcome: "not_arrived" }, ...hist("not_arrived") } as never);
            } else {
                await closeTask(t.taskId, "done", d.outcome, note);
            }
            if (d.wantsReorder && t.productQuery) return reorderNow(t, route, d.reply);
            await offerReorder(t, label);
            return say("Oh ho 😟 Dobara mangwa doon?");
        }
        case "wait_more":
            await SaheliTask.updateOne({ taskId: t.taskId }, { $set: { status: "open", dueAt: new Date(now.getTime() + 3 * 3600_000) }, ...hist("wait_more") } as never);
            return say("Theek hai, thodi der mein phir poochungi 🙂");
        case "reached":
            await closeTask(t.taskId, "done", "reached", note);
            void logFollow(t, "Reached safely ✓", note);
            return say("Achha hua 🙂");
        case "ride_issue":
            await closeTask(t.taskId, "done", "ride_issue", note);
            void logFollow(t, "Ride issue", note, "warn", { issue: "ride" });
            return say("Oh 😟 Kya hua batayiye?");
        default:
            return d.reply ? { reply: d.reply } : null;
    }
}

async function reorderNow(t: ISaheliTask, route: SaheliRoute | null, lead?: string | null): Promise<PreDispatchResult> {
    const { riskyMedClass } = await import("../profile/unusualCore");
    const q = t.productQuery || t.item || "";
    if (!q || riskyMedClass(q)) return lead ? { reply: lead } : null;
    await clearStaleDrafts(t.phone);
    const r = { ...baseRoute(route, t.language), intent: (t.category === "ride" ? "ride" : "order_new") as SaheliRoute["intent"], productQuery: t.category === "ride" ? null : q, category: (t.category === "other" ? null : t.category || null) as SaheliRoute["category"], partners: t.partner && isKnownStore(t.partner) ? [t.partner] : [], ridePickup: t.rideFrom || null, rideDrop: t.rideTo || null };
    return { reroute: r, text: t.category === "ride" ? `book a cab${t.rideFrom ? ` from ${t.rideFrom}` : ""}${t.rideTo ? ` to ${t.rideTo}` : ""}` : q, lead: lead || undefined };
}

export async function preDispatch(input: {
    phone: string;
    text: string;
    identity: Identity;
    route: SaheliRoute | null;
    early: EarlyCtx | null;
}): Promise<PreDispatchResult> {
    if (process.env.DELEGATE_ENABLED === "false") return null;
    const { phone, text, identity, route, early } = input;
    if (route?.intent === "emergency") return null;
    const caregiver = isCaregiverRole(identity.role);
    const d = early?.decision;
    const who = { phone, familyId: identity.familyId, recipientUserId: early?.subjectUserId || identity.userId, ownerUserId: identity.userId };

    // 1) Follow-up answers / resume / approvals (model decided).
    if (d && d.target !== "none") {
        if (d.target === "followup") {
            const t = early!.followups.find((x) => x.taskId === d.taskId) || (early!.followups.length === 1 ? early!.followups[0] : undefined);
            if (t && d.outcome) {
                const r = await applyFollowup(t, d, route);
                if (r) return r;
            }
        }
        if (d.target === "resume") {
            const t = early!.tasks.find((x) => x.taskId === d.taskId) || (early!.tasks.length === 1 ? early!.tasks[0] : undefined);
            if (t && d.resumeAction === "offer" && d.reply) {
                await SaheliTask.updateOne({ taskId: t.taskId }, { $set: { resumeOfferedAt: new Date() }, $inc: { resumeOfferCount: 1 }, $push: { history: { at: new Date(), event: "offered", note: d.reply.slice(0, 200) } } } as never);
                return { reply: d.reply };
            }
            if (t && d.resumeAction === "resume") {
                await closeTask(t.taskId, "done", "resumed", `Resumed ${whenIST(new Date())}`);
                // The original delivery check stays open until the new order is actually placed.
                if (t.orderRef) await SaheliTask.updateOne({ taskId: t.orderRef, kind: "followup", status: { $in: ["open", "asked"] } }, { $push: { history: { at: new Date(), event: "reorder_started", note: text.slice(0, 120) } } } as never).catch(() => undefined);
                void logFollow(t, `Resumed: ${t.title}`, `Left ${whenIST(t.lastActiveAt)} (${phaseWords(t.phase)}); she said: "${text.slice(0, 120)}"`);
                const r = await reorderNow(t, route, d.reply);
                if (r) return r;
            }
            if (t && d.resumeAction === "decline") {
                await closeTask(t.taskId, "cancelled", "declined", text.slice(0, 160));
                void logFollow(t, `Dropped: ${t.title}`, `She said: "${text.slice(0, 120)}"`);
                if (d.reply) return { reply: d.reply };
            }
            if (t && d.resumeAction === "later") {
                await SaheliTask.updateOne({ taskId: t.taskId }, { $set: { resumeOfferedAt: new Date(), lastActiveAt: new Date() }, $push: { history: { at: new Date(), event: "later", note: text.slice(0, 160) } } } as never);
                if (d.reply) return { reply: d.reply };
            }
        }
        if (d.target === "approval" && caregiver && d.approvalDecision) {
            const t = early!.approvals.find((x) => x.taskId === d.taskId) || (early!.approvals.length === 1 ? early!.approvals[0] : undefined);
            if (t) {
                const { personName } = await import("./send.service");
                await decideApproval(t.taskId, identity.familyId, d.approvalDecision, { userId: identity.userId, name: await personName(identity.familyId, identity.userId) });
                return { reply: d.reply || (d.approvalDecision === "approve" ? "Done 👍 I'll let her know." : "Okay, I'll tell her gently 🙏") };
            }
        }
    }

    let whyLead: string | undefined;
    // 2) New information about a remembered WHY ("doctor ne Telma band kar di").
    const wc = early?.whyChange;
    if (wc && wc.change !== "none" && wc.whyId && early!.whys.some((y) => y.whyId === wc.whyId)) {
        const y = early!.whys.find((x) => x.whyId === wc.whyId)!;
        const updated = await applyWhyChange({ familyId: identity.familyId, recipientUserId: who.recipientUserId }, wc.whyId, wc.change, wc.note || `${wc.change} (${whenIST(new Date())})`, caregiver ? "caregiver_chat" : "chat").catch(() => null);
        if (updated) void logFollow({ ...who, taskId: "" }, `What changed: ${y.subject}`, wc.note, wc.change === "stopped" ? "warn" : "info", { whyId: y.whyId, change: wc.change });
        const commerceTurn = route && ["order_new", "order_modify", "order_control", "restaurant_list", "otp_code", "ride"].includes(route.intent);
        if (!commerceTurn && wc.ack) return { reply: wc.ack };
        // She's also ordering in the same breath ("Telma band, ab Cilacar mangwa do"): note it as a lead-in.
        if (commerceTurn && wc.ack && updated) whyLead = wc.ack;
    }

    if (!route || caregiver) return whyLead ? { lead: whyLead } : null; // permissions govern what Saheli does on her own for the elder

    // 3) Permissions (elder's own asks).
    const perms = await getPermissions(identity.familyId);
    const buying = route.intent === "order_new" || route.intent === "restaurant_list" || (route.intent === "order_modify" && (route.partners.length > 0 || Boolean(route.productQuery)));
    const category = route.intent === "restaurant_list" ? "food" : route.intent === "ride" ? "ride" : route.category;
    let cgName: string | null = null;
    const cg = async () => (cgName ??= await firstCaregiverName(identity.familyId));
    if ((buying || route.intent === "ride") && category && !categoryAllowed(perms, category)) {
        const what = route.productQuery || (category === "ride" ? "a ride" : category);
        const a = await createApproval(who, { reason: "category_off", detail: `${what} — ${category === "pharmacy" ? "ordering medicines" : category === "ride" ? "booking rides" : `ordering ${category}`} is switched off for Saheli`, requestedText: text, item: route.productQuery, productQuery: route.productQuery, partner: route.partners[0] || null, category, language: route.language });
        const line = await writeProactiveLine({ purpose: "outside_permission", facts: `She asked: "${text.slice(0, 160)}". Caregiver: ${await cg()}. This kind of order needs the caregiver's OK first.`, language: route.language }).catch(() => null);
        void a;
        return { reply: line || `Iske liye pehle ${await cg()} se poochna hota hai 🙏 Maine unhe pooch liya hai — haan hote hi bataungi.` };
    }
    if (buying && route.partners.length) {
        const off = route.partners.filter((p) => !storeAllowed(perms, p));
        if (off.length === route.partners.length) {
            const alt = allowedAlternative(perms, off[0]!);
            const offName = isKnownStore(off[0]) ? STORE_LABEL[off[0]] : off[0]!;
            const q = route.productQuery || (await currentQuery(phone));
            if (alt && q) {
                const cat = route.category === "pharmacy" || route.category === "food" || route.category === "grocery" ? route.category : "grocery";
                // A durable offer she can take with "haan" (the resume step reroutes it to the allowed app).
                await offerReorder(
                    { taskId: "", phone, familyId: identity.familyId, recipientUserId: who.recipientUserId, ownerUserId: identity.userId, actorRole: "elder", kind: "open_task", item: q, productQuery: q, category: cat, isMedicine: cat === "pharmacy", important: cat === "pharmacy", language: route.language } as unknown as ISaheliTask,
                    `${offName} is off; offered ${STORE_LABEL[alt]}`,
                    { flow: "store_alt", partner: alt },
                );
                const line = await writeProactiveLine({ purpose: "store_off_offer", facts: `She wants: ${q} on ${offName}. ${offName} is switched off by the family (${await cg()}). Allowed alternative: ${STORE_LABEL[alt]}.`, language: route.language }).catch(() => null);
                return { reply: line || `${offName} abhi band hai 🙏 ${STORE_LABEL[alt]} se ${q} mangwa doon?` };
            }
            await createApproval(who, { reason: "store_off", detail: `${q || "order"} on ${offName} — ${offName} is switched off`, requestedText: text, item: q, productQuery: q, partner: off[0], category, language: route.language });
            const line = await writeProactiveLine({ purpose: "outside_permission", facts: `She asked: "${text.slice(0, 160)}" on ${offName}, which the family switched off. Caregiver: ${await cg()}.`, language: route.language }).catch(() => null);
            return { reply: line || `${offName} ke liye pehle ${await cg()} se poochna hoga 🙏 Maine pooch liya hai.` };
        }
    }
    // At the literal *confirm*: store + soft spend limit (the confirm itself stays verbatim).
    if (route.control === "confirm") {
        const doc = (await WhatsappSession.findOne({ phone }).lean().catch(() => null)) as Record<string, unknown> | null;
        const pend = pendingOrderTotal(doc);
        if (pend) {
            const cover = await approvedCover(phone, pend.item, pend.paise);
            if (!cover && pend.partner && !storeAllowed(perms, pend.partner)) {
                const name = isKnownStore(pend.partner) ? STORE_LABEL[pend.partner] : pend.partner;
                await createApproval(who, { reason: "store_off", detail: `${pend.item || "order"} on ${name} — ${name} is switched off`, amountPaise: pend.paise, requestedText: text, item: pend.item, productQuery: pend.item, partner: pend.partner, language: route.language });
                const line = await writeProactiveLine({ purpose: "outside_permission", facts: `She confirmed ${pend.item} on ${name}, which the family switched off. Nothing was ordered. Caregiver: ${await cg()}.`, language: route.language }).catch(() => null);
                return { reply: line || `Ruk jaiye 🙏 ${name} ke liye pehle ${await cg()} se poochna hoga — maine pooch liya hai, abhi kuch order nahi hua.` };
            }
            if (!cover && perms.spendSoftLimitInr != null && pend.paise != null && pend.paise > perms.spendSoftLimitInr * 100) {
                const rs = `₹${Math.round(pend.paise / 100).toLocaleString("en-IN")}`;
                const lim = `₹${perms.spendSoftLimitInr.toLocaleString("en-IN")}`;
                const q = await currentQuery(phone);
                await createApproval(who, { reason: "over_limit", detail: `${pend.item || "Order"} for ${rs} — above the ${lim} limit`, amountPaise: pend.paise, requestedText: text, item: pend.item, productQuery: q || pend.item, partner: pend.partner, category: route.category, language: route.language });
                const line = await writeProactiveLine({ purpose: "outside_permission", facts: `She confirmed ${pend.item} for ${rs}. The family asked Saheli to check with ${await cg()} before orders above ${lim}. Nothing was ordered yet.`, language: route.language }).catch(() => null);
                return { reply: line || `Ye ${rs} ka hai — ${lim} se upar ke order ke liye ${await cg()} se poochti hoon 🙏 Abhi kuch order nahi hua.` };
            }
        }
    }
    // 4) A remembered WHY says the doctor stopped it → ask before searching.
    if (route.intent === "order_new" && route.productQuery) {
        const y = await findWhy({ familyId: identity.familyId, recipientUserId: identity.userId }, route.productQuery).catch(() => null);
        const recentOk = await SaheliTask.exists({ phone, kind: "open_task", flow: "why_check", status: "done", resolvedAt: { $gte: new Date(Date.now() - 30 * 60_000) } });
        if (y && y.status === "stopped" && !recentOk) {
            const { randomUUID } = await import("crypto");
            const last = (y.updates || []).filter((u) => u.kind === "stopped").slice(-1)[0];
            const line = await writeProactiveLine({ purpose: "why_stopped_check", facts: `She asked for ${route.productQuery}. Remembered: ${whySentence(y)}.${last ? ` Stopped note: ${last.note} (${whenIST(last.at)}).` : ""}`, language: route.language }).catch(() => null);
            const reply = line || `${y.subject} to doctor ne band ki thi na 🙏 Phir bhi mangwa doon?`;
            await SaheliTask.create({
                taskId: randomUUID(),
                ...who,
                actorRole: "elder",
                kind: "open_task",
                status: "open",
                title: `Order ${route.productQuery}`,
                item: route.productQuery,
                productQuery: route.productQuery,
                partner: route.partners[0],
                category: route.category || "pharmacy",
                isMedicine: true,
                important: true,
                why: y.reason,
                whyId: y.whyId,
                flow: "why_check",
                phase: "why_check",
                lastActiveAt: new Date(Date.now() - STALE_MS() - 60_000),
                resumeOfferedAt: new Date(),
                resumeOfferCount: 1,
                nudgedAt: new Date(),
                lastSaheliLine: reply,
                history: [{ at: new Date(), event: "why_check", note: reply.slice(0, 200) }],
                expiresAt: new Date(Date.now() + 6 * 3600_000),
            });
            void logFollow({ ...who, taskId: "" }, `Checked before ordering ${route.productQuery}`, `Remembered: ${whySentence(y)}`, "info", { whyId: y.whyId });
            return { reply };
        }
    }
    return whyLead ? { lead: whyLead } : null;
}

async function currentQuery(phone: string): Promise<string | null> {
    const doc = (await WhatsappSession.findOne({ phone }).lean().catch(() => null)) as Record<string, any> | null;
    return doc?.browserTaskDraft?.productQuery || doc?.pharmacyDraft?.searchQuery || null;
}

async function firstCaregiverName(familyId: string): Promise<string> {
    try {
        const Family = (await import("../../models/family.model")).default;
        const User = (await import("../../models/users.model")).default;
        const fam = await Family.findOne({ familyId }).lean();
        const m = (fam?.members || []).find((x: { role?: string }) => x.role === "PRIMARY_CAREGIVER") as { userId?: string; name?: string } | undefined;
        if (m?.name) return m.name.split(" ")[0]!;
        const u = m?.userId ? await User.findOne({ userId: m.userId }).lean() : null;
        return (u as { firstName?: string } | null)?.firstName?.split(" ")[0] || "your family";
    } catch {
        return "your family";
    }
}

/** Before the turn: the live flow (to know whether this turn ended it). */
export async function beforeTurn(phone: string, familyId: string): Promise<FlowSnapshot | null> {
    const doc = await WhatsappSession.findOne({ phone }).lean().catch(() => null);
    return snapshotSession(doc as Record<string, any> | null, familyId);
}

/** After the reply went out: keep the durable open task in step; capture WHY for new tasks. */
export async function afterTurn(input: { phone: string; identity: Identity; before: FlowSnapshot | null; userText: string; saheliText: string }): Promise<void> {
    if (process.env.DELEGATE_ENABLED === "false") return;
    const { phone, identity } = input;
    const caregiver = isCaregiverRole(identity.role);
    const subject = await subjectFor(identity);
    const doc = await WhatsappSession.findOne({ phone }).lean().catch(() => null);
    const after = snapshotSession(doc as Record<string, any> | null, identity.familyId);
    const { lastRouteFor } = await import("../saheliRouter.service");
    const lr = lastRouteFor(phone)?.route;
    const buyingRoute = lr && (lr.intent === "order_new" || lr.intent === "order_modify" || lr.intent === "restaurant_list");
    const t = await syncOpenTask(
        { phone, familyId: identity.familyId, recipientUserId: subject, ownerUserId: identity.userId, role: caregiver ? "caregiver" : "elder" },
        input.before,
        after,
        { user: input.userText, saheli: input.saheliText, productQuery: buyingRoute ? lr!.productQuery : null, category: buyingRoute ? lr!.category : null, language: lr?.language || null },
    );
    // WHY for an important request in progress (e.g. a medicine), once per task.
    if (t && !t.why && (t.whyTries || 0) < 2 && (t.item || t.productQuery) && t.category !== "ride") {
        await SaheliTask.updateOne({ taskId: t.taskId }, { $inc: { whyTries: 1 } }).catch(() => undefined);
        const { extractWhy } = await import("./delegateGemini");
        const chat = await recentChat(phone, subject, !caregiver, 3).catch(() => "");
        const y = await extractWhy({ item: String(t.item || t.productQuery), recentChat: chat }).catch(() => null);
        if (y) {
            const set: Record<string, unknown> = { important: t.important || y.importance === "high" || y.isMedicine, isMedicine: t.isMedicine || y.isMedicine };
            if (!t.language && y.language) set.language = y.language;
            if (y.why) {
                set.why = y.why;
                const { upsertWhy } = await import("./why.service");
                const r = await upsertWhy({ familyId: identity.familyId, recipientUserId: subject }, { subject: String(t.productQuery || t.item), reason: y.why, category: t.category, source: "request", importance: y.importance, ownerUserId: identity.userId }).catch(() => null);
                if (r?.why) set.whyId = r.why.whyId;
            }
            await SaheliTask.updateOne({ taskId: t.taskId, why: { $exists: false } }, { $set: set }).catch(() => undefined);
        }
    }
}
