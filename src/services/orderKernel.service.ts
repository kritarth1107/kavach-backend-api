/**
 * Unified order kernel — AI tools call these; channel UIs render OrderFlowPayload.
 */
import { AppError } from "../middleware/error.middleware";
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
import { resolveFamilyMcpUserId } from "./commerceConnection.service";
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
        return {
            status: "order_flow",
            kind: "order_flow",
            orderFlow: active,
            message: active.message ?? "Continuing your order.",
        };
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

export async function searchOrderCatalog(input: {
    sessionId: string;
    familyId: string;
    actorUserId: string;
    query: string;
}): Promise<Record<string, unknown>> {
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
        orderFlow: flow,
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
