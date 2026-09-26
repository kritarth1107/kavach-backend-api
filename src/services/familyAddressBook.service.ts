/**
 * THE address resolver for every Saheli / dashboard flow (Apollo, PharmEasy, Instamart, Swiggy,
 * Zepto, Blinkit, Zomato, Uber pickup/drop, MCP store checkouts…).
 *
 * - Places are family-scoped and nicknamed (family_addresses). Never shared across families.
 * - Each member has a default place; a place confirmed on WhatsApp is remembered briefly as
 *   the "choice" for the current order/ride.
 * - No global / env / code default and no store-account fallback: null → ask the user.
 * - Legacy per-person rows (recipient_delivery_addresses) are migrated into the book.
 */
import { randomUUID } from "crypto";
import FamilyAddress, { FamilyAddressChoice, type IFamilyAddress } from "../models/familyAddress.model";
import RecipientDeliveryAddress from "../models/recipientDeliveryAddress.model";
import { cityOf, pincodeOf, shortAddress } from "./commerceAutomation/kavachAddress";

export type Place = {
    addressId: string;
    familyId: string;
    nickname: string;
    line1: string;
    line2?: string;
    landmark?: string;
    city?: string;
    state?: string;
    pincode: string;
    lat?: number;
    lng?: number;
    contactName?: string;
    contactPhone?: string;
    memberUserIds: string[];
    defaultForUserIds: string[];
    createdByUserId?: string;
    source: IFamilyAddress["source"];
    lastUsedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
    /** One-line address (line1, landmark, city, state pincode). */
    full: string;
    /** Chat-size address. */
    short: string;
};

/** Resolved delivery address for an order / ride. */
export type ResolvedAddress = { full: string; short: string; pincode: string; nickname: string; addressId: string };

export const CHOICE_TTL_MS = 45 * 60_000;

const STATE_RE =
    /^(andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|orissa|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|new delhi|jammu and kashmir|ladakh|puducherry|chandigarh)$/i;

export class AddressBookError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
    }
}

// ── Pure helpers (unit-tested) ─────────────────────────────────────────────

export function nicknameKey(s: string): string {
    return String(s || "")
        .toLowerCase()
        .replace(/['’]s\b/g, "s")
        .replace(/[^a-z0-9\u0900-\u097f]+/g, " ")
        .trim()
        .replace(/\s+/g, " ");
}

export function tidyNickname(s: string): string {
    const t = String(s || "")
        .replace(/[\r\n]+/g, " ")
        .replace(/^["'“”‘’\s]+|["'“”‘’.!\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

export function formatFull(p: Pick<Place, "line1" | "line2" | "landmark" | "city" | "state" | "pincode">): string {
    const tail = [p.state, p.pincode].filter(Boolean).join(" ");
    return [p.line1, p.line2, p.landmark, p.city, tail].map((x) => (x || "").trim()).filter(Boolean).join(", ");
}

/** Split a typed one-line address ("C-12, Green Park, Near X, Bhopal, Madhya Pradesh 462001"). */
export function splitAddress(text: string): { line1: string; landmark?: string; city?: string; state?: string; pincode: string } | null {
    const full = String(text || "").replace(/\s+/g, " ").trim();
    const pincode = pincodeOf(full);
    if (!pincode) return null;
    let parts = full
        .split(",")
        .map((p) => p.replace(new RegExp(`\\s*-?\\s*\\b${pincode}\\b\\s*`), " ").trim())
        .filter(Boolean)
        .filter((p) => !/^india$/i.test(p));
    let state: string | undefined;
    let city: string | undefined;
    if (parts.length && STATE_RE.test(parts[parts.length - 1]!)) state = parts.pop();
    if (parts.length > 1) city = parts.pop();
    else city = cityOf(full);
    let landmark: string | undefined;
    parts = parts.filter((p) => {
        if (!landmark && /^(near|opp\.?|opposite|behind|beside|next to|in front of)\b/i.test(p)) {
            landmark = p;
            return false;
        }
        return true;
    });
    const line1 = parts.join(", ").trim();
    if (line1.replace(/[^a-z]/gi, "").length < 3) return null;
    return { line1, landmark, city, state, pincode };
}

const HOME_WORDS = new Set(["home", "ghar", "mera ghar", "apna ghar", "my home", "my house", "house", "residence", "ghar pe", "ghar par", "gharpe", "मेरा घर", "घर"]);
const STOP = new Set(["ke", "ka", "ki", "ko", "the", "my", "mera", "meri", "mere", "wala", "wali", "se", "pe", "par", "bhejo", "bhej", "do", "to", "at", "place", "address", "ghar", "flat", "house", "home", "s"]);

function tokens(s: string): string[] {
    return nicknameKey(s)
        .split(" ")
        .map((w) => w.replace(/s$/, ""))
        .filter((w) => w.length >= 2 && !STOP.has(w));
}

/** Match spoken words ("ghar", "beta ke ghar", "clinic") to ONE saved place of this family. */
export function matchPlace<T extends { nickname: string; defaultForUserIds?: string[] }>(
    places: T[],
    words: string | null | undefined,
    memberUserId?: string,
): T | null {
    const k = nicknameKey(words || "");
    if (!k || !places.length) return null;
    const exact = places.find((p) => nicknameKey(p.nickname) === k);
    if (exact) return exact;
    if (HOME_WORDS.has(k)) {
        return (
            places.find((p) => nicknameKey(p.nickname) === "home") ||
            (memberUserId ? places.find((p) => p.defaultForUserIds?.includes(memberUserId)) : undefined) ||
            null
        );
    }
    const contains = places.filter((p) => {
        const n = nicknameKey(p.nickname);
        return n.length >= 3 && (k.includes(n) || n.includes(k));
    });
    if (contains.length === 1) return contains[0]!;
    const q = tokens(k);
    if (!q.length) return null;
    const scored = places
        .map((p) => {
            const t = tokens(p.nickname);
            return { p, hit: q.filter((w) => t.some((x) => x === w || (x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x))))).length };
        })
        .filter((s) => s.hit > 0)
        .sort((a, b) => b.hit - a.hit);
    if (scored.length === 1 || (scored.length > 1 && scored[0]!.hit > scored[1]!.hit)) return scored[0]!.p;
    return null;
}

/** Store-shown address matches a family place: same pincode AND the flat or first street part. */
export function storeAddressMatchesPlace(shown: string | null | undefined, place: Pick<Place, "line1" | "pincode"> | null | undefined): boolean {
    if (!shown || !place) return false;
    if (pincodeOf(shown) !== place.pincode && !new RegExp(`\\b${place.pincode}\\b`).test(shown)) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const n = norm(shown);
    const keys = keyLines(place.line1).map(norm).filter(Boolean);
    if (!keys.length) return true; // no distinctive line to check → pincode only
    return keys.some((x) => n.includes(x));
}

/** ≥3 alphanumerics, or a letter+digit flat code like "B7" (a bare "12" hides inside pincodes). */
function distinctive(x: string): boolean {
    const a = x.replace(/[^a-z0-9]/gi, "");
    return a.length >= 3 || (a.length === 2 && /[a-z]/i.test(a) && /\d/.test(a));
}

/** Distinctive fragments of line1: the flat/house token and the first named street/society part. */
export function keyLines(line1: string): string[] {
    const parts = String(line1 || "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    const out: string[] = [];
    const first = parts[0] || "";
    const m = first.match(/^((?:flat|house|h\.?\s*no\.?)?\s*[a-z]{0,3}[-\s]?\d{1,5}[a-z]?)(?:\s+(.+))?$/i);
    if (m) {
        out.push(m[1]!.replace(/^(?:flat|house|h\.?\s*no\.?)\s*/i, "").replace(/\s+/g, ""));
        if (m[2]) out.push(m[2]);
        else if (parts[1]) out.push(parts[1]);
    } else if (first) out.push(first);
    return out.filter(distinctive);
}

function toPlace(row: IFamilyAddress & { createdAt?: Date; updatedAt?: Date }): Place {
    const full = formatFull(row);
    return {
        addressId: row.addressId,
        familyId: row.familyId,
        nickname: row.nickname,
        line1: row.line1,
        line2: row.line2 || undefined,
        landmark: row.landmark || undefined,
        city: row.city || undefined,
        state: row.state || undefined,
        pincode: row.pincode,
        lat: row.lat ?? undefined,
        lng: row.lng ?? undefined,
        contactName: row.contactName || undefined,
        contactPhone: row.contactPhone || undefined,
        memberUserIds: row.memberUserIds || [],
        defaultForUserIds: row.defaultForUserIds || [],
        createdByUserId: row.createdByUserId,
        source: row.source,
        lastUsedAt: row.lastUsedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        full,
        short: shortAddress(full),
    };
}

export function toResolved(p: Place): ResolvedAddress {
    return { full: p.full, short: p.short, pincode: p.pincode, nickname: p.nickname, addressId: p.addressId };
}

const appliesTo = (p: Pick<Place, "memberUserIds">, memberUserId?: string) =>
    !memberUserId || !p.memberUserIds.length || p.memberUserIds.includes(memberUserId);

// ── Migration (legacy per-person rows → family book) ──────────────────────

const migrated = new Set<string>();

export async function migrateLegacyForFamily(familyId: string): Promise<number> {
    if (!familyId || migrated.has(familyId)) return 0;
    const legacy = await RecipientDeliveryAddress.find({ familyId, migratedAt: { $exists: false } }).lean().catch(() => []);
    let n = 0;
    for (const row of legacy) {
        const parts = splitAddress(row.address);
        if (!parts) continue;
        const existing = (await FamilyAddress.find({ familyId }).lean()).map((r) => toPlace(r));
        const same = existing.find((p) => p.pincode === parts.pincode && storeAddressMatchesPlace(row.address, p));
        if (same) {
            const set: Record<string, unknown> = {};
            if (!existing.some((p) => p.defaultForUserIds.includes(row.recipientUserId))) {
                set.defaultForUserIds = Array.from(new Set([...same.defaultForUserIds, row.recipientUserId]));
            }
            if (same.memberUserIds.length && !same.memberUserIds.includes(row.recipientUserId)) {
                set.memberUserIds = [...same.memberUserIds, row.recipientUserId];
            }
            if (Object.keys(set).length) await FamilyAddress.updateOne({ addressId: same.addressId }, { $set: set });
            await RecipientDeliveryAddress.updateOne({ _id: row._id }, { $set: { migratedAt: new Date() } });
            continue;
        }
        const nickname = await freeNickname(familyId, "Home");
        await FamilyAddress.create({
            addressId: randomUUID(),
            familyId,
            nickname,
            nicknameKey: nicknameKey(nickname),
            ...parts,
            memberUserIds: [],
            defaultForUserIds: existing.some((p) => p.defaultForUserIds.includes(row.recipientUserId)) ? [] : [row.recipientUserId],
            createdByUserId: row.setByUserId || row.recipientUserId,
            source: "migration",
        }).catch((err) => {
            if (!/duplicate key|E11000/i.test(String(err?.message))) throw err;
        });
        await RecipientDeliveryAddress.updateOne({ _id: row._id }, { $set: { migratedAt: new Date() } });
        n++;
    }
    migrated.add(familyId);
    return n;
}

/** One pass over every legacy row (startup). Idempotent. */
export async function migrateAllLegacyAddresses(): Promise<number> {
    const fams: string[] = await RecipientDeliveryAddress.distinct("familyId", { migratedAt: { $exists: false } }).catch(() => []);
    let n = 0;
    for (const f of fams) n += await migrateLegacyForFamily(f).catch((err) => {
        console.warn("[address-book] migrate failed for family …" + String(f).slice(-4), err instanceof Error ? err.message : err);
        return 0;
    });
    return n;
}

// ── Queries ────────────────────────────────────────────────────────────────

export async function listPlaces(familyId: string, opts: { memberUserId?: string } = {}): Promise<Place[]> {
    if (!familyId) return [];
    await migrateLegacyForFamily(familyId).catch(() => 0);
    const rows = await FamilyAddress.find({ familyId }).lean().catch(() => []);
    const places = rows.map((r) => toPlace(r)).filter((p) => appliesTo(p, opts.memberUserId));
    const m = opts.memberUserId;
    return places.sort((a, b) => {
        const da = m && a.defaultForUserIds.includes(m) ? 1 : 0;
        const db = m && b.defaultForUserIds.includes(m) ? 1 : 0;
        if (da !== db) return db - da;
        return new Date(b.lastUsedAt || b.updatedAt || 0).getTime() - new Date(a.lastUsedAt || a.updatedAt || 0).getTime();
    });
}

export async function getPlace(familyId: string, addressId: string): Promise<Place | null> {
    if (!familyId || !addressId) return null;
    const row = await FamilyAddress.findOne({ familyId, addressId }).lean().catch(() => null);
    return row ? toPlace(row) : null;
}

/** Member's default: explicit default → "Home" → the only place → most recently used. */
export function pickDefault(places: Place[], memberUserId?: string): Place | null {
    if (!places.length) return null;
    return (
        (memberUserId ? places.find((p) => p.defaultForUserIds.includes(memberUserId)) : undefined) ||
        places.find((p) => nicknameKey(p.nickname) === "home") ||
        places[0] ||
        null
    );
}

export async function defaultPlaceFor(familyId: string, memberUserId?: string): Promise<Place | null> {
    return pickDefault(await listPlaces(familyId, { memberUserId }), memberUserId);
}

export async function findPlaceByWords(familyId: string, memberUserId: string | undefined, words: string | null | undefined): Promise<Place | null> {
    if (!words) return null;
    return matchPlace(await listPlaces(familyId, { memberUserId }), words, memberUserId);
}

/** The place confirmed for this member's current order / ride (fresh only). */
export async function currentChoice(familyId: string, memberUserId: string): Promise<Place | null> {
    const c = await FamilyAddressChoice.findOne({ familyId, memberUserId }).lean().catch(() => null);
    if (!c || Date.now() - new Date(c.chosenAt).getTime() > CHOICE_TTL_MS) return null;
    const p = await getPlace(familyId, c.addressId);
    return p && appliesTo(p, memberUserId) ? p : null;
}

export async function setChoice(familyId: string, memberUserId: string, addressId: string): Promise<void> {
    const p = await getPlace(familyId, addressId);
    if (!p) throw new AddressBookError("Address not found", 404);
    await FamilyAddressChoice.findOneAndUpdate(
        { familyId, memberUserId },
        { $set: { addressId, chosenAt: new Date() } },
        { upsert: true },
    );
    await FamilyAddress.updateOne({ familyId, addressId }, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
}

export async function clearChoice(familyId: string, memberUserId: string): Promise<void> {
    await FamilyAddressChoice.deleteOne({ familyId, memberUserId }).catch(() => undefined);
}

/**
 * THE resolver. Order: named place ("clinic", "ghar") → place confirmed for the current
 * order → member's default. Always within this family. null = ask the user.
 */
export async function resolveAddress(input: {
    familyId?: string;
    memberUserId?: string;
    nickname?: string | null;
    /** Only the member's default (skip the short-lived choice). */
    ignoreChoice?: boolean;
}): Promise<ResolvedAddress | null> {
    if (!input.familyId) return null;
    if (input.nickname) {
        const p = await findPlaceByWords(input.familyId, input.memberUserId, input.nickname);
        if (p) return toResolved(p);
    }
    if (input.memberUserId && !input.ignoreChoice) {
        const c = await currentChoice(input.familyId, input.memberUserId);
        if (c) return toResolved(c);
    }
    const d = await defaultPlaceFor(input.familyId, input.memberUserId);
    return d ? toResolved(d) : null;
}

// ── Writes ─────────────────────────────────────────────────────────────────

async function freeNickname(familyId: string, wanted: string): Promise<string> {
    const base = tidyNickname(wanted) || "Home";
    const taken = new Set((await FamilyAddress.find({ familyId }, { nicknameKey: 1 }).lean()).map((r) => r.nicknameKey));
    if (!taken.has(nicknameKey(base))) return base;
    for (let i = 2; i < 50; i++) {
        const n = `${base} ${i}`;
        if (!taken.has(nicknameKey(n))) return n;
    }
    return `${base} ${Date.now() % 10000}`;
}

export type PlaceInput = {
    nickname?: string;
    /** Either a one-line address (parsed) or explicit lines. */
    address?: string;
    line1?: string;
    line2?: string;
    landmark?: string;
    city?: string;
    state?: string;
    pincode?: string;
    lat?: number | null;
    lng?: number | null;
    contactName?: string;
    contactPhone?: string;
    memberUserIds?: string[];
    defaultForUserIds?: string[];
};

function validFields(input: PlaceInput): Partial<IFamilyAddress> {
    let base: Partial<IFamilyAddress> = {};
    if (input.address) {
        const s = splitAddress(input.address);
        if (!s) throw new AddressBookError("Address needs street details and a valid 6-digit pincode", 400);
        base = { ...s };
    }
    const pick = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);
    const out: Partial<IFamilyAddress> = { ...base };
    if (input.line1 !== undefined) out.line1 = pick(input.line1, 240);
    if (input.line2 !== undefined) out.line2 = pick(input.line2, 160);
    if (input.landmark !== undefined) out.landmark = pick(input.landmark, 120);
    if (input.city !== undefined) out.city = pick(input.city, 60);
    if (input.state !== undefined) out.state = pick(input.state, 60);
    if (input.pincode !== undefined) {
        const pin = String(input.pincode).trim();
        if (!/^[1-9]\d{5}$/.test(pin)) throw new AddressBookError("pincode must be a valid 6-digit Indian pincode", 400);
        out.pincode = pin;
    }
    if (input.lat !== undefined) out.lat = input.lat === null ? undefined : Number(input.lat);
    if (input.lng !== undefined) out.lng = input.lng === null ? undefined : Number(input.lng);
    if (out.lat !== undefined && !(Math.abs(out.lat) <= 90)) throw new AddressBookError("lat out of range", 400);
    if (out.lng !== undefined && !(Math.abs(out.lng) <= 180)) throw new AddressBookError("lng out of range", 400);
    if (input.contactName !== undefined) out.contactName = pick(input.contactName, 80);
    if (input.contactPhone !== undefined) {
        const ph = String(input.contactPhone || "").replace(/[^\d+]/g, "");
        if (ph && !/^\+?\d{10,13}$/.test(ph)) throw new AddressBookError("contactPhone must be 10–13 digits", 400);
        out.contactPhone = ph || undefined;
    }
    return out;
}

/** Only ids of this family's joined members are accepted (caller passes them). */
function cleanMembers(ids: unknown, familyMemberIds: string[] | undefined): string[] | undefined {
    if (ids === undefined) return undefined;
    if (!Array.isArray(ids)) throw new AddressBookError("memberUserIds must be an array", 400);
    const s = Array.from(new Set(ids.map(String)));
    if (familyMemberIds && s.some((id) => !familyMemberIds.includes(id))) throw new AddressBookError("Unknown family member", 400);
    return s;
}

export async function createPlace(
    familyId: string,
    input: PlaceInput,
    opts: { actorUserId?: string; source: IFamilyAddress["source"]; familyMemberIds?: string[]; autoNickname?: boolean },
): Promise<Place> {
    await migrateLegacyForFamily(familyId).catch(() => 0);
    const f = validFields(input);
    if (!f.line1 || !f.pincode) throw new AddressBookError("line1 and pincode are required", 400);
    const wanted = tidyNickname(input.nickname || "") || (opts.autoNickname ? "Home" : "");
    if (!wanted) throw new AddressBookError("nickname is required", 400);
    let nickname = wanted;
    if (await FamilyAddress.exists({ familyId, nicknameKey: nicknameKey(wanted) })) {
        if (!opts.autoNickname) throw new AddressBookError(`A place called "${wanted}" already exists`, 409);
        nickname = await freeNickname(familyId, wanted);
    }
    const memberUserIds = cleanMembers(input.memberUserIds, opts.familyMemberIds) ?? [];
    const defaults = cleanMembers(input.defaultForUserIds, opts.familyMemberIds) ?? [];
    if (defaults.length) await FamilyAddress.updateMany({ familyId }, { $pull: { defaultForUserIds: { $in: defaults } } });
    const row = await FamilyAddress.create({
        addressId: randomUUID(),
        familyId,
        nickname,
        nicknameKey: nicknameKey(nickname),
        ...f,
        memberUserIds,
        defaultForUserIds: defaults,
        createdByUserId: opts.actorUserId,
        source: opts.source,
    });
    return toPlace(row.toObject());
}

export async function updatePlace(
    familyId: string,
    addressId: string,
    input: PlaceInput,
    opts: { familyMemberIds?: string[] } = {},
): Promise<Place> {
    const cur = await FamilyAddress.findOne({ familyId, addressId });
    if (!cur) throw new AddressBookError("Address not found", 404);
    const f = validFields(input);
    const set: Record<string, unknown> = { ...f };
    if (input.nickname !== undefined) {
        const nick = tidyNickname(input.nickname);
        if (!nick) throw new AddressBookError("nickname can't be empty", 400);
        const key = nicknameKey(nick);
        if (key !== cur.nicknameKey && (await FamilyAddress.exists({ familyId, nicknameKey: key }))) {
            throw new AddressBookError(`A place called "${nick}" already exists`, 409);
        }
        set.nickname = nick;
        set.nicknameKey = key;
    }
    const members = cleanMembers(input.memberUserIds, opts.familyMemberIds);
    if (members) set.memberUserIds = members;
    const defaults = cleanMembers(input.defaultForUserIds, opts.familyMemberIds);
    if (defaults) {
        if (defaults.length) await FamilyAddress.updateMany({ familyId, addressId: { $ne: addressId } }, { $pull: { defaultForUserIds: { $in: defaults } } });
        set.defaultForUserIds = defaults;
    }
    const unset: Record<string, 1> = {};
    for (const [k, v] of Object.entries(set)) if (v === undefined || v === "") { unset[k] = 1; delete set[k]; }
    if ("line1" in unset || "pincode" in unset) throw new AddressBookError("line1 and pincode can't be empty", 400);
    const row = await FamilyAddress.findOneAndUpdate(
        { familyId, addressId },
        { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        { new: true },
    ).lean();
    return toPlace(row!);
}

export async function deletePlace(familyId: string, addressId: string): Promise<void> {
    const r = await FamilyAddress.deleteOne({ familyId, addressId });
    if (!r.deletedCount) throw new AddressBookError("Address not found", 404);
    await FamilyAddressChoice.deleteMany({ familyId, addressId }).catch(() => undefined);
}

export async function setDefaultPlace(familyId: string, addressId: string, memberUserId: string): Promise<Place> {
    const p = await getPlace(familyId, addressId);
    if (!p) throw new AddressBookError("Address not found", 404);
    if (!appliesTo(p, memberUserId)) throw new AddressBookError("This place isn't shared with that member", 400);
    await FamilyAddress.updateMany({ familyId }, { $pull: { defaultForUserIds: memberUserId } });
    await FamilyAddress.updateOne({ familyId, addressId }, { $addToSet: { defaultForUserIds: memberUserId } });
    return (await getPlace(familyId, addressId))!;
}

/**
 * WhatsApp: the elder / caregiver typed a new address. Reuses a matching saved place, else
 * saves it with a provisional nickname (Home if the member has none yet) — Saheli then asks
 * what to call it. The first place of a member becomes their default.
 */
export async function savePlaceFromChat(input: {
    familyId: string;
    memberUserId: string;
    address: string;
    actorUserId?: string;
    nickname?: string | null;
}): Promise<{ place: Place; created: boolean } | null> {
    const parts = splitAddress(input.address);
    if (!parts) return null;
    const mine = await listPlaces(input.familyId, { memberUserId: input.memberUserId });
    const full = formatFull(parts);
    const same = mine.find((p) => p.pincode === parts.pincode && (nicknameKey(p.full) === nicknameKey(full) || storeAddressMatchesPlace(full, p)));
    if (same) {
        if (input.nickname && nicknameKey(input.nickname) !== nicknameKey(same.nickname)) {
            return { place: await updatePlace(input.familyId, same.addressId, { nickname: input.nickname }).catch(() => same), created: false };
        }
        return { place: same, created: false };
    }
    const place = await createPlace(
        input.familyId,
        { ...parts, nickname: input.nickname || (mine.length ? "New place" : "Home"), defaultForUserIds: mine.length ? [] : [input.memberUserId] },
        { actorUserId: input.actorUserId, source: "whatsapp", autoNickname: true },
    );
    return { place, created: true };
}

/** Router context: nickname + city + pincode only (never full street lines). */
export async function placesSummary(familyId: string, memberUserId?: string): Promise<string | null> {
    const places = await listPlaces(familyId, { memberUserId }).catch(() => []);
    if (!places.length) return null;
    const d = pickDefault(places, memberUserId);
    return `saved places: ${places
        .slice(0, 8)
        .map((p) => `"${p.nickname}"${p.addressId === d?.addressId ? " (default)" : ""} ${p.city || ""} ${p.pincode}`.replace(/\s+/g, " "))
        .join("; ")}`;
}

/** MCP store checkouts: keep only store-account addresses that match a place in this family's book. */
export async function filterStoreAddressesToBook<T extends { line1?: string; line2?: string; city?: string; pincode?: string; label?: string }>(
    familyId: string,
    rows: T[],
    memberUserId?: string,
): Promise<Array<T & { place: Place }>> {
    const places = await listPlaces(familyId, { memberUserId }).catch(() => []);
    const out: Array<T & { place: Place }> = [];
    for (const r of rows) {
        const shown = [r.line1, r.line2, r.city, r.pincode].filter(Boolean).join(", ");
        const place = places.find((p) => storeAddressMatchesPlace(shown, p));
        if (place) out.push({ ...r, place });
    }
    return out;
}
