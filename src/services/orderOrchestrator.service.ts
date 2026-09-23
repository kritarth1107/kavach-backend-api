import { randomUUID } from "crypto";
import { AppError } from "../middleware/error.middleware";
import OrderSession, {
    type IOrderSessionDocument,
    type OrderSessionAddress,
    type OrderSessionCartItem,
    type OrderSessionCatalogItem,
    type OrderSessionPhase,
} from "../models/orderSession.model";
import {
    getMcpRestaurantMenu,
    searchMcpProduct,
    startMcpConnect,
    type McpCatalogHit,
} from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { OrderPartner } from "../types/careRecord.types";
import { listFamilyConnectedPartners, resolveFamilyMcpUserId } from "./commerceConnection.service";
import {
    getFamilyForActor,
    getMemberRole,
    requireCareRecipient,
} from "./careRecordAuth.service";
import { approveOrder, suggestOrder } from "./order.service";
import {
    getPartnerOrderSettings,
    orderRequiresCaregiverApproval,
} from "./commerceSettings.service";
import {
    ensurePartnerAddressesSynced,
    listPartnerAddresses,
} from "./partnerAddress.service";
import { rankCatalogHits } from "./catalogResolver.service";
import {
    extractOrderQuery,
    isHighConfidenceOrderIntent,
    messageLooksLikeOrder,
    normalizeOrderText,
    partnerLabel,
    pickOrderPartner,
} from "./saheliOrder.service";
import { createFamilyNotification } from "./notification.service";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type OrderFlowPayload = {
    sessionId: string;
    phase: OrderSessionPhase;
    partner: McpPartnerKey;
    partnerLabel: string;
    query: string;
    connectPartner?: McpPartnerKey;
    connectUrl?: string | null;
    selectedAddressId?: string;
    addresses?: OrderSessionAddress[];
    catalog?: {
        restaurants: OrderSessionCatalogItem[];
        dishes: OrderSessionCatalogItem[];
        products?: OrderSessionCatalogItem[];
    };
    cartItems?: OrderSessionCartItem[];
    orderId?: string;
    message?: string;
    disambiguation?: {
        query: string;
        candidates: Array<
            OrderSessionCatalogItem & { candidateId?: string; confidence?: number }
        >;
    };
};

function orderPartnerToMcp(partner: OrderPartner): McpPartnerKey | null {
    if (partner === OrderPartner.SWIGGY) return "swiggy";
    if (partner === OrderPartner.INSTAMART) return "instamart";
    if (partner === OrderPartner.ZEPTO) return "zepto";
    return null;
}

function mcpToOrderPartner(partner: McpPartnerKey): OrderPartner {
    if (partner === "swiggy") return OrderPartner.SWIGGY;
    if (partner === "instamart") return OrderPartner.INSTAMART;
    return OrderPartner.ZEPTO;
}

function hitToCatalogItem(hit: McpCatalogHit): OrderSessionCatalogItem {
    return {
        id: hit.restaurantId ?? hit.itemId ?? hit.productId ?? hit.spinId,
        itemId: hit.itemId ?? hit.productId,
        name: hit.matchedName ?? hit.name,
        pricePaise: hit.pricePaise,
        kind: hit.kind ?? "dish",
        restaurantId: hit.restaurantId,
        restaurantName: hit.restaurantName,
    };
}

function catalogBrowseHint(partner: McpPartnerKey, query: string): string {
    if (partner === "instamart") {
        return `products and groceries for "${query}"`;
    }
    return `restaurants and dishes for "${query}"`;
}

function splitCatalogHits(hits: McpCatalogHit[]) {
    const restaurants: OrderSessionCatalogItem[] = [];
    const dishes: OrderSessionCatalogItem[] = [];
    const products: OrderSessionCatalogItem[] = [];
    for (const hit of hits) {
        const row = hitToCatalogItem(hit);
        if (hit.kind === "restaurant") {
            row.pricePaise = hit.costForTwoPaise;
            restaurants.push(row);
        } else if (hit.kind === "product") {
            products.push(row);
        } else {
            dishes.push(row);
        }
    }
    return { restaurants, dishes, products };
}

async function loadAddresses(
    familyId: string,
    partner: McpPartnerKey,
    commerceUserId: string,
): Promise<OrderSessionAddress[]> {
    await ensurePartnerAddressesSynced(partner, familyId, commerceUserId);
    const rows = await listPartnerAddresses(familyId, partner, commerceUserId);
    return rows.map((row) => ({
        id: row.partner_address_id,
        label: row.label || "Saved address",
        line1: row.line1,
        city: row.city || undefined,
        pincode: row.pincode || undefined,
        isDefault: row.is_default,
    }));
}

function flowFromSession(session: IOrderSessionDocument, message?: string): OrderFlowPayload {
    return {
        sessionId: session.sessionId,
        phase: session.phase,
        partner: session.partner,
        partnerLabel: partnerLabel(mcpToOrderPartner(session.partner)),
        query: session.query,
        selectedAddressId: session.selectedAddressId,
        addresses: session.addresses,
        catalog: session.catalog,
        cartItems: session.cartItems,
        orderId: session.orderId,
        message,
        disambiguation: session.pendingDisambiguation
            ? {
                  query: session.pendingDisambiguation.query,
                  candidates: session.pendingDisambiguation.candidates,
              }
            : undefined,
    };
}

async function getActiveSession(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    saheliSessionId?: string,
): Promise<IOrderSessionDocument | null> {
    const filter: Record<string, unknown> = {
        familyId,
        recipientUserId,
        actorUserId,
        phase: { $in: ["select_address", "browse", "review_cart"] },
        expiresAt: { $gt: new Date() },
    };
    if (saheliSessionId) filter.saheliSessionId = saheliSessionId;

    return OrderSession.findOne(filter).sort({ updatedAt: -1 });
}

async function loadSessionForActor(
    sessionId: string,
    familyId: string,
    actorUserId: string,
): Promise<IOrderSessionDocument> {
    const family = await getFamilyForActor(familyId, actorUserId);
    const session = await OrderSession.findOne({ sessionId, familyId });
    if (!session) throw new AppError("Order session not found", 404);
    if (session.expiresAt < new Date()) {
        session.phase = "expired";
        await session.save();
        throw new AppError("Order session expired — start a new order", 410);
    }
    requireCareRecipient(family, session.recipientUserId);
    return session;
}

async function searchCatalogForSession(
    session: IOrderSessionDocument,
    query?: string,
): Promise<IOrderSessionDocument> {
    if (!session.selectedAddressId) {
        throw new AppError("Select a delivery address first", 400);
    }
    const commerceUserId =
        (await resolveFamilyMcpUserId(session.familyId, session.partner, session.actorUserId)) ??
        session.actorUserId;
    const searchQuery = (query ?? session.query).trim();
    if (query) session.query = searchQuery.slice(0, 200);

    const { items } = await searchMcpProduct(
        session.partner,
        session.familyId,
        commerceUserId,
        searchQuery,
        { addressId: session.selectedAddressId },
    );
    const ranked = rankCatalogHits(searchQuery, items, session.partner, 20);
    const rankedHits = ranked
        .map((c) =>
            items.find(
                (h) =>
                    (h.itemId && h.itemId === c.itemId) ||
                    (h.spinId && h.spinId === c.spinId) ||
                    (h.productId && h.productId === c.productId) ||
                    (h.restaurantId && h.restaurantId === c.restaurantId) ||
                    (h.matchedName ?? h.name) === c.name,
            ),
        )
        .filter(Boolean) as McpCatalogHit[];
    session.catalog = splitCatalogHits(rankedHits.length ? rankedHits : items);
    session.lastCatalogQuery = searchQuery;
    session.lastCatalogHits = items;
    session.phase = "browse";
    session.pendingDisambiguation = undefined;
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await session.save();
    return session;
}

function parseAddressLabelFromMessage(message: string): string | null {
    const match =
        message.match(/\b(?:to|at|for)\s+(home|office|work|other)\b/i) ??
        message.match(/\buse\s+(home|office|work)\b/i);
    return match?.[1]?.toLowerCase() ?? null;
}

function matchAddressByLabel(
    addresses: OrderSessionAddress[],
    label: string,
): OrderSessionAddress | undefined {
    const normalized = label.toLowerCase();
    return addresses.find((a) => a.label.toLowerCase().includes(normalized));
}

export async function startOrderFlow(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    saheliSessionId?: string;
    /** Set when the AI agent already decided this is an order request. */
    aiInitiated?: boolean;
}): Promise<OrderFlowPayload | null> {
    const orderMessage = normalizeOrderText(input.message);
    if (!input.aiInitiated && !isHighConfidenceOrderIntent(orderMessage)) return null;

    const family = await getFamilyForActor(input.familyId, input.actorUserId);
    requireCareRecipient(family, input.recipientUserId);

    const partner = await pickOrderPartner(orderMessage, input.familyId, input.actorUserId);
    const mcpPartner = orderPartnerToMcp(partner);
    if (!mcpPartner) return null;

    const connected = await listFamilyConnectedPartners(input.familyId, input.actorUserId);
    const isConnected =
        (partner === OrderPartner.SWIGGY && connected.swiggy) ||
        (partner === OrderPartner.INSTAMART && connected.instamart) ||
        (partner === OrderPartner.ZEPTO && connected.zepto);

    if (!isConnected) {
        const { buildOrderCommunicationReply } = await import("./orderPartnerAvailability.service");
        const comms = await buildOrderCommunicationReply({
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            message: orderMessage,
        });
        const started = await startMcpConnect(mcpPartner, input.familyId, input.actorUserId);
        const altHint =
            comms ??
            `${partnerLabel(partner)} isn't connected yet — ask your caregiver to connect it in Integrations.`;
        return {
            sessionId: "",
            phase: "select_address",
            partner: mcpPartner,
            partnerLabel: partnerLabel(partner),
            query: extractOrderQuery(orderMessage),
            connectPartner: mcpPartner,
            connectUrl: started.authorizationUrl ?? null,
            message: `${altHint}${started.authorizationUrl ? " Connect card below." : ""}`.trim(),
        };
    }

    if (mcpPartner === "swiggy") {
        const { getOrderPartnerAvailability } = await import("./orderPartnerAvailability.service");
        const availability = await getOrderPartnerAvailability(input.familyId, input.actorUserId);
        const swiggy = availability.find((r) => r.partner === "swiggy");
        if (swiggy?.connected && !swiggy.serviceable && swiggy.reason === "closed_or_unavailable") {
            const { buildOrderCommunicationReply } = await import("./orderPartnerAvailability.service");
            const comms =
                (await buildOrderCommunicationReply({
                    familyId: input.familyId,
                    actorUserId: input.actorUserId,
                    message: orderMessage,
                })) ??
                "Swiggy isn't taking orders at your saved address right now — restaurants look closed for the day.";
            return {
                sessionId: "",
                phase: "select_address",
                partner: mcpPartner,
                partnerLabel: partnerLabel(partner),
                query: extractOrderQuery(orderMessage),
                message: comms,
            };
        }
    }

    const commerceUserId =
        (await resolveFamilyMcpUserId(input.familyId, mcpPartner, input.actorUserId)) ??
        input.actorUserId;
    const addresses = await loadAddresses(input.familyId, mcpPartner, commerceUserId);
    const query = extractOrderQuery(orderMessage);
    const label = partnerLabel(partner);

    if (!addresses.length) {
        return {
            sessionId: "",
            phase: "select_address",
            partner: mcpPartner,
            partnerLabel: label,
            query,
            addresses: [],
            message: `Your ${label} account is connected but I couldn't find saved delivery addresses. Add one in the Swiggy app, then try again.`,
        };
    }

    await OrderSession.updateMany(
        {
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            phase: { $in: ["select_address", "browse", "review_cart"] },
        },
        { $set: { phase: "expired" } },
    );

    const session = await OrderSession.create({
        sessionId: randomUUID(),
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        partner: mcpPartner,
        phase: "select_address",
        query,
        addresses,
        catalog: { restaurants: [], dishes: [], products: [] },
        cartItems: [],
        saheliSessionId: input.saheliSessionId,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });

    const addressHint = parseAddressLabelFromMessage(orderMessage);
    if (addressHint) {
        const matched = matchAddressByLabel(addresses, addressHint);
        if (matched) {
            session.selectedAddressId = matched.id;
            await session.save();
            await searchCatalogForSession(session);
            return flowFromSession(
                session,
                `Using ${matched.label}. Here are ${label} options for "${query}". Pick an item below.`,
            );
        }
    }

    if (addresses.length === 1) {
        session.selectedAddressId = addresses[0].id;
        await session.save();
        await searchCatalogForSession(session);
        return flowFromSession(
            session,
            `Delivering to ${addresses[0].label}. Browse ${label} options for "${query}" below.`,
        );
    }

    return flowFromSession(
        session,
        `Found ${addresses.length} saved ${label} addresses. Pick a delivery address first — then I'll show ${catalogBrowseHint(mcpPartner, query)}.`,
    );
}

export async function selectOrderFlowAddress(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    addressId: string;
}): Promise<OrderFlowPayload> {
    const session = await loadSessionForActor(input.sessionId, input.familyId, input.actorUserId);
    const address = session.addresses.find((a) => a.id === input.addressId);
    if (!address) throw new AppError("Address not found in this session", 400);

    session.selectedAddressId = input.addressId;
    await session.save();

    const label = partnerLabel(mcpToOrderPartner(session.partner));
    try {
        await searchCatalogForSession(session);
        return flowFromSession(
            session,
            `Delivery to ${address.label}. Browse ${label} options for "${session.query}" below.`,
        );
    } catch (err) {
        console.warn("Catalog search after address select failed:", err);
        session.phase = "browse";
        session.catalog = session.catalog ?? { restaurants: [], dishes: [], products: [] };
        session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await session.save();
        const hint =
            err instanceof AppError
                ? err.message
                : "Partner search is slow right now.";
        return flowFromSession(
            session,
            `Delivery to ${address.label}. I couldn't load ${label} results for "${session.query}" yet (${hint}). Reply *retry* to search again.`,
        );
    }
}

export async function searchOrderFlowCatalog(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    query?: string;
}): Promise<OrderFlowPayload> {
    const session = await loadSessionForActor(input.sessionId, input.familyId, input.actorUserId);
    await searchCatalogForSession(session, input.query);
    return flowFromSession(session, `Updated results for "${session.query}".`);
}

export async function loadOrderFlowRestaurantMenu(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    restaurantId: string;
}): Promise<OrderFlowPayload> {
    const session = await loadSessionForActor(input.sessionId, input.familyId, input.actorUserId);
    if (!session.selectedAddressId) throw new AppError("Select a delivery address first", 400);

    const commerceUserId =
        (await resolveFamilyMcpUserId(session.familyId, session.partner, session.actorUserId)) ??
        session.actorUserId;

    const { items } = await getMcpRestaurantMenu(
        session.partner,
        session.familyId,
        commerceUserId,
        input.restaurantId,
        { addressId: session.selectedAddressId, query: session.query },
    );

    const restaurantName =
        session.catalog.restaurants.find((r) => r.restaurantId === input.restaurantId || r.id === input.restaurantId)
            ?.name ?? "Restaurant";

    session.catalog.dishes = items.map((hit) => ({
        ...hitToCatalogItem(hit),
        restaurantId: input.restaurantId,
        restaurantName,
    }));
    session.phase = "browse";
    await session.save();

    return flowFromSession(session, `Menu from ${restaurantName} — tap a dish to add.`);
}

export async function addOrderFlowCartItem(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    item: {
        itemId?: string;
        name: string;
        quantity?: number;
        pricePaise?: number;
        restaurantId?: string;
        restaurantName?: string;
    };
}): Promise<OrderFlowPayload> {
    const session = await loadSessionForActor(input.sessionId, input.familyId, input.actorUserId);
    const qty = Math.min(Math.max(input.item.quantity ?? 1, 1), 20);
    if (!input.item.pricePaise || input.item.pricePaise <= 0) {
        throw new AppError("Live price required — pick an item from catalog search results.", 400);
    }
    const price = input.item.pricePaise;

    const existing = session.cartItems.find(
        (row) =>
            (input.item.itemId && row.itemId === input.item.itemId) ||
            row.name.toLowerCase() === input.item.name.toLowerCase(),
    );

    if (
        session.partner === "swiggy" &&
        input.item.restaurantId &&
        session.cartItems.length > 0
    ) {
        const cartRestaurant = session.cartItems.find((row) => row.restaurantId)?.restaurantId;
        if (cartRestaurant && cartRestaurant !== input.item.restaurantId) {
            throw new AppError(
                `"${input.item.name}" is from a different restaurant. Swiggy orders must be from one restaurant — start a new order or pick dishes from the same place.`,
                400,
            );
        }
    }

    if (existing) {
        existing.quantity = Math.min(existing.quantity + qty, 20);
    } else {
        session.cartItems.push({
            itemId: input.item.itemId,
            name: input.item.name,
            quantity: qty,
            pricePaise: price,
            restaurantId: input.item.restaurantId,
            restaurantName: input.item.restaurantName,
        });
    }

    session.pendingDisambiguation = undefined;
    session.phase = "review_cart";
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await session.save();

    return flowFromSession(
        session,
        `Added ${input.item.name} ×${qty}. Review your basket or add more items.`,
    );
}

export async function updateOrderFlowCartItem(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    itemIndex: number;
    quantity: number;
}): Promise<OrderFlowPayload> {
    const session = await loadSessionForActor(input.sessionId, input.familyId, input.actorUserId);
    const row = session.cartItems[input.itemIndex];
    if (!row) throw new AppError("Cart item not found", 404);

    if (input.quantity <= 0) {
        session.cartItems.splice(input.itemIndex, 1);
    } else {
        row.quantity = Math.min(input.quantity, 20);
    }

    session.phase = session.cartItems.length ? "review_cart" : "browse";
    await session.save();
    return flowFromSession(session);
}

export async function submitOrderFlowCart(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
}): Promise<{ flow: OrderFlowPayload; order: Record<string, unknown> }> {
    const session = await loadSessionForActor(input.sessionId, input.familyId, input.actorUserId);
    if (!session.cartItems.length) throw new AppError("Cart is empty", 400);

    const selected = session.addresses.find((a) => a.id === session.selectedAddressId);
    const commerceUserId =
        (await resolveFamilyMcpUserId(session.familyId, session.partner, session.actorUserId)) ??
        session.actorUserId;

    const orderPartner = mcpToOrderPartner(session.partner);
    const family = await getFamilyForActor(session.familyId, session.actorUserId);
    const actorRole = getMemberRole(family, session.actorUserId);

    let order = await suggestOrder({
        familyId: session.familyId,
        subjectUserId: session.recipientUserId,
        actorUserId: session.actorUserId,
        commerceUserId,
        partner: orderPartner,
        items: session.cartItems.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            unitPricePaise: item.pricePaise,
        })),
        deliveryAddress: selected
            ? [selected.label, selected.line1, selected.city, selected.pincode].filter(Boolean).join(" · ")
            : undefined,
        notes: session.query,
    });

    const partnerSettings = await getPartnerOrderSettings(session.familyId, session.partner);
    const needsApproval = orderRequiresCaregiverApproval({
        actorRole,
        totalPaise: order.totalPaise,
        settings: partnerSettings,
    });

    if (!needsApproval) {
        order = await approveOrder(session.familyId, order.orderId, session.actorUserId);
    } else {
        void createFamilyNotification(session.familyId, {
            kind: "order_pending",
            title: "Order awaiting approval",
            body: `${partnerLabel(orderPartner)} basket ₹${(order.totalPaise / 100).toFixed(0)} needs family approval.`,
            actionUrl: "/dashboard/approvals",
            recipientUserId: session.recipientUserId,
            dedupeKey: `order:${order.orderId}`,
        });
    }

    if (selected?.id) {
        order.partnerAddressId = selected.id;
        await order.save();
    }

    session.phase = "submitted";
    session.orderId = order.orderId;
    await session.save();

    const searchResults = [
        ...session.catalog.restaurants.map((r) => ({
            query: session.query,
            name: r.name,
            pricePaise: r.pricePaise,
            kind: r.kind,
            restaurantName: r.restaurantName,
            restaurantId: r.restaurantId ?? r.id,
        })),
        ...session.catalog.dishes.map((d) => ({
            query: session.query,
            name: d.name,
            pricePaise: d.pricePaise,
            kind: d.kind,
            restaurantName: d.restaurantName,
            restaurantId: d.restaurantId,
        })),
        ...(session.catalog.products ?? []).map((p) => ({
            query: session.query,
            name: p.name,
            pricePaise: p.pricePaise,
            kind: p.kind ?? "product",
            restaurantName: p.restaurantName,
            restaurantId: p.restaurantId,
        })),
    ];

    const orderPayload: Record<string, unknown> = {
        orderId: order.orderId,
        partner: orderPartner,
        partnerLabel: partnerLabel(orderPartner),
        totalPaise: order.totalPaise,
        items: order.items.map((item, idx) => ({
            name: item.name,
            quantity: item.quantity,
            unitPricePaise: item.unitPricePaise,
            matchedName: session.cartItems[idx]?.restaurantName
                ? `${item.name} · ${session.cartItems[idx]?.restaurantName}`
                : undefined,
        })),
        status: String(order.status),
        source: `${session.partner}_mcp`,
        searchResults,
        addresses: session.addresses,
    };

    const flow = flowFromSession(
        session,
        !needsApproval
            ? `Basket ready — ₹${(order.totalPaise / 100).toFixed(0)} total. Place COD when you're ready.`
            : `Basket ready — ₹${(order.totalPaise / 100).toFixed(0)} total. Family approval required before checkout.`,
    );

    return { flow, order: orderPayload };
}

export async function getOrderFlowSession(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
}): Promise<OrderFlowPayload> {
    const session = await loadSessionForActor(input.sessionId, input.familyId, input.actorUserId);
    return flowFromSession(session);
}

export async function resumeActiveOrderFlow(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    saheliSessionId?: string;
}): Promise<OrderFlowPayload | null> {
    const session = await getActiveSession(
        input.familyId,
        input.recipientUserId,
        input.actorUserId,
        input.saheliSessionId,
    );
    if (!session) return null;
    return flowFromSession(session);
}

export async function handleOrderFlowChatMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    saheliSessionId?: string;
}): Promise<OrderFlowPayload | null> {
    const active = await getActiveSession(
        input.familyId,
        input.recipientUserId,
        input.actorUserId,
        input.saheliSessionId,
    );
    if (!active) return startOrderFlow(input);

    const text = input.message.trim().toLowerCase();

    if (/\b(change address|pick address|other address|different address)\b/i.test(text)) {
        active.phase = "select_address";
        active.selectedAddressId = undefined;
        active.catalog = { restaurants: [], dishes: [], products: [] };
        await active.save();
        return flowFromSession(active, "Pick a delivery address to continue.");
    }

    const addressHint = parseAddressLabelFromMessage(input.message);
    if (addressHint && active.phase === "select_address") {
        const matched = matchAddressByLabel(active.addresses, addressHint);
        if (matched) {
            return selectOrderFlowAddress({
                sessionId: active.sessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                addressId: matched.id,
            });
        }
    }

    if (/\b(show|search|find|instead)\b/i.test(text) && active.selectedAddressId) {
        const query = extractOrderQuery(input.message);
        if (query.length >= 3) {
            return searchOrderFlowCatalog({
                sessionId: active.sessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                query,
            });
        }
    }

    if (/\b(confirm|submit|place|checkout|ready)\b/i.test(text) && active.cartItems.length) {
        const { flow } = await submitOrderFlowCart({
            sessionId: active.sessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
        });
        return flow;
    }

    if (messageLooksLikeOrder(input.message)) {
        return startOrderFlow(input);
    }

    return null;
}

export function orderFlowContextForAi(flow: OrderFlowPayload | null | undefined): string | undefined {
    if (!flow?.sessionId) return undefined;
    const bits = [
        `Active order session ${flow.sessionId}`,
        `Partner: ${flow.partnerLabel}`,
        `Phase: ${flow.phase}`,
        `Query: ${flow.query}`,
    ];
    if (flow.selectedAddressId) bits.push(`Selected address id: ${flow.selectedAddressId}`);
    if (flow.cartItems?.length) bits.push(`Cart items: ${flow.cartItems.length}`);
    bits.push("Ordering UI handles address, browse, and cart — explain the current step briefly.");
    return bits.join(". ");
}

export function orderFlowReply(flow: OrderFlowPayload | null | undefined): string | undefined {
    return flow?.message;
}
