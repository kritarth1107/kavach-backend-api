import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import McpConnection from "../../models/mcpConnection.model";
import McpOAuthSession from "../../models/mcpOAuthSession.model";
import ZeptoConnection from "../../models/zeptoConnection.model";
import { encryptJson, decryptJson } from "../../utils/tokenVault.util";
import {
    KavachMcpOAuthProvider,
    createOAuthState,
    sealOAuthSession,
    unsealClientInfo,
    unsealCodeVerifier,
} from "./kavachOAuthProvider";
import { getMcpPartner } from "./partners";
import type { McpPartnerKey } from "./types";

const CLIENT_INFO = { name: "kavach-backend", version: "1.0.0" };

function pickToolName(tools: Array<{ name: string }>, ...needles: string[]): string | null {
    const lower = needles.map((n) => n.toLowerCase());
    const hit = tools.find((t) => {
        const name = t.name.toLowerCase();
        return lower.every((n) => name.includes(n));
    });
    return hit?.name ?? null;
}

function pickToolFromNeedles(
    tools: Array<{ name: string }>,
    needlesList: string[][],
): string | null {
    for (const needles of needlesList) {
        const hit = pickToolName(tools, ...needles);
        if (hit) return hit;
    }
    return null;
}

async function readLegacyZeptoTokens(familyId: string, userId: string) {
    const row = await ZeptoConnection.findOne({ familyId, userId }).lean();
    if (!row) return null;
    return {
        tokensEnc: row.tokensEnc,
        clientInfoEnc: row.clientInfoEnc,
        connectedAt: row.connectedAt,
    };
}

async function readConnection(partner: McpPartnerKey, familyId: string, userId: string) {
    const row = await McpConnection.findOne({ partner, familyId, userId }).lean();
    if (row) return row;
    if (partner === "zepto") {
        const legacy = await readLegacyZeptoTokens(familyId, userId);
        if (legacy) {
            return {
                partner: "zepto" as const,
                familyId,
                userId,
                tokensEnc: legacy.tokensEnc,
                clientInfoEnc: legacy.clientInfoEnc,
                connectedAt: legacy.connectedAt,
            };
        }
    }
    return null;
}

async function buildProviderFromConnection(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
    handlers?: { onAuthorizationUrl?: (url: string) => void },
): Promise<{ provider: KavachMcpOAuthProvider; hasTokens: boolean }> {
    const config = getMcpPartner(partner);
    const row = await readConnection(partner, familyId, userId);
    if (!row) {
        const oauthState = createOAuthState();
        return {
            provider: new KavachMcpOAuthProvider({
                redirectUri: config.getRedirectUri(),
                oauthState,
                onAuthorizationUrl: handlers?.onAuthorizationUrl,
            }),
            hasTokens: false,
        };
    }

    const tokens = decryptJson<OAuthTokens>(row.tokensEnc);
    const clientInformation = row.clientInfoEnc
        ? unsealClientInfo(row.clientInfoEnc)
        : undefined;

    return {
        provider: new KavachMcpOAuthProvider({
            redirectUri: config.getRedirectUri(),
            oauthState: createOAuthState(),
            tokens,
            clientInformation,
            onAuthorizationUrl: handlers?.onAuthorizationUrl,
        }),
        hasTokens: true,
    };
}

export async function getMcpConnectionStatus(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
) {
    const row = await readConnection(partner, familyId, userId);
    return {
        connected: Boolean(row),
        connectedAt: row?.connectedAt?.toISOString?.() ?? row?.connectedAt ?? null,
    };
}

export async function startMcpConnect(partner: McpPartnerKey, familyId: string, userId: string) {
    const config = getMcpPartner(partner);
    let authorizationUrl = "";
    const oauthState = createOAuthState();
    let capturedVerifier = "";
    let capturedClientInfo: OAuthClientInformationMixed | undefined;

    const provider = new KavachMcpOAuthProvider({
        redirectUri: config.getRedirectUri(),
        oauthState,
        onAuthorizationUrl: (url) => {
            authorizationUrl = url;
        },
        onCodeVerifier: (verifier) => {
            capturedVerifier = verifier;
        },
        onClientInfo: (info) => {
            capturedClientInfo = info;
        },
    });

    const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
        authProvider: provider,
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });

    try {
        await client.connect(transport);
        await client.close();
        return { connected: true, authorizationUrl: null };
    } catch {
        // Expected when OAuth redirect is required
    }

    if (!authorizationUrl || !capturedVerifier) {
        throw new Error(
            `Could not start ${config.label} OAuth. Ensure ${config.getRedirectUri()} is whitelisted by the partner.`,
        );
    }

    const sealed = sealOAuthSession({
        codeVerifier: capturedVerifier,
        clientInformation: capturedClientInfo,
    });

    await McpOAuthSession.create({
        partner,
        familyId,
        userId,
        oauthState,
        authorizationUrl,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        ...sealed,
    });

    return { connected: false, authorizationUrl, oauthState };
}

export async function completeMcpConnect(code: string, state: string) {
    const session = await McpOAuthSession.findOne({ oauthState: state });
    if (!session || session.expiresAt < new Date()) {
        throw new Error("OAuth session expired or invalid. Try connecting again.");
    }

    const config = getMcpPartner(session.partner as McpPartnerKey);
    const codeVerifier = unsealCodeVerifier(session.codeVerifierEnc);
    const clientInformation = session.clientInfoEnc
        ? unsealClientInfo(session.clientInfoEnc)
        : undefined;

    let savedTokens: OAuthTokens | undefined;
    let savedClientInfo: OAuthClientInformationMixed | undefined = clientInformation;

    const provider = new KavachMcpOAuthProvider({
        redirectUri: config.getRedirectUri(),
        oauthState: state,
        codeVerifier,
        clientInformation,
        onTokens: (tokens) => {
            savedTokens = tokens;
        },
        onClientInfo: (info) => {
            savedClientInfo = info;
        },
    });

    const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
        authProvider: provider,
    });

    await transport.finishAuth(code);

    if (!savedTokens) {
        throw new Error(`${config.label} did not return OAuth tokens`);
    }

    await McpConnection.findOneAndUpdate(
        { partner: session.partner, familyId: session.familyId, userId: session.userId },
        {
            tokensEnc: encryptJson(savedTokens),
            clientInfoEnc: savedClientInfo ? encryptJson(savedClientInfo) : undefined,
            connectedAt: new Date(),
        },
        { upsert: true, new: true },
    );

    if (session.partner === "zepto") {
        await ZeptoConnection.deleteOne({
            familyId: session.familyId,
            userId: session.userId,
        });
    }

    await McpOAuthSession.deleteOne({ _id: session._id });

    return {
        partner: session.partner as McpPartnerKey,
        familyId: session.familyId,
        userId: session.userId,
        connected: true,
    };
}

export async function disconnectMcp(partner: McpPartnerKey, familyId: string, userId: string) {
    await McpConnection.deleteOne({ partner, familyId, userId });
    if (partner === "zepto") {
        await ZeptoConnection.deleteOne({ familyId, userId });
    }
    return { disconnected: true };
}

async function withMcpClient<T>(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
    fn: (client: Client) => Promise<T>,
): Promise<T> {
    const config = getMcpPartner(partner);
    const { provider, hasTokens } = await buildProviderFromConnection(partner, familyId, userId);
    if (!hasTokens) {
        throw new Error(
            `${config.label} account not connected. Connect in Integrations first.`,
        );
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
        authProvider: provider,
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    await client.connect(transport);
    try {
        return await fn(client);
    } finally {
        await client.close();
    }
}

export async function listMcpTools(partner: McpPartnerKey, familyId: string, userId: string) {
    return withMcpClient(partner, familyId, userId, async (client) => {
        const result = await client.listTools();
        return result.tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
    });
}

export async function searchMcpProduct(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
    query: string,
): Promise<{ items: Array<{ name: string; pricePaise?: number; productId?: string }> }> {
    const config = getMcpPartner(partner);
    return withMcpClient(partner, familyId, userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const searchTool = pickToolFromNeedles(tools, config.searchToolNeedles);
        if (!searchTool) return { items: [] };

        const result = await client.callTool({
            name: searchTool,
            arguments: { query, q: query, search_query: query },
        });

        const text = extractToolText(result);
        const items = parseSearchResults(text, query);
        return { items };
    });
}

export async function placeMcpOrder(input: {
    partner: McpPartnerKey;
    familyId: string;
    userId: string;
    items: Array<{ name: string; quantity: number }>;
    paymentMethod?: string;
}): Promise<{
    partnerRef: string;
    deepLink?: string;
    paymentLink?: string;
    rawSummary: string;
}> {
    const config = getMcpPartner(input.partner);
    return withMcpClient(input.partner, input.familyId, input.userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const searchTool = pickToolFromNeedles(tools, config.searchToolNeedles);
        const addTool = pickToolFromNeedles(tools, config.addCartNeedles);
        const checkoutTool = pickToolFromNeedles(tools, config.checkoutToolNeedles);

        const summaries: string[] = [];
        let addressId: string | undefined;

        const addressTool = tools.find((t) => /get_addresses/i.test(t.name))?.name;
        if (addressTool) {
            const addresses = await client.callTool({ name: addressTool, arguments: {} });
            summaries.push(extractToolText(addresses));
            addressId = extractFirstId(extractToolText(addresses));
        }

        for (const item of input.items) {
            if (searchTool) {
                const search = await client.callTool({
                    name: searchTool,
                    arguments: {
                        query: item.name,
                        q: item.name,
                        addressId,
                    },
                });
                summaries.push(extractToolText(search));
            }
            if (addTool) {
                const added = await client.callTool({
                    name: addTool,
                    arguments: {
                        product_name: item.name,
                        name: item.name,
                        query: item.name,
                        quantity: item.quantity,
                        addressId,
                    },
                });
                summaries.push(extractToolText(added));
            }
        }

        if (!checkoutTool) {
            return {
                partnerRef: `${input.partner}-mcp-${Date.now()}`,
                deepLink: config.deepLink,
                rawSummary: summaries.join("\n"),
            };
        }

        const paymentMethod = input.paymentMethod ?? "COD";
        const placed = await client.callTool({
            name: checkoutTool,
            arguments: {
                payment_method: paymentMethod,
                paymentMethod,
                addressId,
            },
        });

        const rawSummary = `${summaries.join("\n")}\n${extractToolText(placed)}`;
        const paymentLink = extractUrl(rawSummary);

        return {
            partnerRef: `${input.partner}-mcp-${Date.now()}`,
            deepLink: paymentLink ?? config.deepLink,
            paymentLink: paymentLink ?? undefined,
            rawSummary,
        };
    });
}

function extractToolText(result: unknown): string {
    if (!result || typeof result !== "object") return String(result ?? "");
    const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
    if (!Array.isArray(content)) return JSON.stringify(result);
    return content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");
}

function extractUrl(text: string): string | undefined {
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match?.[0];
}

function extractFirstId(text: string): string | undefined {
    const match = text.match(/"id"\s*:\s*"([^"]+)"/i) ?? text.match(/addr_[A-Za-z0-9]+/);
    return match?.[1] ?? match?.[0];
}

function parseSearchResults(
    text: string,
    fallbackName: string,
): Array<{ name: string; pricePaise?: number; productId?: string }> {
    if (!text.trim()) {
        return [{ name: fallbackName }];
    }

    const priceMatch = text.match(/₹\s*([\d,]+(?:\.\d+)?)/);
    const priceRupees = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : undefined;

    return [
        {
            name: fallbackName,
            pricePaise: priceRupees ? Math.round(priceRupees * 100) : undefined,
        },
    ];
}
