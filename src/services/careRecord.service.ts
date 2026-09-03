import CareRecordEvent from "../models/careRecordEvent.model";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { tokenizePhiInText, detokenizeForDisplay } from "./phiToken.service";

export type AppendCareRecordInput = {
    familyId: string;
    subjectUserId: string;
    actorUserId?: string;
    type: CareRecordEventType;
    source: CareRecordSource;
    channel: ChannelType;
    title: string;
    detail: string;
    payload?: Record<string, unknown>;
    status?: string;
    createdAt?: Date;
    skipSignalCheck?: boolean;
};

export async function appendCareRecordEvent(input: AppendCareRecordInput) {
    const tokenizedDetail = await tokenizePhiInText(input.familyId, input.detail);
    const tokenizedTitle = await tokenizePhiInText(input.familyId, input.title);

    const doc = await CareRecordEvent.create({
        familyId: input.familyId,
        subjectUserId: input.subjectUserId,
        actorUserId: input.actorUserId,
        type: input.type,
        source: input.source,
        channel: input.channel,
        title: tokenizedTitle.text,
        detail: tokenizedDetail.text,
        payload: input.payload ?? {},
        phiTokenRefs: [...tokenizedDetail.phiTokenRefs, ...tokenizedTitle.phiTokenRefs],
        status: input.status,
        createdAt: input.createdAt,
    });

    if (
        !input.skipSignalCheck &&
        input.type === CareRecordEventType.DOCUMENT &&
        typeof input.payload?.rawText === "string"
    ) {
        const { evaluateContextSignalsForDocument } = await import("./contextSignal.service");
        await evaluateContextSignalsForDocument({
            familyId: input.familyId,
            subjectUserId: input.subjectUserId,
            documentId: String(input.payload.documentId ?? doc.eventId),
            rawText: input.payload.rawText,
        });
    }

    return doc;
}

export async function listCareRecordEvents(opts: {
    familyId: string;
    subjectUserId?: string;
    types?: CareRecordEventType[];
    limit?: number;
    before?: Date;
}) {
    const query: Record<string, unknown> = { familyId: opts.familyId };
    if (opts.subjectUserId) query.subjectUserId = opts.subjectUserId;
    if (opts.types?.length) query.type = { $in: opts.types };
    if (opts.before) query.createdAt = { $lt: opts.before };

    const rows = await CareRecordEvent.find(query)
        .sort({ createdAt: -1 })
        .limit(opts.limit ?? 50)
        .lean();

    return rows.map((row) => ({
        eventId: row.eventId,
        familyId: row.familyId,
        subjectUserId: row.subjectUserId,
        actorUserId: row.actorUserId,
        type: row.type,
        source: row.source,
        channel: row.channel,
        title: detokenizeForDisplay(row.title),
        detail: detokenizeForDisplay(row.detail),
        payload: row.payload,
        status: row.status,
        at: row.createdAt ? row.createdAt.toISOString() : null,
    }));
}

export async function getCareRecordTimeline(opts: {
    familyId: string;
    subjectUserId: string;
    limit?: number;
}) {
    return listCareRecordEvents({
        familyId: opts.familyId,
        subjectUserId: opts.subjectUserId,
        limit: opts.limit ?? 100,
    });
}

export async function getCareRecordContextForSaheli(
    familyId: string,
    subjectUserId: string,
    limit = 40,
): Promise<string> {
    const events = await listCareRecordEvents({
        familyId,
        subjectUserId,
        limit,
    });

    if (!events.length) return "No Care Record events yet.";

    return events
        .reverse()
        .map((e) => {
            const when = e.at ? new Date(e.at).toISOString().slice(0, 16) : "";
            return `[${when}] ${e.type}: ${e.title}${e.detail ? ` — ${e.detail.slice(0, 200)}` : ""}`;
        })
        .join("\n");
}

export async function getWeeklyMetrics(familyId: string, subjectUserId: string) {
    const since = new Date();
    since.setDate(since.getDate() - 7);

    const events = await CareRecordEvent.find({
        familyId,
        subjectUserId,
        createdAt: { $gte: since },
    }).lean();

    const byDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        byDay.set(d.toISOString().slice(0, 10), 0);
    }

    const dosesByDay = new Map<string, number>();
    for (const key of byDay.keys()) {
        dosesByDay.set(key, 0);
    }

    let dosesTaken = 0;
    let dosesDue = 0;
    let checkInsSent = 0;
    let checkInsReplied = 0;

    for (const e of events) {
        const day = e.createdAt?.toISOString().slice(0, 10);
        if (day && byDay.has(day)) {
            byDay.set(day, (byDay.get(day) ?? 0) + 1);
        }
        if (e.type === CareRecordEventType.DOSE) {
            if (e.status === "confirmed" || e.status === "reported") {
                dosesTaken += 1;
                if (day && dosesByDay.has(day)) {
                    dosesByDay.set(day, (dosesByDay.get(day) ?? 0) + 1);
                }
            } else dosesDue += 1;
        }
        if (e.type === CareRecordEventType.CHECK_IN) {
            if (e.status === "sent") checkInsSent += 1;
            if (e.status === "replied") checkInsReplied += 1;
        }
    }

    const careEventsByDay = [...byDay.values()];
    const totalEvents = careEventsByDay.reduce((a, b) => a + b, 0);

    return {
        careEventsByDay,
        dosesByDay: [...dosesByDay.values()],
        totalEvents,
        dosesTaken,
        dosesDue,
        checkInsSent,
        checkInsReplied,
        checkInReplyRate:
            checkInsSent > 0 ? Math.round((checkInsReplied / checkInsSent) * 100) : 0,
    };
}
