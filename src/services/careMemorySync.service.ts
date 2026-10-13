/**
 * Bridge from Saheli's care memory (ai-engine Postgres) to the schedules the reminder
 * scheduler fires. The care record owns medicine times; this keeps CareSchedule rows in step.
 */
import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import SaheliNudgeLog from "../models/saheliNudgeLog.model";
import { CareScheduleType } from "../types/careSchedule.types";

const FOOD_TIMING: Record<string, string> = {
    before_food: "Before food",
    after_food: "After food",
    with_food: "With food",
    empty_stomach: "Empty stomach",
};

export function normalizeTimes(times: unknown): string[] {
    const out = new Set<string>();
    for (const raw of Array.isArray(times) ? times : []) {
        const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) continue;
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h > 23 || min > 59) continue;
        out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
    }
    return [...out].sort();
}

/** One schedule row per dose time. Times no longer in the record are switched off, not deleted. */
export async function syncMedicineSchedule(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    sourceKey: string;
    name: string;
    dose?: string;
    times: unknown;
    foodTiming?: string;
    instructions?: string;
    daysOfWeek?: number[];
    active: boolean;
    /** The engine's why-trail id of the change that caused this sync (D-13). */
    traceId?: string;
}): Promise<{ active: string[]; disabled: string[] }> {
    const times = input.active ? normalizeTimes(input.times) : [];
    const existing = await CareSchedule.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        sourceKey: input.sourceKey,
    });
    const instructions = [FOOD_TIMING[input.foodTiming || ""], input.instructions?.trim()].filter(Boolean).join(". ");
    const days = Array.isArray(input.daysOfWeek) ? input.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    const kept: string[] = [];
    const disabled: string[] = [];
    const { parseTimeToMinutes } = await import("./careScheduleCompletion.service");
    const asHHMM = (t: string) => {
        const m = parseTimeToMinutes(t);
        return m === null ? t : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    };
    for (const row of existing) {
        // Dashboard rows may say "1:00 PM"; compare clock times, not strings.
        if (times.includes(asHHMM(row.time)) && !kept.includes(asHHMM(row.time))) {
            row.title = input.name.slice(0, 120);
            row.dosage = input.dose?.slice(0, 80) || undefined;
            row.instructions = instructions.slice(0, 300) || undefined;
            row.daysOfWeek = days;
            row.active = true;
            row.updatedBy = input.actorUserId;
            if (input.traceId) row.lastTraceId = input.traceId;
            await row.save();
            kept.push(asHHMM(row.time));
        } else if (row.active) {
            row.active = false;
            row.updatedBy = input.actorUserId;
            if (input.traceId) row.lastTraceId = input.traceId;
            await row.save();
            disabled.push(row.time);
        }
    }
    for (const time of times.filter((t) => !kept.includes(t))) {
        await CareSchedule.create({
            scheduleId: randomUUID(),
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            type: CareScheduleType.MEDICINE,
            title: input.name.slice(0, 120),
            time,
            dosage: input.dose?.slice(0, 80) || undefined,
            instructions: instructions.slice(0, 300) || undefined,
            daysOfWeek: days,
            active: true,
            createdBy: input.actorUserId,
            updatedBy: input.actorUserId,
            sourceKey: input.sourceKey,
            ...(input.traceId ? { lastTraceId: input.traceId } : {}),
        });
        kept.push(time);
    }
    return { active: kept.sort(), disabled };
}

/** What the reminder scheduler actually did on a day: sent, failed, or never tried. */
export async function reminderLog(input: { familyId: string; recipientUserId: string; dateKey: string }) {
    const [logs, schedules] = await Promise.all([
        SaheliNudgeLog.find({ familyId: input.familyId, recipientUserId: input.recipientUserId, dateKey: input.dateKey })
            .sort({ createdAt: 1 })
            .lean(),
        CareSchedule.find({ familyId: input.familyId, recipientUserId: input.recipientUserId, active: true }).lean(),
    ]);
    const titles = new Map(schedules.map((s) => [s.scheduleId, `${s.title}${s.dosage ? ` ${s.dosage}` : ""} at ${s.time}`]));
    return {
        dateKey: input.dateKey,
        attempts: logs.map((l) => ({
            item: (l.scheduleId && titles.get(l.scheduleId)) || l.scheduleId || "",
            kind: l.nudgeKind,
            delivered: Boolean(l.delivered),
            reason: l.reason || null,
            at: l.lastAttemptAt || l.createdAt,
        })),
        scheduled: schedules
            .filter((s) => s.type === CareScheduleType.MEDICINE)
            .map((s) => ({ scheduleId: s.scheduleId, item: titles.get(s.scheduleId) })),
    };
}

/**
 * The care schedules (medicines and timed routines), for seeding Saheli's care memory once before a person's first turn.
 * What the old profile held moved into the care record with the memory move (trust plan A1); it is not read here.
 */
export async function exportCareRecord(input: { familyId: string; recipientUserId: string }) {
    const schedules = await CareSchedule.find({ familyId: input.familyId, recipientUserId: input.recipientUserId, active: true }).lean();
    return {
        schedules: schedules.map((s) => ({
            scheduleId: s.scheduleId,
            type: s.type,
            title: s.title,
            time: s.time,
            dosage: s.dosage || null,
            instructions: s.instructions || null,
            daysOfWeek: s.daysOfWeek || [],
            sourceKey: s.sourceKey || null,
        })),
    };
}

/** Hand dashboard-made schedule rows to a care-record key so later syncs update them instead of duplicating. */
export async function claimScheduleRows(input: { familyId: string; recipientUserId: string; key: string; scheduleIds: string[] }) {
    const res = await CareSchedule.updateMany(
        { familyId: input.familyId, recipientUserId: input.recipientUserId, scheduleId: { $in: input.scheduleIds }, sourceKey: { $in: [null, undefined, ""] } },
        { $set: { sourceKey: input.key } },
    );
    return { claimed: res.modifiedCount };
}

/**
 * A family member's WhatsApp number, found the way every outbound message finds it: their account number unless it is
 * the internal "+99" placeholder, else their WhatsApp link, else the invitation they joined by (elders often). Until
 * 2026-10-11 this glued the account's "+99" placeholder onto the number, so Saheli's own messages to anyone without a
 * real number on their account were dropped as "placeholder" (a caregiver in Bengaluru heard nothing for minutes).
 */
export async function familyMemberPhone(familyId: string, userId: string): Promise<{ phone: string } | { reason: string }> {
    const { default: Family } = await import("../models/family.model");
    const family = await Family.findOne({ familyId, status: "ACTIVE" }).lean();
    const member = family?.members.find((m) => m.userId === userId && m.status !== "REMOVED");
    if (!member) return { reason: "not a family member" };
    const { resolveRecipientWhatsAppPhone } = await import("./identityResolver.service");
    const resolved = await resolveRecipientWhatsAppPhone(userId, familyId).catch(() => null);
    if (resolved) return { phone: resolved };
    // The invitation they joined by, whatever their role (the resolver reads only care recipients' invitations).
    const { default: FamilyInvitation } = await import("../models/familyInvitation.model");
    const { isInternalPhone } = await import("../utils/phone.util");
    const inv = await FamilyInvitation.findOne({ familyId, userId, phone: { $exists: true, $ne: "" } })
        .sort({ updatedAt: -1 })
        .lean();
    const cc = inv?.phoneCountryCode || "+91";
    if (inv?.phone && !isInternalPhone(cc)) return { phone: `${cc}${String(inv.phone).replace(/\D/g, "").slice(-10)}` };
    return { reason: "no WhatsApp number" };
}

/** Is this member the person cared for in this family? */
export async function isCareRecipient(familyId: string, userId: string): Promise<boolean> {
    const { default: Family } = await import("../models/family.model");
    const family = await Family.findOne({ familyId, status: "ACTIVE" }).lean();
    const member = family?.members.find((m) => m.userId === userId && m.status !== "REMOVED");
    return String(member?.role ?? "") === "CARE_RECIPIENT";
}

/** The kinds the engine may give its sends (anything else is recorded as "message"). */
const ENGINE_KINDS = ["nudge", "checkin", "brief", "message", "reminder", "alert"] as const;

export function engineDeliveryKind(raw: unknown): (typeof ENGINE_KINDS)[number] {
    return (ENGINE_KINDS as readonly string[]).includes(String(raw)) ? (String(raw) as (typeof ENGINE_KINDS)[number]) : "message";
}

/** Saheli starts a message (a follow-up she promised, a check after a fall). Only to members of this family. */
/** A template hint from the engine ({purpose, params, lang}), checked: anything else is dropped. */
export function engineTemplate(raw: unknown): import("./channelOutbound.service").OutboundTemplate | undefined {
    const t = raw as { purpose?: unknown; params?: unknown; lang?: unknown } | null | undefined;
    const purposes = ["reminder", "summary", "alert", "order", "alert_dose", "alert_noreply", "alert_health", "alert_approval", "message"];
    if (!t || typeof t !== "object" || !purposes.includes(String(t.purpose))) return undefined;
    const params = Array.isArray(t.params) ? t.params.map((p) => String(p ?? "")).slice(0, 3) : [];
    return {
        purpose: String(t.purpose) as import("./whatsappTemplates.service").TemplatePurpose,
        params,
        ...(typeof t.lang === "string" && t.lang ? { lang: t.lang } : {}),
    };
}

/** Just the template, when their chat is closed (nothing when it is open: the engine sends the message itself then). */
export async function sendTemplateOnly(input: {
    familyId: string;
    recipientUserId: string;
    toUserId: string;
    template: import("./channelOutbound.service").OutboundTemplate;
    kind?: unknown;
    ref?: unknown;
}) {
    const found = await familyMemberPhone(input.familyId, input.toUserId);
    if ("reason" in found) return { sent: false, reason: found.reason };
    const { windowOpen } = await import("./whatsappWindow.service");
    if (await windowOpen(found.phone)) return { sent: false, reason: "chat open" };
    const { flagsLoadedAt, isSaheliPaused, refreshFlags } = await import("./featureFlags.service");
    if (!flagsLoadedAt()) await refreshFlags().catch(() => undefined);
    if (isSaheliPaused(input.familyId)) return { sent: false, reason: "paused" };
    const { isMetaWhatsAppEnabled } = await import("../clients/metaWhatsApp.client");
    if (!isMetaWhatsAppEnabled()) return { sent: false, reason: "whatsapp off" };
    const { sendTemplateNotice } = await import("./channelOutbound.service");
    const { withDelivery } = await import("./deliveryLedger.service");
    return withDelivery({
        kind: input.template.purpose === "summary" ? "brief" : engineDeliveryKind(input.kind),
        familyId: input.familyId, toUserId: input.toUserId, aboutUserId: input.recipientUserId,
        ...(typeof input.ref === "string" && input.ref.trim() ? { refId: input.ref.trim().slice(0, 160) } : {}),
    }, () => sendTemplateNotice({ familyId: input.familyId, recipientUserId: input.recipientUserId, toUserId: input.toUserId, phone: found.phone, template: input.template }));
}

export async function sendSaheliWhatsApp(input: {
    familyId: string;
    recipientUserId: string;
    toUserId: string;
    text: string;
    buttons?: Array<{ id: string; title: string }>;
    /** The message asks them to share a location: WhatsApp's "Send location" button goes with it. */
    locationRequest?: boolean;
    /** Sent instead when their WhatsApp chat is closed (the message then waits for their next one). */
    template?: import("./channelOutbound.service").OutboundTemplate;
    /** What it is, for the delivery ledger (trust plan B1.1): the escalation streak counts nudges and check-ins. */
    kind?: unknown;
    /** The engine's own id for it (a nudge row, a check-in turn), kept on the ledger row. */
    ref?: unknown;
}) {
    const text = input.text.trim();
    if (!text) return { delivered: false, reason: "empty" };
    if (engineDeliveryKind(input.kind) === "brief" && (await isCareRecipient(input.familyId, input.toUserId))) {
        // The nightly brief is about the person cared for and goes only to their caregivers, never to them.
        return { delivered: false, reason: "a brief goes only to caregivers" };
    }
    const found = await familyMemberPhone(input.familyId, input.toUserId);
    if ("reason" in found) return { delivered: false, reason: found.reason };
    const { phone } = found;
    const { deliverOutboundMessage } = await import("./channelOutbound.service");
    const { scrubStack } = await import("./stackScrub");
    const buttons = (input.buttons || []).filter((b) => b && typeof b.id === "string" && b.id.startsWith("v2:") && b.title);
    let whatsappPayloads;
    if (input.locationRequest) {
        const { buildLocationRequestMessages } = await import("./whatsappMessageComposer.service");
        whatsappPayloads = buildLocationRequestMessages(scrubStack(text));
    } else if (buttons.length) {
        const { buildSaheliButtonMessages } = await import("./whatsappMessageComposer.service");
        whatsappPayloads = buildSaheliButtonMessages(scrubStack(text), buttons);
    }
    const delivery = await deliverOutboundMessage({ purpose: "proactive",
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        toUserId: input.toUserId,
        content: scrubStack(text),
        channel: "whatsapp",
        channelIdentifier: phone,
        ...(whatsappPayloads ? { whatsappPayloads } : {}),
        ...(input.template ? { template: input.template } : {}),
        delivery: {
            kind: engineDeliveryKind(input.kind),
            ...(typeof input.ref === "string" && input.ref.trim() ? { refId: input.ref.trim().slice(0, 160) } : {}),
        },
    });
    // The wamid goes back to the engine (B1.1): it keeps it on its own row (a nudge, a check-in) and can ask how far the
    // message got with the delivery_status tool (sent, delivered, read, failed).
    const wamids = delivery.messageIds ?? [];
    return {
        delivered: Boolean(delivery.delivered),
        ...(wamids.length ? { wamid: wamids[0], wamids } : {}),
        ...(delivery.via ? { via: delivery.via } : {}),
        ...(delivery.waiting ? { waiting: true } : {}),
        ...(delivery.reason ? { reason: delivery.reason } : {}),
    };
}
