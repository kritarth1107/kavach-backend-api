import { searchMcpProduct } from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { OrderPartner } from "../types/careRecord.types";
import { getCareRecordContextForSaheli } from "./careRecord.service";
import { getFamilyForActor } from "./careRecordAuth.service";
import {
    excerptReport,
    findNamedReports,
    findPrintedHits,
    formatPrintedHit,
} from "./labCite.service";
import LabDocument from "../models/labDocument.model";
import SaheliMessage from "../models/saheliMessage.model";
import Order from "../models/order.model";
import { OrderStatus } from "../types/careRecord.types";
import { ensurePartnerAddressesSynced, listPartnerAddresses } from "./partnerAddress.service";
import { resolveFamilyMcpUserId } from "./commerceConnection.service";
import { maybeSuggestOrderFromChat, type OrderChatResult } from "./saheliOrder.service";

export type SaheliToolName =
    | "get_care_timeline"
    | "search_lab_reports"
    | "get_lab_value"
    | "get_elder_messages"
    | "list_partner_addresses"
    | "resolve_order_partner"
    | "search_swiggy_food"
    | "search_instamart"
    | "preview_order"
    | "place_cod_order"
    | "suggest_order"
    | "recall_memories";

export async function executeSaheliTool(input: {
    tool: SaheliToolName;
    args: Record<string, unknown>;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
}): Promise<Record<string, unknown>> {
    await getFamilyForActor(input.familyId, input.actorUserId);

    switch (input.tool) {
        case "get_care_timeline": {
            const limit = Number(input.args.limit ?? 40);
            const timeline = await getCareRecordContextForSaheli(
                input.familyId,
                input.recipientUserId,
                limit,
            );
            return { timeline };
        }
        case "search_lab_reports": {
            const query = String(input.args.query ?? "");
            const labs = await LabDocument.find({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean();
            const mapped = labs.map((d) => ({
                title: d.title,
                recordDate: d.recordDate,
                rawText: d.rawText,
                kind: d.kind,
                structuredValues: (d as { structuredValues?: unknown }).structuredValues ?? [],
            }));
            const hits = findPrintedHits(mapped, query);
            const named = findNamedReports(mapped, query);
            if (hits.length) {
                return { results: hits.map(formatPrintedHit) };
            }
            if (named.length) {
                return { results: [excerptReport(named[named.length - 1])] };
            }
            return {
                results: mapped.slice(0, 5).map((l) => `${l.title}${l.recordDate ? ` (${l.recordDate})` : ""}`),
            };
        }
        case "get_lab_value": {
            const name = String(input.args.name ?? input.args.test ?? "");
            const labs = await LabDocument.find({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            })
                .sort({ createdAt: -1 })
                .lean();
            for (const doc of labs) {
                const structured = (doc as { structuredValues?: Array<{ name: string; value: string; unit?: string; date?: string }> }).structuredValues;
                if (Array.isArray(structured)) {
                    const hit = structured.find((row) =>
                        row.name.toLowerCase().includes(name.toLowerCase()),
                    );
                    if (hit) {
                        return {
                            name: hit.name,
                            value: hit.value,
                            unit: hit.unit,
                            date: hit.date ?? doc.recordDate,
                            source: doc.title,
                        };
                    }
                }
            }
            const hits = findPrintedHits(
                labs.map((d) => ({
                    title: d.title,
                    recordDate: d.recordDate,
                    rawText: d.rawText,
                    kind: d.kind,
                })),
                name,
            );
            return hits.length
                ? { results: hits.map(formatPrintedHit) }
                : { error: `No saved value found for "${name}"` };
        }
        case "get_elder_messages": {
            const limit = Number(input.args.limit ?? 12);
            const rows = await SaheliMessage.find({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                thread: "elder",
                role: "elder",
            })
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean();
            return {
                messages: rows.reverse().map((r) => ({
                    content: r.content,
                    createdAt: r.createdAt?.toISOString?.() ?? null,
                })),
            };
        }
        case "list_partner_addresses": {
            const partner = String(input.args.partner ?? "swiggy") as McpPartnerKey;
            const commerceUserId =
                (await resolveFamilyMcpUserId(input.familyId, partner, input.actorUserId)) ??
                input.actorUserId;
            await ensurePartnerAddressesSynced(partner, input.familyId, commerceUserId);
            const rows = await listPartnerAddresses(input.familyId, partner, commerceUserId);
            return {
                addresses: rows
                    .filter((r) => r.partner === partner)
                    .map((r) => ({
                        id: r.partner_address_id,
                        label: r.label,
                        line1: r.line1,
                        city: r.city,
                        pincode: r.pincode,
                        isDefault: r.is_default,
                    })),
            };
        }
        case "resolve_order_partner": {
            const message = String(input.args.message ?? input.args.query ?? "");
            const { resolveOrderPartnerForMessage } = await import("./orderAgent.service");
            return resolveOrderPartnerForMessage({
                message,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
            });
        }
        case "search_swiggy_food": {
            const query = String(input.args.query ?? "");
            const addressId = input.args.addressId ? String(input.args.addressId) : undefined;
            const commerceUserId =
                (await resolveFamilyMcpUserId(input.familyId, "swiggy", input.actorUserId)) ??
                input.actorUserId;
            const search = await searchMcpProduct("swiggy", input.familyId, commerceUserId, query, {
                addressId,
            });
            return {
                partner: "swiggy",
                addressId: search.addressId,
                error: search.error,
                items: search.items.slice(0, 10),
            };
        }
        case "search_instamart": {
            const query = String(input.args.query ?? "");
            const addressId = input.args.addressId ? String(input.args.addressId) : undefined;
            const commerceUserId =
                (await resolveFamilyMcpUserId(input.familyId, "instamart", input.actorUserId)) ??
                input.actorUserId;
            const search = await searchMcpProduct(
                "instamart",
                input.familyId,
                commerceUserId,
                query,
                { addressId },
            );
            return {
                partner: "instamart",
                addressId: search.addressId,
                error: search.error,
                items: search.items.slice(0, 10),
            };
        }
        case "preview_order": {
            const partner = String(input.args.partner ?? "swiggy") as McpPartnerKey;
            const addressId = String(input.args.addressId ?? "");
            const items = Array.isArray(input.args.items)
                ? (input.args.items as Array<{ name: string; quantity?: number }>)
                : [];
            if (!addressId || !items.length) {
                return { error: "addressId and items[] are required for preview_order" };
            }
            const { previewOrder } = await import("./orderAgent.service");
            return previewOrder({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                partner,
                addressId,
                items: items.map((row) => ({
                    name: String(row.name),
                    quantity: Number(row.quantity ?? 1),
                })),
                notes: input.args.notes ? String(input.args.notes) : undefined,
            });
        }
        case "place_cod_order": {
            const previewId = String(input.args.previewId ?? "");
            if (!previewId) return { error: "previewId is required" };
            const { placeCodOrderFromPreview } = await import("./orderAgent.service");
            return placeCodOrderFromPreview({
                familyId: input.familyId,
                previewId,
                actorUserId: input.actorUserId,
            });
        }
        case "suggest_order": {
            const message = String(input.args.message ?? input.args.query ?? "");
            const { startOrderFlow } = await import("./orderOrchestrator.service");
            const flow = await startOrderFlow({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message,
            });
            if (!flow) return { status: "no_order_intent" };
            return { status: "order_flow", kind: "order_flow", orderFlow: flow, message: flow.message };
        }
        case "recall_memories": {
            const { aiListFamilyMemories } = await import("../clients/aiEngine.client");
            const { ensureAiContext } = await import("./aiTenant.service");
            await getFamilyForActor(input.familyId, input.actorUserId);
            const ctx = await ensureAiContext(
                input.familyId,
                input.recipientUserId,
                "Care recipient",
            );
            const memories = await aiListFamilyMemories({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                limit: Number(input.args.limit ?? 10),
            });
            return { memories: memories.memories };
        }
        default:
            return { error: `Unknown tool: ${input.tool}` };
    }
}

