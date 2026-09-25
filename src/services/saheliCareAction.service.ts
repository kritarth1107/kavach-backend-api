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

export async function logSymptom(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    symptom: string;
    severity?: string;
    note?: string;
    channel?: ChannelType;
    notify?: boolean;
}): Promise<Record<string, unknown>> {
    const detail = [
        input.symptom.trim(),
        input.severity ? `Severity: ${input.severity}` : "",
        input.note?.trim() || "",
    ]
        .filter(Boolean)
        .join(". ")
        .slice(0, 2000);

    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.SYMPTOM,
        source: CareRecordSource.SAHELI,
        channel: input.channel ?? ChannelType.WHATSAPP,
        title: "Symptom",
        detail: detail || "Symptom reported.",
        status: "reported",
        payload: {
            symptom: input.symptom.trim().slice(0, 400),
            severity: input.severity,
            note: input.note,
            followUpSuggested: "evening",
            neverDiagnose: true,
        },
        skipSignalCheck: true,
    });

    if (input.notify !== false) {
        try {
            const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
            await notifyCaregivers({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: `Care note (not a diagnosis): ${detail.slice(0, 220)}`,
                urgency: /severe|worst|unbearable|bahut|bohot/i.test(detail) ? "high" : "medium",
                kind: "symptom",
            });
        } catch (err) {
            console.warn(
                "Caregiver notify for symptom failed:",
                err instanceof Error ? err.message : err,
            );
        }
    }

    return { logged: true, symptom: input.symptom, followUpSuggested: "evening" };
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

    if (input.pain?.trim()) {
        await logSymptom({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            symptom: input.pain.trim(),
            note: input.note,
            channel: input.channel,
            notify: false,
        });
    }

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

    const sugarMatch =
        q.match(/\b(sugar|glucose|blood sugar)\s*[:\s-]*(\d{2,3})\b/i) ??
        q.match(/\b(\d{2,3})\s*(mg\/dl|mgdl)\b/i);
    if (sugarMatch) {
        const value = sugarMatch[2] ?? sugarMatch[1];
        if (value && /\d/.test(value)) {
            await logVitals({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind: "Blood sugar",
                value,
                unit: "mg/dL",
                channel: input.channel,
            });
            return `Logged blood sugar: ${value} mg/dL.`;
        }
    }

    const tookMed =
        /\b(took|had|eaten|finished|le li|le liya|le li hai)\b/i.test(qLower) &&
        /\b(tablet|medicine|dose|capsule|pill|shelcal|folvite|metformin|amlodipine|telma|thyrox|ecosprin|paracetamol)\b/i.test(
            qLower,
        );
    if (tookMed) {
        const medMatch = q.match(
            /\b(folvite|shelcal|metformin|amlodipine|telma|thyrox|ecosprin|paracetamol)\b/i,
        );
        const hint = medMatch?.[1] ?? q.replace(/.*\b(took|had|finished|le li)\b/i, "").trim();
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


    // Explicit "tell <name> I'm fine / ..." — notify caregivers with consent already given.
    const tellMatch = q.match(
        /\b(?:tell|inform|bata(?:o|do)?|message)\s+([A-Za-z][A-Za-z\s]{1,40}?)\s+(?:that\s+)?(?:i'?m|i am|main)\s+(.+)$/i,
    );
    if (tellMatch) {
        const who = tellMatch[1].trim();
        const what = tellMatch[2].trim().slice(0, 200);
        const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
        await notifyCaregivers({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            message: `${input.displayName} asked Saheli to tell ${who}: "${what}"`,
            urgency: "low",
            kind: "elder_share",
        });
        return `Okay — I've let your family know you told ${who}: "${what}".`;
    }

    // Pending notify consent after a recent symptom note.
    const consentYes =
        /^(yes|yeah|yep|haan|han|ji|sure|please|bata do|batao|tell them|inform them|notify them)[!.?\s]*$/i.test(
            q,
        ) || /\b(yes[, ]+)?(tell|inform|notify)\s+(them|my\s+family|son|daughter|beta|beti)\b/i.test(qLower);
    const consentNo =
        /^(no|nahi|nope|mat bata|don'?t tell|do not tell|no need)[!.?\s]*$/i.test(q) ||
        /\b(don'?t|do not|mat)\s+(tell|inform|notify|bata)\b/i.test(qLower);

    if ((consentYes || consentNo) && q.length < 120) {
        const { default: CareRecordEvent } = await import("../models/careRecordEvent.model");
        const { CareRecordEventType } = await import("../types/careRecord.types");
        const recent = await CareRecordEvent.findOne({
            familyId: input.familyId,
            subjectUserId: input.recipientUserId,
            type: CareRecordEventType.SYMPTOM,
            createdAt: { $gte: new Date(Date.now() - 45 * 60 * 1000) },
            "payload.awaitingNotifyConsent": true,
        })
            .sort({ createdAt: -1 })
            .lean();
        if (recent) {
            await CareRecordEvent.updateOne(
                { _id: recent._id },
                { $set: { "payload.awaitingNotifyConsent": false, "payload.notifyConsent": consentYes ? "yes" : "no" } },
            );
            if (consentYes) {
                const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
                await notifyCaregivers({
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                    actorUserId: input.actorUserId,
                    message: `Care note (not a diagnosis): ${String(recent.detail ?? "").slice(0, 220)}`,
                    urgency: /severe|worst|unbearable|bahut|bohot/i.test(String(recent.detail ?? ""))
                        ? "high"
                        : "medium",
                    kind: "symptom",
                });
                return "Okay — I've gently let your family know. I'm still here with you.";
            }
            return "Understood — I won't tell them. I'm here if you change your mind or need anything else.";
        }
    }

    // "My son doesn't know yet" after a symptom — offer consent, do not auto-notify.
    if (
        /\b(doesn'?t|does not|dont|don'?t)\s+know(\s+yet)?\b/i.test(qLower) ||
        /\b(son|daughter|beta|beti|family).{0,40}\b(doesn'?t|does not|dont)\s+know\b/i.test(qLower)
    ) {
        return "Would you like me to let them know gently? Just say yes and I'll tell your family — or say no and I'll keep it between us.";
    }

    // Symptom / pain — log Care Record SYMPTOM, ASK before notify (never diagnose).
    // Emergencies (chest pain / can't breathe) are handled upstream.
    const symptomMatch =
        /\b(chest pain|severe pain|unbearable|can'?t breathe|cannot breathe)\b/i.test(qLower)
            ? null
            : q.match(
                  /\b((?:head|back|stomach|pet|peeth|joint|knee|leg|arm|tooth|throat|ear)?\s*(?:pain|ache|dard|hurting|hurt)|(?:my\s+)?(?:back|peeth|head|stomach|pet)\s+(?:is\s+)?(?:hurting|hurt|aching|painful)|headache|migraine|fever|bukhar|nausea|dizzy|dizziness|cough|khansi|vomiting|thakaan|weakness|swelling|body\s+pain|dard\s+ho\s+raha)\b(.{0,80})/i,
              );
    if (symptomMatch && q.length < 280) {
        const snippet = (symptomMatch[0] + (symptomMatch[2] || "")).trim().slice(0, 200);
        await logSymptom({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            symptom: snippet || q,
            note: q,
            channel: input.channel,
            notify: false,
        });
        // Mark latest symptom as awaiting consent.
        try {
            const { default: CareRecordEvent } = await import("../models/careRecordEvent.model");
            const { CareRecordEventType } = await import("../types/careRecord.types");
            await CareRecordEvent.findOneAndUpdate(
                {
                    familyId: input.familyId,
                    subjectUserId: input.recipientUserId,
                    type: CareRecordEventType.SYMPTOM,
                },
                { $set: { "payload.awaitingNotifyConsent": true } },
                { sort: { createdAt: -1 } },
            );
        } catch {
            /* best-effort */
        }
        return "Sorry you're feeling that — I've noted it. I'm not a doctor and can't diagnose. Would you like me to tell your family?";
    }

    if (
        /\b(fine|good|okay|ok|theek|thik|better|doing well|i'm ok|im ok)\b/i.test(qLower) &&
        q.length < 80 &&
        !/\btell\b/i.test(qLower) &&
        !/\bknow(\s+yet)?\b/i.test(qLower)
    ) {
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
