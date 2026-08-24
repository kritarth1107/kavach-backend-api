import { randomUUID } from "crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";
import User from "../src/models/users.model";
import Family from "../src/models/family.model";
import LabDocument from "../src/models/labDocument.model";
import SaheliMessage from "../src/models/saheliMessage.model";
import { FamilyMemberStatus, FamilyRole } from "../src/types/family.types";

dotenv.config();

const LABS = [
    {
        title: "TSH report",
        kind: "lab",
        recordDate: "8 Aug 2026",
        daysAgo: 17,
        rawText: `Lab report — thyroid
Patient: Mrs. Vasundara Devi
Date: 8 Aug 2026

TSH 4.2 mIU/L
Free T4 1.1 ng/dL

Printed values only. No interpretation.`,
    },
    {
        title: "Fasting glucose",
        kind: "lab",
        recordDate: "18 Aug 2026",
        daysAgo: 7,
        rawText: `Lab report — fasting glucose
Patient: Mrs. Vasundara Devi
Date: 18 Aug 2026

Fasting glucose 104 mg/dL

Printed values only. No interpretation.`,
    },
    {
        title: "Blood pressure log",
        kind: "vitals",
        recordDate: "25 Aug 2026",
        daysAgo: 0,
        rawText: `Home BP log
Patient: Mrs. Vasundara Devi
Date: 25 Aug 2026 · 8:05 AM

Blood pressure 118/76 mmHg
Heart rate 72 bpm

Printed values only. No interpretation.`,
    },
];

let clampSeq = 0;
function at(daysAgo: number, hour: number, minute: number) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > Date.now()) {
        clampSeq += 1;
        d.setTime(Date.now() - 20 * 60_000 + clampSeq * 45_000);
        if (d.getTime() > Date.now()) d.setTime(Date.now() - 1000);
    }
    return d;
}

type SeedMsg = {
    thread: "elder" | "caregiver";
    role: "elder" | "saheli" | "family" | "system";
    content: string;
    daysAgo: number;
    hour: number;
    minute: number;
};

const MESSAGES: SeedMsg[] = [
    {
        thread: "elder",
        role: "system",
        content: "Check-in prompted for Mrs. Vasundara Devi",
        daysAgo: 6,
        hour: 9,
        minute: 0,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Good morning. Slept well. Knee a little stiff.",
        daysAgo: 6,
        hour: 9,
        minute: 8,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Good morning. Slept well. Knee a little stiff.”",
        daysAgo: 6,
        hour: 9,
        minute: 8,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Took Folvite and Shelcal after lunch.",
        daysAgo: 3,
        hour: 14,
        minute: 10,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Took Folvite and Shelcal after lunch.”",
        daysAgo: 3,
        hour: 14,
        minute: 10,
    },
    {
        thread: "elder",
        role: "system",
        content: "Check-in prompted for Mrs. Vasundara Devi",
        daysAgo: 0,
        hour: 9,
        minute: 0,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Morning check-in. Feeling cheerful. BP done — 118/76.",
        daysAgo: 0,
        hour: 9,
        minute: 6,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Morning check-in. Feeling cheerful. BP done — 118/76.”",
        daysAgo: 0,
        hour: 9,
        minute: 6,
    },
    {
        thread: "elder",
        role: "elder",
        content: "I took Folvite at 1. Took Shelcal after lunch. Feeling okay.",
        daysAgo: 0,
        hour: 14,
        minute: 12,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “I took Folvite at 1. Took Shelcal after lunch. Feeling okay.”",
        daysAgo: 0,
        hour: 14,
        minute: 12,
    },
    {
        thread: "caregiver",
        role: "family",
        content: "How is Mama today? Did she take both medicines? What TSH is in the pasted report?",
        daysAgo: 0,
        hour: 14,
        minute: 40,
    },
    {
        thread: "caregiver",
        role: "saheli",
        content:
            "Mrs. Vasundara Devi last said: “I took Folvite at 1. Took Shelcal after lunch. Feeling okay.” Saved report “TSH report” (8 Aug 2026): TSH 4.2 mIU/L Free T4 1.1 ng/dL. Blood pressure log (25 Aug 2026): 118/76 mmHg. Reported only — nothing invented.",
        daysAgo: 0,
        hour: 14,
        minute: 41,
    },
];

async function main() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
    await mongoose.connect(process.env.MONGODB_URI);

    const caregiver = await User.findOne({
        $or: [{ email: /kritarth@kavach\.care/i }, { email: /kritarth@kawach\.care/i }],
    });
    if (!caregiver) throw new Error("Kritarth user not found in Cosmos");

    const family = await Family.findOne({
        "members.userId": caregiver.userId,
        status: "ACTIVE",
    });
    if (!family) throw new Error("Kritarth family not found");

    const recipient = family.members.find(
        (m) => m.role === FamilyRole.CARE_RECIPIENT && m.status === FamilyMemberStatus.JOINED,
    );
    if (!recipient?.userId) throw new Error("No care recipient on this family");

    const familyId = family.familyId;
    const recipientUserId = recipient.userId;

    await LabDocument.deleteMany({ familyId, recipientUserId });
    await SaheliMessage.deleteMany({ familyId, recipientUserId });

    for (const lab of LABS) {
        const stamped = at(lab.daysAgo, 10, 0);
        await LabDocument.create({
            documentId: randomUUID(),
            familyId,
            recipientUserId,
            title: lab.title,
            rawText: lab.rawText,
            kind: lab.kind,
            recordDate: lab.recordDate,
            createdBy: caregiver.userId,
            createdAt: stamped,
            updatedAt: stamped,
        });
    }

    for (const msg of MESSAGES) {
        const stamped = at(msg.daysAgo, msg.hour, msg.minute);
        await SaheliMessage.create({
            messageId: randomUUID(),
            familyId,
            recipientUserId,
            thread: msg.thread,
            role: msg.role,
            content: msg.content,
            createdAt: stamped,
            updatedAt: stamped,
        });
    }

    console.log(
        JSON.stringify(
            {
                ok: true,
                store: "cosmos",
                familyId,
                familyName: family.name,
                recipientUserId,
                labs: LABS.length,
                messages: MESSAGES.length,
            },
            null,
            2,
        ),
    );

    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
