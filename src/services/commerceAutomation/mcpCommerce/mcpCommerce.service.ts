/**
 * MCP-first ordering for Swiggy Food, Instamart and Zepto (family-connected store accounts).
 *
 * - Connections: the caregiver links the store once (OAuth, dashboard). Tokens live encrypted in
 *   `mcpconnections` (AES-256-GCM). Every lookup here is by familyId AND the connecting user must be
 *   a joined member of that family → a family's tokens are never used for another family.
 * - Address: always the family address-book place. Reuse a store address only when its pincode AND
 *   flat/first line match the place (or it's our stored mapping); otherwise create it via MCP.
 *   Never the account default / get_addresses()[0].
 * - Guardrails: COD only (live check per cart), exactly the picked item at the picked qty, no
 *   upsell/membership lines, total at checkout ≤ confirm card + ₹1, one place-order call per card
 *   (Mongo unique lock), stores allowlisted.
 */
import { createHash, randomUUID } from "crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Family from "../../../models/family.model";
import McpConnection from "../../../models/mcpConnection.model";
import McpOrderLock from "../../../models/mcpOrderLock.model";
import McpStoreAddress from "../../../models/mcpStoreAddress.model";
import User from "../../../models/users.model";
import { withMcpClient } from "../../../partners/mcp/mcpClient.service";
import { storeAddressMatchesPlace, type Place } from "../../familyAddressBook.service";
import {
    checkCart,
    checkCartLines,
    etaFrom,
    extractOrderId,
    parseFoodCart,
    parseFoodMenu,
    parseInstamartCart,
    parseRestaurantMenu,
    parseRestaurants,
    type McpRestaurant,
    parseInstamartSearch,
    parseSwiggyAddresses,
    parseZeptoAddresses,
    parseZeptoCart,
    parseZeptoPayment,
    parseZeptoSearch,
    sameStoreAddressId,
    swiggyCodAvailable,
    toolIsError,
    toolText,
    totalMatchesCard,
    type McpPick,
    type McpStore,
    type ParsedCart,
    type StoreAddressRow,
} from "./mcpParse";

export type { McpPick, McpStore, McpRestaurant } from "./mcpParse";

/** Stores allowed to order through MCP (env MCP_ORDER_STORES narrows it; "none" turns MCP ordering off). */
export function mcpOrderStores(): McpStore[] {
    const all: McpStore[] = ["swiggy", "instamart", "zepto"];
    const env = (process.env.MCP_ORDER_STORES || "").trim().toLowerCase();
    if (!env) return all;
    if (env === "none" || env === "off") return [];
    return all.filter((s) => env.split(/[\s,]+/).includes(s));
}

export const MCP_STORE_LABEL: Record<McpStore, string> = { swiggy: "Swiggy", instamart: "Instamart", zepto: "Zepto" };

export class McpStoreError extends Error {
    constructor(
        public code:
            | "not_connected"
            | "unserviceable"
            | "no_address_coords"
            | "address_failed"
            | "cart_failed"
            | "cod_unavailable"
            | "cart_check"
            | "search_failed"
            | "auth_expired"
            | "restaurant_closed",
        message: string,
    ) {
        super(message);
    }
}

// ── Family-scoped connections ───────────────────────────────────────────────

/** store → connecting userId, only for rows of THIS family whose user is a joined member of it. */
export async function familyStoreConnections(familyId: string): Promise<Map<McpStore, { userId: string; connectedAt?: Date }>> {
    const out = new Map<McpStore, { userId: string; connectedAt?: Date }>();
    if (!familyId) return out;
    const [rows, family] = await Promise.all([
        // A login the store keeps refusing is not a connection (live 2026-10-10: shown "Connected" for 10 days while every call got 401).
        McpConnection.find({ familyId, authExpiredAt: { $exists: false } }, { partner: 1, familyId: 1, userId: 1, connectedAt: 1 }).lean(),
        Family.findOne({ familyId, status: "ACTIVE" }),
    ]);
    if (!family) return out;
    const allowed = new Set(mcpOrderStores());
    for (const r of rows.sort((a, b) => +new Date(b.connectedAt || 0) - +new Date(a.connectedAt || 0))) {
        if (r.familyId !== familyId) continue; // belt and braces
        if (!allowed.has(r.partner as McpStore)) continue;
        if (!family.hasJoinedMember(r.userId)) continue;
        if (!out.has(r.partner as McpStore)) out.set(r.partner as McpStore, { userId: r.userId, connectedAt: r.connectedAt });
    }
    return out;
}

async function withFamilyStore<T>(familyId: string, store: McpStore, fn: (client: Client, userId: string) => Promise<T>): Promise<T> {
    const conn = (await familyStoreConnections(familyId)).get(store);
    if (!conn) throw new McpStoreError("not_connected", `${MCP_STORE_LABEL[store]} isn't linked for this family.`);
    const where = { partner: store, familyId, userId: conn.userId };
    try {
        const out = await withMcpClient(store, familyId, conn.userId, (client) => fn(client, conn.userId));
        void McpConnection.updateOne({ ...where, authFailures: { $gt: 0 } }, { $set: { authFailures: 0 } }).catch(() => undefined);
        return out;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isMcpAuthError(message) || /returned 401/i.test(message)) await noteAuthFailure(where, message);
        throw err;
    }
}

/** AUTH_FAILURES_TO_EXPIRE refusals in a row (a 401 after the client already refreshed, or invalid_grant) mark the link expired. */
export const AUTH_FAILURES_TO_EXPIRE = 3;

async function noteAuthFailure(where: { partner: McpStore; familyId: string; userId: string }, message: string): Promise<void> {
    try {
        const row = await McpConnection.findOneAndUpdate(where, { $inc: { authFailures: 1 } }, { new: true }).lean();
        if (row && (isMcpAuthError(message) || (row.authFailures ?? 0) >= AUTH_FAILURES_TO_EXPIRE)) {
            await McpConnection.updateOne(where, { $set: { authExpiredAt: new Date() } });
            console.warn(`[mcp] ${where.partner} link for family ${where.familyId} marked expired after: ${message.slice(0, 120)}`);
        }
    } catch {
        /* bookkeeping only */
    }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await client.callTool({ name, arguments: args });
    return { text: toolText(r), isError: toolIsError(r) };
}

// ── Contacts ────────────────────────────────────────────────────────────────

export type OrderContact = {
    /** Store account holder (the caregiver who linked the store). */
    accountName: string;
    accountPhone10: string;
    /** Who receives the delivery (place contact, else the care recipient). */
    receiverName: string;
    receiverPhone10: string;
};

function phone10(p: string | undefined | null): string {
    const d = String(p || "").replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("91")) return d.slice(2);
    if (d.length === 11 && d.startsWith("0")) return d.slice(1);
    return d.length === 10 ? d : "";
}

export async function resolveOrderContact(input: {
    familyId: string;
    recipientUserId: string;
    recipientPhone: string;
    connectionUserId: string;
    place: Pick<Place, "contactName" | "contactPhone">;
}): Promise<OrderContact> {
    const [elder, account] = await Promise.all([
        User.findOne({ userId: input.recipientUserId }).lean().catch(() => null),
        User.findOne({ userId: input.connectionUserId }).lean().catch(() => null),
    ]);
    const nameOf = (u: unknown) => {
        const x = u as { firstName?: string; lastName?: string; name?: string } | null;
        return [x?.firstName, x?.lastName].filter(Boolean).join(" ").trim() || x?.name || "";
    };
    const phoneOf = (u: unknown) => {
        const x = u as { phone?: { countryCode?: string; number?: string } | string } | null;
        if (!x?.phone) return "";
        if (typeof x.phone === "string") return phone10(x.phone);
        return x.phone.countryCode === "+91" ? phone10(x.phone.number) : "";
    };
    const receiverPhone10 = phone10(input.place.contactPhone) || phone10(input.recipientPhone) || phoneOf(elder);
    const receiverName = input.place.contactName?.trim() || nameOf(elder) || "Family member";
    return {
        accountName: nameOf(account) || receiverName,
        accountPhone10: phoneOf(account) || receiverPhone10,
        receiverName,
        receiverPhone10,
    };
}

// ── Address mapping ─────────────────────────────────────────────────────────

function placeFingerprint(p: Pick<Place, "line1" | "line2" | "landmark" | "city" | "pincode"> & Partial<Pick<Place, "contactName" | "contactPhone">>): string {
    const parts = [p.line1, p.line2, p.landmark, p.city, p.pincode];
    // A place with its own receiver (Vish's number on Vish's Home) needs a store address carrying that receiver.
    if (p.contactPhone) parts.push(p.contactName, p.contactPhone);
    return createHash("sha256").update(parts.map((x) => String(x || "").trim().toLowerCase()).join("|")).digest("hex").slice(0, 16);
}

/** Swiggy lists an address as "Receiver Name: full address": with a receiver set on the place, only that receiver's address fits. */
export function receiverMatches(shown: string, place: Partial<Pick<Place, "contactName" | "contactPhone">>): boolean {
    if (!place.contactName || !place.contactPhone) return true;
    const name = String(shown || "").split(":")[0]!.trim().toLowerCase();
    return name === place.contactName.trim().toLowerCase();
}

async function listStoreAddresses(client: Client, store: McpStore): Promise<StoreAddressRow[]> {
    if (store === "zepto") return parseZeptoAddresses((await call(client, "list_saved_addresses", {})).text);
    const rows: StoreAddressRow[] = [];
    for (let page = 1; page <= 5; page++) {
        const r = await call(client, "get_addresses", page === 1 ? {} : { page });
        const got = parseSwiggyAddresses(r.text);
        rows.push(...got.filter((g) => !rows.some((x) => x.id === g.id)));
        const m = r.text.match(/page\s+(\d+)\s+of\s+(\d+)/i);
        if (!m || Number(m[1]) >= Number(m[2]) || !got.length) break;
    }
    return rows;
}

/** Split a family place into flat / building / locality for the store forms. */
export function placeParts(place: Pick<Place, "line1" | "line2" | "landmark" | "city" | "state" | "pincode" | "full">) {
    const parts = String(place.line1 || "").split(",").map((s) => s.trim()).filter(Boolean);
    const flat = parts[0] || place.line1;
    const building = parts[1] || parts[0] || place.line1;
    const locality = parts.slice(2).join(", ") || place.line2 || "";
    return { flat, building, locality, city: place.city || "", pincode: place.pincode, full: place.full, landmark: place.landmark || "" };
}

export async function coordsForPlace(familyId: string, place: Place): Promise<{ lat: number; lng: number; source: string } | null> {
    if (typeof place.lat === "number" && typeof place.lng === "number") return { lat: place.lat, lng: place.lng, source: "address_book" };
    // Swiggy geocodes the same family address server-side; reuse those coordinates for Zepto.
    const swiggy = await McpStoreAddress.findOne({
        familyId,
        placeAddressId: place.addressId,
        placeFingerprint: placeFingerprint(place),
        partner: { $in: ["instamart", "swiggy"] },
        lat: { $ne: null },
    }).lean();
    if (swiggy?.lat != null && swiggy.lng != null) return { lat: swiggy.lat, lng: swiggy.lng, source: "swiggy_geocode" };
    const { geocodePlace } = await import("../../rideBooking/geoResolve.service");
    const g = await geocodePlace(place.full).catch(() => null);
    if (g?.ok && typeof g.place.lat === "number" && typeof g.place.lng === "number" && g.provider !== "nominatim") {
        return { lat: g.place.lat, lng: g.place.lng, source: g.provider };
    }
    return null;
}

/**
 * The store-account address id for this family place. Order: our stored mapping (still present in
 * the account) → an existing store address with the same pincode AND flat/first line → create it.
 */
export async function ensureStoreAddress(
    client: Client,
    input: { familyId: string; store: McpStore; place: Place; contact: OrderContact; connectionUserId: string },
    opts: { fresh?: boolean } = {},
): Promise<{ storeAddressId: string; via: "mapping" | "matched" | "created" }> {
    const { familyId, store, place, contact } = input;
    const fp = placeFingerprint(place);
    const key = { familyId, partner: store, placeAddressId: place.addressId, placeFingerprint: fp, connectionUserId: input.connectionUserId };
    // A saved Home id is enough to search. Listing addresses first was failing the handshake
    // and the product search never ran.
    if (!opts.fresh) {
        const mapped = await McpStoreAddress.findOne(key).lean();
        if (mapped?.storeAddressId) return { storeAddressId: mapped.storeAddressId, via: "mapping" };
    } else {
        await McpStoreAddress.deleteOne(key);
    }
    const listed = await listStoreAddresses(client, store);
    const mapped = await McpStoreAddress.findOne(key).lean();
    if (mapped) {
        const hit = listed.find((r) => sameStoreAddressId(r.id, mapped.storeAddressId));
        if (hit) return { storeAddressId: hit.id, via: "mapping" };
        await McpStoreAddress.deleteOne(key); // deleted in the store app → resolve again
    }
    // Same Swiggy account behind Food + Instamart: the other line's mapping is fine if it's listed here.
    if (store !== "zepto") {
        const sibling = await McpStoreAddress.findOne({ ...key, partner: store === "swiggy" ? "instamart" : "swiggy" }).lean();
        const hit = sibling && listed.find((r) => sameStoreAddressId(r.id, sibling.storeAddressId));
        if (hit) {
            await McpStoreAddress.create({ ...key, storeAddressId: hit.id, via: "matched", lat: sibling!.lat, lng: sibling!.lng });
            return { storeAddressId: hit.id, via: "matched" };
        }
    }
    const match = listed.find((r) => storeAddressMatchesPlace(r.text, place) && (store === "zepto" || receiverMatches(r.text, place)));
    if (match) {
        await McpStoreAddress.create({ ...key, storeAddressId: match.id, via: "matched" });
        return { storeAddressId: match.id, via: "matched" };
    }
    const pp = placeParts(place);
    let createdId = "";
    let coords: { lat: number; lng: number } | null = null;
    if (store === "zepto") {
        coords = await coordsForPlace(familyId, place);
        if (!coords) throw new McpStoreError("no_address_coords", "No reliable map location for this address, so Zepto can't take it.");
        const r = await call(client, "add_saved_address", {
            type: "OTHER",
            name: `Kavach ${place.nickname}`.slice(0, 40),
            flatDetails: pp.flat,
            buildingName: pp.building,
            landmark: pp.landmark || undefined,
            latitude: coords.lat,
            longitude: coords.lng,
            formattedAddress: pp.full,
            shortAddress: [pp.locality, pp.city, pp.pincode].filter(Boolean).join(", "),
            contactName: contact.receiverName,
            contactNumber: contact.receiverPhone10,
            buildingType: "BUILDING_TYPE_SOCIETY",
        });
        createdId = r.text.match(/Address ID:\s*([A-Za-z0-9-]+)/i)?.[1] || "";
        if (r.isError || !createdId) throw new McpStoreError("address_failed", `Zepto didn't save the address (${r.text.slice(0, 160)}).`);
    } else {
        const r = await call(client, "create_address", {
            fullAddress: pp.full,
            addressLine: [pp.flat, pp.building !== pp.flat ? pp.building : ""].filter(Boolean).join(", "),
            addressLine2: [pp.locality, pp.landmark].filter(Boolean).join(", "),
            locality: pp.locality || undefined,
            city: pp.city,
            postalCode: pp.pincode,
            addressCategory: "FRIENDS_AND_FAMILY",
            addressTag: `Kavach ${place.nickname}`.slice(0, 40),
            userName: contact.accountName,
            userPhone: contact.accountPhone10,
            receiverName: contact.receiverName,
            receiverPhone: contact.receiverPhone10,
        });
        createdId = r.text.match(/"addressId"\s*:\s*"([A-Za-z0-9_-]+)"/)?.[1] || "";
        if (r.isError || !createdId) throw new McpStoreError("address_failed", `Swiggy didn't save the address (${r.text.slice(0, 160)}).`);
    }
    // Verify it's really in the account and use the listed id form.
    const after = await listStoreAddresses(client, store);
    const row = after.find((r) => sameStoreAddressId(r.id, createdId));
    if (!row) throw new McpStoreError("address_failed", `${MCP_STORE_LABEL[store]} saved the address but it isn't listed.`);
    await McpStoreAddress.create({ ...key, storeAddressId: row.id, via: "created", lat: coords?.lat, lng: coords?.lng });
    return { storeAddressId: row.id, via: "created" };
}

async function rememberCoords(familyId: string, store: McpStore, storeAddressId: string, text: string): Promise<void> {
    const m = text.match(/"lat"\s*:\s*(-?\d+\.\d+)[\s\S]{0,40}?"lng"\s*:\s*(-?\d+\.\d+)/);
    if (!m) return;
    await McpStoreAddress.updateMany({ familyId, partner: store, storeAddressId }, { $set: { lat: Number(m[1]), lng: Number(m[2]) } }).catch(() => undefined);
}

async function zeptoSelect(client: Client, storeAddressId: string): Promise<void> {
    const r = await call(client, "select_saved_address", { addressId: storeAddressId });
    if (/does not deliver|not serviceable|unserviceable|no store/i.test(r.text)) {
        throw new McpStoreError("unserviceable", "Zepto doesn't deliver to this address right now.");
    }
    if (r.isError || !/Address selected|Store ID/i.test(r.text)) {
        throw new McpStoreError("address_failed", `Zepto couldn't select the address (${r.text.slice(0, 120)}).`);
    }
}

// ── Search ──────────────────────────────────────────────────────────────────

export type StoreSearch = {
    store: McpStore;
    hits: McpPick[];
    addressVia?: string;
    error?: McpStoreError["code"];
    message?: string;
    /** True only after search_products / search_menu was called. A failed handshake is not a search. */
    calledSearch?: boolean;
};

export type McpCtx = { familyId: string; recipientUserId: string; recipientPhone: string; place: Place };

async function contactFor(ctx: McpCtx, userId: string) {
    return resolveOrderContact({ familyId: ctx.familyId, recipientUserId: ctx.recipientUserId, recipientPhone: ctx.recipientPhone, connectionUserId: userId, place: ctx.place });
}

/** Why a linked-store call failed, without the response body. */
export function storeFailureKind(message: string): "session" | "auth" | "decrypt" | "no_token" | "network" | "other" {
    if (isMcpSessionGlitch(message)) return "session";
    if (isMcpAuthError(message)) return "auth";
    if (/invalid encrypted payload|unable to authenticate data|AES_SECRET is not configured/i.test(message)) return "decrypt";
    if (/account not connected/i.test(message)) return "no_token";
    if (/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|\bnetwork\b/i.test(message)) return "network";
    return "other";
}

/** A 401 handshake is tried once more on the same account. A rejected token is not. */
export function storeSearchTries(message: string): number {
    const kind = storeFailureKind(message);
    return kind === "session" || kind === "network" ? 2 : 1;
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fixture catalog for a training pass. Never calls a store and never places an order. */
function trainSearch(store: McpStore, query: string): StoreSearch {
    const q = String(query || "");
    // A Hindi-only query comes back empty so the caller can search once more in English.
    if (/[\u0900-\u097F]/.test(q) && !/[a-z]/i.test(q)) {
        return { store, hits: [], calledSearch: true, addressVia: "train" };
    }
    const hits: McpPick[] = [];
    if (/protein|ritebite|rite bite|protien/i.test(q)) {
        hits.push(
            { store, name: "RiteBite Max Protein Daily Bar Berry 10g Protein", pricePaise: 4000, spinId: "train-rb-berry", skuId: "train-rb-berry", pvid: "train-rb-berry", spid: "train-rb-berry" },
            { store, name: "Yoga Bar Protein Bar Chocolate 10g Protein", pricePaise: 4500, spinId: "train-yb", skuId: "train-yb", pvid: "train-yb", spid: "train-yb" },
            { store, name: "RiteBite Max Protein Daily Bar Choco Fudge 10g Protein", pricePaise: 4000, spinId: "train-rb-choco", skuId: "train-rb-choco", pvid: "train-rb-choco", spid: "train-rb-choco" },
        );
    } else if (/medicine|dawai|dolo|crocin|tablet|paracetamol/i.test(q)) {
        hits.push({ store, name: "Dolo 650 Tablet", pricePaise: 3200, spinId: "train-dolo", skuId: "train-dolo", pvid: "train-dolo", spid: "train-dolo" });
    } else if (/milk|doodh|bread|atta|biscuit/i.test(q)) {
        hits.push({ store, name: "Amul Taaza Toned Milk 1L", pricePaise: 6800, spinId: "train-milk", skuId: "train-milk", pvid: "train-milk", spid: "train-milk" });
    } else if (q.trim()) {
        hits.push({ store, name: "Amul Taaza Toned Milk 1L", pricePaise: 6800, spinId: "train-milk", skuId: "train-milk", pvid: "train-milk", spid: "train-milk" });
    }
    return { store, hits, calledSearch: true, addressVia: "train" };
}

export async function searchStore(ctx: McpCtx, store: McpStore, query: string, opts: { restaurantName?: string | null; attempt?: number } = {}): Promise<StoreSearch> {
    if (process.env.SAHELI_TRAIN === "1") return trainSearch(store, query);
    let calledSearch = false;
    try {
        return await withFamilyStore(ctx.familyId, store, async (client, userId) => {
            const contact = await contactFor(ctx, userId);
            const addressInput = { familyId: ctx.familyId, store, place: ctx.place, contact, connectionUserId: userId };
            const run = async (addr: { storeAddressId: string; via: string }): Promise<StoreSearch> => {
                if (store === "zepto") {
                    await zeptoSelect(client, addr.storeAddressId);
                    calledSearch = true;
                    const r = await call(client, "search_products", { query });
                    if (r.isError) throw new McpStoreError("search_failed", r.text.slice(0, 160));
                    return { store, hits: parseZeptoSearch(r.text), addressVia: addr.via, calledSearch: true };
                }
                if (store === "instamart") {
                    calledSearch = true;
                    const r = await call(client, "search_products", { query, addressId: addr.storeAddressId });
                    if (r.isError) throw new McpStoreError("search_failed", r.text.slice(0, 160));
                    return { store, hits: parseInstamartSearch(r.text), addressVia: addr.via, calledSearch: true };
                }
                const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
                const want = norm(opts.restaurantName || "");
                const fromRestaurant = (h: McpPick) => {
                    const r = norm(h.restaurantName || "");
                    return Boolean(want && r && (r.includes(want) || want.includes(r.slice(0, 8))));
                };
                const menu = async (q: string) => {
                    const r = await call(client, "search_menu", { query: q, addressId: addr.storeAddressId });
                    if (r.isError) throw new McpStoreError("search_failed", r.text.slice(0, 160));
                    return parseFoodMenu(r.text, 10);
                };
                calledSearch = true;
                let hits = await menu(query || opts.restaurantName || "");
                if (want) {
                    let same = hits.filter(fromRestaurant);
                    if (!same.length && query) same = (await menu(`${opts.restaurantName} ${query}`)).filter(fromRestaurant);
                    if (same.length) hits = same;
                }
                return { store, hits: hits.slice(0, 5), addressVia: addr.via, calledSearch: true };
            };
            let addr = await ensureStoreAddress(client, addressInput);
            try {
                return await run(addr);
            } catch (err) {
                if (err instanceof McpStoreError && err.code === "address_failed") {
                    addr = await ensureStoreAddress(client, addressInput, { fresh: true });
                    return await run(addr);
                }
                throw err;
            }
        });
    } catch (err) {
        const message = describeMcpError(err);
        const attempt = opts.attempt ?? 0;
        const transient = storeSearchTries(message) > 1;
        const wrappedSearch = err instanceof McpStoreError && err.code === "search_failed";
        // A 401 handshake or a dropped socket is not a dead token. Try the connected account again.
        if (transient && attempt + 1 < storeSearchTries(message) && (!(err instanceof McpStoreError) || wrappedSearch)) {
            await sleep(400 * (attempt + 1));
            const again = await searchStore(ctx, store, query, { ...opts, attempt: attempt + 1 });
            return { ...again, calledSearch: Boolean(again.calledSearch || calledSearch) };
        }
        let code = err instanceof McpStoreError ? err.code : "search_failed";
        const kind = storeFailureKind(message);
        if (kind === "decrypt") code = "auth_expired";
        else if (kind === "no_token") code = "not_connected";
        else if (isMcpAuthError(message) && code !== "not_connected" && code !== "unserviceable") code = "auth_expired";
        return { store, hits: [], error: code, message, calledSearch };
    }
}

/** Never an empty diagnostic: message, else error name / code / cause. */
export function describeMcpError(err: unknown): string {
    if (!(err instanceof Error)) return String(err ?? "unknown").slice(0, 200) || "unknown";
    const e = err as Error & { code?: unknown; cause?: unknown };
    const cause = e.cause instanceof Error ? e.cause.message : e.cause ? String(e.cause) : "";
    return [e.message || e.name || "Error", e.code != null ? `code=${String(e.code)}` : "", cause ? `cause=${cause}` : ""].filter(Boolean).join(" ").slice(0, 200);
}

/**
 * MCP SDK session noise ("401 after successful authentication") while tokens still exist.
 * The account stays connected — retry, do not ask for a reconnect, do not open the guest site.
 */
export function isMcpSessionGlitch(message: string): boolean {
    return /401 after successful authentication|streamable http error|server returned 401|MCP error -32001/i.test(message || "");
}

/** The live call rejected the linked account (revoked refresh / unauthorized tool). Not a session glitch. */
export function isMcpAuthError(message: string): boolean {
    if (isMcpSessionGlitch(message)) return false;
    return /invalid_grant|invalidgrant|invalid_token|\bunauthori[sz]ed\b|token (?:has )?expired|refresh token.{0,24}(?:revoked|expired)|re-?authori[sz]/i.test(message || "");
}

/** Shown only after a live auth rejection. Steps are Dashboard → Integrations. */
export function reconnectAccountCopy(labels: string[], elder: boolean): string {
    const names = [...new Set(labels.filter(Boolean))].join(" and ") || "store";
    const steps = `Dashboard → Integrations: open the Kavach dashboard, go to Integrations, disconnect ${names}, then connect ${names} again.`;
    return elder
        ? `The linked ${names} account rejected the sign-in. Ask your caregiver to reconnect it — ${steps}`
        : `The linked ${names} account rejected the sign-in. Reconnect it: ${steps}`;
}

// ── Cart build (shared by prepare + place) ──────────────────────────────────

type BuiltCart = { cart: ParsedCart; totalPaise: number; cod: boolean; storeAddressId: string; addressVia: string };

export type McpLine = { pick: McpPick; qty: number };

/** The card's items: several when the order has more than one (older cards carry only pick + qty). */
export function cardLines(card: Pick<McpCard, "pick" | "qty" | "lines">): McpLine[] {
    return card.lines?.length ? card.lines : [{ pick: card.pick, qty: card.qty }];
}

async function buildCart(client: Client, ctx: McpCtx, store: McpStore, lines: McpLine[], userId: string): Promise<BuiltCart> {
    const pick = lines[0]!.pick, qty = lines[0]!.qty;
    if (store === "swiggy" && lines.length > 1) throw new McpStoreError("cart_failed", "Swiggy Food orders take one dish at a time here.");
    const contact = await contactFor(ctx, userId);
    const addr = await ensureStoreAddress(client, { familyId: ctx.familyId, store, place: ctx.place, contact, connectionUserId: userId });
    const expects = lines.map((l) => ({ id: store === "instamart" ? l.pick.spinId : store === "zepto" ? l.pick.pvid : l.pick.menuItemId, name: l.pick.name, qty: l.qty }));
    const expect = expects[0]!;
    if (store === "instamart") {
        // update_cart REPLACES the whole cart → exactly these items.
        const r = await call(client, "update_cart", { selectedAddressId: addr.storeAddressId, items: lines.map((l) => ({ spinId: l.pick.spinId, skuId: l.pick.skuId, quantity: l.qty })) });
        if (r.isError) throw new McpStoreError("cart_failed", r.text.slice(0, 200));
        void rememberCoords(ctx.familyId, store, addr.storeAddressId, r.text);
        const got = await call(client, "get_cart", {});
        const cart = parseInstamartCart(got.text);
        const chk = checkCartLines(cart, expects, { needTotal: true });
        if (!chk.ok) throw new McpStoreError("cart_check", `Instamart cart check failed: ${chk.reason}`);
        if (!new RegExp(`"selectedAddress"\\s*:\\s*"${addr.storeAddressId.split("__")[0]}`).test(got.text)) {
            throw new McpStoreError("cart_check", "Instamart cart isn't on the family address.");
        }
        const pay = await call(client, "get_payment_options", {});
        return { cart: cart!, totalPaise: cart!.totalPaise!, cod: swiggyCodAvailable(pay.text), storeAddressId: addr.storeAddressId, addressVia: addr.via };
    }
    if (store === "swiggy") {
        await call(client, "flush_food_cart", {});
        const r = await call(client, "update_food_cart", {
            restaurantId: pick.restaurantId,
            addressId: addr.storeAddressId,
            restaurantName: pick.restaurantName,
            cartItems: [{ menu_item_id: pick.menuItemId, quantity: qty }],
        });
        if (r.isError || /closed|not accepting|unserviceable|not available/i.test(r.text.slice(0, 300))) {
            throw new McpStoreError(/closed|not accepting/i.test(r.text) ? "restaurant_closed" : "cart_failed", r.text.slice(0, 200));
        }
        const got = await call(client, "get_food_cart", { addressId: addr.storeAddressId, restaurantName: pick.restaurantName });
        const cart = parseFoodCart(got.text);
        const chk = checkCart(cart, expect, { needTotal: true });
        if (!chk.ok) throw new McpStoreError("cart_check", `Swiggy cart check failed: ${chk.reason}`);
        const pay = await call(client, "get_payment_options", { addressId: addr.storeAddressId });
        return { cart: cart!, totalPaise: cart!.totalPaise!, cod: swiggyCodAvailable(pay.text), storeAddressId: addr.storeAddressId, addressVia: addr.via };
    }
    await zeptoSelect(client, addr.storeAddressId);
    const r = await call(client, "update_cart", {
        deviceId: `kavach-${ctx.familyId.slice(0, 8)}`,
        replaceCart: true,
        cartItems: lines.map((l) => ({ productVariantId: l.pick.pvid, storeProductId: l.pick.spid, quantity: l.qty })),
    });
    if (r.isError) throw new McpStoreError("cart_failed", r.text.slice(0, 200));
    const cart = parseZeptoCart((await call(client, "view_cart", {})).text);
    const chk = checkCartLines(cart, expects);
    if (!chk.ok) throw new McpStoreError("cart_check", `Zepto cart check failed: ${chk.reason}`);
    const pay = parseZeptoPayment((await call(client, "get_payment_methods", {})).text);
    if (!pay.totalPaise) throw new McpStoreError("cart_check", "Zepto didn't show an order total.");
    cart!.totalPaise = pay.totalPaise;
    return { cart: cart!, totalPaise: pay.totalPaise, cod: pay.cod, storeAddressId: addr.storeAddressId, addressVia: addr.via };
}

async function clearCart(client: Client, store: McpStore, pick?: McpPick | McpLine[], familyId?: string): Promise<void> {
    try {
        const picks = Array.isArray(pick) ? pick.map((l) => l.pick) : pick ? [pick] : [];
        if (store === "instamart") await call(client, "clear_cart", {});
        else if (store === "swiggy") await call(client, "flush_food_cart", {});
        else if (picks.some((p) => p.pvid && p.spid)) {
            await call(client, "update_cart", { deviceId: `kavach-${String(familyId || "").slice(0, 8)}`,
                cartItems: picks.filter((p) => p.pvid && p.spid).map((p) => ({ productVariantId: p.pvid, storeProductId: p.spid, quantity: 0 })) });
        }
    } catch (err) {
        console.warn(`[mcp-order] clear ${store} cart failed:`, err instanceof Error ? err.message : err);
    }
}

// ── Confirm card ────────────────────────────────────────────────────────────

export type McpCard = {
    cardId: string;
    store: McpStore;
    pick: McpPick;
    qty: number;
    /** Every item when the order has more than one (pick + qty are the first). */
    lines?: McpLine[];
    itemLine: string;
    totalPaise: number;
    storeAddressId: string;
    placeAddressId: string;
    addressFull: string;
    addressNickname: string;
    feesLabel?: string;
    createdAt: number;
};

/** How long a confirm card stays good. Placing rebuilds the cart and refuses on any change of address, COD or total, so this
 *  only bounds how late a "yes" may come (lab 2026-10-10: a yes after 25 min had to be asked again). */
export const MCP_CARD_TTL_MS = Math.max(5, Number(process.env.MCP_CARD_TTL_MIN || 90)) * 60_000;

/** Build the real cart for exactly this pick → confirm card (then empty the cart again). */
export async function prepareMcpOrder(ctx: McpCtx, pick: McpPick, qty = 1, more: McpLine[] = []): Promise<McpCard> {
    const lines: McpLine[] = [{ pick, qty }, ...more];
    if (process.env.SAHELI_TRAIN === "1") {
        return {
            cardId: "train-card",
            store: pick.store,
            pick,
            qty,
            itemLine: `${qty} × ${pick.name}`,
            totalPaise: pick.pricePaise || 4000,
            storeAddressId: "train-store-addr",
            placeAddressId: ctx.place.addressId,
            addressFull: ctx.place.full,
            addressNickname: ctx.place.nickname,
            createdAt: Date.now(),
        };
    }
    if (!mcpOrderStores().includes(pick.store)) throw new McpStoreError("not_connected", `${MCP_STORE_LABEL[pick.store]} ordering is off.`);
    return withFamilyStore(ctx.familyId, pick.store, async (client, userId) => {
        try {
            const built = await buildCart(client, ctx, pick.store, lines, userId);
            if (!built.cod) throw new McpStoreError("cod_unavailable", `${MCP_STORE_LABEL[pick.store]} isn't offering Cash on Delivery for this order.`);
            const line = built.cart.lines[0]!;
            const fees = built.cart.feeLines.filter((f) => !/item total/i.test(f.label) && (f.paise ?? 0) > 0);
            return {
                cardId: randomUUID(),
                store: pick.store,
                pick,
                qty,
                ...(lines.length > 1 ? { lines } : {}),
                itemLine: lines.length > 1 ? lines.map((l) => `${l.qty} × ${l.pick.name}`).join(", ")
                    : `${qty} × ${line.name || pick.name}${pick.restaurantName ? ` (${pick.restaurantName})` : ""}`,
                totalPaise: built.totalPaise,
                storeAddressId: built.storeAddressId,
                placeAddressId: ctx.place.addressId,
                addressFull: ctx.place.full,
                addressNickname: ctx.place.nickname,
                feesLabel: fees.length ? fees.map((f) => `${f.label} ₹${Math.round((f.paise || 0) / 100)}`).join(", ") : undefined,
                createdAt: Date.now(),
            };
        } finally {
            await clearCart(client, pick.store, lines, ctx.familyId);
        }
    });
}

export type PlaceResult =
    | { status: "placed"; orderId?: string; totalPaise: number; detail: string; eta?: string }
    | { status: "duplicate" | "expired" | "refused"; detail: string; newCard?: McpCard }
    | { status: "failed" | "unknown"; detail: string };

/**
 * Literal "confirm" on a live card → rebuild the exact cart, re-check every guardrail, and make the
 * single place-order call (Cash). Never retried.
 */
export async function placeMcpOrder(ctx: McpCtx, card: McpCard, confirmText: string): Promise<PlaceResult> {
    if (process.env.SAHELI_TRAIN === "1") return { status: "refused", detail: "Training run: nothing was ordered." };
    if (confirmText.trim().toLowerCase() !== "confirm") return { status: "refused", detail: "Needs the word confirm." };
    if (Date.now() - card.createdAt > MCP_CARD_TTL_MS) return { status: "expired", detail: "The confirm card expired." };
    if (card.placeAddressId !== ctx.place.addressId) return { status: "refused", detail: "Delivery address changed since the card." };
    if (!mcpOrderStores().includes(card.store)) return { status: "refused", detail: `${MCP_STORE_LABEL[card.store]} ordering is off.` };
    try {
        await McpOrderLock.create({ cardId: card.cardId, familyId: ctx.familyId, partner: card.store, status: "placing", totalPaise: card.totalPaise });
    } catch {
        return { status: "duplicate", detail: "This order was already confirmed." };
    }
    const setLock = (status: "placed" | "failed" | "refused" | "unknown", extra: { orderId?: string; detail?: string } = {}) =>
        McpOrderLock.updateOne({ cardId: card.cardId }, { $set: { status, ...extra } }).catch(() => undefined);
    try {
        return await withFamilyStore(ctx.familyId, card.store, async (client, userId) => {
            let built: BuiltCart;
            try {
                built = await buildCart(client, ctx, card.store, cardLines(card), userId);
            } catch (err) {
                await clearCart(client, card.store, cardLines(card), ctx.familyId);
                await setLock("refused", { detail: err instanceof Error ? err.message : String(err) });
                return { status: "refused" as const, detail: err instanceof Error ? err.message : String(err) };
            }
            if (built.storeAddressId !== card.storeAddressId) {
                await clearCart(client, card.store, cardLines(card), ctx.familyId);
                await setLock("refused", { detail: "store address changed" });
                return { status: "refused" as const, detail: "The store address changed since the card." };
            }
            if (!built.cod) {
                await clearCart(client, card.store, cardLines(card), ctx.familyId);
                await setLock("refused", { detail: "cod_unavailable" });
                return { status: "refused" as const, detail: `${MCP_STORE_LABEL[card.store]} isn't offering Cash on Delivery for this order now.` };
            }
            if (!totalMatchesCard(card.totalPaise, built.totalPaise)) {
                await clearCart(client, card.store, cardLines(card), ctx.familyId);
                await setLock("refused", { detail: `total changed ${card.totalPaise}→${built.totalPaise}` });
                const newCard: McpCard = { ...card, cardId: randomUUID(), totalPaise: built.totalPaise, createdAt: Date.now() };
                return { status: "refused" as const, detail: "total_changed", newCard };
            }
            // ── The single place-order call ──
            const args =
                card.store === "instamart"
                    ? { name: "checkout", a: { addressId: card.storeAddressId, paymentMethod: "Cash" } }
                    : card.store === "swiggy"
                      ? { name: "place_food_order", a: { addressId: card.storeAddressId, paymentMethod: "Cash" } }
                      : { name: "create_order", a: { confirmOrder: true, userAddressId: card.storeAddressId, riderTip: 0, useZeptoCash: false } };
            let r: { text: string; isError: boolean };
            const sentAt = Date.now();
            try {
                r = await call(client, args.name, args.a);
            } catch (err) {
                // No answer after sending: look in the account's order list before calling it unclear (never placed twice).
                const found = card.store === "instamart" ? await findRecentOrder(client, built.totalPaise ?? card.totalPaise, sentAt) : null;
                if (found) {
                    await setLock("placed", { orderId: found.orderId, detail: "found in the order list after no answer" });
                    return { status: "placed" as const, orderId: found.orderId, totalPaise: built.totalPaise ?? card.totalPaise, detail: "found in the order list", eta: found.eta };
                }
                await setLock("unknown", { detail: err instanceof Error ? err.message : String(err) });
                return { status: "unknown" as const, detail: "The store didn't answer after the order was sent." };
            }
            const failed = r.isError || /\b(failed|error|could not|unable to|not placed)\b/i.test(r.text.slice(0, 200));
            const orderId = extractOrderId(r.text);
            if (failed && !orderId) {
                await setLock("failed", { detail: r.text.slice(0, 500) });
                await clearCart(client, card.store, cardLines(card), ctx.familyId);
                return { status: "failed" as const, detail: r.text.slice(0, 300) };
            }
            // When it comes: from the order answer, else the store's own delivery-status / tracking tool (never blocks the order).
            const eta = etaFrom(r.text) ?? (orderId ? await liveEta(client, ctx, orderId, card.storeAddressId) : undefined);
            await setLock("placed", { orderId, detail: r.text.slice(0, 2000) });
            return { status: "placed" as const, orderId, totalPaise: built.totalPaise, detail: r.text.slice(0, 300), eta };
        });
    } catch (err) {
        await setLock("failed", { detail: err instanceof Error ? err.message : String(err) });
        return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
}

/** An Instamart order placed since `sinceMs` for this total (±₹1), from the account's order list (get_orders). */
export async function findRecentOrder(client: Client, totalPaise: number, sinceMs: number): Promise<{ orderId: string; eta?: string } | null> {
    for (const wait of [3000, 8000]) {
        await new Promise((ok) => setTimeout(ok, wait));
        try {
            const r = await call(client, "get_orders", { count: 5 });
            const data = (await import("./mcpParse")).jsonTail(r.text) as { orders?: Array<Record<string, unknown>> } | null;
            const hits = (data?.orders || []).filter((o) => {
                const at = Date.parse(String(o.createdAt || ""));
                return Number.isFinite(at) && at >= sinceMs - 120_000 && Math.abs(Number(o.totalAmount) * 100 - totalPaise) <= 100
                    && !/cancel|fail/i.test(String(o.status || ""));
            });
            if (hits.length === 1) {
                const eta = typeof hits[0].estimatedDeliveryTime === "string" ? String(hits[0].estimatedDeliveryTime) : undefined;
                return { orderId: String(hits[0].orderId), eta };
            }
        } catch {
            /* try once more, then unclear */
        }
    }
    return null;
}

/** For a place step outside the connector (the browser) that had no clear answer: look in the linked account's orders. */
export async function recentOrderOnStore(familyId: string, store: McpStore, totalPaise: number, sinceMs: number) {
    return withFamilyStore(familyId, store, (client) => findRecentOrder(client, totalPaise, sinceMs));
}

/**
 * After an order: where it is now, from the store's own order list (read-only). The store's own words are passed on as
 * they are (status, its status line, its delivery time); the engine's AI reads them.
 */
export async function orderStatusOnStore(familyId: string, store: McpStore, orderId: string): Promise<Record<string, unknown>> {
    return withFamilyStore(familyId, store, async (client) => {
        const r = await call(client, "get_orders", { count: 8 });
        if (r.isError) return { found: false, detail: r.text.slice(0, 160) };
        const data = (await import("./mcpParse")).jsonTail(r.text) as { orders?: Array<Record<string, unknown>> } | null;
        const o = (data?.orders || []).find((x) => String(x.orderId) === orderId);
        if (!o) return { found: false };
        const pick = (k: string) => (typeof o[k] === "string" || typeof o[k] === "boolean" ? o[k] : undefined);
        return { found: true, status: pick("status"), currentStatus: pick("currentStatus"), historyStatus: pick("historyStatus"),
            estimatedDeliveryTime: pick("estimatedDeliveryTime"), isActive: pick("isActive"), updatedAt: pick("updatedAt") };
    });
}

const ETA_LOOKUP_MS = 10_000;

/**
 * After an order: the delivery time from the store's own tools. Instamart: get_delivery_status (an absolute deliveryBy),
 * then track_order (needs the place's coordinates). Other stores: any tracking tool that takes an orderId. Read-only,
 * at most ETA_LOOKUP_MS; undefined when the store gives none.
 */
export async function liveEta(client: Client, ctx: McpCtx, orderId: string, storeAddressId: string): Promise<string | undefined> {
    const work = (async () => {
        const tools = (await client.listTools()).tools;
        const names = ["get_delivery_status", ...tools.map((t) => t.name).filter((n) => /track/i.test(n) && n !== "get_delivery_status")];
        for (const name of names) {
            const t = tools.find((x) => x.name === name);
            const props = Object.keys(((t?.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
            if (!t || !props.includes("orderId")) continue;
            const args: Record<string, unknown> = { orderId };
            if (props.includes("addressId")) args.addressId = storeAddressId;
            const latKey = props.find((p) => p === "lat" || p === "latitude");
            if (latKey) {
                const at = await coordsForPlace(ctx.familyId, ctx.place).catch(() => null);
                if (!at) continue;
                args[latKey] = at.lat;
                args[latKey === "lat" ? "lng" : "longitude"] = at.lng;
            }
            const r = await call(client, name, args).catch(() => null);
            const eta = r && !r.isError ? etaFrom(r.text) : undefined;
            if (eta) return eta;
        }
        return undefined;
    })().catch(() => undefined);
    return Promise.race([work, new Promise<undefined>((ok) => setTimeout(() => ok(undefined), ETA_LOOKUP_MS).unref?.())]);
}

/** Test/ops helper: empty the family's cart on a store. */
export async function clearFamilyCart(familyId: string, store: McpStore, pick?: McpPick): Promise<void> {
    await withFamilyStore(familyId, store, (client) => clearCart(client, store, pick, familyId));
}

/** Swiggy Food: restaurants taking orders now at the family place (linked account, family address). */
export async function listRestaurantsMcp(ctx: McpCtx, query: string): Promise<McpRestaurant[]> {
    return withFamilyStore(ctx.familyId, "swiggy", async (client, userId) => {
        const contact = await contactFor(ctx, userId);
        const addr = await ensureStoreAddress(client, { familyId: ctx.familyId, store: "swiggy", place: ctx.place, contact, connectionUserId: userId });
        const r = await call(client, "search_restaurants", { query: query.trim() || "restaurants", addressId: addr.storeAddressId });
        if (r.isError) throw new McpStoreError("search_failed", r.text.slice(0, 160));
        return parseRestaurants(r.text);
    });
}

/** Swiggy Food: one restaurant's dishes (skips items that need a size/variant choice). */
export async function restaurantMenuMcp(ctx: McpCtx, restaurant: { id: string; name: string }, dishQuery?: string): Promise<McpPick[]> {
    return withFamilyStore(ctx.familyId, "swiggy", async (client, userId) => {
        const contact = await contactFor(ctx, userId);
        const addr = await ensureStoreAddress(client, { familyId: ctx.familyId, store: "swiggy", place: ctx.place, contact, connectionUserId: userId });
        const r = await call(client, "get_restaurant_menu", { restaurantId: restaurant.id, addressId: addr.storeAddressId, pageSize: 8 });
        if (r.isError) throw new McpStoreError("search_failed", r.text.slice(0, 160));
        const all = parseRestaurantMenu(r.text, restaurant.id, restaurant.name);
        if (dishQuery) {
            const words = dishQuery.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
            const hit = all.filter((h) => words.some((w) => h.name.toLowerCase().includes(w)));
            if (hit.length) return hit.slice(0, 5);
        }
        return all.slice(0, 5);
    });
}
