/**
 * Load synthetic world families (kawach-ai-engine eval/world) into a backend Mongo through the Mongoose models:
 * users, families, medicine schedules, Saheli reminders, companions, voice settings, WhatsApp windows, addresses,
 * permissions and order settings. Everything is invented (fake +91 90000 / +99 numbers).
 *
 * Refuses any database that is not local (localhost, 127.0.0.1 or a CI service called mongo).
 *
 *   WORLD_MONGODB_URI=mongodb://127.0.0.1:27017/world \
 *   WORLD_DIR=../kawach-ai-engine/eval/world/data/families \
 *   npx tsx scripts/seed-world.ts w0001 w0002 …     (or --ids-file ids.txt, or --all)
 */
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";

type Person = {
    id: string; key: string; first: string; surname: string; name: string; role: string; backendRole: string; relation: string;
    phone: string | null; phoneKind: string; email: string; language: string; tz: string; usesWhatsapp: boolean; careRecipient: boolean;
    sleep: { sleep: string; wake: string };
};
type WorldFamily = {
    id: string; familyId: string; people: Person[]; shapes: string[];
    places: Array<{ id: string; nickname: string; line1: string; city: string; state: string; pincode: string; landmark: string; lat: number | null; lng: number | null;
        geoPrecision: string | null; for: string[]; default: string[] }>;
    orders: { uses: string[]; spendLimitInr: number | null; approver: string | null; loginCodeFrom: string; permissions: Record<string, boolean> };
    backend: {
        familyId: string; familyName: string; createdBy: string;
        schedules: Array<{ scheduleId: string; recipientUserId: string; type: string; title: string; time: string; dosage: string; instructions: string;
            daysOfWeek: number[]; active: boolean; createdBy: string }>;
        reminders: Array<{ reminderId: string; recipientUserId: string; text: string; kind: string; times: string[]; repeat: string; date: string | null;
            windowStartMinutes: number | null; windowEndMinutes: number | null; createdBy: string }>;
        companions: Array<{ recipientUserId: string; enabled: boolean; quietHoursStart: string; quietHoursEnd: string; timezone: string }>;
        voice: Array<{ userId: string; mode: string; language: string; dialect: string | null; script: string }>;
        windows: Array<{ phone: string; hoursSinceInbound: number }>;
    };
};

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "mongo"]);

export function assertLocalMongo(uri: string): void {
    const m = uri.match(/^mongodb:\/\/(?:[^@/]+@)?([^/:?,]+)/);
    if (!m || !LOCAL.has(m[1].toLowerCase())) throw new Error(`refusing to seed the world into ${uri.replace(/\/\/[^@]*@/, "//***@")}: local or CI Mongo only`);
}

export function loadWorld(dir: string, ids: string[] | "all"): WorldFamily[] {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    const want = ids === "all" ? null : new Set(ids);
    return files.filter((f) => !want || want.has(f.replace(/\.json$/, ""))).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

function splitPhone(p: string): { countryCode: string; number: string } {
    return p.startsWith("+99") ? { countryCode: "+99", number: p.slice(3) } : { countryCode: "+91", number: p.slice(3) };
}

export async function seedWorld(families: WorldFamily[]): Promise<Record<string, number>> {
    const User = (await import("../src/models/users.model")).default;
    const Family = (await import("../src/models/family.model")).default;
    const CareSchedule = (await import("../src/models/careSchedule.model")).default;
    const SaheliReminder = (await import("../src/models/saheliReminder.model")).default;
    const SaheliCompanion = (await import("../src/models/saheliCompanion.model")).default;
    const VoicePreference = (await import("../src/models/voicePreference.model")).default;
    const WhatsAppWindow = (await import("../src/models/whatsappWindow.model")).default;
    const FamilyAddress = (await import("../src/models/familyAddress.model")).default;
    const SaheliPermissions = (await import("../src/models/saheliPermissions.model")).default;
    const FamilyCommerceSettings = (await import("../src/models/familyCommerceSettings.model")).default;
    const n: Record<string, number> = { families: 0, users: 0, schedules: 0, reminders: 0, companions: 0, addresses: 0, windows: 0 };
    for (const f of families) {
        const b = f.backend;
        const ids = f.people.map((p) => p.id);
        // a re-run replaces this family's earlier seed
        await Promise.all([
            User.deleteMany({ userId: { $in: ids } }), Family.deleteMany({ familyId: b.familyId }), CareSchedule.deleteMany({ familyId: b.familyId }),
            SaheliReminder.deleteMany({ familyId: b.familyId }), SaheliCompanion.deleteMany({ familyId: b.familyId }),
            VoicePreference.deleteMany({ familyId: b.familyId }), FamilyAddress.deleteMany({ familyId: b.familyId }),
            SaheliPermissions.deleteMany({ familyId: b.familyId }), FamilyCommerceSettings.deleteMany({ familyId: b.familyId }),
            WhatsAppWindow.deleteMany({ phone: { $in: f.people.map((p) => p.phone).filter(Boolean) } }),
        ]);
        for (const p of f.people) {
            const doc: Record<string, unknown> = {
                userId: p.id, firstName: p.first.slice(0, 50), lastName: p.surname.slice(0, 50) || undefined, email: p.email,
                passwordHash: "x-world-not-a-real-hash",
            };
            if (p.phone) {
                const ph = splitPhone(p.phone);
                doc.phone = ph;
                doc.phoneKey = `${ph.countryCode}${ph.number}`;
            }
            await User.create(doc);
            n.users++;
        }
        await Family.create({
            familyId: b.familyId, name: b.familyName.slice(0, 100), createdBy: b.createdBy,
            members: f.people.map((p) => ({ userId: p.id, role: p.backendRole, status: "JOINED", name: p.name })),
        });
        n.families++;
        for (const s of b.schedules) {
            await CareSchedule.create({ ...s, familyId: b.familyId, dosage: s.dosage.slice(0, 80) });
            n.schedules++;
        }
        for (const r of b.reminders) {
            await SaheliReminder.create({
                reminderId: r.reminderId, familyId: b.familyId, recipientUserId: r.recipientUserId, text: r.text, kind: r.kind, times: r.times,
                repeat: r.repeat, ...(r.date ? { date: r.date } : {}), ...(r.windowStartMinutes != null ? { windowStartMinutes: r.windowStartMinutes } : {}),
                ...(r.windowEndMinutes != null ? { windowEndMinutes: r.windowEndMinutes } : {}), status: "active", createdBy: r.createdBy, timezone: "Asia/Kolkata",
            });
            n.reminders++;
        }
        for (const c of b.companions) {
            await SaheliCompanion.create({ familyId: b.familyId, ...c });
            n.companions++;
        }
        for (const v of b.voice) await VoicePreference.create({ familyId: b.familyId, ...v, updatedBy: b.createdBy });
        for (const w of b.windows) {
            const last = new Date(Date.now() - w.hoursSinceInbound * 3600_000);
            await WhatsAppWindow.create({ phone: w.phone, lastInboundAt: last, ...(w.hoursSinceInbound >= 24 ? { closedAt: new Date(last.getTime() + 24 * 3600_000) } : {}) });
            n.windows++;
        }
        for (const a of f.places) {
            await FamilyAddress.create({
                addressId: a.id, familyId: b.familyId, nickname: a.nickname.slice(0, 40), line1: a.line1, nicknameKey: a.nickname.toLowerCase().replace(/\s+/g, " ").trim(),
                landmark: a.landmark || undefined, city: a.city, state: a.state, pincode: a.pincode, ...(a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : {}),
                ...(a.geoPrecision ? { geoPrecision: a.geoPrecision } : {}), memberUserIds: a.for, defaultForUserIds: a.default, createdByUserId: b.createdBy,
                source: "dashboard",
            });
            n.addresses++;
        }
        await SaheliPermissions.create({
            familyId: b.familyId, ...f.orders.permissions, spendSoftLimitInr: f.orders.spendLimitInr ?? 2000, updatedBy: b.createdBy,
        });
        if (f.orders.approver) await FamilyCommerceSettings.create({ familyId: b.familyId, approvalThresholdPaise: (f.orders.spendLimitInr ?? 2000) * 100 });
    }
    return n;
}

async function main() {
    const uri = process.env.WORLD_MONGODB_URI || process.env.TEST_MONGODB_URI || "";
    if (!uri) throw new Error("set WORLD_MONGODB_URI to a local Mongo");
    assertLocalMongo(uri);
    const dir = process.env.WORLD_DIR || path.resolve(__dirname, "../../kawach-ai-engine/eval/world/data/families");
    const args = process.argv.slice(2);
    let ids: string[] | "all" = args.filter((a) => /^w\d{4}$/.test(a));
    if (args.includes("--all")) ids = "all";
    const fileAt = args.indexOf("--ids-file");
    if (fileAt >= 0) ids = fs.readFileSync(args[fileAt + 1], "utf8").split(/\s+/).filter(Boolean);
    const families = loadWorld(dir, ids);
    const t0 = Date.now();
    await mongoose.connect(uri);
    try {
        const n = await seedWorld(families);
        console.log(`seeded ${families.length} families in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${JSON.stringify(n)}`);
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}
