/**
 * Family address book API (docs/address-book-api.md). Family-scoped like the activity routes:
 * the caller must be a JOINED member of :familyId; writes need a caregiver role.
 */
import type { Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { getFamilyForActor, getMemberRole } from "../services/careRecordAuth.service";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import {
    AddressBookError,
    createPlace,
    deletePlace,
    getPlace,
    listPlaces,
    pickDefault,
    setDefaultPlace,
    updatePlace,
    type Place,
    type PlaceInput,
} from "../services/familyAddressBook.service";

async function access(req: Request, write: boolean) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    const role = getMemberRole(family, actorUserId);
    if (write && role !== FamilyRole.PRIMARY_CAREGIVER && role !== FamilyRole.CO_CAREGIVER) {
        throw new AppError("Only caregivers can change the address book", 403);
    }
    const memberIds = family.members.filter((m) => m.status === FamilyMemberStatus.JOINED).map((m) => m.userId);
    return { familyId, actorUserId, memberIds };
}

function view(p: Place, memberUserId?: string, defaultId?: string) {
    return {
        addressId: p.addressId,
        nickname: p.nickname,
        line1: p.line1,
        line2: p.line2 ?? null,
        landmark: p.landmark ?? null,
        city: p.city ?? null,
        state: p.state ?? null,
        pincode: p.pincode,
        lat: p.lat ?? null,
        lng: p.lng ?? null,
        contactName: p.contactName ?? null,
        contactPhone: p.contactPhone ?? null,
        fullAddress: p.full,
        memberUserIds: p.memberUserIds,
        defaultForUserIds: p.defaultForUserIds,
        isDefaultForMember: memberUserId ? p.addressId === defaultId : undefined,
        createdByUserId: p.createdByUserId ?? null,
        source: p.source,
        lastUsedAt: p.lastUsedAt ? new Date(p.lastUsedAt).toISOString() : null,
        createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
        updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    };
}

function body(req: Request): PlaceInput {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const out: PlaceInput = {};
    for (const k of ["nickname", "address", "line1", "line2", "landmark", "city", "state", "pincode", "contactName", "contactPhone"] as const) {
        if (b[k] !== undefined) {
            if (b[k] !== null && typeof b[k] !== "string") throw new AppError(`${k} must be a string`, 400);
            out[k] = (b[k] as string | null) ?? "";
        }
    }
    for (const k of ["lat", "lng"] as const) {
        if (b[k] !== undefined) {
            if (b[k] !== null && typeof b[k] !== "number") throw new AppError(`${k} must be a number`, 400);
            out[k] = b[k] as number | null;
        }
    }
    if (b.memberUserIds !== undefined) out.memberUserIds = b.memberUserIds as string[];
    if (b.defaultForUserIds !== undefined) out.defaultForUserIds = b.defaultForUserIds as string[];
    return out;
}

const wrapErr = (err: unknown): never => {
    if (err instanceof AddressBookError) throw new AppError(err.message, err.status);
    throw err;
};

export async function listFamilyAddressesHandler(req: Request, res: Response) {
    const { familyId, memberIds } = await access(req, false);
    const memberUserId = typeof req.query.memberUserId === "string" && req.query.memberUserId ? req.query.memberUserId : undefined;
    if (memberUserId && !memberIds.includes(memberUserId)) throw new AppError("Unknown family member", 400);
    const places = await listPlaces(familyId, { memberUserId });
    const d = memberUserId ? pickDefault(places, memberUserId) : null;
    res.json({ success: true, data: { addresses: places.map((p) => view(p, memberUserId, d?.addressId)) } });
}

export async function getFamilyAddressHandler(req: Request, res: Response) {
    const { familyId } = await access(req, false);
    const p = await getPlace(familyId, req.params.addressId);
    if (!p) throw new AppError("Address not found", 404);
    res.json({ success: true, data: { address: view(p) } });
}

export async function createFamilyAddressHandler(req: Request, res: Response) {
    const { familyId, actorUserId, memberIds } = await access(req, true);
    const p = await createPlace(familyId, body(req), { actorUserId, source: "dashboard", familyMemberIds: memberIds }).catch(wrapErr);
    res.status(201).json({ success: true, data: { address: view(p) } });
}

export async function updateFamilyAddressHandler(req: Request, res: Response) {
    const { familyId, memberIds } = await access(req, true);
    const p = await updatePlace(familyId, req.params.addressId, body(req), { familyMemberIds: memberIds }).catch(wrapErr);
    res.json({ success: true, data: { address: view(p) } });
}

export async function deleteFamilyAddressHandler(req: Request, res: Response) {
    const { familyId } = await access(req, true);
    await deletePlace(familyId, req.params.addressId).catch(wrapErr);
    res.json({ success: true, data: { deleted: true } });
}

export async function setDefaultFamilyAddressHandler(req: Request, res: Response) {
    const { familyId, memberIds } = await access(req, true);
    const memberUserId = String((req.body ?? {}).memberUserId || "");
    if (!memberUserId || !memberIds.includes(memberUserId)) throw new AppError("memberUserId must be a joined family member", 400);
    const p = await setDefaultPlace(familyId, req.params.addressId, memberUserId).catch(wrapErr);
    res.json({ success: true, data: { address: view(p, memberUserId, p.addressId) } });
}
