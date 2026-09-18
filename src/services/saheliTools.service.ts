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
    | "search_swiggy_food"
    | "search_instamart"
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
        case "search_swiggy_food": {
            const query = String(input.args.query ?? "");
            const addressId = input.args.addressId ? String(input.args.addressId) : undefined;
            const commerceUserId =
                (await resolveFamilyMcpUserId(input.familyId, "swiggy", input.actorUserId)) ??
                input.actorUserId;
            const search = await searchMcpProduct("swiggy", input.familyId, commerceUserId, query, {
                addressId,
            });
            return { items: search.items.slice(0, 10) };
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
            return { items: search.items.slice(0, 10) };
        }
        case "suggest_order": {
            const message = String(input.args.message ?? input.args.query ?? "");
            const result = await maybeSuggestOrderFromChat({
                familyId: input.familyId,
                subjectUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message,
            });
            if (!result) return { status: "no_order_intent" };
            return { status: result.kind, result: result as OrderChatResult };
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

export async function getSaheliInsights(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
): Promise<Array<{ kind: string; title: string; detail: string }>> {
    await getFamilyForActor(familyId, actorUserId);
    const insights: Array<{ kind: string; title: string; detail: string }> = [];

    const pendingOrders = await Order.find({
        familyId,
        subjectUserId: recipientUserId,
        status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
    })
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();
    for (const order of pendingOrders) {
        insights.push({
            kind: "order",
            title: "Order awaiting approval",
            detail: `${order.partner} basket ₹${(order.totalPaise / 100).toFixed(0)} needs family approval.`,
        });
    }

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recentLabs = await LabDocument.find({
        familyId,
        recipientUserId,
        createdAt: { $gte: cutoff },
    })
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();
    for (const lab of recentLabs) {
        insights.push({
            kind: "lab",
            title: "New report uploaded",
            detail: `${lab.title}${lab.recordDate ? ` (${lab.recordDate})` : ""} — review in Saheli or Reports.`,
        });
    }

    const lastElder = await SaheliMessage.findOne({
        familyId,
        recipientUserId,
        thread: "elder",
        role: "elder",
    })
        .sort({ createdAt: -1 })
        .lean();
    if (lastElder?.createdAt && lastElder.createdAt < new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)) {
        insights.push({
            kind: "checkin",
            title: "No recent check-in",
            detail: `${recipientUserId} has not messaged Saheli in a few days.`,
        });
    }

    return insights.slice(0, 5);
}
