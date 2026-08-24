import { randomBytes, randomUUID } from "crypto";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";
import User from "../src/models/users.model";
import Family from "../src/models/family.model";
import CareSchedule from "../src/models/careSchedule.model";
import FamilyInvitation, { hashInviteToken } from "../src/models/familyInvitation.model";
import { AuthProvider } from "../src/types/user.types";
import {
    FamilyInvitationStatus,
    FamilyMemberStatus,
    FamilyRole,
} from "../src/types/family.types";
import { CareScheduleType } from "../src/types/careSchedule.types";
import { buildCosmosSafePhonePlaceholder, phoneFieldsFromNormalized } from "../src/utils/phone.util";
import config from "../src/config/app.config";
import LabDocument from "../src/models/labDocument.model";
import SaheliMessage from "../src/models/saheliMessage.model";

dotenv.config();

const RAHUL_USER_ID = "86b50c4f-a9b7-4a5e-aaf9-33c982e48e21";
const PAPA_EMAIL = "papa.demo.rahul@pending.kavach";
const SEED_TAG = "rahul-demo";

const SCHEDULES = [
    {
        type: CareScheduleType.MEDICINE,
        title: "Telmisartan 40mg",
        time: "8:00 AM",
        dosage: "1 tablet",
        instructions: "After breakfast, with water",
        daysOfWeek: [] as number[],
    },
    {
        type: CareScheduleType.CHECK_IN,
        title: "Morning check-in",
        time: "9:00 AM",
        dosage: "",
        instructions: "Saheli asks how Papa is feeling",
        daysOfWeek: [] as number[],
    },
    {
        type: CareScheduleType.VITALS,
        title: "Blood pressure",
        time: "7:00 PM",
        dosage: "",
        instructions: "Write the reading Saheli is told",
        daysOfWeek: [] as number[],
    },
    {
        type: CareScheduleType.CUSTOM,
        title: "Evening walk",
        time: "6:00 PM",
        dosage: "",
        instructions: "Around the park, if Papa wants",
        daysOfWeek: [1, 2, 3, 4, 5, 6],
    },
];

const LAB = {
    title: "TSH report",
    recordDate: "8 Aug 2026",
    rawText: `Lab report — thyroid
Patient: Papa
Date: 8 Aug 2026

TSH 4.2 mIU/L
Free T4 1.1 ng/dL

Printed values only. No interpretation added.`,
};

async function ensurePapa(familyId: string, rahulUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new Error("Rahul family not found");

    const existingRecipient = family.members.find(
        (m) => m.role === FamilyRole.CARE_RECIPIENT && m.status === FamilyMemberStatus.JOINED,
    );
    if (existingRecipient) {
        return existingRecipient.userId;
    }

    let papa = await User.findOne({ email: PAPA_EMAIL });
    if (!papa) {
        const passwordHash = await bcrypt.hash(randomBytes(24).toString("hex"), config.security.bcryptSaltRounds);
        papa = await User.create({
            userId: randomUUID(),
            email: PAPA_EMAIL,
            firstName: "Papa",
            lastName: "",
            passwordHash,
            primaryAuthProvider: AuthProvider.EMAIL,
            emailVerified: false,
            ...phoneFieldsFromNormalized(buildCosmosSafePhonePlaceholder()),
        });
    }

    await family.addMember(papa.userId, FamilyRole.CARE_RECIPIENT, {
        invitedBy: rahulUserId,
        status: FamilyMemberStatus.JOINED,
    });

    const existingInvite = await FamilyInvitation.findOne({
        familyId,
        userId: papa.userId,
    });
    if (!existingInvite) {
        await FamilyInvitation.create({
            familyId,
            email: PAPA_EMAIL,
            role: FamilyRole.CARE_RECIPIENT,
            invitedBy: rahulUserId,
            status: FamilyInvitationStatus.ACCEPTED,
            tokenHash: hashInviteToken(randomBytes(32).toString("hex")),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            inviteeName: "Papa",
            namePrefix: "Mr.",
            relationship: "Father",
            location: "Nagpur",
            userId: papa.userId,
        });
    }

    return papa.userId;
}

async function ensureSchedules(familyId: string, recipientUserId: string, createdBy: string) {
    const existing = await CareSchedule.find({ familyId, recipientUserId }).lean();
    const titles = new Set(existing.map((s) => s.title));
    let created = 0;
    for (const item of SCHEDULES) {
        if (titles.has(item.title)) continue;
        await CareSchedule.create({
            familyId,
            recipientUserId,
            type: item.type,
            title: item.title,
            time: item.time,
            dosage: item.dosage || undefined,
            instructions: item.instructions || undefined,
            daysOfWeek: item.daysOfWeek,
            active: true,
            createdBy,
        });
        created += 1;
    }
    return { existing: existing.length, created };
}

async function ensureLabAndChat(
    familyId: string,
    recipientUserId: string,
    caregiverUserId: string,
) {
    await LabDocument.deleteMany({ familyId, recipientUserId });
    await SaheliMessage.deleteMany({ familyId, recipientUserId });

    await LabDocument.create({
        documentId: randomUUID(),
        familyId,
        recipientUserId,
        title: LAB.title,
        rawText: LAB.rawText,
        kind: "lab",
        recordDate: LAB.recordDate,
        createdBy: caregiverUserId,
    });

    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread: "elder",
        role: "elder",
        content: "I took Telmisartan after breakfast. Feeling okay.",
    });
    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread: "elder",
        role: "saheli",
        content: "Saved. You said: “I took Telmisartan after breakfast. Feeling okay.”",
    });
    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread: "caregiver",
        role: "family",
        content: "How is Papa today? What TSH is in the pasted report?",
    });
    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread: "caregiver",
        role: "saheli",
        content:
            "Papa last said: “I took Telmisartan after breakfast. Feeling okay.” Saved report “TSH report” (8 Aug 2026): TSH 4.2 mIU/L Free T4 1.1 ng/dL. Reported only — nothing invented.",
    });

    return { store: "cosmos", labTitle: LAB.title };
}

async function main() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
    await mongoose.connect(process.env.MONGODB_URI);

    const rahul = await User.findOne({ userId: RAHUL_USER_ID });
    if (!rahul) throw new Error("Rahul not found");

    const family = await Family.findOne({
        "members.userId": RAHUL_USER_ID,
        status: "ACTIVE",
    });
    if (!family) throw new Error("Rahul family not found");

    const recipientUserId = await ensurePapa(family.familyId, rahul.userId);
    const schedules = await ensureSchedules(family.familyId, recipientUserId, rahul.userId);
    const lab = await ensureLabAndChat(family.familyId, recipientUserId, rahul.userId);

    const payload = {
        seed: SEED_TAG,
        store: "cosmos",
        familyId: family.familyId,
        familyName: family.name,
        recipientUserId,
        recipientName: "Papa",
        schedules,
        lab,
    };

    console.log(JSON.stringify(payload));
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
