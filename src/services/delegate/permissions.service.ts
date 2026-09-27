/**
 * What Saheli is allowed to do for a family (per-family record, caregiver-editable where safe).
 * Enforced in the WhatsApp turn (delegate turn hook) before a search starts and again at the
 * literal *confirm*. Hard guards stay in code and are shown as locked rules, never settings.
 */
import SaheliPermissions, { PERMISSION_STORES, type ISaheliPermissions, type PermissionStore } from "../../models/saheliPermissions.model";

export type Permissions = Omit<ISaheliPermissions, "history" | "stores"> & {
    stores: Record<PermissionStore, boolean>;
    history: ISaheliPermissions["history"];
    updatedAt?: Date;
};

export const STORE_LABEL: Record<PermissionStore, string> = {
    instamart: "Instamart",
    zepto: "Zepto",
    blinkit: "Blinkit",
    swiggy: "Swiggy",
    zomato: "Zomato",
    apollo: "Apollo Pharmacy",
    pharmeasy: "PharmEasy",
    tata_1mg: "Tata 1mg",
    uber: "Uber",
};
export const STORE_CATEGORY: Record<PermissionStore, "grocery" | "food" | "pharmacy" | "ride"> = {
    instamart: "grocery",
    zepto: "grocery",
    blinkit: "grocery",
    swiggy: "food",
    zomato: "food",
    apollo: "pharmacy",
    pharmeasy: "pharmacy",
    tata_1mg: "pharmacy",
    uber: "ride",
};

/** Hard guards (code, not settings) — shown on the dashboard with a lock. */
export const LOCKED_RULES = [
    "Always shows the item, price and address, and places nothing until the words *confirm* are typed",
    "Signs in to a store only after a *confirm*",
    "Cash on delivery only — never stores or uses card / UPI details",
    "Only these stores — nothing outside the list",
    "Never orders tobacco, gutka, vapes or alcohol",
    "Pauses and checks in on bulk sleeping pills / strong painkillers",
    "Tells you on WhatsApp only for placed orders, health red flags, 3 unanswered check-ins, or anything unusual / scam-like — everything else goes to this dashboard and the daily snapshot",
];

export const DEFAULTS = {
    groceries: true,
    food: true,
    medicines: true,
    rides: true,
    spendSoftLimitInr: 2000 as number | null,
    deliveryFollowUps: true,
    medicineStartCheck: true,
    resumeNudges: true,
};

function normalize(familyId: string, row: Partial<ISaheliPermissions> | null): Permissions {
    const stores = {} as Record<PermissionStore, boolean>;
    for (const s of PERMISSION_STORES) stores[s] = row?.stores?.[s] !== false;
    return {
        familyId,
        groceries: row?.groceries ?? DEFAULTS.groceries,
        food: row?.food ?? DEFAULTS.food,
        medicines: row?.medicines ?? DEFAULTS.medicines,
        rides: row?.rides ?? DEFAULTS.rides,
        stores,
        spendSoftLimitInr: row && "spendSoftLimitInr" in row ? (row.spendSoftLimitInr ?? null) : DEFAULTS.spendSoftLimitInr,
        deliveryFollowUps: row?.deliveryFollowUps ?? DEFAULTS.deliveryFollowUps,
        medicineStartCheck: row?.medicineStartCheck ?? DEFAULTS.medicineStartCheck,
        resumeNudges: row?.resumeNudges ?? DEFAULTS.resumeNudges,
        history: (row?.history || []).slice(-30),
        updatedBy: row?.updatedBy,
        updatedAt: row?.updatedAt ?? undefined,
    };
}

export async function getPermissions(familyId: string): Promise<Permissions> {
    const row = await SaheliPermissions.findOne({ familyId }).lean().catch(() => null);
    return normalize(familyId, row as Partial<ISaheliPermissions> | null);
}

const BOOL_FIELDS = ["groceries", "food", "medicines", "rides", "deliveryFollowUps", "medicineStartCheck", "resumeNudges"] as const;
const FIELD_LABEL: Record<(typeof BOOL_FIELDS)[number], string> = {
    groceries: "Order groceries",
    food: "Order food",
    medicines: "Order medicines",
    rides: "Book rides",
    deliveryFollowUps: "Check deliveries arrived",
    medicineStartCheck: "Check new medicines were started",
    resumeNudges: "Remind about unfinished orders",
};

export class PermissionPatchError extends Error {}

/** Caregiver edit. Only known keys; stores can only be switched within the fixed allowlist. */
export async function updatePermissions(
    familyId: string,
    actor: { userId: string; name?: string },
    patch: Record<string, unknown>,
): Promise<Permissions> {
    const cur = await getPermissions(familyId);
    const set: Record<string, unknown> = {};
    const changes: string[] = [];
    for (const f of BOOL_FIELDS) {
        if (patch[f] === undefined) continue;
        if (typeof patch[f] !== "boolean") throw new PermissionPatchError(`${f} must be true/false`);
        if (patch[f] !== cur[f]) {
            set[f] = patch[f];
            changes.push(`${FIELD_LABEL[f]}: ${patch[f] ? "on" : "off"}`);
        }
    }
    if (patch.stores !== undefined) {
        if (!patch.stores || typeof patch.stores !== "object") throw new PermissionPatchError("stores must be an object");
        for (const [k, v] of Object.entries(patch.stores as Record<string, unknown>)) {
            if (!(PERMISSION_STORES as readonly string[]).includes(k)) throw new PermissionPatchError(`unknown store ${k}`);
            if (typeof v !== "boolean") throw new PermissionPatchError(`stores.${k} must be true/false`);
            if (v !== cur.stores[k as PermissionStore]) {
                set[`stores.${k}`] = v;
                changes.push(`${STORE_LABEL[k as PermissionStore]}: ${v ? "allowed" : "off"}`);
            }
        }
    }
    if (patch.spendSoftLimitInr !== undefined) {
        const v = patch.spendSoftLimitInr;
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 100 || v > 50000)) {
            throw new PermissionPatchError("spendSoftLimitInr must be null or ₹100–₹50,000");
        }
        const n = v === null ? null : Math.round(v as number);
        if (n !== cur.spendSoftLimitInr) {
            set.spendSoftLimitInr = n;
            changes.push(`Ask before orders above: ${n === null ? "no limit" : `₹${n.toLocaleString("en-IN")}`}`);
        }
    }
    if (!changes.length) return cur;
    await SaheliPermissions.updateOne(
        { familyId },
        {
            $set: { ...set, updatedBy: actor.userId },
            $push: { history: { $each: [{ at: new Date(), by: actor.userId, byName: actor.name, change: changes.join(", ") }], $slice: -50 } },
        } as never,
        { upsert: true },
    );
    return getPermissions(familyId);
}

export function categoryKey(category: string | null | undefined): "groceries" | "food" | "medicines" | "rides" | null {
    switch (category) {
        case "grocery":
            return "groceries";
        case "food":
            return "food";
        case "pharmacy":
            return "medicines";
        case "ride":
            return "rides";
        default:
            return null;
    }
}
export function categoryAllowed(p: Permissions, category: string | null | undefined): boolean {
    const k = categoryKey(category);
    return k ? p[k] : true;
}
export function isKnownStore(partner: string | null | undefined): partner is PermissionStore {
    return (PERMISSION_STORES as readonly string[]).includes(String(partner || ""));
}
/** Only allowlisted stores are toggles; anything else is left to the existing hard allowlist. */
export function storeAllowed(p: Permissions, partner: string | null | undefined): boolean {
    return isKnownStore(partner) ? p.stores[partner] !== false : true;
}
/** An allowed store in the same category (for "Zepto is off — Instamart instead?"). */
export function allowedAlternative(p: Permissions, partner: string): PermissionStore | null {
    if (!isKnownStore(partner)) return null;
    const cat = STORE_CATEGORY[partner];
    return (PERMISSION_STORES.find((s) => s !== partner && STORE_CATEGORY[s] === cat && p.stores[s] !== false) as PermissionStore) || null;
}

/** Plain lines for the dashboard card and for Saheli ("what can you do for me?"). */
export function describePermissions(p: Permissions): { can: string[]; asks: string[] } {
    const can: string[] = [];
    const asks: string[] = [];
    const storesFor = (cat: string) => PERMISSION_STORES.filter((s) => STORE_CATEGORY[s] === cat && p.stores[s]).map((s) => STORE_LABEL[s]);
    (p.groceries ? can : asks).push(`Order groceries${p.groceries && storesFor("grocery").length ? ` (${storesFor("grocery").join(", ")})` : ""} — cash on delivery`);
    (p.food ? can : asks).push(`Order food${p.food && storesFor("food").length ? ` (${storesFor("food").join(", ")})` : ""}`);
    (p.medicines ? can : asks).push(`Order medicines${p.medicines && storesFor("pharmacy").length ? ` (${storesFor("pharmacy").join(", ")})` : ""} — always with her *confirm*`);
    (p.rides ? can : asks).push("Book rides (Uber)");
    if (p.spendSoftLimitInr != null) asks.push(`Any order above ₹${p.spendSoftLimitInr.toLocaleString("en-IN")}`);
    const off = PERMISSION_STORES.filter((s) => !p.stores[s]).map((s) => STORE_LABEL[s]);
    if (off.length) asks.push(`Anything on ${off.join(", ")}`);
    return { can, asks };
}

/** Rupees from a confirm card label like "₹1,234.50". */
export function paiseFromLabel(label: unknown): number | null {
    const m = String(label ?? "").replace(/,/g, "").match(/(?:₹|rs\.?|inr)\s*(\d+(?:\.\d{1,2})?)/i);
    return m ? Math.round(Number(m[1]) * 100) : null;
}

/** Total of the order waiting for *confirm* in this WhatsApp session (null if unknown). */
export function pendingOrderTotal(doc: Record<string, unknown> | null | undefined): { paise: number | null; partner: string | null; item: string | null } | null {
    if (!doc) return null;
    const bd = doc.browserTaskDraft as Record<string, any> | undefined;
    const live = (d: any) => d?.phase && d.phase !== "idle" && d.phase !== "done";
    if (live(bd) && ["awaiting_confirm", "awaiting_mcp_confirm", "awaiting_sku_confirm"].includes(bd!.phase)) {
        const paise =
            (typeof bd!.mcpCard?.totalPaise === "number" ? bd!.mcpCard.totalPaise : null) ??
            paiseFromLabel(bd!.confirm?.totalLabel) ??
            (typeof bd!.selectedSku?.pricePaise === "number" ? bd!.selectedSku.pricePaise : null) ??
            (bd!.catalogOptions?.length === 1 && typeof bd!.catalogOptions[0].pricePaise === "number" ? bd!.catalogOptions[0].pricePaise : null);
        const partner = String(bd!.selectedSku?.partner || bd!.partner || "") || null;
        const item = String(bd!.selectedSku?.name || bd!.mcpCard?.itemLine || bd!.productQuery || bd!.dishQuery || "") || null;
        return { paise, partner, item };
    }
    const pd = doc.pharmacyDraft as Record<string, any> | undefined;
    if (live(pd) && /confirm/.test(String(pd!.phase))) {
        const items = Array.isArray(pd!.items) ? pd!.items : [];
        const sum = items.reduce((a: number, i: any) => a + (typeof i.pricePaise === "number" ? i.pricePaise * (Number(i.quantity) || 1) : 0), 0);
        return { paise: sum || null, partner: String(pd!.partner || "") || null, item: items.map((i: any) => i.name).filter(Boolean).join(", ") || String(pd!.searchQuery || "") || null };
    }
    return null;
}
