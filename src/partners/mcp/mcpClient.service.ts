import { randomUUID } from "crypto";
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

export type McpCatalogHit = {
    kind?: "restaurant" | "dish" | "product";
    name: string;
    matchedName?: string;
    pricePaise?: number;
    costForTwoPaise?: number;
    productId?: string;
    itemId?: string;
    spinId?: string;
    restaurantId?: string;
    restaurantName?: string;
};

export type McpSearchResult = {
    items: McpCatalogHit[];
    addressId?: string;
    error?: string;
};

type McpTool = { name: string; description?: string };

function parseToolJson(text: string): unknown {
    const trimmed = text.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenced) {
            try {
                return JSON.parse(fenced[1].trim());
            } catch {
                return null;
            }
        }
        return null;
    }
}

function digData(obj: unknown): Record<string, unknown> | null {
    if (!obj || typeof obj !== "object") return null;
    const root = obj as Record<string, unknown>;
    if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
        return root.data as Record<string, unknown>;
    }
    return root;
}

function parsePricePaise(value: unknown): number | undefined {
    if (value == null) return undefined;
    if (typeof value === "number" && Number.isFinite(value)) {
        return value >= 1000 ? Math.round(value) : Math.round(value * 100);
    }
    if (typeof value === "string") {
        const match = value.match(/₹?\s*([\d,]+(?:\.\d+)?)/);
        if (match) return Math.round(Number(match[1].replace(/,/g, "")) * 100);
    }
    return undefined;
}

function fuzzyMatch(name: string, query: string): boolean {
    const normalizedName = name.toLowerCase();
    const normalizedQuery = query.toLowerCase().trim();
    if (!normalizedQuery) return false;
    if (normalizedName.includes(normalizedQuery)) return true;
    const words = normalizedQuery.split(/\s+/).filter((w) => w.length > 2);
    return words.some((w) => normalizedName.includes(w));
}

function extractRestaurants(parsed: unknown): Array<Record<string, unknown>> {
    const data = digData(parsed);
    if (!data) return [];
    const list = data.restaurants ?? data.results;
    return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

function flattenMenuItems(parsed: unknown): Array<{ id: string; name: string; price?: unknown }> {
    const data = digData(parsed);
    if (!data) return [];

    const items: Array<{ id: string; name: string; price?: unknown }> = [];
    const pushItem = (row: Record<string, unknown>) => {
        const id = row.id ?? row.itemId ?? row.menuItemId;
        const name = row.name ?? row.title ?? row.displayName;
        if (!id || !name) return;
        items.push({
            id: String(id),
            name: String(name),
            price: row.price ?? row.finalPrice ?? row.defaultPrice ?? row.itemPrice,
        });
    };

    const categories = data.categories ?? data.menu;
    if (Array.isArray(categories)) {
        for (const category of categories) {
            if (!category || typeof category !== "object") continue;
            const cat = category as Record<string, unknown>;
            if (cat.id && cat.name && !cat.items) {
                pushItem(cat);
                continue;
            }
            if (Array.isArray(cat.items)) {
                for (const item of cat.items) {
                    if (item && typeof item === "object") pushItem(item as Record<string, unknown>);
                }
            }
        }
    }

    if (Array.isArray(data.items)) {
        for (const item of data.items) {
            if (item && typeof item === "object") pushItem(item as Record<string, unknown>);
        }
    }

    return items;
}

function extractMenuSearchItems(parsed: unknown): Array<{
    name: string;
    itemId?: string;
    restaurantId?: string;
    restaurantName?: string;
    price?: unknown;
}> {
    const data = digData(parsed);
    if (!data) return [];

    const list = data.items ?? data.menuItems ?? data.results ?? data.dishes;
    if (!Array.isArray(list)) return [];

    return list
        .map((row) => {
            if (!row || typeof row !== "object") return null;
            const obj = row as Record<string, unknown>;
            const name = obj.name ?? obj.title ?? obj.displayName;
            if (!name) return null;
            return {
                name: String(name),
                itemId: obj.itemId ? String(obj.itemId) : obj.id ? String(obj.id) : undefined,
                restaurantId: obj.restaurantId ? String(obj.restaurantId) : undefined,
                restaurantName: (() => {
                    if (obj.restaurantName) return String(obj.restaurantName);
                    const restaurant = obj.restaurant;
                    if (restaurant && typeof restaurant === "object") {
                        const name = (restaurant as Record<string, unknown>).name;
                        if (name) return String(name);
                    }
                    return undefined;
                })(),
                price: obj.price ?? obj.finalPrice ?? obj.defaultPrice,
            };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

function extractInstamartProducts(parsed: unknown): Array<Record<string, unknown>> {
    const data = digData(parsed);
    if (!data) return [];
    const list = data.products ?? data.items ?? data.results;
    return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [];
}

function hitsFromInstamartProducts(products: Array<Record<string, unknown>>): McpCatalogHit[] {
    const hits: McpCatalogHit[] = [];
    for (const product of products.slice(0, 10)) {
        const variations = (product.variations ?? product.variants) as unknown;
        const variantList = Array.isArray(variations) ? variations : [];
        const variant =
            (variantList[0] as Record<string, unknown> | undefined) ??
            (product as Record<string, unknown>);

        const name = String(
            variant.displayName ?? variant.name ?? product.name ?? product.displayName ?? "Product",
        );
        const spinId = variant.spinId ?? variant.id ?? product.spinId ?? product.id;
        hits.push({
            kind: "product",
            name,
            pricePaise: parsePricePaise(variant.price ?? variant.mrp ?? product.price),
            spinId: spinId ? String(spinId) : undefined,
            productId: spinId ? String(spinId) : undefined,
        });
    }
    return hits;
}

async function resolveMcpAddressId(
    client: Client,
    tools: McpTool[],
    familyId: string,
    partner: McpPartnerKey,
    userId: string,
    overrideAddressId?: string,
): Promise<string | undefined> {
    if (overrideAddressId) return overrideAddressId;

    const { getDefaultPartnerAddressId } = await import("../../services/partnerAddress.service");
    const cached = await getDefaultPartnerAddressId(familyId, partner, userId);
    if (cached) return cached;

    const addressTool = tools.find((t) =>
        /get_addresses|list_addresses|saved_addresses/i.test(t.name),
    )?.name;
    if (!addressTool) return undefined;

    const result = await client.callTool({ name: addressTool, arguments: {} });
    const addresses = parsePartnerAddresses(result);
    return addresses[0]?.partnerAddressId;
}

function normalizeCatalogQuery(query: string): string {
    const stop = new Set([
        "i",
        "we",
        "me",
        "my",
        "want",
        "to",
        "eat",
        "order",
        "get",
        "have",
        "some",
        "please",
        "food",
        "khana",
        "the",
        "a",
        "an",
        "would",
        "like",
        "need",
        "bring",
        "mujhe",
        "hungry",
        "craving",
    ]);
    const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word.length > 1 && !stop.has(word));
    return words.join(" ") || query.trim();
}

async function searchSwiggyFoodCatalog(
    client: Client,
    tools: McpTool[],
    addressId: string | undefined,
    query: string,
): Promise<McpCatalogHit[]> {
    if (!addressId) return [];

    const catalogQuery = normalizeCatalogQuery(query);
    const hits: McpCatalogHit[] = [];
    const searchRestTool =
        tools.find((t) => t.name === "search_restaurants")?.name ??
        pickToolName(tools, "search", "restaurant");
    const searchMenuTool = tools.find((t) => t.name === "search_menu")?.name;
    const menuTool =
        tools.find((t) => t.name === "get_restaurant_menu")?.name ??
        pickToolName(tools, "restaurant", "menu");

    let openRestaurants: Array<Record<string, unknown>> = [];
    if (searchRestTool) {
        const result = await client.callTool({
            name: searchRestTool,
            arguments: { addressId, query: catalogQuery },
        });
        const restaurants = extractRestaurants(extractToolJson(result));
        openRestaurants = restaurants.filter(
            (r) => !r.availabilityStatus || String(r.availabilityStatus).toUpperCase() === "OPEN",
        );

        for (const restaurant of openRestaurants.slice(0, 5)) {
            const name = String(restaurant.name ?? "Restaurant");
            hits.push({
                kind: "restaurant",
                name,
                restaurantId: restaurant.id ? String(restaurant.id) : undefined,
                restaurantName: name,
                costForTwoPaise: parsePricePaise(restaurant.costForTwo ?? restaurant.avgCostForTwo),
                productId: restaurant.id ? String(restaurant.id) : undefined,
            });
        }
    }

    if (searchMenuTool) {
        const result = await client.callTool({
            name: searchMenuTool,
            arguments: { addressId, query: catalogQuery },
        });
        for (const dish of extractMenuSearchItems(extractToolJson(result)).slice(0, 8)) {
            hits.push({
                kind: "dish",
                name: dish.name,
                matchedName: dish.restaurantName ? `${dish.name} · ${dish.restaurantName}` : dish.name,
                itemId: dish.itemId,
                productId: dish.itemId,
                restaurantId: dish.restaurantId,
                restaurantName: dish.restaurantName,
                pricePaise: parsePricePaise(dish.price),
            });
        }
    }

    if (!hits.some((h) => h.kind === "dish") && menuTool && openRestaurants[0]?.id) {
        const restaurant = openRestaurants[0];
        const restaurantId = String(restaurant.id);
        const restaurantName = String(restaurant.name ?? "Restaurant");
        const result = await client.callTool({
            name: menuTool,
            arguments: { restaurantId },
        });
        const menuItems = flattenMenuItems(extractToolJson(result));
        for (const item of menuItems
            .filter((row) => fuzzyMatch(row.name, catalogQuery) || fuzzyMatch(row.name, query))
            .slice(0, 6)) {
            hits.push({
                kind: "dish",
                name: item.name,
                matchedName: `${item.name} · ${restaurantName}`,
                itemId: item.id,
                productId: item.id,
                restaurantId,
                restaurantName,
                pricePaise: parsePricePaise(item.price),
            });
        }
    }

    return hits;
}

async function searchInstamartCatalog(
    client: Client,
    tools: McpTool[],
    addressId: string | undefined,
    query: string,
): Promise<McpCatalogHit[]> {
    if (!addressId) return [];

    const searchTool =
        tools.find((t) => t.name === "search_products")?.name ??
        pickToolFromNeedles(tools, [["search", "product"], ["search"]]);
    if (!searchTool) return [];

    const result = await client.callTool({
        name: searchTool,
        arguments: { addressId, query },
    });
    return hitsFromInstamartProducts(extractInstamartProducts(extractToolJson(result)));
}

function pickBestCatalogHit(hits: McpCatalogHit[], preferDishes: boolean): McpCatalogHit | undefined {
    if (!hits.length) return undefined;
    if (preferDishes) {
        return (
            hits.find((h) => h.kind === "dish" && h.pricePaise) ??
            hits.find((h) => h.kind === "product" && h.pricePaise) ??
            hits.find((h) => h.kind === "dish") ??
            hits.find((h) => h.kind === "product") ??
            hits[0]
        );
    }
    return hits.find((h) => h.pricePaise) ?? hits[0];
}

async function resolveSwiggyCartItems(
    client: Client,
    tools: McpTool[],
    addressId: string | undefined,
    items: Array<{ name: string; quantity: number }>,
): Promise<{ restaurantId: string; cartItems: Array<{ itemId: string; quantity: number }> }> {
    let restaurantId: string | undefined;
    const cartItems: Array<{ itemId: string; quantity: number }> = [];

    for (const item of items) {
        const hits = await searchSwiggyFoodCatalog(client, tools, addressId, item.name);
        const dish = pickBestCatalogHit(hits, true);
        if (!dish?.itemId || !dish.restaurantId) {
            throw new Error(`Could not find "${item.name}" on Swiggy Food. Try a specific dish name.`);
        }
        if (restaurantId && dish.restaurantId !== restaurantId) {
            throw new Error(
                `"${item.name}" is from a different restaurant. Swiggy orders must be from one restaurant.`,
            );
        }
        restaurantId = dish.restaurantId;
        cartItems.push({ itemId: dish.itemId, quantity: item.quantity });
    }

    if (!restaurantId || !cartItems.length) {
        throw new Error("Could not build Swiggy Food cart.");
    }

    return { restaurantId, cartItems };
}

async function resolveInstamartCartItems(
    client: Client,
    tools: McpTool[],
    addressId: string | undefined,
    items: Array<{ name: string; quantity: number }>,
): Promise<Array<{ spinId: string; quantity: number }>> {
    const cartItems: Array<{ spinId: string; quantity: number }> = [];

    for (const item of items) {
        const hits = await searchInstamartCatalog(client, tools, addressId, item.name);
        const product = pickBestCatalogHit(hits, false);
        const spinId = product?.spinId ?? product?.productId;
        if (!spinId) {
            throw new Error(`Could not find "${item.name}" on Instamart.`);
        }
        cartItems.push({ spinId, quantity: item.quantity });
    }

    return cartItems;
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

    await McpOAuthSession.deleteMany({ partner, familyId, userId });
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
            $set: {
                tokensEnc: encryptJson(savedTokens),
                clientInfoEnc: savedClientInfo ? encryptJson(savedClientInfo) : undefined,
                connectedAt: new Date(),
            },
            $setOnInsert: {
                connectionId: randomUUID(),
            },
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

    const result = {
        partner: session.partner as McpPartnerKey,
        familyId: session.familyId,
        userId: session.userId,
        connected: true,
    };

    void import("../../services/partnerAddress.service").then(({ refreshPartnerAddressesInBackground }) =>
        refreshPartnerAddressesInBackground(result.partner, result.familyId, result.userId),
    );

    return result;
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
    opts?: { addressId?: string },
): Promise<McpSearchResult> {
    const config = getMcpPartner(partner);
    return withMcpClient(partner, familyId, userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const addressId = await resolveMcpAddressId(
            client,
            tools,
            familyId,
            partner,
            userId,
            opts?.addressId,
        );

        if ((partner === "swiggy" || partner === "instamart") && !addressId) {
            return {
                items: [],
                error: "no_address",
                addressId: undefined,
            };
        }

        if (partner === "swiggy") {
            const items = await searchSwiggyFoodCatalog(client, tools, addressId, query);
            return { items, addressId };
        }

        if (partner === "instamart") {
            const items = await searchInstamartCatalog(client, tools, addressId, query);
            return { items, addressId };
        }

        const searchTool = pickToolFromNeedles(tools, config.searchToolNeedles);
        if (!searchTool) return { items: [] };

        const result = await client.callTool({
            name: searchTool,
            arguments: { query, q: query, search_query: query, addressId },
        });

        const parsed = extractToolJson(result);
        const text = typeof parsed === "string" ? parsed : extractToolText(result);
        const instamartHits = hitsFromInstamartProducts(extractInstamartProducts(parsed));
        if (instamartHits.length) return { items: instamartHits };

        const menuHits = extractMenuSearchItems(parsed).map((dish) => ({
            kind: "dish" as const,
            name: dish.name,
            matchedName: dish.restaurantName ? `${dish.name} · ${dish.restaurantName}` : dish.name,
            itemId: dish.itemId,
            productId: dish.itemId,
            restaurantId: dish.restaurantId,
            restaurantName: dish.restaurantName,
            pricePaise: parsePricePaise(dish.price),
        }));
        if (menuHits.length) return { items: menuHits };

        return { items: parseSearchResults(text, query) };
    });
}

export async function getMcpRestaurantMenu(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
    restaurantId: string,
    opts?: { addressId?: string; query?: string },
): Promise<{ items: McpCatalogHit[] }> {
    if (partner !== "swiggy") return { items: [] };
    return withMcpClient(partner, familyId, userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const menuTool =
            tools.find((t) => t.name === "get_restaurant_menu")?.name ??
            pickToolName(tools, "restaurant", "menu");
        if (!menuTool) return { items: [] };

        const result = await client.callTool({
            name: menuTool,
            arguments: { restaurantId },
        });
        const menuItems = flattenMenuItems(extractToolJson(result));
        const query = opts?.query?.trim() ?? "";
        const filtered = query
            ? menuItems.filter(
                  (row) => fuzzyMatch(row.name, query) || fuzzyMatch(row.name, normalizeCatalogQuery(query)),
              )
            : menuItems;

        return {
            items: filtered.slice(0, 30).map((item) => ({
                kind: "dish" as const,
                name: item.name,
                itemId: item.id,
                productId: item.id,
                restaurantId,
                pricePaise: parsePricePaise(item.price),
            })),
        };
    });
}

export type ParsedPartnerAddress = {
    partnerAddressId: string;
    label?: string;
    line1: string;
    line2?: string;
    city?: string;
    pincode?: string;
};

export async function syncPartnerAddressesFromMcp(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
): Promise<ParsedPartnerAddress[]> {
    return withMcpClient(partner, familyId, userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const addressTool = tools.find((t) => /get_addresses|list_addresses|saved_addresses/i.test(t.name))?.name;
        if (!addressTool) {
            console.warn(`${partner} MCP: no get_addresses tool for family ${familyId}`);
            return [];
        }

        const collected = new Map<string, ParsedPartnerAddress>();
        let page = 1;
        const pageSize = 10;

        for (let guard = 0; guard < 20; guard += 1) {
            const result = await client.callTool({
                name: addressTool,
                arguments: { page, pageSize },
            });
            const parsed = unwrapMcpToolPayload(result);
            if (
                parsed &&
                typeof parsed === "object" &&
                (parsed as Record<string, unknown>).success === false
            ) {
                const err = (parsed as Record<string, unknown>).error;
                console.warn(`${partner} get_addresses failed for family ${familyId}:`, err);
                break;
            }

            const batch = parsePartnerAddresses(result);
            for (const row of batch) {
                if (!collected.has(row.partnerAddressId)) collected.set(row.partnerAddressId, row);
            }

            if (!batch.length && guard === 0) {
                for (const args of [{}, { limit: 20 }, { pageSize: 20 }]) {
                    const fallback = await client.callTool({ name: addressTool, arguments: args });
                    const parsedFallback = parsePartnerAddresses(fallback);
                    for (const row of parsedFallback) {
                        if (!collected.has(row.partnerAddressId)) collected.set(row.partnerAddressId, row);
                    }
                    if (parsedFallback.length) break;
                }
                if (!collected.size) {
                    const raw = extractToolText(
                        await client.callTool({ name: addressTool, arguments: { page: 1, pageSize: 10 } }),
                    );
                    console.warn(
                        `${partner} get_addresses unparsed sample for family ${familyId}:`,
                        raw.slice(0, 400),
                    );
                }
            }

            const pagination = extractAddressPagination(parsed ?? result);
            if (!pagination?.hasMore) break;
            if (pagination.totalPages != null && page >= pagination.totalPages) break;
            page += 1;
        }

        if (!collected.size) {
            console.warn(`${partner} get_addresses returned no parseable addresses for family ${familyId}`);
        }

        return [...collected.values()];
    });
}

export async function placeMcpOrder(input: {
    partner: McpPartnerKey;
    familyId: string;
    userId: string;
    items: Array<{ name: string; quantity: number }>;
    paymentMethod?: string;
    addressId?: string;
}): Promise<{
    partnerRef: string;
    deepLink?: string;
    paymentLink?: string;
    rawSummary: string;
}> {
    const config = getMcpPartner(input.partner);
    return withMcpClient(input.partner, input.familyId, input.userId, async (client) => {
        const tools = (await client.listTools()).tools;
        const paymentMethod = input.paymentMethod ?? "COD";
        const addressId = await resolveMcpAddressId(
            client,
            tools,
            input.familyId,
            input.partner,
            input.userId,
            input.addressId,
        );

        if (input.partner === "swiggy") {
            const { restaurantId, cartItems } = await resolveSwiggyCartItems(
                client,
                tools,
                addressId,
                input.items,
            );
            const updateCartTool =
                tools.find((t) => t.name === "update_food_cart")?.name ??
                pickToolFromNeedles(tools, config.addCartNeedles);
            const checkoutTool =
                tools.find((t) => t.name === "place_food_order")?.name ??
                pickToolFromNeedles(tools, config.checkoutToolNeedles);

            if (!updateCartTool || !checkoutTool) {
                throw new Error("Swiggy Food cart tools are unavailable on this connection.");
            }

            const cartArgs: Record<string, unknown> = { restaurantId, items: cartItems };
            if (addressId) cartArgs.addressId = addressId;

            const cartUpdate = await client.callTool({
                name: updateCartTool,
                arguments: cartArgs,
            });
            const checkoutArgs: Record<string, unknown> = { paymentMethod };
            if (addressId) checkoutArgs.addressId = addressId;

            const placed = await client.callTool({
                name: checkoutTool,
                arguments: checkoutArgs,
            });

            const rawSummary = `${extractToolText(cartUpdate)}\n${extractToolText(placed)}`;
            const parsed = parseToolJson(extractToolText(placed));
            const orderId =
                (parsed &&
                    typeof parsed === "object" &&
                    ((parsed as Record<string, unknown>).orderId ??
                        digData(parsed)?.orderId)) ||
                undefined;

            return {
                partnerRef: orderId ? String(orderId) : `swiggy-mcp-${Date.now()}`,
                deepLink: extractUrl(rawSummary) ?? config.deepLink,
                paymentLink: extractUrl(rawSummary),
                rawSummary,
            };
        }

        if (input.partner === "instamart") {
            const cartItems = await resolveInstamartCartItems(
                client,
                tools,
                addressId,
                input.items,
            );
            const updateCartTool =
                tools.find((t) => t.name === "update_cart")?.name ??
                pickToolFromNeedles(tools, config.addCartNeedles);
            const checkoutTool =
                tools.find((t) => t.name === "checkout")?.name ??
                pickToolFromNeedles(tools, config.checkoutToolNeedles);

            if (!updateCartTool || !checkoutTool) {
                throw new Error("Instamart cart tools are unavailable on this connection.");
            }

            const imCartArgs: Record<string, unknown> = { items: cartItems };
            if (addressId) imCartArgs.addressId = addressId;

            const cartUpdate = await client.callTool({
                name: updateCartTool,
                arguments: imCartArgs,
            });
            const imCheckoutArgs: Record<string, unknown> = { paymentMethod };
            if (addressId) imCheckoutArgs.addressId = addressId;

            const placed = await client.callTool({
                name: checkoutTool,
                arguments: imCheckoutArgs,
            });

            const rawSummary = `${extractToolText(cartUpdate)}\n${extractToolText(placed)}`;
            const parsed = parseToolJson(extractToolText(placed));
            const orderId =
                (parsed &&
                    typeof parsed === "object" &&
                    ((parsed as Record<string, unknown>).orderId ??
                        digData(parsed)?.orderId)) ||
                undefined;

            return {
                partnerRef: orderId ? String(orderId) : `instamart-mcp-${Date.now()}`,
                deepLink: extractUrl(rawSummary) ?? config.deepLink,
                paymentLink: extractUrl(rawSummary),
                rawSummary,
            };
        }

        const searchTool = pickToolFromNeedles(tools, config.searchToolNeedles);
        const addTool = pickToolFromNeedles(tools, config.addCartNeedles);
        const checkoutTool = pickToolFromNeedles(tools, config.checkoutToolNeedles);
        const summaries: string[] = [];

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

function looksLikeOpaqueBlob(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 96) return false;
    const compact = trimmed.replace(/\s+/g, "");
    if (/^[\d+/=A-Za-z_-]+$/.test(compact) && compact.length > 96) return true;
    if (/^(CqMF|eyJ)[A-Za-z0-9+/=_-]{80,}/.test(compact)) return true;
    return false;
}

function extractTextBlocks(result: unknown): string[] {
    if (!result || typeof result !== "object") return [];
    const obj = result as {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
    };
    const blocks: string[] = [];

    if (typeof obj.structuredContent === "string" && obj.structuredContent.trim()) {
        blocks.push(obj.structuredContent.trim());
    }

    if (Array.isArray(obj.content)) {
        for (const block of obj.content) {
            if (block?.type === "text" && block.text?.trim()) {
                blocks.push(block.text.trim());
            }
        }
    }

    return blocks;
}

function extractToolText(result: unknown): string {
    if (typeof result === "string") return result;
    if (!result || typeof result !== "object") return String(result ?? "");
    const obj = result as {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
    };
    if (obj.structuredContent != null && typeof obj.structuredContent === "object") {
        try {
            return JSON.stringify(obj.structuredContent);
        } catch {
            // fall through to content blocks
        }
    }
    const blocks = extractTextBlocks(result).filter((text) => !looksLikeOpaqueBlob(text));
    if (blocks.length) return blocks.join("\n");
    return JSON.stringify(result);
}

function unwrapMcpToolPayload(result: unknown): unknown {
    if (result == null) return null;
    if (typeof result === "string") return parseToolJson(result);

    if (Array.isArray(result)) {
        const asBlocks = result.every(
            (row) => row && typeof row === "object" && "type" in (row as object),
        );
        if (asBlocks) return unwrapMcpToolPayload({ content: result });
    }

    if (typeof result !== "object") return null;
    const obj = result as Record<string, unknown>;

    if (obj.structuredContent != null) {
        if (typeof obj.structuredContent === "string") {
            const parsed = parseToolJson(obj.structuredContent);
            if (parsed != null) return parsed;
        } else if (Array.isArray(obj.structuredContent)) {
            const nested = unwrapMcpToolPayload({ content: obj.structuredContent });
            if (nested != null) return nested;
        } else if (typeof obj.structuredContent === "object") {
            return obj.structuredContent;
        }
    }

    for (const text of extractTextBlocks(result)) {
        if (looksLikeOpaqueBlob(text)) continue;
        const parsed = parseToolJson(text);
        if (parsed != null) return parsed;
    }

    if (obj.success != null || obj.data != null || obj.addresses != null) {
        return obj;
    }

    return null;
}

function extractToolJson(result: unknown): unknown {
    const payload = unwrapMcpToolPayload(result);
    if (payload != null) return payload;

    if (typeof result === "string") return parseToolJson(result);

    const text = extractToolText(result);
    if (!text.trim()) return null;
    return parseToolJson(text);
}

function extractUrl(text: string): string | undefined {
    const match = text.match(/https?:\/\/[^\s)]+/i);
    return match?.[0];
}

function extractFirstId(text: string): string | undefined {
    const match =
        text.match(/"id"\s*:\s*"([^"]+)"/i) ??
        text.match(/"addressId"\s*:\s*"([^"]+)"/i) ??
        text.match(/addr_[A-Za-z0-9]+/);
    return match?.[1] ?? match?.[0];
}

function extractAddressPagination(parsed: unknown): {
    page?: number;
    totalPages?: number;
    hasMore?: boolean;
} | null {
    if (!parsed || typeof parsed !== "object") return null;
    const root = parsed as Record<string, unknown>;
    const data = digData(parsed);
    const pagination =
        (data?.pagination as Record<string, unknown> | undefined) ??
        (root.pagination as Record<string, unknown> | undefined);
    if (!pagination || typeof pagination !== "object") return null;
    return {
        page: typeof pagination.page === "number" ? pagination.page : undefined,
        totalPages:
            typeof pagination.totalPages === "number" ? pagination.totalPages : undefined,
        hasMore: typeof pagination.hasMore === "boolean" ? pagination.hasMore : undefined,
    };
}

function extractAddressList(parsed: unknown): unknown[] {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== "object") return [];
    const root = parsed as Record<string, unknown>;
    if (Array.isArray(root.addresses)) return root.addresses;
    // Swiggy recipe: callTool result is { data: Address[] } (data is the array itself).
    if (Array.isArray(root.data)) return root.data;
    const data = digData(parsed);
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.addresses)) return data.addresses;
    if (Array.isArray(data.results)) return data.results;
    if (Array.isArray(data.savedAddresses)) return data.savedAddresses;
    return [];
}

function parsePartnerAddresses(input: unknown): ParsedPartnerAddress[] {
    const payload = unwrapMcpToolPayload(input);
    const fromJson = extractAddressList(payload ?? input);
    if (fromJson.length) {
        return fromJson
            .map((row) => normalizeAddressRow(row))
            .filter((row): row is ParsedPartnerAddress => Boolean(row));
    }

    const text = typeof input === "string" ? input : extractToolText(input);
    if (!text.trim()) return [];

    try {
        const json = parseToolJson(text);
        const list = extractAddressList(json);
        if (list.length) {
            return list
                .map((row) => normalizeAddressRow(row))
                .filter((row): row is ParsedPartnerAddress => Boolean(row));
        }
    } catch {
        // fall through to regex parsing
    }

    const blocks = text.split(/\n(?=\d+\.|\*|-)/).filter(Boolean);
    const parsed: ParsedPartnerAddress[] = [];
    for (const block of blocks) {
        const id = extractFirstId(block);
        const line = block.replace(/\s+/g, " ").trim();
        if (!id || line.length < 8) continue;
        parsed.push({
            partnerAddressId: id,
            label: line.slice(0, 80),
            line1: line.slice(0, 300),
        });
    }

    if (!parsed.length) {
        const id = extractFirstId(text);
        if (id) {
            parsed.push({
                partnerAddressId: id,
                line1: text.replace(/\s+/g, " ").trim().slice(0, 300),
            });
        }
    }

    return parsed;
}

function normalizeAddressRow(row: unknown): ParsedPartnerAddress | null {
    if (!row || typeof row !== "object") return null;
    let obj = row as Record<string, unknown>;
    if (obj.address && typeof obj.address === "object") {
        obj = { ...(obj.address as Record<string, unknown>), ...obj };
    }
    const partnerAddressId = String(
        obj.id ??
            obj.addressId ??
            obj.address_id ??
            obj.partnerAddressId ??
            obj.savedAddressId ??
            "",
    ).trim();
    if (!partnerAddressId) return null;

    const line1 = String(
        obj.line1 ??
            obj.addressLine ??
            obj.addressLine1 ??
            obj.displayText ??
            obj.address ??
            obj.formattedAddress ??
            obj.fullAddress ??
            obj.label ??
            "Saved address",
    ).trim();

    return {
        partnerAddressId,
        label: obj.label
            ? String(obj.label)
            : obj.addressTag
              ? String(obj.addressTag)
              : obj.addressCategory
                ? String(obj.addressCategory)
                : obj.name
                  ? String(obj.name)
                  : undefined,
        line1,
        line2: obj.line2 ? String(obj.line2) : obj.addressLine2 ? String(obj.addressLine2) : undefined,
        city: obj.city ? String(obj.city) : undefined,
        pincode: obj.pincode ? String(obj.pincode) : obj.postalCode ? String(obj.postalCode) : undefined,
    };
}

function parseSearchResults(text: string, fallbackName: string): McpCatalogHit[] {
    const parsed = parseToolJson(text);
    if (parsed) {
        const instamartHits = hitsFromInstamartProducts(extractInstamartProducts(parsed));
        if (instamartHits.length) return instamartHits;

        const restaurants = extractRestaurants(parsed);
        if (restaurants.length) {
            return restaurants.slice(0, 8).map((restaurant) => ({
                kind: "restaurant" as const,
                name: String(restaurant.name ?? fallbackName),
                restaurantId: restaurant.id ? String(restaurant.id) : undefined,
                restaurantName: restaurant.name ? String(restaurant.name) : undefined,
                costForTwoPaise: parsePricePaise(restaurant.costForTwo ?? restaurant.avgCostForTwo),
                productId: restaurant.id ? String(restaurant.id) : undefined,
            }));
        }

        const menuHits = extractMenuSearchItems(parsed);
        if (menuHits.length) {
            return menuHits.slice(0, 8).map((dish) => ({
                kind: "dish" as const,
                name: dish.name,
                matchedName: dish.restaurantName ? `${dish.name} · ${dish.restaurantName}` : dish.name,
                itemId: dish.itemId,
                productId: dish.itemId,
                restaurantId: dish.restaurantId,
                restaurantName: dish.restaurantName,
                pricePaise: parsePricePaise(dish.price),
            }));
        }
    }

    if (!text.trim()) return [];

    const hits: McpCatalogHit[] = [];
    const pricePattern = /₹\s*([\d,]+(?:\.\d+)?)/g;
    const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines.slice(0, 8)) {
        const priceMatch = line.match(/₹\s*([\d,]+(?:\.\d+)?)/);
        const name = line
            .replace(/₹\s*[\d,]+(?:\.\d+)?/g, "")
            .replace(/^[\d.)]+\s*/, "")
            .trim();
        if (!name || name.length < 2) continue;
        hits.push({
            name,
            pricePaise: priceMatch ? parsePricePaise(priceMatch[0]) : undefined,
        });
    }

    if (hits.length) return hits;

    const priceMatch = text.match(pricePattern);
    return priceMatch
        ? [
              {
                  name: fallbackName,
                  pricePaise: parsePricePaise(priceMatch[0]),
              },
          ]
        : [];
}
