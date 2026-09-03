import config from "../../config/app.config";

export const ZEPTO_MCP_URL = process.env.ZEPTO_MCP_URL || "https://mcp.zepto.co.in/mcp";

export function getZeptoRedirectUri(): string {
    if (process.env.ZEPTO_MCP_REDIRECT_URI) {
        return process.env.ZEPTO_MCP_REDIRECT_URI;
    }
    const frontend = config.server.liveFrontendUrl.replace(/\/$/, "");
    return `${frontend}/api/integrations/zepto/callback`;
}
