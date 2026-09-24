import { listFamilyConnectedPartners, resolveFamilyMcpUserId } from "../commerceConnection.service";
import { getAutomationSession } from "./sessionStore.service";
import { getCommerceAdapter, isMcpCommercePartner } from "./adapters";
import { shouldPreferBrowserForPartner } from "./commerceBrowserFirst";
import type { CommercePartnerKey } from "./types";
import type { McpPartnerKey } from "../../partners/mcp/types";

export type ElderCommercePath =
    | { kind: "mcp"; partner: McpPartnerKey; commerceUserId: string }
    | { kind: "browser"; partner: CommercePartnerKey }
    | { kind: "automation_session"; partner: CommercePartnerKey }
    | { kind: "start_login"; partner: CommercePartnerKey; oauthUrl?: string; prompt: string };

/**
 * Elder order path:
 * 0) COMMERCE_BROWSER_FIRST (default ON) for Swiggy/Zomato/Blinkit/Zepto/Instamart → browser
 * 1) else MCP connected for elder (preferred) or family fallback
 * 2) else automation session cookies
 * 3) else start OTP / OAuth login in WhatsApp
 *
 * MCP code/adapters stay registered — flip COMMERCE_BROWSER_FIRST=0 to restore MCP primary.
 */
export async function resolveElderCommercePath(input: {
    familyId: string;
    elderUserId: string;
    partner: CommercePartnerKey;
}): Promise<ElderCommercePath> {
    if (shouldPreferBrowserForPartner(input.partner)) {
        const session = await getAutomationSession(input.elderUserId, input.partner);
        if (session?.status === "connected" && session.encryptedBlob) {
            return { kind: "automation_session", partner: input.partner };
        }
        return { kind: "browser", partner: input.partner };
    }

    if (isMcpCommercePartner(input.partner)) {
        const mcpPartner = input.partner as McpPartnerKey;
        const connected = await listFamilyConnectedPartners(input.familyId, input.elderUserId);
        const isConnected = Boolean(connected[mcpPartner]);
        if (isConnected) {
            const commerceUserId =
                (await resolveFamilyMcpUserId(input.familyId, mcpPartner, input.elderUserId)) ??
                input.elderUserId;
            return { kind: "mcp", partner: mcpPartner, commerceUserId };
        }
    }

    const session = await getAutomationSession(input.elderUserId, input.partner);
    if (session?.status === "connected" && session.encryptedBlob) {
        return { kind: "automation_session", partner: input.partner };
    }

    const adapter = getCommerceAdapter(input.partner);
    // Probe login without consuming OTP yet — return WA prompt.
    const started = await adapter.loginWithOtp({
        userId: input.elderUserId,
        familyId: input.familyId,
        phoneE164: "",
    });
    const label = input.partner.replace("_", " ");
    return {
        kind: "start_login",
        partner: input.partner,
        oauthUrl: started.oauthUrl,
        prompt: started.oauthUrl
            ? `Connect ${label} on your number — open the link, complete OTP, then tell me your order again.`
            : `To order on ${label} from your WhatsApp, reply with the *OTP* you receive from ${label}.`,
    };
}
