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
            "Cash on Delivery only. Saheli refuses an order if Zepto doesn't offer COD for it.",
        connectedDescription:
            "Linked for your whole family. Your family member asks Saheli on WhatsApp, picks an option and replies \"confirm\" — no OTP. Delivery always goes to a family address-book place.",
        disconnectedDescription:
            "Not linked. Link Zepto once and Saheli can order on WhatsApp without an OTP (Cash on Delivery, family address book only).",
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
            "Cash on Delivery only. Saheli refuses an order if Swiggy doesn't offer COD for it.",
        connectedDescription:
            "Linked for your whole family. Your family member asks Saheli on WhatsApp, picks a dish and replies \"confirm\" — no OTP. Delivery always goes to a family address-book place.",
        disconnectedDescription:
            "Not linked. Link Swiggy Food once and Saheli can order meals on WhatsApp without an OTP (Cash on Delivery, family address book only). Without it Saheli uses the Swiggy website, which asks for an OTP.",
        searchToolNeedles: [["search", "restaurant"], ["search", "menu"]],
        addCartNeedles: [["update", "food", "cart"], ["food", "cart"]],
        checkoutToolNeedles: [["place", "food", "order"], ["place", "order"]],
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
            "Cash on Delivery only, placed on the linked Swiggy account. Saheli refuses an order if Instamart doesn't offer COD for it.",
        connectedDescription:
            "Linked for your whole family. Saheli compares Instamart (and Zepto, if linked) on WhatsApp; your family member picks and replies \"confirm\" — no OTP.",
        disconnectedDescription:
            "Not linked. Link Instamart once (Swiggy login) and Saheli can order groceries on WhatsApp without an OTP. Without it Saheli uses the website, which asks for an OTP.",
        searchToolNeedles: [["search", "product"], ["search"]],
        addCartNeedles: [["add", "cart"], ["cart"]],
        checkoutToolNeedles: [["checkout"]],
    },
};

export function getMcpPartner(partner: McpPartnerKey): McpPartnerConfig {
    return MCP_PARTNERS[partner];
}
