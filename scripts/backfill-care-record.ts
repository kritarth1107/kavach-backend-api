/**
 * Backfill Care Record events from legacy Mongo collections.
 * Usage: npx tsx scripts/backfill-care-record.ts [--familyId=...]
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import SaheliMessage from "../src/models/saheliMessage.model";
import LabDocument from "../src/models/labDocument.model";
import CareRecordEvent from "../src/models/careRecordEvent.model";
import { appendCareRecordEvent } from "../src/services/careRecord.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../src/types/careRecord.types";

dotenv.config();

async function main() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
    await mongoose.connect(process.env.MONGODB_URI);

    const familyFilter = process.argv
        .find((a) => a.startsWith("--familyId="))
        ?.split("=")[1];

    const msgQuery = familyFilter ? { familyId: familyFilter } : {};
    const existing = await CareRecordEvent.countDocuments(msgQuery);
    if (existing > 0 && !process.argv.includes("--force")) {
        console.log(`Care Record already has ${existing} events. Use --force to backfill anyway.`);
        await mongoose.disconnect();
        return;
    }

    let created = 0;

    const messages = await SaheliMessage.find(msgQuery).sort({ createdAt: 1 }).lean();
    for (const msg of messages) {
        const type =
            msg.role === "system"
                ? CareRecordEventType.CHECK_IN
                : CareRecordEventType.MESSAGE;
        await appendCareRecordEvent({
            familyId: msg.familyId,
            subjectUserId: msg.recipientUserId,
            type,
            source: CareRecordSource.SAHELI,
            channel: ChannelType.DASHBOARD,
            title: msg.role === "saheli" ? "Saheli" : msg.role,
            detail: msg.content,
            status: "reported",
            createdAt: msg.createdAt,
            skipSignalCheck: true,
        });
        created += 1;
    }

    const labs = await LabDocument.find(msgQuery).sort({ createdAt: 1 }).lean();
    for (const lab of labs) {
        const eventType =
            lab.kind === "vitals"
                ? CareRecordEventType.VITAL
                : lab.kind === "symptom"
                  ? CareRecordEventType.SYMPTOM
                  : CareRecordEventType.DOCUMENT;
        await appendCareRecordEvent({
            familyId: lab.familyId,
            subjectUserId: lab.recipientUserId,
            actorUserId: lab.createdBy,
            type: eventType,
            source: CareRecordSource.DASHBOARD,
            channel: ChannelType.DASHBOARD,
            title: lab.title,
            detail: lab.rawText.slice(0, 500),
            payload: { documentId: lab.documentId, rawText: lab.rawText, kind: lab.kind },
            status: "logged",
            createdAt: lab.createdAt,
            skipSignalCheck: true,
        });
        created += 1;
    }

    console.log(JSON.stringify({ ok: true, created }, null, 2));
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
