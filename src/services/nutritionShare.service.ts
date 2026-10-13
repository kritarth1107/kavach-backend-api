/**
 * Doctor links for the food and nutrition report (nutrition plan §N10, founder Q8: shared only when the caregiver, or a
 * self-care user, chooses). The report itself comes from Saheli's engine, so the dashboard, the PDF, WhatsApp and the
 * link always show the same numbers. A link expires (default 7 days), can be revoked, counts opens and shows no phone
 * numbers: only the person's name and the report.
 */
import { randomBytes } from "crypto";
import { aiEngineJson } from "../clients/aiEngine.client";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";
import type { IFamilyDocument } from "../models/family.model";
import ShareLink from "../models/shareLink.model";
import { FamilyRole } from "../types/family.types";
import { getMemberRole, isCareSubject } from "./careRecordAuth.service";

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const REPORT_DAYS = [7, 14, 30] as const;
export const DEFAULT_EXPIRES_DAYS = 7;
const MAX_EXPIRES_DAYS = 30;
const MAX_LIVE_LINKS = 20;

export function nutritionShareUrl(token: string): string {
    return `${String(config.server.liveFrontendUrl || "https://app.kavach.care").replace(/\/$/, "")}/n/${token}`;
}

/** Only a joined caregiver, about a care recipient of the family or about themselves (self care). Never the person cared
 *  for, a view-only member or a doctor. */
export function canShareNutrition(family: IFamilyDocument, subjectUserId: string, actorUserId: string): boolean {
    const role = getMemberRole(family, actorUserId);
    if (role !== FamilyRole.PRIMARY_CAREGIVER && role !== FamilyRole.CO_CAREGIVER) return false;
    return isCareSubject(family, subjectUserId, actorUserId);
}

type LinkRow = {
    _id: unknown;
    token: string;
    days: number;
    label?: string | null;
    createdBy: string;
    createdAt?: Date;
    expiresAt: Date;
    revokedAt?: Date | null;
    opens: number;
    lastOpenedAt?: Date | null;
};

function view(l: LinkRow, now = new Date()) {
    return {
        id: String(l._id),
        url: nutritionShareUrl(l.token),
        days: l.days,
        label: l.label ?? null,
        createdBy: l.createdBy,
        createdAt: l.createdAt?.toISOString() ?? null,
        expiresAt: l.expiresAt.toISOString(),
        revokedAt: l.revokedAt ? l.revokedAt.toISOString() : null,
        opens: l.opens,
        lastOpenedAt: l.lastOpenedAt ? l.lastOpenedAt.toISOString() : null,
        active: !l.revokedAt && l.expiresAt.getTime() > now.getTime(),
    };
}

export type NutritionShareView = ReturnType<typeof view>;

export async function createNutritionShare(input: {
    familyId: string;
    subjectUserId: string;
    createdBy: string;
    days?: unknown;
    expiresInDays?: unknown;
    label?: unknown;
}): Promise<NutritionShareView> {
    const days = Number(input.days ?? 7);
    if (!REPORT_DAYS.includes(days as (typeof REPORT_DAYS)[number])) throw new AppError("days must be 7, 14 or 30", 400);
    const valid = input.expiresInDays === undefined || input.expiresInDays === null ? DEFAULT_EXPIRES_DAYS : Number(input.expiresInDays);
    if (!Number.isInteger(valid) || valid < 1 || valid > MAX_EXPIRES_DAYS) throw new AppError(`expiresInDays must be 1–${MAX_EXPIRES_DAYS}`, 400);
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 80) : null;
    const now = new Date();
    const live = await ShareLink.countDocuments({
        kind: "nutrition", familyId: input.familyId, subjectUserId: input.subjectUserId, revokedAt: null, expiresAt: { $gt: now },
    });
    if (live >= MAX_LIVE_LINKS) throw new AppError("Too many open links: revoke one first", 429);
    const doc = await ShareLink.create({
        kind: "nutrition",
        token: randomBytes(18).toString("base64url"),
        familyId: input.familyId,
        subjectUserId: input.subjectUserId,
        createdBy: input.createdBy,
        days,
        label,
        expiresAt: new Date(now.getTime() + valid * 86_400_000),
    });
    return view(doc.toObject() as LinkRow, now);
}

/** Every link made for this person, newest first (the family sees what is out there, revoked and expired included). */
export async function listNutritionShares(familyId: string, subjectUserId: string): Promise<NutritionShareView[]> {
    const rows = await ShareLink.find({ kind: "nutrition", familyId, subjectUserId }).sort({ createdAt: -1 }).limit(50).lean<LinkRow[]>();
    const now = new Date();
    return rows.map((r) => view(r, now));
}

export async function revokeNutritionShare(familyId: string, subjectUserId: string, id: string): Promise<{ revoked: boolean }> {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw new AppError("Bad id", 400);
    const r = await ShareLink.updateOne(
        { _id: id, kind: "nutrition", familyId, subjectUserId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
    );
    if (!r.matchedCount) {
        const exists = await ShareLink.exists({ _id: id, kind: "nutrition", familyId, subjectUserId });
        if (!exists) throw new AppError("Link not found", 404);
    }
    return { revoked: r.modifiedCount > 0 };
}

const GONE = "This link has expired or was turned off by the family";

/** The doctor's page: the person's name and the report (no phone numbers, nothing about the family). */
export async function publicNutritionReport(token: string) {
    if (!TOKEN_RE.test(token)) throw new AppError("Link not found", 404);
    const now = new Date();
    const link = await ShareLink.findOneAndUpdate(
        { token, kind: "nutrition", revokedAt: null, expiresAt: { $gt: now } },
        { $inc: { opens: 1 }, $set: { lastOpenedAt: now } },
        { new: true },
    ).lean<LinkRow & { familyId: string; subjectUserId: string }>();
    if (!link) throw new AppError(GONE, 404);
    const { getFamilyMembersList } = await import("./familyMember.service");
    const list = await getFamilyMembersList(link.familyId, link.subjectUserId).catch(() => null);
    if (!list) throw new AppError(GONE, 404);
    type M = { userId?: string; fullName?: string; name?: string; status?: string };
    const subject = (list.members as M[]).find((m) => m.userId === link.subjectUserId && String(m.status ?? "JOINED").toUpperCase() !== "REMOVED");
    if (!subject) throw new AppError(GONE, 404);
    const raw = (await aiEngineJson(
        "GET",
        `/v2/dash/${encodeURIComponent(link.familyId)}/${encodeURIComponent(link.subjectUserId)}/nutrition/report?days=${link.days}`,
        undefined,
        45_000,
    )) as Record<string, unknown>;
    // internal ids stay inside Kavach
    const { subjectId: _subjectId, familyId: _familyId, ...report } = raw ?? {};
    return {
        person: { name: (subject.fullName || subject.name || "").trim() || "Patient" },
        days: link.days,
        sharedAt: link.createdAt?.toISOString() ?? null,
        expiresAt: link.expiresAt.toISOString(),
        report,
    };
}
