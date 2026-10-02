/**
 * Emergency card share links. The card itself comes from Saheli's care memory (ai-engine), so the
 * dashboard, WhatsApp and the public link always show the same record.
 */
import { randomBytes } from "crypto";
import { aiEngineJson } from "../clients/aiEngine.client";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";
import EmergencyLink from "../models/emergencyLink.model";
import Family from "../models/family.model";
import User from "../models/users.model";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function emergencyUrl(token: string): string {
    return `${String(config.server.liveFrontendUrl || "https://app.kavach.care").replace(/\/$/, "")}/e/${token}`;
}

/** One live link per person; reuse it unless it was revoked. */
export async function ensureEmergencyLink(familyId: string, subjectUserId: string, createdBy: string) {
    const live = await EmergencyLink.findOne({ familyId, subjectUserId, revokedAt: null }).lean();
    if (live) return { token: live.token, url: emergencyUrl(live.token), createdAt: live.createdAt, opens: live.opens };
    const token = randomBytes(18).toString("base64url");
    const doc = await EmergencyLink.create({ token, familyId, subjectUserId, createdBy });
    return { token, url: emergencyUrl(token), createdAt: doc.createdAt, opens: 0 };
}

export async function revokeEmergencyLinks(familyId: string, subjectUserId: string) {
    const r = await EmergencyLink.updateMany({ familyId, subjectUserId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return { revoked: r.modifiedCount };
}

export async function currentEmergencyLink(familyId: string, subjectUserId: string) {
    const live = await EmergencyLink.findOne({ familyId, subjectUserId, revokedAt: null }).lean();
    return live ? { url: emergencyUrl(live.token), createdAt: live.createdAt, opens: live.opens, lastOpenedAt: live.lastOpenedAt } : null;
}

/** The public card: the care facts plus the person's name and the caregivers' phone numbers. */
export async function publicEmergencyCard(token: string) {
    if (!TOKEN_RE.test(token)) throw new AppError("Link not found", 404);
    const link = await EmergencyLink.findOneAndUpdate(
        { token, revokedAt: null },
        { $inc: { opens: 1 }, $set: { lastOpenedAt: new Date() } },
        { new: true },
    ).lean();
    if (!link) throw new AppError("This emergency link is no longer active", 404);
    const family = await Family.findOne({ familyId: link.familyId, status: "ACTIVE" }).lean();
    if (!family) throw new AppError("This emergency link is no longer active", 404);
    const joined = family.members.filter((m) => m.status === FamilyMemberStatus.JOINED);
    const users = await User.find({ userId: { $in: joined.map((m) => m.userId) } }).lean();
    const byId = new Map(users.map((u) => [u.userId, u]));
    const person = byId.get(link.subjectUserId);
    const phone = (u: (typeof users)[number] | undefined) => {
        const p = u?.phone as { countryCode?: string; number?: string } | undefined;
        return p?.number ? `${p.countryCode || "+91"} ${p.number}` : null;
    };
    const caregivers = joined
        .filter((m) => m.role === FamilyRole.PRIMARY_CAREGIVER || m.role === FamilyRole.CO_CAREGIVER)
        .filter((m) => m.userId !== link.subjectUserId)
        .map((m) => {
            const u = byId.get(m.userId);
            return { name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "Family", phone: phone(u), primary: m.role === FamilyRole.PRIMARY_CAREGIVER };
        })
        .sort((a, b) => Number(b.primary) - Number(a.primary));
    const card = await aiEngineJson(
        "GET",
        `/v2/dash/${encodeURIComponent(link.familyId)}/${encodeURIComponent(link.subjectUserId)}/emergency`,
    );
    return {
        person: {
            name: [person?.firstName, person?.lastName].filter(Boolean).join(" ") || "Care recipient",
            photo: person?.avatarUrl ?? null,
            phone: phone(person),
        },
        caregivers,
        card,
        updatedAt: new Date().toISOString(),
    };
}
