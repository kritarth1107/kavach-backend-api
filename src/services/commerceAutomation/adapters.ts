import type { CommerceAutomationAdapter, CommercePartnerKey, PlaceResult, SearchHit } from "./types";
import { beginOtpLogin, getAutomationSession, markSessionConnected } from "./sessionStore.service";
import { startMcpConnect, searchMcpProduct } from "../../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../../partners/mcp/types";
import { runBrowserTask } from "./browserWorker.service";
import { shouldPreferBrowserForPartner } from "./commerceBrowserFirst";

const MCP_PARTNERS = new Set<CommercePartnerKey>(["swiggy", "instamart", "zepto"]);

function stubPlace(partner: CommercePartnerKey): PlaceResult {
    return {
        ok: false,
        status: "error",
        message: `${partner} place needs WhatsApp confirm via browser task — no silent pay.`,
    };
}

/** MCP-backed adapter for Swiggy / Instamart / Zepto (elder-owned tokens preferred). */
function mcpAdapter(partner: McpPartnerKey): CommerceAutomationAdapter {
    return {
        partner,
        async loginWithOtp(input) {
            try {
                const started = await startMcpConnect(partner, input.familyId, input.userId);
                const oauthUrl = started.authorizationUrl ?? undefined;
                await beginOtpLogin({
                    userId: input.userId,
                    partner,
                    otpChallengeId: `mcp:${Date.now()}`,
                });
                return {
                    status: oauthUrl ? "pending_login" : "awaiting_otp",
                    otpChallengeId: `mcp:${Date.now()}`,
                    oauthUrl,
                };
            } catch {
                return {
                    status: "error",
                    oauthUrl: undefined,
                };
            }
        },
        async submitOtp(input) {
            void input.otp;
            await markSessionConnected({ userId: input.userId, partner });
            return { status: "connected" };
        },
        async search(input) {
            const session = await getAutomationSession(input.userId, partner);
            void session;
            const result = await searchMcpProduct(
                partner,
                input.familyId,
                input.userId,
                input.query,
                { addressId: input.addressId },
            );
            const hits: SearchHit[] = (result.items ?? []).slice(0, 8).map((h, idx) => ({
                id: String((h as { itemId?: string; id?: string }).itemId ?? (h as { id?: string }).id ?? h.name ?? idx),
                name: h.name,
                pricePaise: h.pricePaise,
            }));
            return {
                hits,
                message: hits.length === 0 ? `No ${partner} hits for "${input.query}".` : undefined,
            };
        },
        async setAddress() {
            return { ok: true };
        },
        async addToCart() {
            return { ok: true, message: "Use existing MCP cart path for live add." };
        },
        async getBill() {
            return null;
        },
        async place() {
            return stubPlace(partner);
        },
    };
}

/**
 * Browser-automation adapter (Apollo / pharmacy / Blinkit / Zomato).
 * Uses Gemini multimodal + Playwright when Chromium is available; dry-run otherwise.
 */
function browserAdapter(partner: CommercePartnerKey): CommerceAutomationAdapter {
    return {
        partner,
        async loginWithOtp(input) {
            const challenge = `${partner}-otp-${Date.now()}`;
            await beginOtpLogin({
                userId: input.userId,
                partner,
                otpChallengeId: challenge,
            });
            return {
                status: "awaiting_otp",
                otpChallengeId: challenge,
            };
        },
        async submitOtp(input) {
            if (!/^\d{4,8}$/.test(input.otp.trim())) {
                return { status: "error" };
            }
            // Drive browser with OTP (persists profile cookies when Playwright live)
            const result = await runBrowserTask({
                familyId: input.familyId,
                userId: input.userId,
                goal: `Complete ${partner} login with OTP`,
                partner,
                otp: input.otp.trim(),
            });
            if (result.status === "error") {
                return { status: "error" };
            }
            await markSessionConnected({ userId: input.userId, partner });
            return { status: "connected" };
        },
        async search(input) {
            // Guest/MCP catalog first — never invent prices; do not open login for search.
            const { searchGuestCatalog } = await import("./guestCatalogSearch.service");
            const catalog = await searchGuestCatalog({
                partner,
                query: input.query,
                familyId: input.familyId,
                userId: input.userId,
            });
            if (catalog.hits.length) {
                const hits: SearchHit[] = catalog.hits.map((h) => ({
                    id: h.id,
                    name: h.name,
                    pricePaise: h.pricePaise,
                    requiresRx: h.requiresRx,
                }));
                return {
                    hits,
                    message: `Found ${hits.length} live guest match(es) for "${input.query}". Confirm SKU before login.`,
                };
            }
            return {
                hits: [],
                message:
                    catalog.unavailableReason ||
                    `${partner} guest search returned no priced match for "${input.query}".`,
            };
        },
        async setAddress() {
            return { ok: true };
        },
        async addToCart() {
            return { ok: true };
        },
        async getBill() {
            return null;
        },
        async place(input) {
            const result = await runBrowserTask({
                familyId: input.familyId,
                userId: input.userId,
                goal: `Place ${partner} order after user confirm`,
                partner,
                userConfirmed: true,
                maxSteps: 10,
            });
            if (result.status === "done") {
                return {
                    ok: true,
                    status: result.mode === "dry_run" ? "needs_payment" : "placed",
                    message: result.message,
                };
            }
            if (result.status === "need_user_confirm") {
                return {
                    ok: false,
                    status: "needs_payment",
                    message: result.message,
                };
            }
            return {
                ok: false,
                status: "error",
                message: result.message,
            };
        },
    };
}

/** MCP adapters kept registered — used when COMMERCE_BROWSER_FIRST=0. */
const mcpRegistry: Partial<Record<CommercePartnerKey, CommerceAutomationAdapter>> = {
    swiggy: mcpAdapter("swiggy"),
    instamart: mcpAdapter("instamart"),
    zepto: mcpAdapter("zepto"),
};

const registry: Partial<Record<CommercePartnerKey, CommerceAutomationAdapter>> = {
    // Default primary path is browser when COMMERCE_BROWSER_FIRST (see getCommerceAdapter).
    swiggy: browserAdapter("swiggy"),
    instamart: browserAdapter("instamart"),
    zepto: browserAdapter("zepto"),
    blinkit: browserAdapter("blinkit"),
    zomato: browserAdapter("zomato"),
    apollo: browserAdapter("apollo"),
    pharmeasy: browserAdapter("pharmeasy"),
    tata_1mg: browserAdapter("tata_1mg"),
    bigbasket: browserAdapter("bigbasket"),
    jiomart: browserAdapter("jiomart"),
    dmart: browserAdapter("dmart"),
    natures_basket: browserAdapter("natures_basket"),
    amazon: browserAdapter("amazon"),
    flipkart: browserAdapter("flipkart"),
    myntra: browserAdapter("myntra"),
    uber: browserAdapter("uber"),
    ola: browserAdapter("ola"),
    rapido: browserAdapter("rapido"),
    generic_grocery: browserAdapter("generic_grocery"),
};

export function getCommerceAdapter(partner: CommercePartnerKey): CommerceAutomationAdapter {
    // When browser-first is off, restore MCP adapters for Swiggy/Instamart/Zepto.
    if (MCP_PARTNERS.has(partner) && !shouldPreferBrowserForPartner(partner)) {
        const mcp = mcpRegistry[partner];
        if (mcp) return mcp;
    }
    const adapter = registry[partner];
    if (!adapter) throw new Error(`No commerce adapter for ${partner}`);
    return adapter;
}

/** Always returns the MCP-backed adapter when one exists (for explicit MCP fallback). */
export function getMcpCommerceAdapter(partner: CommercePartnerKey): CommerceAutomationAdapter | null {
    return mcpRegistry[partner] ?? null;
}

export function isMcpCommercePartner(partner: CommercePartnerKey): boolean {
    return MCP_PARTNERS.has(partner);
}

export const PHARMACY_PARTNERS: CommercePartnerKey[] = ["apollo", "pharmeasy", "tata_1mg"];
export const GROCERY_AUTOMATION_PARTNERS: CommercePartnerKey[] = [
    "instamart",
    "swiggy",
    "zepto",
    "blinkit",
    "bigbasket",
    "jiomart",
    "dmart",
    "natures_basket",
    "generic_grocery",
];

export const RETAIL_BROWSER_PARTNERS: CommercePartnerKey[] = [
    "amazon",
    "flipkart",
    "myntra",
];

export const RIDE_BROWSER_PARTNERS: CommercePartnerKey[] = ["uber", "ola", "rapido"];
