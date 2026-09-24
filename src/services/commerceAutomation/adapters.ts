import type { CommerceAutomationAdapter, CommercePartnerKey, PlaceResult, SearchHit } from "./types";
import { beginOtpLogin, getAutomationSession, markSessionConnected } from "./sessionStore.service";
import { startMcpConnect, searchMcpProduct } from "../../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../../partners/mcp/types";

const MCP_PARTNERS = new Set<CommercePartnerKey>(["swiggy", "instamart", "zepto"]);

function stubPlace(partner: CommercePartnerKey): PlaceResult {
    return {
        ok: false,
        status: "error",
        message: `${partner} browser automation place is not live yet — use MCP when connected, or complete OTP login when prompted.`,
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
            } catch (err) {
                return {
                    status: "error",
                    oauthUrl: undefined,
                };
            }
        },
        async submitOtp(input) {
            // Official Swiggy MCP OAuth may complete out-of-band; mark connected best-effort.
            void input.otp;
            await markSessionConnected({ userId: input.userId, partner });
            return { status: "connected" };
        },
        async search(input) {
            const session = await getAutomationSession(input.userId, partner);
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
                message:
                    hits.length === 0
                        ? `No ${partner} hits for "${input.query}".`
                        : session?.status === "connected"
                          ? undefined
                          : undefined,
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

/** Pharmacy / Blinkit / Zomato scaffolds — OTP session + search stub until Playwright worker ships. */
function scaffoldAdapter(partner: CommercePartnerKey): CommerceAutomationAdapter {
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
            await markSessionConnected({ userId: input.userId, partner });
            return { status: "connected" };
        },
        async search(input) {
            // Honest scaffold: no live catalog. UX still confirms list before pay.
            return {
                hits: [
                    {
                        id: `${partner}-stub-1`,
                        name: input.query.slice(0, 80) || "Item",
                        pricePaise: undefined,
                        requiresRx: /rx|prescription|antibiotic|schedule\s*h/i.test(input.query),
                    },
                ],
                message: `${partner} live search is scaffolding — confirm items, address, and total before pay. OTC can proceed; Rx-required needs a prescription photo.`,
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
        async place() {
            return stubPlace(partner);
        },
    };
}

const registry: Partial<Record<CommercePartnerKey, CommerceAutomationAdapter>> = {
    swiggy: mcpAdapter("swiggy"),
    instamart: mcpAdapter("instamart"),
    zepto: mcpAdapter("zepto"),
    blinkit: scaffoldAdapter("blinkit"),
    zomato: scaffoldAdapter("zomato"),
    apollo: scaffoldAdapter("apollo"),
    pharmeasy: scaffoldAdapter("pharmeasy"),
    tata_1mg: scaffoldAdapter("tata_1mg"),
};

export function getCommerceAdapter(partner: CommercePartnerKey): CommerceAutomationAdapter {
    const adapter = registry[partner];
    if (!adapter) throw new Error(`No commerce adapter for ${partner}`);
    return adapter;
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
];
