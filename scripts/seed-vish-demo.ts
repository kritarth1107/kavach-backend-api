/**
 * Idempotent demo seed for Vish / Sudha (Kavach Dashboard Values PDF, 26 Aug 2026).
 *
 * Usage:
 *   npx tsx scripts/seed-vish-demo.ts
 */
import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import os from "os";
import User from "../src/models/users.model";
import Family from "../src/models/family.model";
import CareSchedule from "../src/models/careSchedule.model";
import FamilyInvitation, { hashInviteToken } from "../src/models/familyInvitation.model";
import LabDocument from "../src/models/labDocument.model";
import SaheliMessage from "../src/models/saheliMessage.model";
import { AuthProvider } from "../src/types/user.types";
import {
    FamilyInvitationStatus,
    FamilyMemberStatus,
    FamilyRole,
} from "../src/types/family.types";
import { CareScheduleType } from "../src/types/careSchedule.types";
import { buildCosmosSafePhonePlaceholder, normalizePhoneInput, phoneFieldsFromNormalized } from "../src/utils/phone.util";
import config from "../src/config/app.config";

dotenv.config();

const SEED_TAG = "vish-demo";
const VISH_EMAIL = "vish2030@gmail.com";
const SUDHA_EMAIL = "sudha.demo.vish@pending.kavach";
const FAMILY_NAME = "Vish's family";
const DEMO_PASSWORD = "KavachDemo2026!";

const SCHEDULES = [
    {
        type: CareScheduleType.MEDICINE,
        title: "Tab Folvite 5mg",
        time: "8:00 AM",
        dosage: "1 tablet",
        instructions: "After breakfast",
    },
    {
        type: CareScheduleType.MEDICINE,
        title: "Tab Pantodac 40mg",
        time: "8:00 AM",
        dosage: "1 tablet",
        instructions: "Before food",
    },
    {
        type: CareScheduleType.MEDICINE,
        title: "Tab Perinorm 10mg",
        time: "8:00 AM",
        dosage: "1 tablet",
        instructions: "After breakfast",
    },
    {
        type: CareScheduleType.CHECK_IN,
        title: "Morning check-in",
        time: "10:00 AM",
        dosage: "",
        instructions: "Saheli asks how Sudha is feeling",
    },
    {
        type: CareScheduleType.MEDICINE,
        title: "Syp Cremaffin",
        time: "9:00 PM",
        dosage: "10 ml",
        instructions: "After dinner",
    },
];

type LabSeed = {
    title: string;
    kind: string;
    recordDate: string;
    daysAgo: number;
    hour: number;
    minute: number;
    rawText: string;
    tags?: string[];
};

const LABS: LabSeed[] = [
    {
        title: "Morning vitals",
        kind: "vitals",
        recordDate: "26 Aug 2026",
        daysAgo: 0,
        hour: 7,
        minute: 41,
        tags: ["vitals", "bp", "glucose"],
        rawText: `Home vitals log
Patient: Sudha
Date: 26 Aug 2026 · 07:41 IST

Blood pressure 128/78 mmHg
Pulse 78 bpm
Fasting glucose 132 mg/dL
SpO2 96%

Printed values only.`,
    },
    {
        title: "Morning vitals",
        kind: "vitals",
        recordDate: "24 Aug 2026",
        daysAgo: 2,
        hour: 7,
        minute: 40,
        tags: ["vitals", "bp"],
        rawText: `Home vitals log
Patient: Sudha
Date: 24 Aug 2026 · 07:40 IST

Blood pressure 124/76 mmHg
Pulse 72 bpm
Fasting glucose 139 mg/dL

Printed values only.`,
    },
    {
        title: "Morning vitals",
        kind: "vitals",
        recordDate: "22 Aug 2026",
        daysAgo: 4,
        hour: 7,
        minute: 52,
        tags: ["vitals", "bp", "flagged"],
        rawText: `Home vitals log
Patient: Sudha
Date: 22 Aug 2026 · 07:52 IST

Blood pressure 142/88 mmHg
Pulse 86 bpm
Fasting glucose 148 mg/dL
Note: highest BP this week

Printed values only.`,
    },
    {
        title: "Morning vitals",
        kind: "vitals",
        recordDate: "20 Aug 2026",
        daysAgo: 6,
        hour: 7,
        minute: 45,
        tags: ["vitals", "bp"],
        rawText: `Home vitals log
Patient: Sudha
Date: 20 Aug 2026 · 07:45 IST

Blood pressure 126/76 mmHg
Pulse 72 bpm
Fasting glucose 124 mg/dL

Printed values only.`,
    },
    {
        title: "Pharmacy receipt — Cremaffin",
        kind: "pharmacy",
        recordDate: "19 Aug 2026",
        daysAgo: 7,
        hour: 16,
        minute: 30,
        tags: ["order", "pharmacy"],
        rawText: `Pharmacy delivery
Patient: Sudha
Date: 19 Aug 2026

Syp Cremaffin refill
Amount ₹1,460
Status: delivered

Printed values only.`,
    },
    {
        title: "Symptom note",
        kind: "symptom",
        recordDate: "23 Aug 2026",
        daysAgo: 3,
        hour: 14,
        minute: 12,
        tags: ["symptom"],
        rawText: `Symptom log
Patient: Sudha
Date: 23 Aug 2026

General unwellness — moderate

Printed values only.`,
    },
    {
        title: "TSH report",
        kind: "lab",
        recordDate: "8 Aug 2026",
        daysAgo: 18,
        hour: 10,
        minute: 0,
        tags: ["lab", "tsh"],
        rawText: `Lab report — thyroid
Patient: Sudha
Date: 8 Aug 2026

TSH 4.2 mIU/L
Free T4 1.1 ng/dL

Printed values only.`,
    },
];

type MsgSeed = {
    thread: "elder" | "caregiver";
    role: "elder" | "saheli" | "family" | "system";
    content: string;
    daysAgo: number;
    hour: number;
    minute: number;
};

const MESSAGES: MsgSeed[] = [
    // Today — drives 3/5 tasks + 9 Saheli replies
    {
        thread: "elder",
        role: "system",
        content: "Morning reminder sent — Folvite, Pantodac, Perinorm",
        daysAgo: 0,
        hour: 8,
        minute: 0,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Took Tab Folvite 5mg.",
        daysAgo: 0,
        hour: 8,
        minute: 9,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Took Tab Folvite 5mg.”",
        daysAgo: 0,
        hour: 8,
        minute: 9,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Took Tab Pantodac 40mg.",
        daysAgo: 0,
        hour: 8,
        minute: 12,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Took Tab Pantodac 40mg.”",
        daysAgo: 0,
        hour: 8,
        minute: 12,
    },
    {
        thread: "elder",
        role: "system",
        content: "Tab Perinorm 10mg — second nudge sent",
        daysAgo: 0,
        hour: 8,
        minute: 47,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Reminder sent for Tab Perinorm 10mg — still awaiting your reply.",
        daysAgo: 0,
        hour: 8,
        minute: 47,
    },
    {
        thread: "elder",
        role: "system",
        content: "Check-in prompted for Sudha",
        daysAgo: 0,
        hour: 10,
        minute: 2,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Good morning Sudha! How are you feeling today?",
        daysAgo: 0,
        hour: 10,
        minute: 2,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Feeling good today, had idli for breakfast.",
        daysAgo: 0,
        hour: 10,
        minute: 14,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Feeling good today, had idli for breakfast.”",
        daysAgo: 0,
        hour: 10,
        minute: 14,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Which tablet is due tonight?",
        daysAgo: 0,
        hour: 11,
        minute: 4,
    },
    {
        thread: "elder",
        role: "saheli",
        content:
            "Tonight at 9:00 PM you have Syp Cremaffin — 10 ml after dinner. Tab Perinorm 10mg from this morning is still unconfirmed.",
        daysAgo: 0,
        hour: 11,
        minute: 4,
    },
    {
        thread: "caregiver",
        role: "family",
        content: "How is Mama today? Did she take the morning medicines?",
        daysAgo: 0,
        hour: 10,
        minute: 30,
    },
    {
        thread: "caregiver",
        role: "saheli",
        content:
            "Sudha last said: “Feeling good today, had idli for breakfast.” She confirmed Tab Folvite 5mg and Tab Pantodac 40mg. Tab Perinorm 10mg is still unconfirmed after a second nudge. Latest vitals (26 Aug): BP 128/78, pulse 78, fasting sugar 132 mg/dL. Reported only — nothing invented.",
        daysAgo: 0,
        hour: 10,
        minute: 31,
    },
    // Yesterday
    {
        thread: "elder",
        role: "elder",
        content: "Took Syp Cremaffin after dinner.",
        daysAgo: 1,
        hour: 21,
        minute: 36,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Took Syp Cremaffin after dinner.”",
        daysAgo: 1,
        hour: 21,
        minute: 36,
    },
    // Prior week — check-ins & doses for trends
    {
        thread: "elder",
        role: "elder",
        content: "Took Tab Folvite and Tab Pantodac after breakfast.",
        daysAgo: 2,
        hour: 8,
        minute: 15,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Took Tab Folvite and Tab Pantodac after breakfast.”",
        daysAgo: 2,
        hour: 8,
        minute: 15,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Feeling tired today.",
        daysAgo: 3,
        hour: 8,
        minute: 27,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Feeling tired today.”",
        daysAgo: 3,
        hour: 8,
        minute: 27,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Took all morning tablets. BP feels fine.",
        daysAgo: 4,
        hour: 8,
        minute: 20,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Took all morning tablets. BP feels fine.”",
        daysAgo: 4,
        hour: 8,
        minute: 20,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Good morning. Slept well.",
        daysAgo: 5,
        hour: 10,
        minute: 5,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Good morning. Slept well.”",
        daysAgo: 5,
        hour: 10,
        minute: 5,
    },
    {
        thread: "elder",
        role: "elder",
        content: "Took folvite and pantodac.",
        daysAgo: 6,
        hour: 8,
        minute: 10,
    },
    {
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “Took folvite and pantodac.”",
        daysAgo: 6,
        hour: 8,
        minute: 10,
    },
];

let clampSeq = 0;
function at(daysAgo: number, hour: number, minute: number): Date {
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

async function ensureVish() {
    let vish = await User.findOne({ email: VISH_EMAIL.toLowerCase() });
    if (!vish) {
        const passwordHash = await bcrypt.hash(DEMO_PASSWORD, config.security.bcryptSaltRounds);
        vish = await User.create({
            userId: randomUUID(),
            email: VISH_EMAIL,
            firstName: "Vish",
            lastName: "BR",
            passwordHash,
            primaryAuthProvider: AuthProvider.EMAIL,
            emailVerified: true,
            ...phoneFieldsFromNormalized(buildCosmosSafePhonePlaceholder()),
        });
    } else {
        if (!vish.firstName) {
            vish.firstName = "Vish";
            vish.lastName = "BR";
            await vish.save();
        }
    }
    return vish;
}

async function ensureFamily(vishUserId: string) {
    let family = await Family.findOne({
        createdBy: vishUserId,
        status: "ACTIVE",
        name: FAMILY_NAME,
    });

    if (!family) {
        family = await Family.findOne({
            "members.userId": vishUserId,
            status: "ACTIVE",
        });
    }

    if (!family) {
        family = await Family.create({
            name: FAMILY_NAME,
            createdBy: vishUserId,
            members: [
                {
                    userId: vishUserId,
                    role: FamilyRole.PRIMARY_CAREGIVER,
                    status: FamilyMemberStatus.JOINED,
                    joinedAt: new Date(),
                },
            ],
        });
    } else if (family.name !== FAMILY_NAME) {
        family.name = FAMILY_NAME;
        await family.save();
    }

    const vishMember = family.members.find((m) => m.userId === vishUserId);
    if (!vishMember) {
        await family.addMember(vishUserId, FamilyRole.PRIMARY_CAREGIVER, {
            status: FamilyMemberStatus.JOINED,
        });
    } else if (vishMember.role !== FamilyRole.PRIMARY_CAREGIVER) {
        vishMember.role = FamilyRole.PRIMARY_CAREGIVER;
        await family.save();
    }

    await User.updateOne(
        { userId: vishUserId },
        { activeFamilyId: family.familyId, primaryFamilyId: family.familyId },
    );

    return family;
}

async function ensureSudha(familyId: string, vishUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new Error("Family not found");

    const existing = family.members.find(
        (m) =>
            m.role === FamilyRole.CARE_RECIPIENT &&
            m.status === FamilyMemberStatus.JOINED,
    );
    if (existing?.userId) return existing.userId;

    let sudha = await User.findOne({ email: SUDHA_EMAIL });
    if (!sudha) {
        const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), config.security.bcryptSaltRounds);
        sudha = await User.create({
            userId: randomUUID(),
            email: SUDHA_EMAIL,
            firstName: "Sudha",
            lastName: "",
            passwordHash,
            primaryAuthProvider: AuthProvider.EMAIL,
            emailVerified: false,
            ...phoneFieldsFromNormalized(normalizePhoneInput("+91", "9880576589")),
        });
    }

    await family.addMember(sudha.userId, FamilyRole.CARE_RECIPIENT, {
        invitedBy: vishUserId,
        status: FamilyMemberStatus.JOINED,
    });

    const invite = await FamilyInvitation.findOne({ familyId, userId: sudha.userId });
    if (!invite) {
        await FamilyInvitation.create({
            familyId,
            email: SUDHA_EMAIL,
            role: FamilyRole.CARE_RECIPIENT,
            invitedBy: vishUserId,
            status: FamilyInvitationStatus.ACCEPTED,
            tokenHash: hashInviteToken(randomBytes(32).toString("hex")),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            inviteeName: "Sudha",
            namePrefix: "",
            relationship: "Mother",
            phone: "9880576589",
            phoneCountryCode: "+91",
            location: "Bangalore",
            userId: sudha.userId,
        });
    }

    return sudha.userId;
}

async function ensureSchedules(familyId: string, recipientUserId: string, createdBy: string) {
    await CareSchedule.deleteMany({ familyId, recipientUserId });
    for (const item of SCHEDULES) {
        await CareSchedule.create({
            familyId,
            recipientUserId,
            type: item.type,
            title: item.title,
            time: item.time,
            dosage: item.dosage || undefined,
            instructions: item.instructions || undefined,
            daysOfWeek: [],
            active: true,
            createdBy,
        });
    }
    return SCHEDULES.length;
}

async function seedLabsAndMessages(
    familyId: string,
    recipientUserId: string,
    caregiverUserId: string,
) {
    await LabDocument.deleteMany({ familyId, recipientUserId });
    await SaheliMessage.deleteMany({ familyId, recipientUserId });

    for (const lab of LABS) {
        const stamped = at(lab.daysAgo, lab.hour, lab.minute);
        await LabDocument.create({
            documentId: randomUUID(),
            familyId,
            recipientUserId,
            title: lab.title,
            rawText: lab.rawText,
            kind: lab.kind,
            recordDate: lab.recordDate,
            tags: lab.tags ?? [],
            analysisStatus: "ready",
            createdBy: caregiverUserId,
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

    return { labs: LABS.length, messages: MESSAGES.length };
}

async function main() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
    await mongoose.connect(process.env.MONGODB_URI);

    const vish = await ensureVish();
    const family = await ensureFamily(vish.userId);
    const recipientUserId = await ensureSudha(family.familyId, vish.userId);
    const scheduleCount = await ensureSchedules(family.familyId, recipientUserId, vish.userId);
    const content = await seedLabsAndMessages(family.familyId, recipientUserId, vish.userId);

    const payload = {
        seed: SEED_TAG,
        store: "cosmos",
        familyId: family.familyId,
        familyName: family.name,
        caregiver: {
            userId: vish.userId,
            email: VISH_EMAIL,
            name: "Vish BR",
            loginHint: "Sign in with Google using vish2030@gmail.com, or email + demo password",
            demoPassword: DEMO_PASSWORD,
        },
        careRecipient: {
            userId: recipientUserId,
            name: "Sudha",
            age: 63,
            location: "Bangalore",
            phone: "+91 98805 76589",
        },
        schedules: scheduleCount,
        ...content,
    };

    const jsonPath = path.join(os.homedir(), "Desktop", "kavach-dashboard-data.json");
    try {
        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
    } catch {
        // Desktop may not exist in CI
    }

    console.log(JSON.stringify(payload, null, 2));
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
