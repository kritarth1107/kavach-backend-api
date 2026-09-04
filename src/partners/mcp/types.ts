export type McpPartnerKey = "zepto" | "swiggy" | "instamart";

export const MCP_PARTNER_KEYS: McpPartnerKey[] = ["zepto", "swiggy", "instamart"];

export function isMcpPartnerKey(value: string): value is McpPartnerKey {
    return MCP_PARTNER_KEYS.includes(value as McpPartnerKey);
}

export interface McpPartnerConfig {
    key: McpPartnerKey;
    label: string;
    mcpUrl: string;
    getRedirectUri: () => string;
    partnerTrack: string;
    deepLink: string;
    paymentNote: string;
    connectedDescription: string;
    disconnectedDescription: string;
    searchToolNeedles: string[][];
    addCartNeedles: string[][];
    checkoutToolNeedles: string[][];
}
