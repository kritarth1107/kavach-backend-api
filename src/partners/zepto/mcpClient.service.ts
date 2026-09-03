import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import ZeptoConnection from "../../models/zeptoConnection.model";
import { encryptJson, decryptJson } from "../../utils/tokenVault.util";
import {
    KavachZeptoOAuthProvider,
    createOAuthState,
    sealOAuthSession,
    unsealClientInfo,
    unsealCodeVerifier,
} from "./kavachOAuthProvider";
import { ZEPTO_MCP_URL } from "./config";
import ZeptoOAuthSession from "../../models/zeptoOAuthSession.model";

const CLIENT_INFO = { name: "kavach-backend", version: "1.0.0" };

function pickToolName(tools: Array<{ name: string }>, ...needles: string[]): string | null {
    const lower = needles.map((n) => n.toLowerCase());
    const hit = tools.find((t) => {
        const name = t.name.toLowerCase();
        return lower.every((n) => name.includes(n));
    });
    return hit?.name ?? null;
}

async function buildProviderFromConnection(
    familyId: string,
    userId: string,
    handlers?: {
        onAuthorizationUrl?: (url: string) => void;
    },
): Promise<{ provider: KavachZeptoOAuthProvider; hasTokens: boolean }> {
    const row = await ZeptoConnection.findOne({ familyId, userId }).lean();
    if (!row) {
        const oauthState = createOAuthState();
        return {
            provider: new KavachZeptoOAuthProvider({
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
        provider: new KavachZeptoOAuthProvider({
            oauthState: createOAuthState(),
            tokens,
            clientInformation,
            onAuthorizationUrl: handlers?.onAuthorizationUrl,
        }),
        hasTokens: true,
    };
}

export async function getZeptoConnectionStatus(familyId: string, userId: string) {
    const row = await ZeptoConnection.findOne({ familyId, userId }).lean();
    return {
        connected: Boolean(row),
        connectedAt: row?.connectedAt?.toISOString() ?? null,
    };
}

export async function startZeptoConnect(familyId: string, userId: string) {
    let authorizationUrl = "";
    const oauthState = createOAuthState();
    let capturedVerifier = "";
    let capturedClientInfo: OAuthClientInformationMixed | undefined;

    const provider = new KavachZeptoOAuthProvider({
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

    const transport = new StreamableHTTPClientTransport(new URL(ZEPTO_MCP_URL), {
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
            "Could not start Zepto OAuth. Ensure ZEPTO_MCP_REDIRECT_URI is whitelisted by Zepto.",
        );
    }

    const sealed = sealOAuthSession({
        codeVerifier: capturedVerifier,
        clientInformation: capturedClientInfo,
    });

    await ZeptoOAuthSession.create({
        familyId,
        userId,
        oauthState,
        authorizationUrl,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        ...sealed,
    });

    return { connected: false, authorizationUrl, oauthState };
}

export async function completeZeptoConnect(code: string, state: string) {
    const session = await ZeptoOAuthSession.findOne({ oauthState: state });
    if (!session || session.expiresAt < new Date()) {
        throw new Error("OAuth session expired or invalid. Try connecting again.");
    }

    const codeVerifier = unsealCodeVerifier(session.codeVerifierEnc);
    const clientInformation = session.clientInfoEnc
        ? unsealClientInfo(session.clientInfoEnc)
        : undefined;

    let savedTokens: OAuthTokens | undefined;
    let savedClientInfo: OAuthClientInformationMixed | undefined = clientInformation;

    const provider = new KavachZeptoOAuthProvider({
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

    const transport = new StreamableHTTPClientTransport(new URL(ZEPTO_MCP_URL), {
        authProvider: provider,
    });

    await transport.finishAuth(code);

    if (!savedTokens) {
        throw new Error("Zepto did not return OAuth tokens");
    }

    await ZeptoConnection.findOneAndUpdate(
        { familyId: session.familyId, userId: session.userId },
        {
            tokensEnc: encryptJson(savedTokens),
            clientInfoEnc: savedClientInfo ? encryptJson(savedClientInfo) : undefined,
            connectedAt: new Date(),
        },
        { upsert: true, new: true },
    );

    await ZeptoOAuthSession.deleteOne({ _id: session._id });

    return {
        familyId: session.familyId,
        userId: session.userId,
        connected: true,
    };
}

export async function disconnectZepto(familyId: string, userId: string) {
    await ZeptoConnection.deleteOne({ familyId, userId });
    return { disconnected: true };
}

async function withMcpClient<T>(
    familyId: string,
    userId: string,
    fn: (client: Client) => Promise<T>,
): Promise<T> {
    const { provider, hasTokens } = await buildProviderFromConnection(familyId, userId);
    if (!hasTokens) {
        throw new Error("Zepto account not connected. Connect Zepto in Integrations first.");
    }

    const transport = new StreamableHTTPClientTransport(new URL(ZEPTO_MCP_URL), {
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

export async function listZeptoTools(familyId: string, userId: string) {
    return withMcpClient(familyId, userId, async (client) => {
        const result = await client.listTools();
        return result.tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
    });
}

export async function searchZeptoProduct(
    familyId: string,
    userId: string,
    query: string,
): Promise<{ items: Array<{ name: string; pricePaise?: number; productId?: string }> }> {
    return withMcpClient(familyId, userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const searchTool =
            pickToolName(tools, "search") ??
            tools.find((t) => /product/i.test(t.name))?.name;
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

export async function placeZeptoOrderViaMcp(input: {
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
    return withMcpClient(input.familyId, input.userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const searchTool = pickToolName(tools, "search") ?? pickToolName(tools, "product");
        const addTool =
            pickToolName(tools, "add", "cart") ??
            pickToolName(tools, "cart", "add") ??
            tools.find((t) => /cart/i.test(t.name))?.name;
        const placeTool =
            pickToolName(tools, "place", "order") ??
            tools.find((t) => /place/i.test(t.name) && /order/i.test(t.name))?.name;

        const summaries: string[] = [];

        for (const item of input.items) {
            if (searchTool) {
                const search = await client.callTool({
                    name: searchTool,
                    arguments: { query: item.name, q: item.name },
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
                    },
                });
                summaries.push(extractToolText(added));
            }
        }

        if (!placeTool) {
            return {
                partnerRef: `zepto-mcp-${Date.now()}`,
                rawSummary: summaries.join("\n"),
            };
        }

        const placed = await client.callTool({
            name: placeTool,
            arguments: {
                payment_method: input.paymentMethod ?? "cod",
                paymentMethod: input.paymentMethod ?? "cod",
            },
        });

        const rawSummary = `${summaries.join("\n")}\n${extractToolText(placed)}`;
        const paymentLink = extractUrl(rawSummary);

        return {
            partnerRef: `zepto-mcp-${Date.now()}`,
            deepLink: paymentLink ?? "https://www.zeptonow.com/",
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
