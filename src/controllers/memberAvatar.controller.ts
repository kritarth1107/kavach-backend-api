/** Member photo: a caregiver (or the member) uploads it; stored on Cloudflare R2, linked on the user. */
import { Request, Response } from "express";
import path from "path";
import { AppError } from "../middleware/error.middleware";
import Family from "../models/family.model";
import User from "../models/users.model";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { canManageMembers, getFamilyMembersList } from "../services/familyMember.service";
import { deleteFamilyFile, isR2Configured, uploadFamilyFile } from "../services/r2Storage.service";

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export async function postMemberAvatar(req: Request, res: Response) {
    const actorId = req.user!.userId;
    const { familyId, memberUserId } = req.params;
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorId)) throw new AppError("Family not found or access denied", 404);
    const actorRole = (family.getMemberRole(actorId) as FamilyRole | null) ?? null;
    if (actorId !== memberUserId && !canManageMembers(actorRole)) throw new AppError("Only caregivers can change member photos", 403);
    const member = family.members.find((m) => m.userId === memberUserId && m.status !== FamilyMemberStatus.REMOVED);
    if (!member) throw new AppError("Member not found", 404);

    const file = req.file;
    if (!file) throw new AppError("Choose a photo to upload", 400);
    if (!IMAGE_TYPES.has(file.mimetype)) throw new AppError("Photo must be JPG, PNG, WebP or HEIC", 400);
    if (file.size > MAX_AVATAR_BYTES) throw new AppError("Photo must be under 5 MB", 400);
    if (!isR2Configured()) throw new AppError("Photo storage is not configured", 503);

    const ext = path.extname(file.originalname || "").toLowerCase() || `.${file.mimetype.split("/")[1]}`;
    const key = `${familyId}/avatars/${memberUserId}-${Date.now()}${ext}`;
    const url = await uploadFamilyFile(key, file.buffer, file.mimetype);

    const user = await User.findOne({ userId: memberUserId });
    if (!user) throw new AppError("Member not found", 404);
    const old = user.avatarUrl;
    user.avatarUrl = url;
    await user.save();
    // Remove the previous uploaded photo if it was ours (never a Google profile picture).
    const marker = `/${familyId}/avatars/`;
    if (old && old.includes(marker)) {
        void deleteFamilyFile(old.slice(old.indexOf(marker) + 1)).catch(() => undefined);
    }
    res.json({ success: true, data: { avatarUrl: url, ...(await getFamilyMembersList(familyId, actorId)) } });
}
