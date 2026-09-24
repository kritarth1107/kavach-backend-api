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
import { rankCatalogHits } from "./catalogResolver.service";

export type SaheliToolName =
    | "get_care_timeline"
    | "search_lab_reports"
    | "get_lab_value"
    | "get_elder_messages"
    | "list_partner_addresses"
    | "resolve_order_partner"
    | "search_swiggy_food"
    | "search_instamart"
    | "search_zepto"
    | "preview_order"
    | "place_cod_order"
    | "suggest_order"
    | "ensure_order_session"
    | "quick_order"
    | "confirm_and_place_order"
    | "search_catalog"
    | "resolve_catalog_item"
    | "add_to_order_cart"
    | "get_order_cart"
    | "submit_order_cart"
    | "select_order_address"
    | "get_order_status"
    | "suggest_reorder"
    | "recall_memories"
    | "save_memory"
    | "get_today_schedule"
    | "get_missed_tasks"
    | "get_family_briefing"
    | "get_family_members"
    | "get_upcoming_appointments"
    | "mark_schedule_completed"
    | "mark_schedule_missed"
    | "log_vitals"
    | "log_dose"
    | "log_check_in"
    | "log_symptom"
    | "create_reminder"
    | "list_reminders"
    | "cancel_reminder"
    | "log_appointment_notes"
    | "get_lab_trends"
    | "get_abnormal_flags"
    | "summarize_health_record"
    | "notify_caregivers"
    | "trigger_emergency_escalation"
    | "browser_order"
    | "browse_and_shop"
    | "book_ride"
    | "ride_status"
    | "cancel_ride";

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
            const candidates = rankCatalogHits(query, search.items, "swiggy", 10);
            return {
                partner: "swiggy",
                addressId: search.addressId,
                error: search.error,
                items: search.items.slice(0, 10),
                candidates,
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
            const candidates = rankCatalogHits(query, search.items, "instamart", 10);
            return {
                partner: "instamart",
                addressId: search.addressId,
                error: search.error,
                items: search.items.slice(0, 10),
                candidates,
            };
        }
        case "quick_order": {
            // When COMMERCE_BROWSER_FIRST (default ON), steer Instamart/Swiggy/Zepto to browser_order.
            // MCP quick_order remains available when flag is off.
            const qoMessage = String(input.args.message ?? "");
            const { resolveSiteFromMessage } = await import("./commerceAutomation/siteResolve");
            const { shouldPreferBrowserForPartner } = await import(
                "./commerceAutomation/commerceBrowserFirst"
            );
            const site = resolveSiteFromMessage(qoMessage);
            if (shouldPreferBrowserForPartner(site.siteKey)) {
                // Browser-first place path — but SEARCH guest/MCP catalog before login.
                const { resolvePlaybook, listSupportedBrowserSites, partnerLabel } = await import(
                    "./commerceAutomation/playbooks"
                );
                const { searchGuestCatalog, formatGuestCatalogConfirmCopy } = await import(
                    "./commerceAutomation/guestCatalogSearch.service"
                );
                const partner =
                    site.siteKey === "generic"
                        ? ("generic" as const)
                        : (site.siteKey as import("./commerceAutomation/types").CommercePartnerKey);
                const playbook = resolvePlaybook(partner, qoMessage, site.startUrl);
                const query = qoMessage
                    .replace(
                        /\b(order|buy|get|purchase|shop|from|on|via|at|please|for|me)\b/gi,
                        " ",
                    )
                    .replace(new RegExp(String(playbook.partner).replace(/_/g, "\\s*"), "ig"), " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 80) || qoMessage.slice(0, 80);
                const catalog = await searchGuestCatalog({
                    partner: String(playbook.partner),
                    query,
                    familyId: input.familyId,
                    userId: input.actorUserId,
                });
                if (catalog.hits.length) {
                    return {
                        ok: true,
                        status: "need_sku_confirm",
                        path: "browser_guest_catalog",
                        message: formatGuestCatalogConfirmCopy({
                            partnerLabel: partnerLabel(String(playbook.partner)),
                            query,
                            hits: catalog.hits,
                        }),
                        siteKey: playbook.siteKey,
                        partner: playbook.partner,
                        startUrl: playbook.startUrl,
                        candidates: catalog.hits.slice(0, 3).map((h) => ({
                            id: h.id,
                            name: h.name,
                            pricePaise: h.pricePaise,
                            productUrl: h.productUrl,
                        })),
                        supportedSites: listSupportedBrowserSites(),
                        note: "Search-before-login. After elder confirms SKU, call browser_order with userConfirmed and exact product name.",
                    };
                }
                return {
                    ok: true,
                    status: "need_sku_confirm",
                    path: "browser_guest_catalog_unavailable",
                    message:
                        catalog.unavailableReason ||
                        `No live guest price yet for ${partnerLabel(String(playbook.partner))}. Ask confirm to open the site — never invent ₹.`,
                    siteKey: playbook.siteKey,
                    partner: playbook.partner,
                    startUrl: playbook.startUrl,
                    candidates: [],
                    supportedSites: listSupportedBrowserSites(),
                    note: "No guest catalog — do not open login until explicit confirm.",
                };
            }
            const { quickOrder } = await import("./orderKernel.service");
            return quickOrder({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: qoMessage,
                saheliSessionId: input.args.saheliSessionId
                    ? String(input.args.saheliSessionId)
                    : undefined,
            }) as Promise<Record<string, unknown>>;
        }
        case "confirm_and_place_order": {
            const { confirmAndPlaceOrder } = await import("./orderKernel.service");
            return confirmAndPlaceOrder({
                sessionId: String(input.args.sessionId ?? ""),
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                recipientUserId: input.recipientUserId,
            }) as Promise<Record<string, unknown>>;
        }
        case "ensure_order_session": {
            const { ensureOrderSession } = await import("./orderKernel.service");
            return ensureOrderSession({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: input.args.message ? String(input.args.message) : undefined,
                saheliSessionId: input.args.saheliSessionId
                    ? String(input.args.saheliSessionId)
                    : undefined,
            });
        }
        case "search_catalog": {
            const { searchOrderCatalog } = await import("./orderKernel.service");
            return searchOrderCatalog({
                sessionId: String(input.args.sessionId ?? ""),
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                query: String(input.args.query ?? ""),
            });
        }
        case "resolve_catalog_item": {
            const { resolveOrderCatalogItem } = await import("./orderKernel.service");
            return resolveOrderCatalogItem({
                sessionId: String(input.args.sessionId ?? ""),
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                query: input.args.query ? String(input.args.query) : undefined,
                candidateIndex:
                    input.args.candidateIndex != null
                        ? Number(input.args.candidateIndex)
                        : undefined,
                candidateId: input.args.candidateId ? String(input.args.candidateId) : undefined,
            });
        }
        case "add_to_order_cart": {
            const { addToOrderCart } = await import("./orderKernel.service");
            const rawItems = Array.isArray(input.args.items) ? input.args.items : [input.args];
            const items = rawItems.map((row: Record<string, unknown>) => ({
                query: row.query ? String(row.query) : undefined,
                candidateIndex:
                    row.candidateIndex != null ? Number(row.candidateIndex) : undefined,
                candidateId: row.candidateId ? String(row.candidateId) : undefined,
                quantity: row.quantity != null ? Number(row.quantity) : 1,
            }));
            return addToOrderCart({
                sessionId: String(input.args.sessionId ?? ""),
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                items,
            });
        }
        case "get_order_cart": {
            const { getOrderCart } = await import("./orderKernel.service");
            return getOrderCart({
                sessionId: String(input.args.sessionId ?? ""),
                familyId: input.familyId,
                actorUserId: input.actorUserId,
            });
        }
        case "submit_order_cart": {
            const { submitOrderCart } = await import("./orderKernel.service");
            return submitOrderCart({
                sessionId: String(input.args.sessionId ?? ""),
                familyId: input.familyId,
                actorUserId: input.actorUserId,
            });
        }
        case "select_order_address": {
            const { selectOrderSessionAddress } = await import("./orderKernel.service");
            return selectOrderSessionAddress({
                sessionId: String(input.args.sessionId ?? ""),
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                addressId: String(input.args.addressId ?? ""),
            });
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
                aiInitiated: true,
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
        case "get_today_schedule": {
            const { getScheduleDayStatuses } = await import("./careScheduleCompletion.service");
            const dateKey = input.args.dateKey ? String(input.args.dateKey) : undefined;
            const day = await getScheduleDayStatuses(
                input.familyId,
                input.recipientUserId,
                input.actorUserId,
                dateKey,
            );
            return {
                dateKey: day.dateKey,
                items: day.items,
                completedCount: day.completedCount,
                missedCount: day.missedCount,
                upcomingCount: day.upcomingCount,
                adherencePercent: day.adherencePercent,
            };
        }
        case "get_missed_tasks": {
            const { getScheduleDayStatuses } = await import("./careScheduleCompletion.service");
            const dateKey = input.args.dateKey ? String(input.args.dateKey) : undefined;
            const day = await getScheduleDayStatuses(
                input.familyId,
                input.recipientUserId,
                input.actorUserId,
                dateKey,
            );
            const missed = day.items.filter((i) => i.status === "missed" || i.status === "due");
            return {
                dateKey: day.dateKey,
                missed,
                missedCount: missed.length,
            };
        }
        case "get_family_briefing": {
            const { getRecipientBriefing } = await import("./saheli.service");
            const dateKey = input.args.dateKey ? String(input.args.dateKey) : undefined;
            const briefing = await getRecipientBriefing(
                input.familyId,
                input.recipientUserId,
                input.actorUserId,
                dateKey,
            );
            return {
                recipientName: briefing.recipientName,
                lastHeardAt: briefing.lastHeardAt,
                lastHeardLine: briefing.lastHeardLine,
                lastCheckInAt: briefing.lastCheckInAt,
                todayItems: briefing.todayItems,
                unconfirmedItems: briefing.unconfirmedItems,
                adherencePercent: briefing.adherencePercent,
                dateKey: briefing.dateKey,
            };
        }
        case "get_family_members": {
            const { getFamilyMembersList } = await import("./familyMember.service");
            const { formatFamilyRosterForAi } = await import("./saheliCaregiverFacts.service");
            const list = await getFamilyMembersList(input.familyId, input.actorUserId);
            return {
                familyName: list.familyName,
                members: list.members.map((m) => ({
                    userId: m.userId,
                    name: m.fullName || m.name,
                    role: m.roleLabel,
                    relationship: m.relationship,
                    phone:
                        m.phone && m.phoneCountryCode
                            ? `${m.phoneCountryCode} ${m.phone.replace(/\D/g, "")}`
                            : m.phone ?? null,
                    email: m.email,
                    status: m.status,
                })),
                rosterText: formatFamilyRosterForAi(list.members),
            };
        }
        case "search_zepto": {
            const query = String(input.args.query ?? "");
            const addressId = input.args.addressId ? String(input.args.addressId) : undefined;
            const commerceUserId =
                (await resolveFamilyMcpUserId(input.familyId, "zepto", input.actorUserId)) ??
                input.actorUserId;
            const search = await searchMcpProduct("zepto", input.familyId, commerceUserId, query, {
                addressId,
            });
            return {
                partner: "zepto",
                addressId: search.addressId,
                error: search.error,
                items: search.items.slice(0, 10),
            };
        }
        case "get_order_status": {
            const orderId = String(input.args.orderId ?? "");
            const filter = orderId
                ? { familyId: input.familyId, orderId }
                : { familyId: input.familyId, subjectUserId: input.recipientUserId };
            const order = await Order.findOne(filter).sort({ createdAt: -1 }).lean();
            if (!order) return { error: "No order found" };
            return {
                orderId: order.orderId,
                partner: order.partner,
                status: order.status,
                totalPaise: order.totalPaise,
                items: order.items,
                createdAt: order.createdAt?.toISOString?.() ?? null,
            };
        }
        case "suggest_reorder": {
            const last = await Order.findOne({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                status: { $nin: [OrderStatus.CANCELLED] },
            })
                .sort({ createdAt: -1 })
                .lean();
            if (!last) return { error: "No previous order to repeat" };
            const message = last.items.map((i) => `${i.name}`).join(", ");
            const { startOrderFlow } = await import("./orderOrchestrator.service");
            const flow = await startOrderFlow({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: `order ${message} from ${last.partner}`,
                aiInitiated: true,
            });
            return flow
                ? { status: "order_flow", orderFlow: flow, message: flow.message }
                : { error: "Could not start reorder flow" };
        }
        case "save_memory": {
            const { aiInboxMemory } = await import("../clients/aiEngine.client");
            const { ensureAiContext } = await import("./aiTenant.service");
            const ctx = await ensureAiContext(
                input.familyId,
                input.recipientUserId,
                "Care recipient",
            );
            const content = String(input.args.content ?? input.args.memory ?? "");
            if (!content.trim()) return { error: "content is required" };
            const result = await aiInboxMemory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                content: content.slice(0, 500),
                sourceRole: "saheli",
            });
            return { saved: true, fact_id: result.fact_id, message: "I'll remember that." };
        }
        case "mark_schedule_completed": {
            const { markScheduleCompleted } = await import("./saheliCareAction.service");
            return markScheduleCompleted({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                scheduleId: input.args.scheduleId ? String(input.args.scheduleId) : undefined,
                titleHint: input.args.title ? String(input.args.title) : undefined,
                dateKey: input.args.dateKey ? String(input.args.dateKey) : undefined,
                note: input.args.note ? String(input.args.note) : undefined,
            });
        }
        case "mark_schedule_missed": {
            const { markScheduleMissed } = await import("./saheliCareAction.service");
            return markScheduleMissed({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                scheduleId: input.args.scheduleId ? String(input.args.scheduleId) : undefined,
                titleHint: input.args.title ? String(input.args.title) : undefined,
                dateKey: input.args.dateKey ? String(input.args.dateKey) : undefined,
                note: input.args.note ? String(input.args.note) : undefined,
            });
        }
        case "log_vitals": {
            const { logVitals } = await import("./saheliCareAction.service");
            return logVitals({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind: String(input.args.kind ?? input.args.name ?? "Vitals"),
                value: String(input.args.value ?? ""),
                unit: input.args.unit ? String(input.args.unit) : undefined,
                note: input.args.note ? String(input.args.note) : undefined,
            });
        }
        case "log_dose": {
            const { logDose } = await import("./saheliCareAction.service");
            return logDose({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                medicineName: String(input.args.medicineName ?? input.args.name ?? ""),
                quantity: input.args.quantity ? String(input.args.quantity) : undefined,
                note: input.args.note ? String(input.args.note) : undefined,
            });
        }
        case "log_check_in": {
            const { logCheckIn } = await import("./saheliCareAction.service");
            return logCheckIn({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                mood: input.args.mood ? String(input.args.mood) : undefined,
                meals: input.args.meals ? String(input.args.meals) : undefined,
                sleep: input.args.sleep ? String(input.args.sleep) : undefined,
                pain: input.args.pain ? String(input.args.pain) : undefined,
                note: input.args.note ? String(input.args.note) : undefined,
            });
        }
        case "log_symptom": {
            const { logSymptom } = await import("./saheliCareAction.service");
            return logSymptom({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                symptom: String(input.args.symptom ?? input.args.pain ?? input.args.note ?? ""),
                severity: input.args.severity ? String(input.args.severity) : undefined,
                note: input.args.note ? String(input.args.note) : undefined,
            });
        }
        case "log_appointment_notes": {
            const { logAppointmentNotes } = await import("./saheliCareAction.service");
            return logAppointmentNotes({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                summary: String(input.args.summary ?? input.args.notes ?? ""),
                doctorName: input.args.doctorName ? String(input.args.doctorName) : undefined,
            });
        }
        case "get_upcoming_appointments": {
            const { getScheduleDayStatuses } = await import("./careScheduleCompletion.service");
            const day = await getScheduleDayStatuses(
                input.familyId,
                input.recipientUserId,
                input.actorUserId,
            );
            const appointments = day.items.filter((i) => i.type === "APPOINTMENT");
            return { dateKey: day.dateKey, appointments };
        }
        case "get_lab_trends": {
            const { getLabTrends } = await import("./labTrends.service");
            const marker = String(input.args.marker ?? input.args.name ?? "TSH");
            return getLabTrends(
                input.familyId,
                input.recipientUserId,
                input.actorUserId,
                marker,
                Number(input.args.limit ?? 12),
            );
        }
        case "get_abnormal_flags": {
            const { getAbnormalLabFlags } = await import("./saheliHealthAlert.service");
            return getAbnormalLabFlags(input.familyId, input.recipientUserId, input.actorUserId);
        }
        case "summarize_health_record": {
            const timeline = await getCareRecordContextForSaheli(
                input.familyId,
                input.recipientUserId,
                Number(input.args.limit ?? 30),
            );
            const { getScheduleDayStatuses } = await import("./careScheduleCompletion.service");
            const day = await getScheduleDayStatuses(
                input.familyId,
                input.recipientUserId,
                input.actorUserId,
            );
            return {
                careTimeline: timeline,
                todaySchedule: day.items,
                adherencePercent: day.adherencePercent,
            };
        }
        
        case "create_reminder": {
            const { createSaheliReminder } = await import("./saheliReminder.service");
            const textArg = String(input.args.text ?? input.args.message ?? "").trim();
            const timesRaw = input.args.times;
            const times = Array.isArray(timesRaw)
                ? timesRaw.map((t) => String(t))
                : typeof timesRaw === "string"
                  ? [timesRaw]
                  : undefined;
            const result = await createSaheliReminder({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                text: textArg,
                times,
                kind: input.args.kind === "hourly_window" ? "hourly_window" : undefined,
                windowStartMinutes:
                    input.args.windowStartMinutes != null
                        ? Number(input.args.windowStartMinutes)
                        : undefined,
                windowEndMinutes:
                    input.args.windowEndMinutes != null
                        ? Number(input.args.windowEndMinutes)
                        : input.args.windowEndMinutes === null
                          ? null
                          : undefined,
                stopConditionPhrase: input.args.stopConditionPhrase
                    ? String(input.args.stopConditionPhrase)
                    : undefined,
            });
            if (!result.ok) {
                return {
                    error: result.error,
                    askUser: result.askUser,
                    status: "needs_slot",
                };
            }
            return {
                status: "created",
                reminder: result.reminder,
                askUser: result.askUser,
            };
        }
        case "list_reminders": {
            const { listSaheliReminders } = await import("./saheliReminder.service");
            const reminders = await listSaheliReminders({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                status: input.args.status === "cancelled" || input.args.status === "completed"
                    ? (input.args.status as "cancelled" | "completed")
                    : "active",
            });
            return { reminders };
        }
        case "cancel_reminder": {
            const { cancelSaheliReminder } = await import("./saheliReminder.service");
            return await cancelSaheliReminder({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                reminderId: input.args.reminderId ? String(input.args.reminderId) : undefined,
                textHint: input.args.textHint ? String(input.args.textHint) : undefined,
            });
        }
case "notify_caregivers": {
            const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
            return notifyCaregivers({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: String(input.args.message ?? ""),
                urgency: (input.args.urgency as "low" | "medium" | "high") ?? "medium",
            });
        }
        case "trigger_emergency_escalation": {
            const { triggerEmergencyEscalation } = await import("./saheliEmergency.service");
            return triggerEmergencyEscalation({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: String(input.args.message ?? "Emergency"),
                channel: "whatsapp",
            });
        }


        case "book_ride": {
            const { bookRideTool } = await import("./rideBooking/rideWhatsApp.service");
            const { FamilyRole } = await import("../types/family.types");
            const User = (await import("../models/users.model")).default;
            const ChannelIdentity = (await import("../models/channelIdentity.model")).default;
            const { ChannelType } = await import("../types/careRecord.types");
            // Resolve actor WhatsApp phone for session draft
            let phone = String(input.args.phone ?? "").trim();
            if (!phone) {
                const ident = await ChannelIdentity.findOne({
                    userId: input.actorUserId,
                    channelType: ChannelType.WHATSAPP,
                })
                    .lean()
                    .catch(() => null);
                phone = String((ident as { channelIdentifier?: string } | null)?.channelIdentifier ?? "");
            }
            if (!phone) {
                const user = await User.findById(input.actorUserId).lean();
                const cc = (user as { phone?: { countryCode?: string; number?: string } } | null)?.phone?.countryCode;
                const num = (user as { phone?: { countryCode?: string; number?: string } } | null)?.phone?.number;
                if (cc && num) phone = `${cc}${num}`.replace(/^\+/, "");
            }
            if (!phone) {
                return { ok: false, error: "phone required to start ride WhatsApp session" };
            }
            const result = await bookRideTool({
                phone,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                recipientUserId: input.recipientUserId,
                actorRole: FamilyRole.CARE_RECIPIENT,
                message: String(input.args.message ?? input.args.goal ?? "book a cab"),
                pickup: input.args.pickup ? String(input.args.pickup) : undefined,
                drop: input.args.drop ? String(input.args.drop) : undefined,
                otp: input.args.otp ? String(input.args.otp) : undefined,
                userConfirmed: Boolean(input.args.userConfirmed),
            });
            return {
                ...result,
                note: "Confirm-before-book. Elder pastes Uber OTP in WhatsApp. Caregiver notify-only.",
            };
        }
        case "ride_status": {
            const { rideStatusTool } = await import("./rideBooking/rideWhatsApp.service");
            const ChannelIdentity = (await import("../models/channelIdentity.model")).default;
            const { ChannelType } = await import("../types/careRecord.types");
            let phone = String(input.args.phone ?? "").trim();
            if (!phone) {
                const ident = await ChannelIdentity.findOne({
                    userId: input.actorUserId,
                    channelType: ChannelType.WHATSAPP,
                })
                    .lean()
                    .catch(() => null);
                phone = String((ident as { channelIdentifier?: string } | null)?.channelIdentifier ?? "");
            }
            if (!phone) return { ok: false, error: "phone required" };
            return rideStatusTool(phone);
        }
        case "cancel_ride": {
            const { cancelRideTool } = await import("./rideBooking/rideWhatsApp.service");
            const ChannelIdentity = (await import("../models/channelIdentity.model")).default;
            const { ChannelType } = await import("../types/careRecord.types");
            let phone = String(input.args.phone ?? "").trim();
            if (!phone) {
                const ident = await ChannelIdentity.findOne({
                    userId: input.actorUserId,
                    channelType: ChannelType.WHATSAPP,
                })
                    .lean()
                    .catch(() => null);
                phone = String((ident as { channelIdentifier?: string } | null)?.channelIdentifier ?? "");
            }
            if (!phone) return { ok: false, error: "phone required" };
            return cancelRideTool(phone);
        }

        case "browser_order":
        case "browse_and_shop": {
            const message = String(input.args.message ?? input.args.goal ?? "").trim();
            if (!message) {
                return { ok: false, error: "message required — e.g. order oats from bigbasket" };
            }
            const { resolveSiteFromMessage } = await import("./commerceAutomation/siteResolve");
            const { resolvePlaybook, listSupportedBrowserSites, partnerLabel } = await import(
                "./commerceAutomation/playbooks"
            );
            const { runBrowserTask } = await import("./commerceAutomation/browserWorker.service");
            const forceBrowser = true; // this tool is the browser path
            const resolved = resolveSiteFromMessage(message, { forceBrowser });
            const partner =
                resolved.siteKey === "generic"
                    ? ("generic" as const)
                    : (resolved.siteKey as import("./commerceAutomation/types").CommercePartnerKey);
            const playbook = resolvePlaybook(partner, message, resolved.startUrl);
            const userConfirmed = Boolean(input.args.userConfirmed);
            const otp = input.args.otp ? String(input.args.otp) : undefined;

            // Search-before-login: guest/MCP catalog first unless already confirming or pasting OTP.
            if (!userConfirmed && !otp) {
                const { searchGuestCatalog, formatGuestCatalogConfirmCopy } = await import(
                    "./commerceAutomation/guestCatalogSearch.service"
                );
                const query = message
                    .replace(
                        /\b(order|buy|get|purchase|shop|from|on|via|at|please|for|me)\b/gi,
                        " ",
                    )
                    .replace(new RegExp(String(playbook.partner).replace(/_/g, "\\s*"), "ig"), " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 80) || message.slice(0, 80);
                const catalog = await searchGuestCatalog({
                    partner: String(playbook.partner),
                    query,
                    familyId: input.familyId,
                    userId: input.actorUserId,
                });
                if (catalog.hits.length) {
                    const copy = formatGuestCatalogConfirmCopy({
                        partnerLabel: partnerLabel(String(playbook.partner)),
                        query,
                        hits: catalog.hits,
                    });
                    return {
                        ok: true,
                        status: "need_sku_confirm",
                        path: "guest_catalog",
                        message: copy,
                        siteKey: playbook.siteKey,
                        partner: playbook.partner,
                        startUrl: playbook.startUrl,
                        candidates: catalog.hits.slice(0, 3).map((h) => ({
                            id: h.id,
                            name: h.name,
                            pricePaise: h.pricePaise,
                            productUrl: h.productUrl,
                        })),
                        supportedSites: listSupportedBrowserSites(),
                        note: "Search-before-login: show exact SKU+₹, wait for confirm, then call browser_order with userConfirmed=true (and exact product name in message).",
                    };
                }
                // Honest: no guest price — still do not open login until explicit confirm.
                return {
                    ok: true,
                    status: "need_sku_confirm",
                    path: "guest_catalog_unavailable",
                    message:
                        catalog.unavailableReason ||
                        `No live guest price for ${partnerLabel(String(playbook.partner))} yet. Ask the elder to reply confirm to open the site (OTP may follow), or try another name — never invent ₹.`,
                    siteKey: playbook.siteKey,
                    partner: playbook.partner,
                    startUrl: playbook.startUrl,
                    candidates: [],
                    supportedSites: listSupportedBrowserSites(),
                    note: "No guest catalog hit — do not invent prices; only open browser after explicit confirm.",
                };
            }

            const result = await runBrowserTask({
                familyId: input.familyId,
                userId: input.actorUserId,
                goal: message.slice(0, 240),
                partner: playbook.partner,
                startUrl: playbook.startUrl,
                otp,
                userConfirmed,
                deadlineMs: Number(process.env.BROWSER_TASK_DEADLINE_MS) || 28_000,
            });
            return {
                ok: result.status !== "error",
                status: result.status,
                message: result.message,
                siteKey: playbook.siteKey,
                partner: playbook.partner,
                startUrl: playbook.startUrl,
                mode: result.mode,
                confirm: result.confirm,
                healthAware: /Saheli tip/i.test(result.message),
                supportedSites: listSupportedBrowserSites(),
                note: "Primary path for Instamart/Swiggy/Zepto/Blinkit/Zomato is private browser (COMMERCE_BROWSER_FIRST). Search-before-login for SKU+₹; confirm-before-pay at checkout. MCP quick_order remains as fallback when flag off.",
            };
        }
        default:
            return { error: `Unknown tool: ${input.tool}` };
    }
}

