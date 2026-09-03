/**
 * Tenant isolation smoke test — two families must not cross-read Care Record.
 * Usage: npx tsx scripts/test-tenant-isolation.ts
 */
import dotenv from "dotenv";
import mongoose from "mongoose";
import { listCareRecordEvents } from "../src/services/careRecord.service";
import { getFamilyForActor } from "../src/services/careRecordAuth.service";

dotenv.config();

async function main() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
    await mongoose.connect(process.env.MONGODB_URI);

    const User = (await import("../src/models/users.model")).default;
    const Family = (await import("../src/models/family.model")).default;
    const { FamilyRole, FamilyMemberStatus } = await import("../src/types/family.types");
    const { randomUUID } = await import("crypto");
    const { buildCosmosSafePhonePlaceholder, phoneFieldsFromNormalized } = await import(
        "../src/utils/phone.util"
    );
    const bcrypt = (await import("bcryptjs")).default;
    const config = (await import("../src/config/app.config")).default;

    const passwordHash = await bcrypt.hash("test-pass", config.security.bcryptSaltRounds);

    async function mkUser(email: string) {
        return User.create({
            userId: randomUUID(),
            email,
            firstName: "Test",
            passwordHash,
            emailVerified: true,
            ...phoneFieldsFromNormalized(buildCosmosSafePhonePlaceholder()),
        });
    }

    const u1 = await mkUser(`iso-a-${Date.now()}@test.kavach`);
    const u2 = await mkUser(`iso-b-${Date.now()}@test.kavach`);

    const f1 = await Family.create({
        name: "Isolation A",
        createdBy: u1.userId,
        members: [{ userId: u1.userId, role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED }],
    });
    const f2 = await Family.create({
        name: "Isolation B",
        createdBy: u2.userId,
        members: [{ userId: u2.userId, role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED }],
    });

    const { appendCareRecordEvent } = await import("../src/services/careRecord.service");
    const { CareRecordEventType, CareRecordSource, ChannelType } = await import(
        "../src/types/careRecord.types"
    );

    await appendCareRecordEvent({
        familyId: f1.familyId,
        subjectUserId: u1.userId,
        type: CareRecordEventType.MESSAGE,
        source: CareRecordSource.DASHBOARD,
        channel: ChannelType.DASHBOARD,
        title: "Secret A",
        detail: "family-a-only",
        skipSignalCheck: true,
    });

    await getFamilyForActor(f1.familyId, u1.userId);
    const aEvents = await listCareRecordEvents({ familyId: f1.familyId, limit: 10 });
    const bAttempt = await listCareRecordEvents({ familyId: f2.familyId, limit: 10 });

    if (!aEvents.some((e) => e.detail.includes("family-a-only"))) {
        throw new Error("Family A events missing");
    }
    if (bAttempt.some((e) => e.detail.includes("family-a-only"))) {
        throw new Error("Cross-tenant leak detected");
    }

    try {
        await getFamilyForActor(f1.familyId, u2.userId);
        throw new Error("User B should not access family A");
    } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (!msg.includes("access denied")) {
            throw err;
        }
    }

    console.log(JSON.stringify({ ok: true, message: "Tenant isolation passed" }));
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
