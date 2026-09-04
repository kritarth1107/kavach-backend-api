import config from "../../config/app.config";
import type { McpPartnerConfig, McpPartnerKey } from "./types";

function frontendCallback(partner: McpPartnerKey): string {
    const frontend = config.server.liveFrontendUrl.replace(/\/$/, "");
    return `${frontend}/api/integrations/${partner}/callback`;
}

export const MCP_PARTNERS: Record<McpPartnerKey, McpPartnerConfig> = {
    zepto: {
        key: "zepto",
        label: "Zepto",
        mcpUrl: process.env.ZEPTO_MCP_URL || "https://mcp.zepto.co.in/mcp",
        getRedirectUri: () =>
            process.env.ZEPTO_MCP_REDIRECT_URI || frontendCallback("zepto"),
        partnerTrack: "https://github.com/zeptonow/mcp/issues",
        deepLink: "https://www.zeptonow.com/",
        paymentNote:
            "Payment via Zepto MCP (COD, UPI link, wallet). Razorpay not required for Zepto orders.",
        connectedDescription:
            "Your Zepto account is linked via official MCP. Approved orders are placed through Zepto.",
        disconnectedDescription:
            "Connect your Zepto account to place real orders. Until then, mock fulfillment + deep link.",
        searchToolNeedles: [["search"], ["product"]],
        addCartNeedles: [["add", "cart"], ["cart"]],
        checkoutToolNeedles: [["place", "order"], ["checkout"]],
    },
    swiggy: {
        key: "swiggy",
        label: "Swiggy Food",
        mcpUrl: process.env.SWIGGY_MCP_URL || "https://mcp.swiggy.com/food",
        getRedirectUri: () =>
            process.env.SWIGGY_MCP_REDIRECT_URI || frontendCallback("swiggy"),
        partnerTrack: "https://mcp.swiggy.com/builders/docs/start/what-is-swiggy-mcp.md",
        deepLink: "https://www.swiggy.com/",
        paymentNote:
            "Payment via Swiggy MCP (COD, UPI, Swiggy Pay). User completes payment in Swiggy app when prompted.",
        connectedDescription:
            "Your Swiggy account is linked via official MCP. Food orders can be placed through Swiggy Food tools.",
        disconnectedDescription:
            "Connect your Swiggy account for live food ordering via MCP. Until then, orders stay in mock mode.",
        searchToolNeedles: [["search"], ["restaurant"]],
        addCartNeedles: [["add", "cart"], ["cart"]],
        checkoutToolNeedles: [["checkout"], ["place", "order"]],
    },
    instamart: {
        key: "instamart",
        label: "Instamart",
        mcpUrl: process.env.INSTAMART_MCP_URL || "https://mcp.swiggy.com/im",
        getRedirectUri: () =>
            process.env.INSTAMART_MCP_REDIRECT_URI || frontendCallback("instamart"),
        partnerTrack: "https://mcp.swiggy.com/builders/docs/build/recipes/order-groceries.md",
        deepLink: "https://www.swiggy.com/instamart",
        paymentNote:
            "Payment via Instamart MCP (COD or UPI). Groceries are placed on the caregiver's Swiggy Instamart account.",
        connectedDescription:
            "Your Instamart account is linked via official MCP. Grocery baskets can be checked out through Instamart.",
        disconnectedDescription:
            "Connect Instamart for live grocery ordering via MCP. Until then, mock fulfillment applies.",
        searchToolNeedles: [["search", "product"], ["search"]],
        addCartNeedles: [["add", "cart"], ["cart"]],
        checkoutToolNeedles: [["checkout"]],
    },
};

export function getMcpPartner(partner: McpPartnerKey): McpPartnerConfig {
    return MCP_PARTNERS[partner];
}
