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
    productId?: string;
    itemId?: string;
    spinId?: string;
    restaurantId?: string;
    restaurantName?: string;
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
    const addresses = parsePartnerAddresses(extractToolText(result));
    return addresses[0]?.partnerAddressId;
}

async function searchSwiggyFoodCatalog(
    client: Client,
    tools: McpTool[],
    addressId: string | undefined,
    query: string,
): Promise<McpCatalogHit[]> {
    if (!addressId) return [];

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
            arguments: { addressId, query },
        });
        const restaurants = extractRestaurants(parseToolJson(extractToolText(result)));
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
                pricePaise: parsePricePaise(restaurant.costForTwo ?? restaurant.avgCostForTwo),
                productId: restaurant.id ? String(restaurant.id) : undefined,
            });
        }
    }

    if (searchMenuTool) {
        const result = await client.callTool({
            name: searchMenuTool,
            arguments: { addressId, query },
        });
        for (const dish of extractMenuSearchItems(parseToolJson(extractToolText(result))).slice(0, 8)) {
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
        const menuItems = flattenMenuItems(parseToolJson(extractToolText(result)));
        for (const item of menuItems.filter((row) => fuzzyMatch(row.name, query)).slice(0, 6)) {
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
    return hitsFromInstamartProducts(extractInstamartProducts(parseToolJson(extractToolText(result))));
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
): Promise<{ items: McpCatalogHit[] }> {
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

        if (partner === "swiggy") {
            const items = await searchSwiggyFoodCatalog(client, tools, addressId, query);
            return { items: items.length ? items : parseSearchResults("", query) };
        }

        if (partner === "instamart") {
            const items = await searchInstamartCatalog(client, tools, addressId, query);
            return { items: items.length ? items : parseSearchResults("", query) };
        }

        const searchTool = pickToolFromNeedles(tools, config.searchToolNeedles);
        if (!searchTool) return { items: [] };

        const result = await client.callTool({
            name: searchTool,
            arguments: { query, q: query, search_query: query, addressId },
        });

        const text = extractToolText(result);
        const parsed = parseToolJson(text);
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
        if (!addressTool) return [];

        const result = await client.callTool({ name: addressTool, arguments: {} });
        return parsePartnerAddresses(extractToolText(result));
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

            const cartUpdate = await client.callTool({
                name: updateCartTool,
                arguments: { restaurantId, items: cartItems },
            });
            const placed = await client.callTool({
                name: checkoutTool,
                arguments: { paymentMethod },
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

            const cartUpdate = await client.callTool({
                name: updateCartTool,
                arguments: { items: cartItems },
            });
            const placed = await client.callTool({
                name: checkoutTool,
                arguments: { paymentMethod },
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

function parsePartnerAddresses(text: string): ParsedPartnerAddress[] {
    if (!text.trim()) return [];

    try {
        const json = JSON.parse(text) as unknown;
        if (Array.isArray(json)) {
            return json
                .map((row) => normalizeAddressRow(row))
                .filter((row): row is ParsedPartnerAddress => Boolean(row));
        }
        if (json && typeof json === "object") {
            const obj = json as { addresses?: unknown[]; data?: unknown[] };
            const list = obj.addresses ?? obj.data ?? [];
            if (Array.isArray(list)) {
                return list
                    .map((row) => normalizeAddressRow(row))
                    .filter((row): row is ParsedPartnerAddress => Boolean(row));
            }
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
    const obj = row as Record<string, unknown>;
    const partnerAddressId = String(
        obj.id ?? obj.addressId ?? obj.address_id ?? obj.partnerAddressId ?? "",
    ).trim();
    if (!partnerAddressId) return null;

    const line1 = String(
        obj.line1 ??
            obj.addressLine1 ??
            obj.address ??
            obj.formattedAddress ??
            obj.fullAddress ??
            obj.label ??
            "Saved address",
    ).trim();

    return {
        partnerAddressId,
        label: obj.label ? String(obj.label) : obj.name ? String(obj.name) : undefined,
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
                pricePaise: parsePricePaise(restaurant.costForTwo ?? restaurant.avgCostForTwo),
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
