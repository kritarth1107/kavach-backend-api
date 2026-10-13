/**
 * What Saheli is allowed to do for a family. The truth is the family's boundaries in Saheli's care record (the engine's
 * boundary:policy fact: limits, approvers, categories that always need approval), set on the dashboard's limits page or
 * on WhatsApp (trust plan A1: SaheliPermissions is retired, read only for the memory move). This view maps it for the
 * old delegate hooks: every category and store stays allowed (approval is enforced by the engine at the confirm), and
 * "ask before orders above" is the policy's limit for the care recipient's own orders. Hard guards stay in code and
 * are shown as locked rules, never settings.
 */
import { PERMISSION_STORES, type ISaheliPermissions, type PermissionStore } from "../../models/saheliPermissions.model";

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

const cache = new Map<string, { at: number; p: Permissions }>();
const CACHE_MS = 60_000;

/** The family's permissions, read from the engine's boundary policy (cached 60 s; defaults when it cannot be read). */
export async function getPermissions(familyId: string): Promise<Permissions> {
    const hit = cache.get(familyId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
    let limit: number | null = DEFAULTS.spendSoftLimitInr;
    try {
        const { aiEngineJson } = await import("../../clients/aiEngine.client");
        const got = await aiEngineJson<{ policy?: { elder_order_limit?: number | null } }>(
            "GET", `/v2/dash/${encodeURIComponent(familyId)}/family/boundaries`, undefined, 4000,
        );
        const v = got.policy?.elder_order_limit;
        limit = typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
    } catch (err) {
        console.warn(`[permissions] boundary policy read failed: ${err instanceof Error ? err.message : err}`);
        if (hit) return hit.p;
    }
    const stores = {} as Record<PermissionStore, boolean>;
    for (const s of PERMISSION_STORES) stores[s] = true;
    const p: Permissions = {
        familyId,
        groceries: true,
        food: true,
        medicines: true,
        rides: true,
        stores,
        spendSoftLimitInr: limit,
        deliveryFollowUps: DEFAULTS.deliveryFollowUps,
        medicineStartCheck: DEFAULTS.medicineStartCheck,
        resumeNudges: DEFAULTS.resumeNudges,
        history: [],
    };
    cache.set(familyId, { at: Date.now(), p });
    return p;
}

/** Tests only. */
export function primePermissions(p: Permissions): void {
    cache.set(p.familyId, { at: Date.now(), p });
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
