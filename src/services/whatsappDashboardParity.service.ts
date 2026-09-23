/**
 * Phase 3: WhatsApp ↔ Dashboard parity handlers (wave 1)
 * 
 * Deterministic handlers for common dashboard actions via WhatsApp:
 * 1. Connect/reconnect partner (Swiggy, Instamart, Zepto)
 * 2. Confirm/reject pending order or approval
 * 3. Order status ("where is my order?")
 * 4. Fix/forget memory by text
 * 5. Quiet hours / don't disturb
 * 6. Caregiver brief: "how is Amma?"
 */

import type { McpPartnerKey } from "../partners/mcp/types";
import { OrderPartner, OrderStatus } from "../types/careRecord.types";
import Order from "../models/order.model";

export type DashboardParityResult = {
    handled: boolean;
    reply?: string;
    interactiveButtons?: Array<{ id: string; title: string }>;
    interactiveList?: { title: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> };
};

const PARTNER_KEYWORDS: Record<McpPartnerKey, RegExp> = {
    swiggy: /\b(swiggy(?:\s+food)?|swiggi)\b/i,
    instamart: /\b(instamart|insta\s*mart)\b/i,
    zepto: /\b(zepto|zepeto)\b/i,
};

const CONNECT_INTENT = /\b(connect|link|setup|set\s*up|reconnect|re-?connect|add|enable)\b/i;
const STATUS_INTENT = /\b(status|state|connection|connected|linked)\b/i;

function detectPartner(text: string): McpPartnerKey | null {
    for (const [partner, regex] of Object.entries(PARTNER_KEYWORDS)) {
        if (regex.test(text)) return partner as McpPartnerKey;
    }
    return null;
}

function partnerLabel(partner: McpPartnerKey): string {
    if (partner === "swiggy") return "Swiggy Food";
    if (partner === "instamart") return "Instamart";
    return "Zepto";
}

/**
 * 1. Connect/reconnect partner handler
 */
export async function tryHandlePartnerConnect(input: {
    familyId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();
    
    if (!CONNECT_INTENT.test(text) && !STATUS_INTENT.test(text)) {
        return { handled: false };
    }

    const partner = detectPartner(text);
    if (!partner) {
        if (CONNECT_INTENT.test(text) || /\b(partner|delivery|app)\b/i.test(text)) {
            return {
                handled: true,
                reply: "Which partner do you want to connect?\n\n• *Swiggy* — food delivery\n• *Instamart* — groceries\n• *Zepto* — quick groceries",
                interactiveButtons: [
                    { id: "connect:swiggy", title: "Connect Swiggy" },
                    { id: "connect:instamart", title: "Connect Instamart" },
                    { id: "connect:zepto", title: "Connect Zepto" },
                ],
            };
        }
        return { handled: false };
    }

    const { listFamilyConnectedPartners } = await import("./commerceConnection.service");
    const connected = await listFamilyConnectedPartners(input.familyId, input.actorUserId);
    const isConnected = connected[partner];
    const label = partnerLabel(partner);

    if (STATUS_INTENT.test(text) && !CONNECT_INTENT.test(text)) {
        return {
            handled: true,
            reply: isConnected
                ? `✅ ${label} is connected and ready to use.`
                : `❌ ${label} is not connected yet. Say "connect ${partner}" to link your account.`,
        };
    }

    if (isConnected && /\b(reconnect|re-?connect)\b/i.test(text)) {
        const { disconnectMcp, startMcpConnect } = await import("../partners/mcp/mcpClient.service");
        await disconnectMcp(partner, input.familyId, input.actorUserId);
        const started = await startMcpConnect(partner, input.familyId, input.actorUserId);
        
        if (started.authorizationUrl) {
            return {
                handled: true,
                reply: `To reconnect ${label}, tap the button below to sign in with your ${label} account.`,
                interactiveButtons: [
                    { id: `connect_url:${started.authorizationUrl}`, title: `Connect ${label}` },
                ],
            };
        }
        return {
            handled: true,
            reply: `${label} connection reset. Please try connecting again from the Kavach dashboard.`,
        };
    }

    if (isConnected) {
        return {
            handled: true,
            reply: `✅ ${label} is already connected! You can order by saying what you want — e.g., "pizza from Swiggy" or "milk from Instamart".`,
        };
    }

    const { startMcpConnect } = await import("../partners/mcp/mcpClient.service");
    try {
        const started = await startMcpConnect(partner, input.familyId, input.actorUserId);
        
        if (started.authorizationUrl) {
            return {
                handled: true,
                reply: `To connect ${label}, tap the button below to sign in with your ${label} account.`,
                interactiveButtons: [
                    { id: `connect_url:${started.authorizationUrl}`, title: `Connect ${label}` },
                ],
            };
        }
        
        return {
            handled: true,
            reply: `${label} connected! You can now order by saying what you want.`,
        };
    } catch (err) {
        console.warn(`Partner connect failed for ${partner}:`, err);
        return {
            handled: true,
            reply: `Couldn't start ${label} connection. Please try from the Kavach dashboard or try again later.`,
        };
    }
}

/**
 * 2. Confirm/reject pending order handler
 */
export async function tryHandlePendingOrderAction(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    interactiveId?: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim().toLowerCase();
    const interactiveId = input.interactiveId?.trim() ?? "";

    const isConfirmIntent = /\b(approve|confirm|yes|haan|ha|ok|okay|accept|allow|ji)\b/i.test(text) ||
        interactiveId.startsWith("approve_order:");
    const isRejectIntent = /\b(reject|decline|cancel|no|nahi|naa|deny|refuse)\b/i.test(text) ||
        interactiveId.startsWith("reject_order:");
    const isPendingQuery = /\b(pending|waiting|approval|awaiting)\b/i.test(text) &&
        /\b(order|basket|approval)\b/i.test(text);

    if (!isConfirmIntent && !isRejectIntent && !isPendingQuery && !interactiveId.includes("order:")) {
        return { handled: false };
    }

    let orderId: string | undefined;
    const orderIdMatch = interactiveId.match(/order:([a-f0-9-]+)/i) || text.match(/order[:\s]+([a-f0-9-]+)/i);
    if (orderIdMatch) orderId = orderIdMatch[1];

    const pendingOrder = await Order.findOne({
        familyId: input.familyId,
        status: OrderStatus.AWAITING_APPROVAL,
        ...(orderId ? { orderId } : {}),
    }).sort({ createdAt: -1 }).lean();

    if (!pendingOrder) {
        if (isPendingQuery || isConfirmIntent || isRejectIntent) {
            return {
                handled: true,
                reply: "No pending orders waiting for approval right now.",
            };
        }
        return { handled: false };
    }

    if (isPendingQuery && !isConfirmIntent && !isRejectIntent) {
        const items = pendingOrder.items.map(i => `${i.name} ×${i.quantity}`).join(", ");
        const total = `₹${(pendingOrder.totalPaise / 100).toFixed(0)}`;
        const partnerName = pendingOrder.partner === OrderPartner.SWIGGY ? "Swiggy" :
            pendingOrder.partner === OrderPartner.INSTAMART ? "Instamart" : "Zepto";

        return {
            handled: true,
            reply: `*Pending ${partnerName} order* (${total}):\n${items}\n\nApprove or reject?`,
            interactiveButtons: [
                { id: `approve_order:${pendingOrder.orderId}`, title: "✅ Approve" },
                { id: `reject_order:${pendingOrder.orderId}`, title: "❌ Reject" },
            ],
        };
    }

    if (isConfirmIntent) {
        const { approveOrder } = await import("./order.service");
        try {
            await approveOrder(input.familyId, pendingOrder.orderId, input.actorUserId);
            const items = pendingOrder.items.map(i => i.name).join(", ");
            return {
                handled: true,
                reply: `✅ Order approved! ${items} — ₹${(pendingOrder.totalPaise / 100).toFixed(0)}. Placing now...`,
            };
        } catch (err) {
            return {
                handled: true,
                reply: `Couldn't approve the order. ${err instanceof Error ? err.message : "Try again."}`,
            };
        }
    }

    if (isRejectIntent) {
        const { rejectOrder } = await import("./order.service");
        try {
            await rejectOrder(input.familyId, pendingOrder.orderId, input.actorUserId);
            return {
                handled: true,
                reply: "❌ Order rejected. The basket has been cancelled.",
            };
        } catch (err) {
            return {
                handled: true,
                reply: `Couldn't reject the order. ${err instanceof Error ? err.message : "Try again."}`,
            };
        }
    }

    return { handled: false };
}

/**
 * 3. Order status handler ("where is my order?")
 */
export async function tryHandleOrderStatusQuery(input: {
    familyId: string;
    recipientUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim().toLowerCase();

    const isStatusQuery = /\b(where|status|track|tracking|update)\b/i.test(text) &&
        /\b(order|delivery|food|groceries|my)\b/i.test(text);
    const isSimpleStatus = /^(status|order\s*status|where'?s?\s+my\s+order)$/i.test(text.trim());

    if (!isStatusQuery && !isSimpleStatus) {
        return { handled: false };
    }

    const recentOrders = await Order.find({
        familyId: input.familyId,
        status: { $nin: [OrderStatus.CANCELLED] },
    })
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();

    if (!recentOrders.length) {
        return {
            handled: true,
            reply: "No recent orders found. Say what you'd like to order anytime!",
        };
    }

    const latest = recentOrders[0];
    const items = latest.items.map(i => `${i.name} ×${i.quantity}`).join(", ");
    const total = `₹${(latest.totalPaise / 100).toFixed(0)}`;
    const partnerName = latest.partner === OrderPartner.SWIGGY ? "Swiggy" :
        latest.partner === OrderPartner.INSTAMART ? "Instamart" : "Zepto";

    const statusLabels: Record<string, string> = {
        [OrderStatus.AWAITING_APPROVAL]: "⏳ Waiting for approval",
        [OrderStatus.APPROVED]: "✅ Approved, placing order...",
        [OrderStatus.PAID]: "🛵 On the way",
        [OrderStatus.DELIVERED]: "📦 Delivered",
        [OrderStatus.CANCELLED]: "❌ Cancelled",
    };

    const statusLabel = statusLabels[latest.status] ?? latest.status.replace(/_/g, " ");

    return {
        handled: true,
        reply: `*Latest ${partnerName} order* (${total}):\n${items}\n\n*Status:* ${statusLabel}`,
    };
}

/**
 * 4. Memory fix/forget handler
 */
export async function tryHandleMemoryAction(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();

    const forgetMatch = text.match(/\b(?:forget|remove|delete|erase)\s+(?:that\s+)?(?:memory\s+)?(?:about\s+)?["']?(.+?)["']?\s*$/i) ||
        text.match(/\b(?:don'?t|do\s+not)\s+remember\s+(?:that\s+)?["']?(.+?)["']?\s*$/i);
    
    const fixMatch = text.match(/\b(?:fix|correct|update|change)\s+(?:memory\s+)?(?:about\s+)?["']?(.+?)["']?\s+to\s+["']?(.+?)["']?\s*$/i) ||
        text.match(/\b(?:actually|it'?s)\s+["']?(.+?)["']?\s*(?:not|,\s*not)\s+["']?(.+?)["']?\s*$/i);

    const rememberMatch = text.match(/\b(?:remember|save|note)\s+(?:that\s+)?["']?(.+?)["']?\s*$/i);

    if (!forgetMatch && !fixMatch && !rememberMatch) {
        return { handled: false };
    }

    const { ensureAiContext } = await import("./aiTenant.service");
    let ctx;
    try {
        ctx = await ensureAiContext(input.familyId, input.recipientUserId, "Elder");
    } catch (err) {
        return {
            handled: true,
            reply: "Memory system is not available right now. Try again later.",
        };
    }

    if (forgetMatch) {
        const query = forgetMatch[1].trim();
        if (query.length < 3) {
            return {
                handled: true,
                reply: "Please tell me what you'd like me to forget — e.g., 'forget that I like tea'.",
            };
        }

        const { aiGrepMemory, aiForgetMemory } = await import("../clients/aiEngine.client");
        try {
            const grep = await aiGrepMemory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                query,
                limit: 1,
            });

            if (!grep.hits.length) {
                return {
                    handled: true,
                    reply: `I don't have any memory about "${query}" to forget.`,
                };
            }

            const hit = grep.hits[0];
            await aiForgetMemory({
                factId: hit.slug,
                forgottenBy: input.actorUserId,
            });

            return {
                handled: true,
                reply: `Done — I've forgotten about "${hit.title}".`,
            };
        } catch (err) {
            console.warn("Memory forget failed:", err);
            return {
                handled: true,
                reply: "Couldn't forget that memory. Try again later.",
            };
        }
    }

    if (fixMatch) {
        const [, oldValue, newValue] = fixMatch;
        if (!oldValue?.trim() || !newValue?.trim()) {
            return {
                handled: true,
                reply: "Please tell me what to fix — e.g., 'fix my birthday to March 15'.",
            };
        }

        const { aiGrepMemory, aiCorrectMemory } = await import("../clients/aiEngine.client");
        try {
            const grep = await aiGrepMemory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                query: oldValue.trim(),
                limit: 1,
            });

            if (!grep.hits.length) {
                return {
                    handled: true,
                    reply: `I don't have any memory about "${oldValue.trim()}" to fix.`,
                };
            }

            const hit = grep.hits[0];
            await aiCorrectMemory({
                factId: hit.slug,
                replacementContent: newValue.trim(),
                actorUserId: input.actorUserId,
                sourceRole: "elder",
            });

            return {
                handled: true,
                reply: `Done — I've updated "${hit.title}" to "${newValue.trim()}".`,
            };
        } catch (err) {
            console.warn("Memory fix failed:", err);
            return {
                handled: true,
                reply: "Couldn't fix that memory. Try again later.",
            };
        }
    }

    if (rememberMatch) {
        const content = rememberMatch[1].trim();
        if (content.length < 3) {
            return {
                handled: true,
                reply: "Please tell me what you'd like me to remember — e.g., 'remember that I like walks in the evening'.",
            };
        }

        const { aiInboxMemory } = await import("../clients/aiEngine.client");
        try {
            await aiInboxMemory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                content,
                sourceRole: "elder",
            });

            return {
                handled: true,
                reply: `I'll remember that: "${content}"`,
            };
        } catch (err) {
            console.warn("Memory save failed:", err);
            return {
                handled: true,
                reply: "Couldn't save that memory. Try again later.",
            };
        }
    }

    return { handled: false };
}

/**
 * 5. Quiet hours / DND handler
 */
export async function tryHandleQuietHours(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim().toLowerCase();

    const isDndIntent = /\b(quiet|silent|dnd|do\s*not\s*disturb|don'?t\s*disturb|mute|pause)\b/i.test(text);
    const isQueryIntent = /\b(what|when|check|show|current)\b/i.test(text) && isDndIntent;
    const isOffIntent = /\b(off|disable|remove|clear|unmute|resume)\b/i.test(text) && isDndIntent;

    if (!isDndIntent) {
        return { handled: false };
    }

    const { getCompanionProfile, updateCompanionProfile, isWithinQuietHours } = await import("./saheliCompanion.service");
    const profile = await getCompanionProfile(input.familyId, input.recipientUserId);

    if (isQueryIntent) {
        const hasQuietHours = profile.quietHoursStart && profile.quietHoursEnd;
        const withinQuiet = isWithinQuietHours(profile);
        
        if (hasQuietHours) {
            return {
                handled: true,
                reply: `Quiet hours: ${profile.quietHoursStart} to ${profile.quietHoursEnd}.\n${withinQuiet ? "You're currently in quiet hours." : "Not in quiet hours right now."}`,
            };
        }
        return {
            handled: true,
            reply: "No quiet hours set. Say 'quiet hours 10pm to 7am' to set them.",
        };
    }

    if (isOffIntent) {
        await updateCompanionProfile(input.familyId, input.recipientUserId, input.actorUserId, {
            quietHoursStart: "",
            quietHoursEnd: "",
        });
        return {
            handled: true,
            reply: "Quiet hours turned off. I'll reach out anytime now.",
        };
    }

    const timeMatch = text.match(/(\d{1,2})\s*(?::|\.)?(\d{2})?\s*(am|pm)?\s*(?:to|-)\s*(\d{1,2})\s*(?::|\.)?(\d{2})?\s*(am|pm)?/i) ||
        text.match(/from\s+(\d{1,2})\s*(am|pm)?\s+to\s+(\d{1,2})\s*(am|pm)?/i);

    if (timeMatch) {
        let startHour = parseInt(timeMatch[1], 10);
        const startMinute = parseInt(timeMatch[2] || "0", 10);
        const startAmPm = (timeMatch[3] || "").toLowerCase();
        let endHour = parseInt(timeMatch[4], 10);
        const endMinute = parseInt(timeMatch[5] || "0", 10);
        const endAmPm = (timeMatch[6] || "").toLowerCase();

        if (startAmPm === "pm" && startHour !== 12) startHour += 12;
        if (startAmPm === "am" && startHour === 12) startHour = 0;
        if (endAmPm === "pm" && endHour !== 12) endHour += 12;
        if (endAmPm === "am" && endHour === 12) endHour = 0;

        const startStr = `${startHour.toString().padStart(2, "0")}:${startMinute.toString().padStart(2, "0")}`;
        const endStr = `${endHour.toString().padStart(2, "0")}:${endMinute.toString().padStart(2, "0")}`;

        await updateCompanionProfile(input.familyId, input.recipientUserId, input.actorUserId, {
            quietHoursStart: startStr,
            quietHoursEnd: endStr,
        });

        return {
            handled: true,
            reply: `Quiet hours set: ${startStr} to ${endStr}. I won't message during these hours.`,
        };
    }

    if (/\b(night|evening)\b/i.test(text)) {
        await updateCompanionProfile(input.familyId, input.recipientUserId, input.actorUserId, {
            quietHoursStart: "22:00",
            quietHoursEnd: "07:00",
        });
        return {
            handled: true,
            reply: "Quiet hours set: 10 PM to 7 AM. I won't message during these hours.",
        };
    }

    return {
        handled: true,
        reply: "Tell me when you'd like quiet hours — e.g., 'quiet hours 10pm to 7am' or 'quiet hours at night'.",
    };
}

/**
 * 6. Caregiver brief handler ("how is Amma?")
 */
export async function tryHandleCaregiverBrief(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    recipientName?: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim().toLowerCase();

    const briefPatterns = [
        /\bhow\s+is\s+(\w+)\b/i,
        /\bhow'?s\s+(\w+)\b/i,
        /\bbrief\s+(?:on|about|for)\s+(\w+)\b/i,
        /\bupdate\s+(?:on|about|for)\s+(\w+)\b/i,
        /\b(\w+)\s+(?:ka|ki)\s+(?:khabar|haal)\b/i,
        /\b(mama|mummy|papa|amma|appa|nana|nani|dadi|dada|grandma|grandpa)\s*(?:kaisi|kaisa|kaise|theek)?\b/i,
    ];

    const elderTerms = ["mama", "mummy", "papa", "amma", "appa", "nana", "nani", "dadi", "dada", "grandma", "grandpa", "mom", "dad", "elder"];
    
    let matchedName: string | null = null;
    for (const pattern of briefPatterns) {
        const match = text.match(pattern);
        if (match?.[1]) {
            matchedName = match[1];
            break;
        }
    }

    if (!matchedName && !/\b(brief|update|how|khabar|haal)\b/i.test(text)) {
        return { handled: false };
    }

    if (matchedName && !elderTerms.some(term => matchedName!.toLowerCase().includes(term)) && 
        matchedName.toLowerCase() !== input.recipientName?.toLowerCase()) {
        return { handled: false };
    }

    const { generateCareBrief } = await import("./careBrief.service");
    try {
        const brief = await generateCareBrief(input.familyId, input.recipientUserId, input.actorUserId);
        
        const sections: string[] = [];
        sections.push(`*Care Brief for ${brief.subjectName}*\n`);
        
        if (brief.sections.narrative) {
            sections.push(brief.sections.narrative.slice(0, 500));
        }

        if (brief.sections.recentSignals?.length) {
            const signals = brief.sections.recentSignals.slice(0, 3)
                .map(s => `• ${s.title}: ${s.detail.slice(0, 80)}`)
                .join("\n");
            sections.push(`\n*Recent Notes:*\n${signals}`);
        }

        return {
            handled: true,
            reply: sections.join("\n").slice(0, 1500),
        };
    } catch (err) {
        console.warn("Care brief generation failed:", err);
        
        const { getRecipientBriefing } = await import("./saheli.service");
        try {
            const briefing = await getRecipientBriefing(
                input.familyId,
                input.recipientUserId,
                input.actorUserId,
            );

            const lines: string[] = [];
            lines.push(`*${briefing.recipientName}*\n`);

            if (briefing.lastHeardAt) {
                lines.push(`Last heard: ${briefing.lastHeardLine || "recently"}`);
            }

            if (briefing.todayItems?.length) {
                const completed = briefing.todayItems.filter(i => i.status === "completed").length;
                lines.push(`Today: ${completed}/${briefing.todayItems.length} tasks done`);
            }

            if (briefing.adherencePercent != null) {
                lines.push(`Adherence: ${briefing.adherencePercent}%`);
            }

            return {
                handled: true,
                reply: lines.join("\n"),
            };
        } catch {
            return {
                handled: true,
                reply: "Couldn't load the care brief right now. Try again later.",
            };
        }
    }
}

/**
 * Main dispatcher for Phase 3 WhatsApp handlers
 */
export async function tryHandleWhatsAppDashboardAction(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    interactiveId?: string;
    role: "caregiver" | "elder";
    recipientName?: string;
}): Promise<DashboardParityResult> {
    const orderStatus = await tryHandleOrderStatusQuery({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        text: input.text,
    });
    if (orderStatus.handled) return orderStatus;

    const memoryAction = await tryHandleMemoryAction({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        text: input.text,
    });
    if (memoryAction.handled) return memoryAction;

    const quietHours = await tryHandleQuietHours({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        text: input.text,
    });
    if (quietHours.handled) return quietHours;

    if (input.role === "caregiver") {
        const pendingOrder = await tryHandlePendingOrderAction({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            text: input.text,
            interactiveId: input.interactiveId,
        });
        if (pendingOrder.handled) return pendingOrder;

        const partnerConnect = await tryHandlePartnerConnect({
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            text: input.text,
        });
        if (partnerConnect.handled) return partnerConnect;

        const caregiverBrief = await tryHandleCaregiverBrief({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            text: input.text,
            recipientName: input.recipientName,
        });
        if (caregiverBrief.handled) return caregiverBrief;
    }

    return { handled: false };
}
