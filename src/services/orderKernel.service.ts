/**
 * Unified order kernel — AI tools call these; channel UIs render OrderFlowPayload.
 *
 * Phase 2 addition: quickOrder / confirmOrPlace for one-message ordering.
 */
import { AppError } from "../middleware/error.middleware";
import { buildCommerceHealthSuggestions } from "./saheliCommerceHealthHints.service";
import type { McpCatalogHit } from "../partners/mcp/mcpClient.service";
import { searchMcpProduct } from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import type { OrderSessionCatalogItem } from "../models/orderSession.model";
import {
    type CatalogCandidate,
    findHitForCandidate,
    rankCatalogHits,
    resolveCatalogFromHits,
} from "./catalogResolver.service";
import { resolveFamilyMcpUserId, listFamilyConnectedPartners } from "./commerceConnection.service";
import {
    addOrderFlowCartItem,
    getOrderFlowSession,
    resumeActiveOrderFlow,
    startOrderFlow,
    submitOrderFlowCart,
    selectOrderFlowAddress,
    type OrderFlowPayload,
} from "./orderOrchestrator.service";
import OrderSession from "../models/orderSession.model";
import { getLastSuccessfulAddress, recordSuccessfulAddress } from "./elderPartnerAddress.service";
import { partnerErrorPayload, isPartnerError } from "./orderSessionRecovery.service";
import {
    extractOrderQuery,
    pickOrderPartner,
    partnerLabel,
    isHighConfidenceOrderIntent,
} from "./saheliOrder.service";
import { OrderPartner } from "../types/careRecord.types";

export type OrderDisambiguation = {
    query: string;
    candidates: Array<
        OrderSessionCatalogItem & { candidateId?: string; confidence?: number }
    >;
};

function candidateToCatalogItem(c: CatalogCandidate): OrderSessionCatalogItem {
    return {
        id: c.candidateId,
        itemId: c.itemId ?? c.spinId ?? c.productId,
        name: c.name,
        pricePaise: c.pricePaise,
        kind: c.kind,
        restaurantId: c.restaurantId,
        restaurantName: c.restaurantName,
    };
}

function attachDisambiguation(
    flow: OrderFlowPayload,
    query: string,
    candidates: CatalogCandidate[],
): OrderFlowPayload {
    return {
        ...flow,
        disambiguation: {
            query,
            candidates: candidates.map((c) => ({
                ...candidateToCatalogItem(c),
                candidateId: c.candidateId,
                confidence: c.confidence,
            })),
        },
        message:
            flow.message ??
            `Which "${query}" did you mean? Pick a number or tell me the exact one.`,
    };
}

async function loadSessionHits(sessionId: string, familyId: string, actorUserId: string) {
    const session = await OrderSession.findOne({ sessionId, familyId });
    if (!session) throw new AppError("Order session not found", 404);
    const raw = session.get("lastCatalogHits") as McpCatalogHit[] | undefined;
    const query = String(session.get("lastCatalogQuery") ?? session.query);
    return { session, hits: raw ?? [], query };
}

async function persistSearch(sessionId: string, familyId: string, query: string, hits: McpCatalogHit[]) {
    await OrderSession.updateOne(
        { sessionId, familyId },
        { $set: { lastCatalogQuery: query, lastCatalogHits: hits } },
    );
}

export async function ensureOrderSession(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message?: string;
    saheliSessionId?: string;
}): Promise<Record<string, unknown>> {
    const active = await resumeActiveOrderFlow({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        saheliSessionId: input.saheliSessionId,
    });
    if (active?.sessionId) {
        const { isActiveOrderSession } = await import("./orderSessionRecovery.service");
        const stillValid = await isActiveOrderSession(active.sessionId, input.familyId);
        if (stillValid) {
            return {
                status: "order_flow",
                kind: "order_flow",
                orderFlow: active,
                message: active.message ?? "Continuing your order.",
            };
        }
    }

    const message = input.message?.trim();
    if (!message) {
        throw new AppError("message is required to start a new order session", 400);
    }

    const flow = await startOrderFlow({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message,
        saheliSessionId: input.saheliSessionId,
        aiInitiated: true,
    });
    if (!flow) {
        return { status: "no_order_intent" };
    }
    return {
        status: "order_flow",
        kind: "order_flow",
        orderFlow: flow,
        message: flow.message,
    };
}

async function guardActiveSession(
    sessionId: string,
    familyId: string,
): Promise<Record<string, unknown> | null> {
    const { isActiveOrderSession, sessionExpiredPayload } = await import(
        "./orderSessionRecovery.service"
    );
    if (!(await isActiveOrderSession(sessionId, familyId))) {
        return sessionExpiredPayload();
    }
    return null;
}

export async function searchOrderCatalog(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    query: string;
}): Promise<Record<string, unknown>> {
    const expired = await guardActiveSession(input.sessionId, input.familyId);
    if (expired) return expired;

    const session = await OrderSession.findOne({ sessionId: input.sessionId, familyId: input.familyId });
    if (!session) throw new AppError("Order session not found", 404);
    if (!session.selectedAddressId) {
        return {
            status: "needs_address",
            message: "Pick a delivery address first (list_partner_addresses / select address in order flow).",
            orderFlow: await getOrderFlowSession(input),
        };
    }

    const commerceUserId =
        (await resolveFamilyMcpUserId(session.familyId, session.partner, input.actorUserId)) ??
        input.actorUserId;

    const search = await searchMcpProduct(
        session.partner,
        session.familyId,
        commerceUserId,
        input.query.trim(),
        { addressId: session.selectedAddressId },
    );

    if (search.error) {
        return { status: "error", error: search.error, query: input.query };
    }

    const ranked = rankCatalogHits(input.query, search.items, session.partner, 10);
    await persistSearch(session.sessionId, session.familyId, input.query, search.items);

    return {
        status: "results",
        query: input.query,
        partner: session.partner,
        sessionId: session.sessionId,
        candidates: ranked,
        message:
            ranked.length > 0
                ? `Found ${ranked.length} options for "${input.query}". Use resolve_catalog_item or add_to_order_cart.`
                : `No results for "${input.query}".`,
    };
}

export async function resolveOrderCatalogItem(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    query?: string;
    candidateIndex?: number;
    candidateId?: string;
}): Promise<Record<string, unknown>> {
    const { session, hits, query: storedQuery } = await loadSessionHits(
        input.sessionId,
        input.familyId,
        input.actorUserId,
    );
    const query = (input.query ?? storedQuery).trim();
    if (!hits.length && query) {
        const searchResult = await searchOrderCatalog({
            sessionId: input.sessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            query,
        });
        if (searchResult.status !== "results") return searchResult;
        const refreshed = await loadSessionHits(input.sessionId, input.familyId, input.actorUserId);
        hits.push(...refreshed.hits);
    }

    if (input.candidateIndex != null || input.candidateId) {
        const ranked = rankCatalogHits(query, hits, session.partner, 10);
        const picked =
            input.candidateId != null
                ? ranked.find((c) => c.candidateId === input.candidateId)
                : ranked[input.candidateIndex!];
        if (!picked) {
            return { status: "not_found", message: "That option number was not found." };
        }
        const hit = findHitForCandidate(picked, hits);
        if (!hit) return { status: "not_found", message: "Catalog item expired — search again." };
        return { status: "resolved", query, candidate: picked, hit };
    }

    return resolveCatalogFromHits(query, hits, session.partner);
}

export async function addToOrderCart(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    items: Array<{
        query?: string;
        candidateIndex?: number;
        candidateId?: string;
        quantity?: number;
    }>;
}): Promise<Record<string, unknown>> {
    if (!input.items.length) {
        throw new AppError("items[] is required", 400);
    }

    const expired = await guardActiveSession(input.sessionId, input.familyId);
    if (expired) return expired;

    let flow: OrderFlowPayload | null = null;
    const added: string[] = [];
    let pendingDisambiguation: OrderDisambiguation | null = null;

    for (const line of input.items) {
        const resolved = await resolveOrderCatalogItem({
            sessionId: input.sessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            query: line.query,
            candidateIndex: line.candidateIndex,
            candidateId: line.candidateId,
        });

        if (resolved.status === "disambiguation_required") {
            const candidates = resolved.candidates as CatalogCandidate[];
            pendingDisambiguation = {
                query: String(resolved.query),
                candidates: candidates.map(candidateToCatalogItem),
            };
            await OrderSession.updateOne(
                { sessionId: input.sessionId, familyId: input.familyId },
                {
                    $set: {
                        pendingDisambiguation: {
                            query: String(resolved.query),
                            candidates: candidates.map((c) => ({
                                ...candidateToCatalogItem(c),
                                candidateId: c.candidateId,
                                confidence: c.confidence,
                            })),
                        },
                    },
                },
            );
            const current = await getOrderFlowSession(input);
            return {
                status: "disambiguation_required",
                query: resolved.query,
                candidates,
                orderFlow: attachDisambiguation(current, String(resolved.query), candidates),
                added,
            };
        }

        if (resolved.status !== "resolved") {
            return { ...resolved, added, orderFlow: flow ?? (await getOrderFlowSession(input)) };
        }

        const candidate = resolved.candidate as CatalogCandidate;
        flow = await addOrderFlowCartItem({
            sessionId: input.sessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            item: {
                itemId: candidate.itemId ?? candidate.spinId ?? candidate.productId,
                name: candidate.name,
                quantity: line.quantity ?? 1,
                pricePaise: candidate.pricePaise,
                restaurantId: candidate.restaurantId,
                restaurantName: candidate.restaurantName,
            },
        });
        added.push(candidate.name);
    }

    return {
        status: "added",
        added,
        orderFlow: flow,
        message:
            added.length > 1
                ? `Added ${added.length} items to your basket.`
                : `Added ${added[0]} to your basket.`,
        disambiguation: pendingDisambiguation,
    };
}

export async function getOrderCart(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
}): Promise<Record<string, unknown>> {
    const flow = await getOrderFlowSession(input);
    let healthSuggestions = flow.healthSuggestions;
    if (!healthSuggestions?.length && (flow.cartItems?.length ?? 0) > 0) {
        try {
            const sessionMeta = await OrderSession.findOne({
                sessionId: input.sessionId,
                familyId: input.familyId,
            }).lean();
            if (sessionMeta) {
                healthSuggestions = await buildCommerceHealthSuggestions({
                    familyId: input.familyId,
                    recipientUserId: sessionMeta.recipientUserId,
                    cartItemNames: (flow.cartItems ?? []).map((i) => i.name),
                });
            }
        } catch {
            healthSuggestions = undefined;
        }
    }
    const enriched = { ...flow, healthSuggestions };
    return {
        status: "cart",
        sessionId: flow.sessionId,
        partner: flow.partner,
        partnerLabel: flow.partnerLabel,
        phase: flow.phase,
        cartItems: flow.cartItems ?? [],
        totalPaise: (flow.cartItems ?? []).reduce(
            (sum, item) => sum + item.quantity * item.pricePaise,
            0,
        ),
        healthSuggestions: healthSuggestions ?? [],
        orderFlow: enriched,
    };
}

export async function submitOrderCart(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
}): Promise<Record<string, unknown>> {
    const { flow, order } = await submitOrderFlowCart(input);
    return {
        status: "submitted",
        kind: "order_flow",
        orderFlow: flow,
        order,
        message: flow.message,
    };
}

/** Deterministic order start when AI is unavailable but message is clearly an order. */
export async function tryStartOrderFromMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    saheliSessionId?: string;
}): Promise<{ reply: string; orderFlow?: OrderFlowPayload } | null> {
    const { messageLooksLikeOrder } = await import("./saheliOrder.service");
    if (!messageLooksLikeOrder(input.message)) return null;

    const result = await ensureOrderSession({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: input.message,
        saheliSessionId: input.saheliSessionId,
    });

    if (result.status === "no_order_intent") return null;

    const flow = result.orderFlow as OrderFlowPayload | undefined;
    const reply =
        (typeof flow?.message === "string" && flow.message.trim()) ||
        (typeof result.message === "string" && result.message.trim()) ||
        "";

    if (!reply && !flow?.sessionId && !flow?.connectPartner) return null;

    return {
        reply: reply || "Starting your order — one moment.",
        orderFlow: flow,
    };
}

export async function selectOrderSessionAddress(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    addressId: string;
}): Promise<Record<string, unknown>> {
    const flow = await selectOrderFlowAddress(input);
    return { status: "order_flow", kind: "order_flow", orderFlow: flow, message: flow.message };
}

function orderPartnerToMcp(partner: OrderPartner): McpPartnerKey | null {
    if (partner === OrderPartner.SWIGGY) return "swiggy";
    if (partner === OrderPartner.INSTAMART) return "instamart";
    if (partner === OrderPartner.ZEPTO) return "zepto";
    return null;
}

export type QuickOrderResult = {
    status: "confirm_ready" | "needs_confirm" | "needs_address" | "partner_not_connected" | "partner_error" | "no_results" | "order_placed";
    sessionId?: string;
    partner: McpPartnerKey;
    partnerLabel: string;
    query: string;
    address?: { id: string; label: string; line1?: string };
    items?: Array<{ name: string; pricePaise: number; itemId?: string; quantity: number }>;
    totalPaise?: number;
    message: string;
    orderFlow?: OrderFlowPayload;
    connectUrl?: string | null;
    orderId?: string;
    /** Memory-backed tips — Saheli suggests, elder decides. */
    healthSuggestions?: OrderFlowPayload["healthSuggestions"];
};

/**
 * Phase 2: Quick order flow - one message + one confirm.
 * 
 * E.g., "2L milk Instamart" → system picks partner, reuses last successful address,
 * searches catalog, returns ONE confirm card. On confirm → place order.
 */
export async function quickOrder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    saheliSessionId?: string;
}): Promise<QuickOrderResult> {
    const orderMessage = input.message.trim();
    const query = extractOrderQuery(orderMessage);
    
    const partner = await pickOrderPartner(orderMessage, input.familyId, input.actorUserId);
    const mcpPartner = orderPartnerToMcp(partner);
    if (!mcpPartner) {
        return {
            status: "partner_error",
            partner: "zepto",
            partnerLabel: "Zepto",
            query,
            message: "Couldn't determine which delivery partner to use. Try 'milk from Instamart' or 'pizza from Swiggy'.",
        };
    }

    const label = partnerLabel(partner);
    const connected = await listFamilyConnectedPartners(input.familyId, input.actorUserId);
    const isConnected =
        (partner === OrderPartner.SWIGGY && connected.swiggy) ||
        (partner === OrderPartner.INSTAMART && connected.instamart) ||
        (partner === OrderPartner.ZEPTO && connected.zepto);

    if (!isConnected) {
        const { startMcpConnect } = await import("../partners/mcp/mcpClient.service");
        let connectUrl: string | null = null;
        try {
            const started = await startMcpConnect(mcpPartner, input.familyId, input.actorUserId);
            connectUrl = started.authorizationUrl ?? null;
        } catch {
            connectUrl = null;
        }
        return {
            status: "partner_not_connected",
            partner: mcpPartner,
            partnerLabel: label,
            query,
            message: `Connect ${label} first to place this order.${connectUrl ? " Tap below to connect." : " Ask your caregiver to connect it in Integrations."}`,
            connectUrl,
        };
    }

    const lastAddress = await getLastSuccessfulAddress(input.familyId, input.recipientUserId, mcpPartner);
    const commerceUserId =
        (await resolveFamilyMcpUserId(input.familyId, mcpPartner, input.actorUserId)) ??
        input.actorUserId;

    let searchHits: McpCatalogHit[] = [];
    let searchAddressId: string | undefined;
    let searchError: string | undefined;

    if (lastAddress) {
        try {
            const search = await searchMcpProduct(
                mcpPartner,
                input.familyId,
                commerceUserId,
                query,
                { addressId: lastAddress.addressId },
            );
            searchHits = search.items;
            searchAddressId = search.addressId ?? lastAddress.addressId;
            searchError = search.error;
        } catch (err) {
            if (isPartnerError(err)) {
                return {
                    status: "partner_error",
                    partner: mcpPartner,
                    partnerLabel: label,
                    query,
                    message: `${label} search is slow right now. Try again in a moment.`,
                };
            }
            searchError = err instanceof Error ? err.message : "Search failed";
        }
    }

    if (!lastAddress || searchError === "no_address" || !searchAddressId) {
        const flow = await startOrderFlow({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            message: orderMessage,
            saheliSessionId: input.saheliSessionId,
            aiInitiated: true,
        });

        if (!flow) {
            return {
                status: "no_results",
                partner: mcpPartner,
                partnerLabel: label,
                query,
                message: "Couldn't start your order. Try being more specific about what you want.",
            };
        }

        return {
            status: "needs_address",
            sessionId: flow.sessionId,
            partner: mcpPartner,
            partnerLabel: label,
            query,
            message: flow.message ?? `Pick a delivery address to order from ${label}.`,
            orderFlow: flow,
        };
    }

    const ranked = rankCatalogHits(query, searchHits, mcpPartner, 5);
    if (!ranked.length || !ranked[0]?.pricePaise) {
        const flow = await startOrderFlow({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            message: orderMessage,
            saheliSessionId: input.saheliSessionId,
            aiInitiated: true,
        });

        return {
            status: "no_results",
            sessionId: flow?.sessionId,
            partner: mcpPartner,
            partnerLabel: label,
            query,
            address: { id: searchAddressId, label: lastAddress.label ?? "Saved address", line1: lastAddress.line1 },
            message: `I couldn't find "${query}" on ${label}. Try a different search or browse the catalog.`,
            orderFlow: flow ?? undefined,
        };
    }

    const bestMatch = ranked[0];
    const items = [{
        name: bestMatch.name,
        pricePaise: bestMatch.pricePaise!,
        itemId: bestMatch.itemId ?? bestMatch.spinId ?? bestMatch.productId,
        quantity: 1,
        restaurantId: bestMatch.restaurantId,
        restaurantName: bestMatch.restaurantName,
    }];

    const flow = await startOrderFlow({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: orderMessage,
        saheliSessionId: input.saheliSessionId,
        aiInitiated: true,
    });

    if (!flow?.sessionId) {
        return {
            status: "partner_error",
            partner: mcpPartner,
            partnerLabel: label,
            query,
            message: "Couldn't start the order. Try again.",
        };
    }

    await OrderSession.updateOne(
        { sessionId: flow.sessionId, familyId: input.familyId },
        { $set: { selectedAddressId: searchAddressId } },
    );

    try {
        const addResult = await addOrderFlowCartItem({
            sessionId: flow.sessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            item: {
                itemId: items[0].itemId,
                name: items[0].name,
                quantity: 1,
                pricePaise: items[0].pricePaise,
                restaurantId: items[0].restaurantId,
                restaurantName: items[0].restaurantName,
            },
        });

        const tips = addResult.healthSuggestions ?? [];
        const tipBlock = tips.length
            ? `\n\nSaheli tip — you decide:\n${tips.map((t) => `• ${t.text}`).join("\n")}`
            : "";
        return {
            status: "confirm_ready",
            sessionId: flow.sessionId,
            partner: mcpPartner,
            partnerLabel: label,
            query,
            address: { id: searchAddressId, label: lastAddress.label ?? "Saved address", line1: lastAddress.line1 },
            items: items.map(i => ({ name: i.name, pricePaise: i.pricePaise, itemId: i.itemId, quantity: i.quantity })),
            totalPaise: items.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0),
            message: `${items[0].name} · ₹${(items[0].pricePaise / 100).toFixed(0)} from ${label}\nTo: ${lastAddress.label ?? "Saved address"}${tipBlock}`,
            orderFlow: addResult,
            healthSuggestions: tips,
        };
    } catch (err) {
        console.warn("Quick order add to cart failed:", err);
        return {
            status: "partner_error",
            sessionId: flow.sessionId,
            partner: mcpPartner,
            partnerLabel: label,
            query,
            message: `Couldn't add item to cart. ${err instanceof Error ? err.message : "Try again."}`,
            orderFlow: flow,
        };
    }
}

/**
 * Phase 2: Confirm and place order from quick order flow.
 */
export async function confirmAndPlaceOrder(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
}): Promise<{
    status: "placed" | "awaiting_approval" | "error";
    orderId?: string;
    message: string;
    orderFlow?: OrderFlowPayload;
}> {
    try {
        const { flow, order } = await submitOrderFlowCart({
            sessionId: input.sessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
        });

        const session = await OrderSession.findOne({ sessionId: input.sessionId, familyId: input.familyId }).lean();
        if (session?.selectedAddressId) {
            const address = session.addresses?.find(a => a.id === session.selectedAddressId);
            await recordSuccessfulAddress({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                partner: session.partner,
                addressId: session.selectedAddressId,
                addressLabel: address?.label,
                addressLine1: address?.line1,
            });
        }

        const orderId = typeof order.orderId === "string" ? order.orderId : flow.orderId;
        const status = String(order.status ?? "");
        const isPending = status === "awaiting_approval";
        const isPlaced = status === "paid" || status === "delivered";

        return {
            status: isPending ? "awaiting_approval" : isPlaced ? "placed" : "awaiting_approval",
            orderId,
            message: isPending
                ? "Basket submitted — waiting for your family to approve before checkout."
                : isPlaced
                  ? `Order placed! ₹${((order.totalPaise as number) / 100).toFixed(0)} from ${flow.partnerLabel}. I'll update you when it's on the way.`
                  : `Basket approved — placing with ${flow.partnerLabel}…`,
            orderFlow: flow,
        };
    } catch (err) {
        console.warn("Confirm and place order failed:", err);
        return {
            status: "error",
            message: err instanceof Error ? err.message : "Order failed. Try again.",
        };
    }
}
