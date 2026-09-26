/**
 * Pure parsers for Swiggy Food / Instamart / Zepto MCP tool output (unit-tested in
 * scripts/test-mcp-commerce.ts). The servers return prose + (sometimes) a JSON tail.
 */

export type McpStore = "swiggy" | "instamart" | "zepto";

export type StoreAddressRow = { id: string; label: string; text: string };

/** A pickable search result with the store ids needed to add exactly this item to the cart. */
export type McpPick = {
    store: McpStore;
    name: string;
    pricePaise?: number;
    /** Instamart */
    spinId?: string;
    skuId?: string;
    /** Zepto */
    pvid?: string;
    spid?: string;
    /** Swiggy Food */
    menuItemId?: string;
    restaurantId?: string;
    restaurantName?: string;
};

export type CartLine = { name: string; qty: number; pricePaise?: number; id?: string };
export type ParsedCart = { lines: CartLine[]; totalPaise?: number; feeLines: Array<{ label: string; paise?: number }> };

export function toolText(result: unknown): string {
    const r = result as { content?: Array<{ type?: string; text?: string }> } | null;
    return (r?.content || []).map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n");
}

export function toolIsError(result: unknown): boolean {
    return Boolean((result as { isError?: boolean } | null)?.isError);
}

/** Balanced {...} / [...] starting at i (string-aware), or null. */
function balancedAt(text: string, i: number): string | null {
    const open = text[i]!, close = open === "{" ? "}" : "]";
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < text.length; k++) {
        const c = text[k]!;
        if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === open) depth++;
        else if (c === close && --depth === 0) return text.slice(i, k + 1);
    }
    return null;
}

/** First JSON object/array in the text that parses (servers put prose before and after it). */
export function jsonTail(text: string): unknown {
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch !== "{" && ch !== "[") continue;
        if (i > 0 && text[i - 1] !== "\n" && text[i - 1] !== " ") continue;
        const chunk = balancedAt(text, i);
        if (!chunk) continue;
        try {
            return JSON.parse(chunk);
        } catch {
            /* keep scanning */
        }
    }
    return null;
}

export function rupeesToPaise(v: unknown): number | undefined {
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100);
    if (typeof v !== "string") return undefined;
    const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Math.round(Number(m[0]) * 100) : undefined;
}

// ── Addresses ───────────────────────────────────────────────────────────────

/** Swiggy get_addresses: "2. [Tag] Name: address text (ID: xyz)". */
export function parseSwiggyAddresses(text: string): StoreAddressRow[] {
    const out: StoreAddressRow[] = [];
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*\d+\.\s*\[([^\]]*)\]\s*([^:]*):\s*(.+?)\s*\(ID:\s*([A-Za-z0-9_-]+)\)\s*$/);
        if (m) out.push({ label: m[1]!.trim(), text: `${m[2]!.trim()}: ${m[3]!.trim()}`, id: m[4]! });
    }
    return out;
}

/** Zepto list_saved_addresses: numbered "1. Label: text" lines + an "Address IDs:" block. */
export function parseZeptoAddresses(text: string): StoreAddressRow[] {
    const [body, ids = ""] = text.split(/Address IDs:/i);
    const texts = new Map<number, { label: string; text: string }>();
    for (const line of (body || "").split("\n")) {
        const m = line.match(/^\s*(\d+)\.\s*([^:]+):\s*(.+)$/);
        if (m) texts.set(Number(m[1]), { label: m[2]!.trim(), text: m[3]!.trim() });
    }
    const out: StoreAddressRow[] = [];
    for (const line of ids.split("\n")) {
        const m = line.match(/^\s*(\d+)\.\s*"([^"]*)"\s*→\s*ID:\s*([A-Za-z0-9-]+)/);
        if (!m) continue;
        const t = texts.get(Number(m[1]));
        out.push({ id: m[3]!, label: t?.label || m[2]!, text: t?.text || "" });
    }
    return out;
}

/** Swiggy returns a short id from create_address and "short__suffix" in listings. */
export function sameStoreAddressId(listed: string, known: string): boolean {
    if (!listed || !known) return false;
    if (listed === known) return true;
    return listed.split("__")[0] === known.split("__")[0];
}

// ── Search ──────────────────────────────────────────────────────────────────

/** Instamart search_products JSON: products[].variations[] (price in rupees). In-stock only. */
export function parseInstamartSearch(text: string, max = 3): McpPick[] {
    const j = jsonTail(text) as { products?: Array<Record<string, unknown>> } | null;
    const out: McpPick[] = [];
    for (const p of j?.products || []) {
        if (p.inStock === false || p.isAvail === false) continue;
        const vars = (p.variations as Array<Record<string, unknown>> | undefined) || [];
        for (const v of vars) {
            if (v.isInStockAndAvailable === false) continue;
            const price = v.price as { offerPrice?: unknown; mrp?: unknown } | undefined;
            const spinId = typeof v.spinId === "string" ? v.spinId : undefined;
            if (!spinId) continue;
            const name = [String(v.displayName || p.displayName || "").trim(), String(v.quantityDescription || "").trim()].filter(Boolean).join(" — ");
            out.push({ store: "instamart", name, pricePaise: rupeesToPaise(price?.offerPrice ?? price?.mrp), spinId, skuId: typeof v.skuId === "string" ? v.skuId : undefined });
            break; // one variation per product keeps the list short; the elder can ask for a size
        }
        if (out.length >= max) break;
    }
    return out;
}

/** Zepto search_products: "1. Name - ₹77 (1 pack (1 L))" + "[1] pvid: …, spid: …". */
export function parseZeptoSearch(text: string, max = 3): McpPick[] {
    const [body, ids = ""] = text.split(/Product IDs:/i);
    const idMap = new Map<number, { pvid: string; spid: string }>();
    for (const line of ids.split("\n")) {
        const m = line.match(/^\s*\[(\d+)\]\s*pvid:\s*([A-Za-z0-9-]+),\s*spid:\s*([A-Za-z0-9-]+)/);
        if (m) idMap.set(Number(m[1]), { pvid: m[2]!, spid: m[3]! });
    }
    const out: McpPick[] = [];
    for (const line of (body || "").split("\n")) {
        const m = line.match(/^\s*(\d+)\.\s*(.+?)\s+-\s+₹\s*([\d,.]+)\s*(?:\((.*)\))?\s*$/);
        if (!m) continue;
        if (/out of stock|unavailable/i.test(line)) continue;
        const ids2 = idMap.get(Number(m[1]));
        if (!ids2) continue;
        const pack = (m[4] || "").replace(/^1 (?:pack|pc|piece)\s*\((.*)\)$/i, "$1").trim();
        out.push({ store: "zepto", name: pack ? `${m[2]!.trim()} — ${pack}` : m[2]!.trim(), pricePaise: rupeesToPaise(m[3]), pvid: ids2.pvid, spid: ids2.spid });
        if (out.length >= max) break;
    }
    return out;
}

/** Swiggy search_menu: "1. Dish — ₹200 | Veg | 3.6★ | Restaurant (restaurantId: 1) (ID: 2) [has addons]". */
export function parseFoodMenu(text: string, max = 5): McpPick[] {
    const out: McpPick[] = [];
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*\d+\.\s*(.+?)\s+—\s+₹\s*([\d,.]+)\s*\|(.*)\(restaurantId:\s*(\d+)\)\s*\(ID:\s*(\d+)\)\s*(\[.*\])?\s*$/);
        if (!m) continue;
        const flags = m[6] || "";
        // Items that need a size/variant choice can't be added as "exactly this"; skip them.
        if (/variant/i.test(flags)) continue;
        if (/closed|unavailable/i.test(m[3]!)) continue;
        const segs = m[3]!.split("|").map((s) => s.trim()).filter(Boolean);
        const restaurantName = segs[segs.length - 1] || "";
        out.push({ store: "swiggy", name: m[1]!.trim(), pricePaise: rupeesToPaise(m[2]), menuItemId: m[5]!, restaurantId: m[4]!, restaurantName });
        if (out.length >= max) break;
    }
    return out;
}

// ── Carts / payment ─────────────────────────────────────────────────────────

/** Instamart update_cart / get_cart JSON. */
export function parseInstamartCart(text: string): ParsedCart | null {
    const j = jsonTail(text) as {
        items?: Array<Record<string, unknown>>;
        billBreakdown?: { lineItems?: Array<{ label?: string; value?: string }>; toPay?: { value?: string } };
        cartTotalAmount?: string;
    } | null;
    if (!j) return null;
    return {
        lines: (j.items || []).map((i) => ({
            name: [String(i.itemName || ""), String(i.itemVariant || "")].filter(Boolean).join(" — "),
            qty: Number(i.quantity) || 0,
            pricePaise: rupeesToPaise(i.discountedFinalPrice ?? i.mrp),
            id: typeof i.spinId === "string" ? i.spinId : undefined,
        })),
        totalPaise: rupeesToPaise(j.billBreakdown?.toPay?.value ?? j.cartTotalAmount),
        feeLines: (j.billBreakdown?.lineItems || []).map((l) => ({ label: String(l.label || ""), paise: rupeesToPaise(l.value) })),
    };
}

/** Swiggy get_food_cart text: "- Dish — ₹200 (ID: 1)" / "- 2x Dish …" and "TO PAY: ₹297". */
export function parseFoodCart(text: string): ParsedCart | null {
    if (/cart is empty/i.test(text)) return { lines: [], feeLines: [] };
    const lines: CartLine[] = [];
    const feeLines: ParsedCart["feeLines"] = [];
    let totalPaise: number | undefined;
    for (const raw of text.split("\n")) {
        const line = raw.trim();
        const item = line.match(/^-\s*(?:(\d+)\s*x\s*)?(.+?)\s+—\s+₹\s*([\d,.]+)(?:\s*\(ID:\s*(\d+)\))?(.*)$/i);
        if (item) {
            const qtyTail = (item[5] || "").match(/(?:qty|quantity)\s*:?\s*(\d+)|x\s*(\d+)/i);
            const qty = Number(item[1] || qtyTail?.[1] || qtyTail?.[2] || 1);
            lines.push({ name: item[2]!.trim(), qty, pricePaise: rupeesToPaise(item[3]), id: item[4] });
            continue;
        }
        const pay = line.match(/^TO PAY:\s*₹\s*([\d,.]+)/i);
        if (pay) {
            totalPaise = rupeesToPaise(pay[1]);
            continue;
        }
        const fee = line.match(/^([A-Za-z][A-Za-z &/-]{2,40}):\s*(-?₹\s*[\d,.]+)/);
        if (fee) feeLines.push({ label: fee[1]!.trim(), paise: rupeesToPaise(fee[2]!.replace("₹", "")) });
    }
    return { lines, totalPaise, feeLines };
}

/** Zepto view_cart: "1. Name - ₹77 (Qty: 1)\n   pvid: …, spid: …". */
export function parseZeptoCart(text: string): ParsedCart | null {
    if (/cart is empty/i.test(text)) return { lines: [], feeLines: [] };
    const lines: CartLine[] = [];
    const rows = text.split("\n");
    for (let i = 0; i < rows.length; i++) {
        const m = rows[i]!.match(/^\s*\d+\.\s*(.+?)\s+-\s+(?:₹\s*([\d,.]+)|Price N\/A)\s*\(Qty:\s*(\d+)\)/i);
        if (!m) continue;
        const ids = (rows[i + 1] || "").match(/pvid:\s*([A-Za-z0-9-]+)/);
        lines.push({ name: m[1]!.trim(), qty: Number(m[3]), pricePaise: m[2] ? rupeesToPaise(m[2]) : undefined, id: ids?.[1] });
    }
    return { lines, feeLines: [] };
}

/** Swiggy get_payment_options JSON → is Cash on Delivery offered for this cart? */
export function swiggyCodAvailable(text: string): boolean {
    const j = jsonTail(text) as { cod?: { available?: boolean } } | null;
    if (j && j.cod && typeof j.cod.available === "boolean") return j.cod.available;
    return /\bCash on Delivery\b|Pay on delivery/i.test(text.split(/Unavailable/i)[0] || "");
}

/** Zepto get_payment_methods text → { cod, totalPaise }. COD must be in the available block. */
export function parseZeptoPayment(text: string): { cod: boolean; totalPaise?: number } {
    const avail = text.split(/Unavailable methods/i)[0] || "";
    const total = text.match(/Order Total:\s*₹\s*([\d,.]+)/i);
    return { cod: /Cash on Delivery|\(COD\)/i.test(avail), totalPaise: total ? rupeesToPaise(total[1]) : undefined };
}

/** Upsell / membership / add-on charges we never accept on an elder's order. */
export const UPSELL_RE = /\b(swiggy\s*one|one\s*lite|membership|super\s*saver|zepto\s*pass|pass\s*fee|donation|feeding\s*india|tip|insurance|protect|priority)\b/i;

export type CartCheck = { ok: true } | { ok: false; reason: "empty" | "extra_items" | "qty_mismatch" | "item_mismatch" | "upsell" | "no_total" };

/** Exactly the picked item(s) at the picked qty, no upsell lines, and a readable total. */
export function checkCart(cart: ParsedCart | null, expect: { id?: string; name: string; qty: number }, opts: { needTotal?: boolean } = {}): CartCheck {
    if (!cart || !cart.lines.length) return { ok: false, reason: "empty" };
    if (cart.lines.length !== 1) return { ok: false, reason: "extra_items" };
    const line = cart.lines[0]!;
    if (line.qty !== expect.qty) return { ok: false, reason: "qty_mismatch" };
    if (expect.id && line.id && line.id !== expect.id) return { ok: false, reason: "item_mismatch" };
    if (!expect.id || !line.id) {
        const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        const a = norm(line.name), b = norm(expect.name.split(" — ")[0] || expect.name);
        if (a && b && !a.includes(b.slice(0, 12)) && !b.includes(a.slice(0, 12))) return { ok: false, reason: "item_mismatch" };
    }
    if (cart.feeLines.some((f) => UPSELL_RE.test(f.label) && (f.paise ?? 0) > 0)) return { ok: false, reason: "upsell" };
    if (opts.needTotal && !(typeof cart.totalPaise === "number" && cart.totalPaise > 0)) return { ok: false, reason: "no_total" };
    return { ok: true };
}

/** Cart total at checkout may not exceed the confirm card by more than ₹1 (rounding). */
export function totalMatchesCard(cardPaise: number, nowPaise: number | undefined): boolean {
    return typeof nowPaise === "number" && Number.isFinite(nowPaise) && nowPaise <= cardPaise + 100;
}

export function extractOrderId(text: string): string | undefined {
    const j = jsonTail(text) as Record<string, unknown> | null;
    const dig = (o: unknown): string | undefined => {
        if (!o || typeof o !== "object") return undefined;
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            if (/^order_?id$/i.test(k) && (typeof v === "string" || typeof v === "number")) return String(v);
            const d = typeof v === "object" ? dig(v) : undefined;
            if (d) return d;
        }
        return undefined;
    };
    return dig(j) || text.match(/order\s*(?:id|#|number)\s*[:#]?\s*([A-Za-z0-9-]{5,})/i)?.[1];
}

export type McpRestaurant = { id: string; name: string; cuisines?: string; rating?: string; eta?: string; open: boolean };

/** Swiggy search_restaurants JSON → restaurants (availabilityStatus OPEN = taking orders). */
export function parseRestaurants(text: string): McpRestaurant[] {
    const j = jsonTail(text) as { restaurants?: Array<Record<string, unknown>> } | null;
    return (j?.restaurants || [])
        .filter((r) => r.id != null && r.name)
        .map((r) => ({
            id: String(r.id),
            name: String(r.name).replace(/\s*\(Ad\)\s*$/i, "").trim(),
            cuisines: Array.isArray(r.cuisines) ? (r.cuisines as unknown[]).slice(0, 3).join(", ") : undefined,
            rating: r.avgRating != null ? String(r.avgRating) : undefined,
            eta: typeof r.deliveryTimeRange === "string" ? r.deliveryTimeRange.toLowerCase() : undefined,
            open: String(r.availabilityStatus || "").toUpperCase() === "OPEN",
        }));
}

/** Swiggy get_restaurant_menu text: "- Dish — ₹219 | Veg, Bestseller, has variants [image: …] (ID: 1)". */
export function parseRestaurantMenu(text: string, restaurantId: string, restaurantName: string, max = 40): McpPick[] {
    const out: McpPick[] = [];
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*-\s*(.+?)\s+—\s+₹\s*([\d,.]+)\s*(?:\|([^[(]*))?.*\(ID:\s*(\d+)\)\s*$/);
        if (!m || seen.has(m[4]!)) continue;
        seen.add(m[4]!);
        if (/variant/i.test(m[3] || "") || /out of stock|unavailable/i.test(m[3] || "")) continue;
        out.push({ store: "swiggy", name: m[1]!.trim(), pricePaise: rupeesToPaise(m[2]), menuItemId: m[4]!, restaurantId, restaurantName });
        if (out.length >= max) break;
    }
    return out;
}
