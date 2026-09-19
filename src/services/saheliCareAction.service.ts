import CareSchedule from "../models/careSchedule.model";
import { AppError } from "../middleware/error.middleware";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { appendCareRecordEvent } from "./careRecord.service";
import {
    getScheduleDayStatuses,
    markScheduleItemCompletion,
} from "./careScheduleCompletion.service";
import { toDateKeyIST } from "../utils/istTime.util";

function fuzzyMatchScheduleTitle(title: string, query: string): boolean {
    const t = title.toLowerCase();
    const q = query.toLowerCase().trim();
    if (!q || q.length < 2) return false;
    if (t.includes(q) || q.includes(t)) return true;
    const tokens = q.split(/\s+/).filter((w) => w.length >= 3);
    return tokens.some((w) => t.includes(w));
}

export async function markScheduleCompleted(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    scheduleId?: string;
    titleHint?: string;
    dateKey?: string;
    note?: string;
    channel?: ChannelType;
    source?: CareRecordSource;
}): Promise<Record<string, unknown>> {
    let scheduleId = input.scheduleId;
    const dateKey = input.dateKey ?? toDateKeyIST();

    if (!scheduleId && input.titleHint) {
        const day = await getScheduleDayStatuses(
            input.familyId,
            input.recipientUserId,
            input.actorUserId,
            dateKey,
        );
        const match = day.items.find(
            (i) =>
                fuzzyMatchScheduleTitle(i.title, input.titleHint!) &&
                i.status !== "completed",
        );
        scheduleId = match?.scheduleId;
    }

    if (!scheduleId) {
        return { error: "Could not find a matching schedule item to mark complete." };
    }

    const schedule = await CareSchedule.findOne({
        scheduleId,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
    }).lean();
    if (!schedule) return { error: "Schedule item not found." };

    const day = await markScheduleItemCompletion(
        input.familyId,
        input.recipientUserId,
        scheduleId,
        input.actorUserId,
        { status: "completed", dateKey, note: input.note },
    );

    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.CHECK_IN,
        source: input.source ?? CareRecordSource.SAHELI,
        channel: input.channel ?? ChannelType.WHATSAPP,
        title: schedule.title,
        detail: input.note?.trim() || `Marked ${schedule.title} as done for ${dateKey}.`,
        status: "completed",
        payload: { scheduleId, dateKey, action: "schedule_completed" },
        skipSignalCheck: true,
    });

    return {
        status: "completed",
        scheduleId,
        title: schedule.title,
        dateKey,
        adherencePercent: day.adherencePercent,
    };
}

export async function markScheduleMissed(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    scheduleId?: string;
    titleHint?: string;
    dateKey?: string;
    note?: string;
}): Promise<Record<string, unknown>> {
    let scheduleId = input.scheduleId;
    const dateKey = input.dateKey ?? toDateKeyIST();

    if (!scheduleId && input.titleHint) {
        const day = await getScheduleDayStatuses(
            input.familyId,
            input.recipientUserId,
            input.actorUserId,
            dateKey,
        );
        const match = day.items.find((i) => fuzzyMatchScheduleTitle(i.title, input.titleHint!));
        scheduleId = match?.scheduleId;
    }

    if (!scheduleId) return { error: "Could not find a matching schedule item." };

    const schedule = await CareSchedule.findOne({ scheduleId }).lean();
    const day = await markScheduleItemCompletion(
        input.familyId,
        input.recipientUserId,
        scheduleId,
        input.actorUserId,
        { status: "missed", dateKey, note: input.note },
    );

    return {
        status: "missed",
        scheduleId,
        title: schedule?.title,
        dateKey,
        adherencePercent: day.adherencePercent,
    };
}

export async function logVitals(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    kind: string;
    value: string;
    unit?: string;
    note?: string;
    channel?: ChannelType;
}): Promise<Record<string, unknown>> {
    const detail = [input.kind, input.value, input.unit].filter(Boolean).join(" ");
    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.VITAL,
        source: CareRecordSource.SAHELI,
        channel: input.channel ?? ChannelType.WHATSAPP,
        title: input.kind,
        detail: input.note?.trim() ? `${detail} — ${input.note.trim()}` : detail,
        status: "reported",
        payload: { kind: input.kind, value: input.value, unit: input.unit },
        skipSignalCheck: true,
    });

    const bpMatch = input.value.match(/(\d{2,3})\s*[/\\]\s*(\d{2,3})/);
    if (bpMatch && /bp|blood pressure/i.test(input.kind)) {
        const day = await getScheduleDayStatuses(
            input.familyId,
            input.recipientUserId,
            input.actorUserId,
        );
        const bpItem = day.items.find(
            (i) =>
                /bp|blood pressure|vitals/i.test(i.title) &&
                i.status !== "completed",
        );
        if (bpItem) {
            await markScheduleItemCompletion(
                input.familyId,
                input.recipientUserId,
                bpItem.scheduleId,
                input.actorUserId,
                { status: "completed", note: `BP ${input.value}` },
            );
        }
    }

    return { logged: true, kind: input.kind, value: input.value, unit: input.unit };
}

export async function logDose(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    medicineName: string;
    quantity?: string;
    note?: string;
    channel?: ChannelType;
}): Promise<Record<string, unknown>> {
    const detail = [input.medicineName, input.quantity].filter(Boolean).join(" ×");
    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.DOSE,
        source: CareRecordSource.SAHELI,
        channel: input.channel ?? ChannelType.WHATSAPP,
        title: input.medicineName,
        detail: input.note?.trim() ? `${detail} — ${input.note.trim()}` : detail,
        status: "reported",
        payload: { medicineName: input.medicineName, quantity: input.quantity },
        skipSignalCheck: true,
    });

    const marked = await markScheduleCompleted({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        titleHint: input.medicineName,
        note: input.note,
        channel: input.channel,
    });

    return { logged: true, medicineName: input.medicineName, schedule: marked };
}

export async function logCheckIn(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    mood?: string;
    meals?: string;
    sleep?: string;
    pain?: string;
    note?: string;
    channel?: ChannelType;
}): Promise<Record<string, unknown>> {
    const parts = [
        input.mood ? `Mood: ${input.mood}` : "",
        input.meals ? `Meals: ${input.meals}` : "",
        input.sleep ? `Sleep: ${input.sleep}` : "",
        input.pain ? `Pain: ${input.pain}` : "",
        input.note ?? "",
    ].filter(Boolean);

    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.CHECK_IN,
        source: CareRecordSource.SAHELI,
        channel: input.channel ?? ChannelType.WHATSAPP,
        title: "Check-in",
        detail: parts.join(". ") || "Check-in noted.",
        status: "reported",
        payload: {
            mood: input.mood,
            meals: input.meals,
            sleep: input.sleep,
            pain: input.pain,
        },
        skipSignalCheck: true,
    });

    const day = await getScheduleDayStatuses(
        input.familyId,
        input.recipientUserId,
        input.actorUserId,
    );
    const checkInItem = day.items.find(
        (i) => /check.?in/i.test(i.title) && i.status !== "completed",
    );
    if (checkInItem) {
        await markScheduleItemCompletion(
            input.familyId,
            input.recipientUserId,
            checkInItem.scheduleId,
            input.actorUserId,
            { status: "completed", note: parts.join(". ") },
        );
    }

    return { logged: true, summary: parts.join(". ") };
}

export async function tryApplyElderCareActionFromMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    displayName: string;
    channel?: ChannelType;
}): Promise<string | null> {
    const q = input.message.trim();
    const qLower = q.toLowerCase();

    const doneSchedule =
        q.match(/\bI completed schedule ([\w-]+)/i) ?? q.match(/^done:([\w-]+)$/i);
    if (doneSchedule?.[1]) {
        const result = await markScheduleCompleted({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            scheduleId: doneSchedule[1],
            channel: input.channel,
        });
        if (result.title) {
            return `Done — ${result.title} marked complete.`;
        }
    }

    const bpMatch = q.match(/\b(\d{2,3})\s*[/\\]\s*(\d{2,3})\b/);
    if (bpMatch || /\b(bp|blood pressure)\b/i.test(qLower)) {
        const value = bpMatch ? `${bpMatch[1]}/${bpMatch[2]}` : q.replace(/.*?(bp|blood pressure)[:\s]*/i, "").trim();
        if (value && /\d/.test(value)) {
            await logVitals({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind: "Blood pressure",
                value,
                channel: input.channel,
            });
            return `Logged BP: ${value}.`;
        }
    }

    const tookMed =
        /\b(took|had|eaten|finished|le li|li hai|le liya|tablet|medicine|dose|capsule)\b/i.test(qLower);
    if (tookMed) {
        const medMatch = q.match(
            /\b(folvite|shelcal|metformin|amlodipine|telma|thyrox|ecosprin|paracetamol|[a-z]{4,})\b/i,
        );
        const hint = medMatch?.[1] ?? q.replace(/.*\b(took|had|finished)\b/i, "").trim();
        if (hint.length >= 3) {
            const result = await logDose({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                medicineName: hint,
                channel: input.channel,
            });
            const schedule = result.schedule;
            if (
                schedule &&
                typeof schedule === "object" &&
                "title" in schedule &&
                typeof schedule.title === "string" &&
                schedule.title
            ) {
                return `Done — ${schedule.title} marked for today.`;
            }
            return `Noted — ${hint}.`;
        }
    }

    if (/\b(fine|good|okay|ok|theek|thik|better|doing well|i'm ok|im ok)\b/i.test(qLower) && q.length < 80) {
        await logCheckIn({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            mood: q,
            channel: input.channel,
        });
        return "Glad to hear that.";
    }

    return null;
}

export async function logAppointmentNotes(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    summary: string;
    doctorName?: string;
    channel?: ChannelType;
}): Promise<Record<string, unknown>> {
    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.CHECK_IN,
        source: CareRecordSource.SAHELI,
        channel: input.channel ?? ChannelType.WHATSAPP,
        title: input.doctorName ? `Visit — ${input.doctorName}` : "Doctor visit",
        detail: input.summary.slice(0, 2000),
        status: "reported",
        payload: { doctorName: input.doctorName, kind: "appointment_notes" },
        skipSignalCheck: true,
    });
    return { logged: true };
}
