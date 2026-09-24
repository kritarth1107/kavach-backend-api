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
    fetchInstamartCartBill,
    getMcpRestaurantMenu,
    probeInstamartAddressServiceability,
    searchMcpProduct,
    startMcpConnect,
    type McpCatalogHit,
    type PartnerBillBreakdown,
} from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { OrderPartner } from "../types/careRecord.types";
import { listFamilyConnectedPartners, resolveFamilyMcpUserId } from "./commerceConnection.service";
import {
    getFamilyForActor,
    getMemberRole,
    requireCareRecipient,
} from "./careRecordAuth.service";
import { approveOrder, payOrder, suggestOrder } from "./order.service";
import {
    getPartnerOrderSettings,
    orderRequiresCaregiverApproval,
} from "./commerceSettings.service";
import {
    buildCommerceHealthSuggestions,
    type CommerceHealthSuggestion,
} from "./saheliCommerceHealthHints.service";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
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
    billBreakdown?: PartnerBillBreakdown;
    orderId?: string;
    /** Order status after submit — drives truthful WA "placed" vs "awaiting approval" copy. */
    orderStatus?: string;
    message?: string;
    /** Gentle memory-backed tips before confirm — elder decides. */
    healthSuggestions?: CommerceHealthSuggestion[];
    /** Grocery partner closed / not delivering at selected address (even if search returned hits). */
    deliveryUnavailable?: boolean;
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

function flowFromSession(
    session: IOrderSessionDocument,
    message?: string,
    extras?: Partial<
        Pick<
            OrderFlowPayload,
            "deliveryUnavailable" | "connectPartner" | "connectUrl" | "healthSuggestions"
        >
    >,
): OrderFlowPayload {
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
        billBreakdown: session.billBreakdown,
        orderId: session.orderId,
        orderStatus: session.orderStatus,
        message,
        healthSuggestions: extras?.healthSuggestions,
        deliveryUnavailable: extras?.deliveryUnavailable,
        connectPartner: extras?.connectPartner,
        connectUrl: extras?.connectUrl,
        disambiguation: session.pendingDisambiguation
            ? {
                  query: session.pendingDisambiguation.query,
                  candidates: session.pendingDisambiguation.candidates,
              }
            : undefined,
    };
}

function groceryCatalogIsEmpty(session: IOrderSessionDocument): boolean {
    const products = session.catalog?.products?.length ?? 0;
    const dishes = session.catalog?.dishes?.length ?? 0;
    // Instamart/Zepto browse is product-led; ignore stray restaurant rows.
    return products + dishes === 0;
}

function pickCheapestSpinId(session: IOrderSessionDocument): string | undefined {
    const rawHits = Array.isArray(session.lastCatalogHits)
        ? (session.lastCatalogHits as Array<Record<string, unknown>>)
        : [];
    const fromHits = rawHits
        .map((h) => ({
            spinId: String(h.spinId ?? h.productId ?? h.itemId ?? ""),
            pricePaise:
                typeof h.pricePaise === "number"
                    ? h.pricePaise
                    : Number.MAX_SAFE_INTEGER,
        }))
        .filter((h) => h.spinId);
    if (fromHits.length) {
        fromHits.sort((a, b) => a.pricePaise - b.pricePaise);
        return fromHits[0]?.spinId;
    }
    const products = [...(session.catalog?.products ?? []), ...(session.catalog?.dishes ?? [])];
    const withId = products.filter((p) => p.itemId || p.id);
    if (!withId.length) return undefined;
    withId.sort(
        (a, b) => (a.pricePaise ?? Number.MAX_SAFE_INTEGER) - (b.pricePaise ?? Number.MAX_SAFE_INTEGER),
    );
    return withId[0]?.itemId ?? withId[0]?.id;
}

function looksLikeAuthSearchError(err: unknown): boolean {
    const msg = err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
    return /401|unauthori[sz]ed|re-?auth|reconnect|token.*(expired|invalid)|not authenticated|login required|session expired/i.test(
        msg,
    );
}

async function zeptoAltHintIfConnected(familyId: string, actorUserId: string, failedPartner: McpPartnerKey): Promise<string> {
    if (failedPartner !== "instamart") return "";
    try {
        const connected = await listFamilyConnectedPartners(familyId, actorUserId);
        if (connected.zepto) {
            return " I can try Zepto instead — just say *order on Zepto*.";
        }
    } catch {
        // ignore — alt hint is optional
    }
    return "";
}

async function finalizeGroceryAddressCatalog(
    session: IOrderSessionDocument,
    address: OrderSessionAddress,
): Promise<OrderFlowPayload> {
    const label = partnerLabel(mcpToOrderPartner(session.partner));
    const addressLabel = address.label || "that address";

    if (session.partner !== "instamart" && session.partner !== "zepto") {
        return flowFromSession(
            session,
            `Delivery to ${addressLabel}. Browse ${label} options for "${session.query}" below.`,
        );
    }

    if (groceryCatalogIsEmpty(session)) {
        const zeptoHint = await zeptoAltHintIfConnected(session.familyId, session.actorUserId, session.partner);
        session.phase = "browse";
        session.catalog = { restaurants: [], dishes: [], products: [] };
        session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await session.save();
        return flowFromSession(
            session,
            `${label} isn't delivering to ${addressLabel} right now (or nothing is available there). Reply *change address* to pick another address, or *cancel* to stop.${zeptoHint}`,
            { deliveryUnavailable: true },
        );
    }

    if (session.partner === "instamart" && session.selectedAddressId) {
        const commerceUserId =
            (await resolveFamilyMcpUserId(session.familyId, session.partner, session.actorUserId)) ??
            session.actorUserId;
        const spinId = pickCheapestSpinId(session);
        try {
            const probe = await probeInstamartAddressServiceability(
                session.familyId,
                commerceUserId,
                session.selectedAddressId,
                { spinId },
            );
            if (!probe.serviceable) {
                const zeptoHint = await zeptoAltHintIfConnected(
                    session.familyId,
                    session.actorUserId,
                    session.partner,
                );
                session.phase = "browse";
                session.catalog = { restaurants: [], dishes: [], products: [] };
                session.cartItems = [];
                session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
                await session.save();
                return flowFromSession(
                    session,
                    `Instamart isn't delivering to ${addressLabel} right now — it looks closed or not serviceable there. Reply *change address* to pick another address, or *cancel* to stop.${zeptoHint}`,
                    { deliveryUnavailable: true },
                );
            }
        } catch (err) {
            console.warn("Instamart cart serviceability probe failed:", err);
            // Fail open to browse, but be honest that checkout might still fail.
            return flowFromSession(
                session,
                `Delivery to ${addressLabel}. Here are ${label} options for "${session.query}". If checkout fails, Instamart may be closed at this address — say *change address* to try another.`,
            );
        }
    }

    return flowFromSession(
        session,
        `Delivery to ${addressLabel}. Browse ${label} options for "${session.query}" below.`,
    );
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
            const autoFlow = await finalizeGroceryAddressCatalog(session, matched);
            if (!autoFlow.deliveryUnavailable) {
                autoFlow.message = `Using ${matched.label}. Here are ${label} options for "${query}". Pick an item below.`;
            }
            return autoFlow;
        }
    }

    if (addresses.length === 1) {
        session.selectedAddressId = addresses[0].id;
        await session.save();
        await searchCatalogForSession(session);
        return finalizeGroceryAddressCatalog(session, addresses[0]);
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
        return finalizeGroceryAddressCatalog(session, address);
    } catch (err) {
        console.warn("Catalog search after address select failed:", err);
        session.phase = "browse";
        session.catalog = session.catalog ?? { restaurants: [], dishes: [], products: [] };
        session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
        await session.save();
        if (looksLikeAuthSearchError(err)) {
            return flowFromSession(
                session,
                `${label} needs a reconnect before I can shop for "${session.query}". Ask your caregiver to reconnect ${label} in Integrations, or reply *cancel* to stop.`,
                { deliveryUnavailable: true },
            );
        }
        const hint =
            err instanceof AppError
                ? err.message
                : "Partner search is slow right now.";
        return flowFromSession(
            session,
            `Delivery to ${address.label}. I couldn't load ${label} results for "${session.query}" yet (${hint}). Reply *retry* to search again, *change address* to pick another address, or *cancel* to stop.`,
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
    const address =
        session.addresses.find((a) => a.id === session.selectedAddressId) ??
        ({
            id: session.selectedAddressId ?? "",
            label: "that address",
            line1: "",
        } satisfies OrderSessionAddress);
    if (session.partner === "instamart" || session.partner === "zepto") {
        const finalized = await finalizeGroceryAddressCatalog(session, address);
        if (finalized.deliveryUnavailable) return finalized;
    }
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

function resolveCartItemPricePaise(
    session: IOrderSessionDocument,
    item: { itemId?: string; name: string },
): number | undefined {
    const id = item.itemId?.trim();
    const nameLower = item.name.trim().toLowerCase();

    const catalogRows = [
        ...(session.catalog?.products ?? []),
        ...(session.catalog?.dishes ?? []),
    ];
    for (const row of catalogRows) {
        const matchId = Boolean(id && (row.itemId === id || row.id === id));
        const matchName = Boolean(nameLower && row.name.toLowerCase() === nameLower);
        if ((matchId || matchName) && row.pricePaise && row.pricePaise > 0) {
            return row.pricePaise;
        }
    }

    const rawHits = Array.isArray(session.lastCatalogHits)
        ? (session.lastCatalogHits as Array<Record<string, unknown>>)
        : [];
    for (const hit of rawHits) {
        const hitId = String(hit.spinId ?? hit.productId ?? hit.itemId ?? hit.id ?? "").trim();
        const hitName = String(hit.name ?? hit.matchedName ?? "")
            .trim()
            .toLowerCase();
        const matchId = Boolean(id && hitId && hitId === id);
        const matchName = Boolean(nameLower && hitName && hitName === nameLower);
        const price =
            typeof hit.pricePaise === "number" && Number.isFinite(hit.pricePaise)
                ? hit.pricePaise
                : undefined;
        if ((matchId || matchName) && price && price > 0) {
            return price;
        }
    }
    return undefined;
}


async function refreshSessionBillBreakdown(session: IOrderSessionDocument): Promise<void> {
    if (session.partner !== "instamart" || !session.cartItems.length) return;
    try {
        const mcpUserId =
            (await resolveFamilyMcpUserId(session.familyId, session.partner, session.actorUserId)) ??
            session.actorUserId;
        const bill = await fetchInstamartCartBill({
            familyId: session.familyId,
            userId: mcpUserId,
            addressId: session.selectedAddressId,
            items: session.cartItems.map((item) => ({
                name: item.name,
                quantity: item.quantity,
                itemId: item.itemId,
            })),
        });
        if (bill) session.billBreakdown = bill;
    } catch (err) {
        console.warn("Instamart bill breakdown refresh failed:", err);
    }
}


async function withHealthSuggestions(
    session: IOrderSessionDocument,
    message?: string,
): Promise<OrderFlowPayload> {
    let healthSuggestions: CommerceHealthSuggestion[] | undefined;
    try {
        healthSuggestions = await buildCommerceHealthSuggestions({
            familyId: session.familyId,
            recipientUserId: session.recipientUserId,
            cartItemNames: (session.cartItems ?? []).map((i) => i.name),
        });
        if (!healthSuggestions.length) healthSuggestions = undefined;
    } catch {
        healthSuggestions = undefined;
    }
    return flowFromSession(session, message, { healthSuggestions });
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
    let price = input.item.pricePaise;
    if (!price || price <= 0) {
        price = resolveCartItemPricePaise(session, input.item);
    }
    if (!price || price <= 0) {
        throw new AppError("Live price required — pick an item from catalog search results.", 400);
    }

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
    await refreshSessionBillBreakdown(session);
    await session.save();

    return withHealthSuggestions(
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
    return withHealthSuggestions(session);
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

    if (selected?.id) {
        order.partnerAddressId = selected.id;
        await order.save();
    }

    // Best-effort fee snapshot before approval/checkout messaging.
    await refreshSessionBillBreakdown(session);
    if (session.billBreakdown) {
        order.billBreakdown = session.billBreakdown;
        if (
            typeof session.billBreakdown.grandTotalPaise === "number" &&
            session.billBreakdown.grandTotalPaise > 0
        ) {
            order.totalPaise = session.billBreakdown.grandTotalPaise;
        }
        await order.save();
    }

    if (!needsApproval) {
        order = await approveOrder(session.familyId, order.orderId, session.actorUserId);
        // Auto-approved path: actually place via MCP/COD pay (truthful "Order placed").
        try {
            const paid = await payOrder(session.familyId, order.orderId, session.actorUserId, {
                partnerAddressId: order.partnerAddressId ?? selected?.id,
            });
            order = paid.order;
        } catch (err) {
            // Leave as approved — do not claim placed. Surface error to caller.
            session.phase = "submitted";
            session.orderId = order.orderId;
            session.orderStatus = String(order.status);
            await session.save();
            throw err instanceof AppError
                ? err
                : new AppError(
                      err instanceof Error ? err.message : "Checkout failed",
                      400,
                  );
        }

        // Elder Instinct path: caregivers get notify-only (WhatsApp + in-app) — never an approve gate.
        if (actorRole === FamilyRole.CARE_RECIPIENT) {
            const itemSummary = order.items
                .slice(0, 4)
                .map((i) => `${i.name}×${i.quantity}`)
                .join(", ");
            const amount = `₹${(order.totalPaise / 100).toFixed(0)}`;
            const notifyBody =
                `Amma placed an order on ${partnerLabel(orderPartner)} — ${amount}` +
                (itemSummary ? ` (${itemSummary})` : "") +
                `. Notify only — no approval needed.`;
            const caregivers = family.members
                .filter(
                    (m) =>
                        m.status === FamilyMemberStatus.JOINED &&
                        m.userId &&
                        m.userId !== session.actorUserId &&
                        m.role !== FamilyRole.CARE_RECIPIENT,
                )
                .map((m) => m.userId!);
            if (caregivers.length) {
                void createFamilyNotification(
                    session.familyId,
                    {
                        kind: "order_placed",
                        title: "Amma placed an order",
                        body: notifyBody.slice(0, 280),
                        actionUrl: "/dashboard/approvals",
                        recipientUserId: session.recipientUserId,
                        dedupeKey: `order-placed:${order.orderId}`,
                    },
                    caregivers,
                );
            }
            void import("./saheliCaregiverAlert.service")
                .then(({ notifyCaregivers }) =>
                    notifyCaregivers({
                        familyId: session.familyId,
                        recipientUserId: session.recipientUserId,
                        actorUserId: session.actorUserId,
                        message: notifyBody,
                        urgency: "low",
                        kind: "order_placed",
                    }),
                )
                .catch((err) =>
                    console.warn("Elder order caregiver WhatsApp notify failed:", err),
                );
        }
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

    session.phase = "submitted";
    session.orderId = order.orderId;
    session.orderStatus = String(order.status);
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

    const paidOk = String(order.status) === "paid" || String(order.status) === "delivered";
    const flow = flowFromSession(
        session,
        paidOk
            ? `Order placed on ${partnerLabel(orderPartner)} — ₹${(order.totalPaise / 100).toFixed(0)}. I'll update you when it's on the way.`
            : needsApproval
              ? `Basket submitted — ₹${(order.totalPaise / 100).toFixed(0)} total. Waiting for family approval before checkout.`
              : `Basket approved — ₹${(order.totalPaise / 100).toFixed(0)}. Placing with ${partnerLabel(orderPartner)}…`,
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

    if (
        /\b(?:change|chahge|chang|chage|chnage)\s+(?:my\s+)?(?:delivery\s+)?address\b/i.test(text) ||
        /\b(?:pick|other|different|new)\s+(?:delivery\s+)?address\b/i.test(text)
    ) {
        active.phase = "select_address";
        active.selectedAddressId = undefined;
        active.cartItems = [];
        active.catalog = { restaurants: [], dishes: [], products: [] };
        active.pendingDisambiguation = undefined;
        await active.save();
        return flowFromSession(
            active,
            active.query
                ? `Ok — cancelled this basket. Still looking for "${active.query}". Pick a delivery address to continue.`
                : "Ok — cancelled this basket. Pick a delivery address to continue.",
        );
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
