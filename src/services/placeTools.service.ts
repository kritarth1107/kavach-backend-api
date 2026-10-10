/**
 * Saheli (WhatsApp) access to the family address book: the same places the dashboard manages (standing rule: every
 * dashboard feature also works through Saheli). Saving: the care recipient for their own places, or a caregiver.
 * Removing: caregivers only, after the person said yes. View-only members and doctors can only look.
 */
import { FamilyRole } from "../types/family.types";
import { getFamilyForActor, getMemberRole } from "./careRecordAuth.service";
import {
    AddressBookError,
    createPlace,
    deletePlace,
    formatFull,
    listPlaces,
    matchPlace,
    nicknameKey,
    pickDefault,
    setDefaultPlace,
    splitAddress,
    storeAddressMatchesPlace,
    tidyNickname,
    updatePlace,
    type Place,
    type PlaceInput,
} from "./familyAddressBook.service";

type Ctx = { familyId: string; recipientUserId: string; actorUserId: string };

const CAREGIVERS = new Set<FamilyRole | null>([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

function maskPhone(p?: string): string | null {
    const d = String(p || "").replace(/\D/g, "");
    return d.length >= 10 ? `ending ${d.slice(-4)}` : null;
}

function view(p: Place, defaultId?: string) {
    return {
        name: p.nickname,
        address: p.full,
        pincode: p.pincode,
        receiver: p.contactName || p.contactPhone ? [p.contactName, maskPhone(p.contactPhone)].filter(Boolean).join(", ") : null,
        isDefault: p.addressId === defaultId,
    };
}

async function role(ctx: Ctx): Promise<FamilyRole | null> {
    return getMemberRole(await getFamilyForActor(ctx.familyId, ctx.actorUserId), ctx.actorUserId);
}

/** Words → one saved place of this person: its name ("Beta's flat", "ghar"), else a pincode or city only one place has. */
export function findByWords(places: Place[], words: string, memberUserId?: string): Place | null {
    const byName = matchPlace(places, words, memberUserId);
    if (byName) return byName;
    const k = nicknameKey(words);
    const pin = k.match(/\b[1-9]\d{5}\b/)?.[0];
    const hits = places.filter((p) => (pin ? p.pincode === pin : !!p.city && nicknameKey(p.city).length >= 3 && ` ${k} `.includes(` ${nicknameKey(p.city)} `)));
    return hits.length === 1 ? hits[0]! : null;
}

export async function listPlacesTool(ctx: Ctx): Promise<Record<string, unknown>> {
    const places = await listPlaces(ctx.familyId, { memberUserId: ctx.recipientUserId });
    const d = pickDefault(places, ctx.recipientUserId);
    return places.length
        ? { places: places.map((p) => view(p, d?.addressId)), note: "Orders go only to one of these places, confirmed with the person." }
        : { places: [], note: "No saved place yet: ask for the full address with pincode and what to call it, then save it with save_place." };
}

function err(e: unknown): Record<string, unknown> {
    if (e instanceof AddressBookError) return { ok: false, error: e.message };
    throw e;
}

/**
 * Save a new place, or change a saved one (place = its name): address, name, receiver, default for this person.
 * A new address that is already saved is not added twice.
 */
export async function savePlaceTool(ctx: Ctx, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await role(ctx);
    const own = r === FamilyRole.CARE_RECIPIENT && ctx.actorUserId === ctx.recipientUserId;
    if (!own && !CAREGIVERS.has(r)) return { ok: false, error: "Only the person themselves or a caregiver can save or change places." };
    const str = (k: string) => (typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string).trim() : undefined);
    const address = str("address");
    const name = str("name") ? tidyNickname(str("name")!) : undefined;
    const target = str("place");
    const makeDefault = args.make_default === true;
    const fields: PlaceInput = {};
    if (str("receiver_name") !== undefined) fields.contactName = str("receiver_name");
    if (str("receiver_phone") !== undefined) fields.contactPhone = str("receiver_phone");
    if (address) {
        const parts = splitAddress(address);
        if (!parts) return { ok: false, error: "That address needs the house/flat and street, and a valid 6-digit pincode. Ask for the full address." };
        Object.assign(fields, { line1: parts.line1, landmark: parts.landmark ?? "", city: parts.city ?? "", state: parts.state ?? "", pincode: parts.pincode, line2: "" });
    }
    const mine = await listPlaces(ctx.familyId, { memberUserId: ctx.recipientUserId });
    try {
        let place: Place;
        let created = false;
        if (target) {
            // change a saved place
            const cur = findByWords(mine, target, ctx.recipientUserId);
            if (!cur) return { ok: false, error: `No saved place called "${target}".`, places: mine.map((p) => p.nickname) };
            if (name && nicknameKey(name) !== nicknameKey(cur.nickname)) fields.nickname = name;
            if (!Object.keys(fields).length && !makeDefault) return { ok: false, error: "Nothing to change: give a new address, name, receiver, or make_default." };
            place = Object.keys(fields).length ? await updatePlace(ctx.familyId, cur.addressId, fields) : cur;
        } else {
            if (!address) return { ok: false, error: "Give the full address with pincode for a new place (or place = the saved place to change)." };
            const full = formatFull({ line1: fields.line1!, landmark: fields.landmark, city: fields.city, state: fields.state, pincode: fields.pincode! });
            const same = mine.find((p) => p.pincode === fields.pincode && (nicknameKey(p.full) === nicknameKey(full) || storeAddressMatchesPlace(full, p)));
            if (same) {
                const change: PlaceInput = {};
                if (name && nicknameKey(name) !== nicknameKey(same.nickname)) change.nickname = name;
                if (fields.contactName !== undefined) change.contactName = fields.contactName;
                if (fields.contactPhone !== undefined) change.contactPhone = fields.contactPhone;
                place = Object.keys(change).length ? await updatePlace(ctx.familyId, same.addressId, change) : same;
            } else {
                const nickname = name || (mine.length ? "" : "Home");
                if (!nickname) return { ok: false, error: "Ask what to call this place (e.g. Beta's flat, Clinic), then save it with that name." };
                const taken = mine.find((p) => nicknameKey(p.nickname) === nicknameKey(nickname));
                if (taken) {
                    return { ok: false, error: `"${taken.nickname}" is already saved as ${taken.full}. Ask whether to replace that address (place="${taken.nickname}" with the new address) or use another name.` };
                }
                place = await createPlace(
                    ctx.familyId,
                    { ...fields, nickname, defaultForUserIds: mine.length && !makeDefault ? [] : [ctx.recipientUserId] },
                    { actorUserId: ctx.actorUserId, source: "whatsapp" },
                );
                created = true;
            }
        }
        if (makeDefault && !place.defaultForUserIds.includes(ctx.recipientUserId)) place = await setDefaultPlace(ctx.familyId, place.addressId, ctx.recipientUserId);
        const d = pickDefault(await listPlaces(ctx.familyId, { memberUserId: ctx.recipientUserId }), ctx.recipientUserId);
        return {
            ok: true,
            created,
            place: view(place, d?.addressId),
            note: created
                ? "Saved in the family address book (the dashboard shows it too). Read the name and area back in one line. For an order there, pass its name as area in start_task."
                : "Updated in the family address book. Read the change back in one line.",
        };
    } catch (e) {
        return err(e);
    }
}

/** Remove a saved place: caregivers only, and only after the person said yes to removing that place. */
export async function removePlaceTool(ctx: Ctx, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!CAREGIVERS.has(await role(ctx))) return { ok: false, error: "Only a caregiver can remove a saved place." };
    if (args.confirmed !== true) return { ok: false, error: "Ask them to confirm removing it first (say its name and area), then call again with confirmed=true." };
    const mine = await listPlaces(ctx.familyId, { memberUserId: ctx.recipientUserId });
    const cur = findByWords(mine, String(args.place ?? ""), ctx.recipientUserId);
    if (!cur) return { ok: false, error: `No saved place called "${String(args.place ?? "")}".`, places: mine.map((p) => p.nickname) };
    try {
        await deletePlace(ctx.familyId, cur.addressId);
    } catch (e) {
        return err(e);
    }
    const left = await listPlaces(ctx.familyId, { memberUserId: ctx.recipientUserId });
    return { ok: true, removed: cur.nickname, left: left.map((p) => p.nickname), note: left.length ? "" : "No saved place is left: the next order will ask for an address." };
}
