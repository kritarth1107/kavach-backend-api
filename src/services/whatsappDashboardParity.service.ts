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

    // "approved?", "is it approved", "approval status" → status query, NEVER auto-approve.
    const isApprovalStatusQuestion =
        /\b(approved\?|is\s+it\s+approved|was\s+it\s+approved|approval\s+status|order\s+approved\?|has\s+it\s+been\s+approved)\b/i.test(
            text,
        ) ||
        (/\bapproved\b/i.test(text) && /\?/.test(text)) ||
        (/^(approved|approval)\??$/i.test(text.trim()));

    const isConfirmIntent =
        !isApprovalStatusQuestion &&
        (/\b(approve|confirm|yes|haan|ha|ok|okay|accept|allow|ji)\b/i.test(text) ||
            interactiveId.startsWith("approve_order:"));
    const isRejectIntent = /\b(reject|decline|cancel|no|nahi|naa|deny|refuse)\b/i.test(text) ||
        interactiveId.startsWith("reject_order:");
    const isPendingQuery =
        isApprovalStatusQuestion ||
        (/\b(pending|waiting|approval|awaiting|approved)\b/i.test(text) &&
            /\b(order|basket|approval|status|approved)\b/i.test(text));

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
        const { approveOrder, payOrder } = await import("./order.service");
        try {
            await approveOrder(input.familyId, pendingOrder.orderId, input.actorUserId);
            const items = pendingOrder.items.map(i => i.name).join(", ");
            const amount = `₹${(pendingOrder.totalPaise / 100).toFixed(0)}`;
            try {
                const paid = await payOrder(
                    input.familyId,
                    pendingOrder.orderId,
                    input.actorUserId,
                    { partnerAddressId: pendingOrder.partnerAddressId },
                );
                if (paid.payment.paymentLink) {
                    return {
                        handled: true,
                        reply: `✅ Approved ${amount} (${items}). Complete payment here: ${paid.payment.paymentLink}`,
                    };
                }
                return {
                    handled: true,
                    reply: `✅ Approved and placed (${items}, ${amount}). I'll update you when it's on the way.`,
                };
            } catch (payErr) {
                return {
                    handled: true,
                    reply: `✅ Approved ${amount} (${items}), but checkout failed: ${
                        payErr instanceof Error ? payErr.message : "Try Pay from the dashboard."
                    }`,
                };
            }
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

    const isStatusQuery =
        (/\b(where|status|track|tracking|update)\b/i.test(text) &&
            /\b(order|delivery|food|groceries|my)\b/i.test(text)) ||
        /\b(approved\?|is\s+it\s+approved|was\s+it\s+approved|approval\s+status)\b/i.test(text) ||
        (/\bapproved\b/i.test(text) && /\?/.test(text));
    const isSimpleStatus = /^(status|order\s*status|where'?s?\s+my\s+order|approved\??)$/i.test(
        text.trim(),
    );

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
 * Returns the content to save only when the message is an explicit remember request.
 * Questions (ending in "?") and greetings never trigger a memory save.
 */
export function extractExplicitRememberContent(raw: string): string | null {
    const t = raw.trim();
    if (!t || /\?\s*$/.test(t)) return null;
    const lead = String.raw`^(?:(?:please|pls|plz|saheli|ji|and|also)[,\s]+)*`;
    const en = new RegExp(
        lead +
            String.raw`(?:remember|note\s+(?:this|that|down|it)|save\s+(?:this|that|it)|keep\s+in\s+mind)\s*(?:that\s+)?[:,\-]?\s*["']?(.+?)["']?[.!]*\s*$`,
        "i",
    );
    let m = t.match(en);
    if (m?.[1]) return m[1].trim();
    m = t.match(
        /^(?:saheli[,\s]+)?yaad\s+rakh(?:na|o|iye|na\s+ji)?\s*(?:ki\s+)?[:,\-]?\s*(.{3,})$/i,
    );
    if (m?.[1]) return m[1].trim();
    m = t.match(/^(.{3,}?)[,\s]+(?:ye\s+|yeh\s+)?yaad\s+rakh(?:na|o|iye)\b[\s.!]*$/i);
    if (m?.[1]) return m[1].trim();
    return null;
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

    // Explicit remember intent ONLY ("remember that…", "note this: …", "yaad rakhna ki …").
    // A loose \b(remember|save|note)\b match turned spoken questions like "sun sakte ho?"
    // into memory saves ("I'll remember that: …").
    const rememberContent = extractExplicitRememberContent(text);
    const rememberMatch = rememberContent ? ([text, rememberContent] as const) : null;

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

/**
 * Wave 2 parity: recent labs / "any new reports?"
 */
export async function tryHandleLabsQuery(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();
    const isLabs =
        /\b(labs?|lab\s*reports?|blood\s*report|reports?|test\s*results?)\b/i.test(text) &&
        /\b(new|latest|recent|any|show|list|kya|naya|report)\b/i.test(text);
    const isSimple =
        /^(any\s+new\s+reports?\??|new\s+labs?\??|lab\s*reports?\??)$/i.test(text);
    if (!isLabs && !isSimple) return { handled: false };

    const LabDocument = (await import("../models/labDocument.model")).default;
    const labs = await LabDocument.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
    })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

    if (!labs.length) {
        return {
            handled: true,
            reply: "No lab reports saved yet. Caregivers can upload them from the Kavach dashboard.",
        };
    }

    const lines = labs.map((d: any, i: number) => {
        const when = d.recordDate || (d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : "");
        return `${i + 1}. *${d.title || "Lab report"}*${when ? ` (${when})` : ""}`;
    });
    return {
        handled: true,
        reply: `*Recent lab reports*\n${lines.join("\n")}\n\nAsk about a specific test (e.g. "TSH") for values.`,
    };
}

/**
 * Wave 2 parity: today's care schedule / next meds
 */
export async function tryHandleCareScheduleQuery(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();
    const isSchedule =
        /\b(schedule|today'?s?\s+(meds?|medicines?|care)|next\s+(med|medicine|dose|reminder)|kya\s+lena|aaj\s+ki\s+dawai|medicine\s+list)\b/i.test(
            text,
        ) || /^(today'?s?\s+schedule|my\s+schedule|aaj\s+ka\s+schedule)\??$/i.test(text);
    if (!isSchedule) return { handled: false };

    const { getScheduleDayStatuses } = await import("./careScheduleCompletion.service");
    try {
        const day = await getScheduleDayStatuses(
            input.familyId,
            input.recipientUserId,
            input.actorUserId,
        );
        const items = day?.items ?? [];
        if (!items.length) {
            return {
                handled: true,
                reply: "No care schedule items for today. Caregivers can add medicines from the dashboard.",
            };
        }
        const upcoming = items.filter((i: any) => i.status === "upcoming" || i.status === "due");
        const done = items.filter((i: any) => i.status === "completed");
        const missed = items.filter((i: any) => i.status === "missed");
        const fmt = (arr: any[]) =>
            arr
                .slice(0, 6)
                .map((i) => `• ${i.time || "?"} — ${i.title}${i.status === "completed" ? " ✓" : ""}`)
                .join("\n");
        const parts: string[] = ["*Today's care schedule*"];
        if (upcoming.length) parts.push(`*Up next*\n${fmt(upcoming)}`);
        if (missed.length) parts.push(`*Missed*\n${fmt(missed)}`);
        if (done.length) parts.push(`*Done*\n${fmt(done)}`);
        if (parts.length === 1) parts.push(fmt(items));
        return { handled: true, reply: parts.join("\n\n") };
    } catch (err) {
        console.warn("Care schedule WA query failed:", err);
        return { handled: true, reply: "Couldn't load today's schedule right now. Try again in a bit." };
    }
}

/**
 * Wave 2 parity: list pending approvals (broader than one order)
 */
export async function tryHandlePendingApprovalsList(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();
    const isList =
        /\b(pending\s+approvals?|approvals?\s+pending|what'?s?\s+pending|list\s+approvals?|awaiting\s+approval|pending\s+orders?|approval\s+status|is\s+it\s+approved|was\s+it\s+approved)\b/i.test(
            text,
        ) ||
        (/^(approved)\??$/i.test(text.trim()));
    if (!isList) return { handled: false };

    const { listPendingApprovals } = await import("./order.service");
    try {
        const pending = await listPendingApprovals(input.familyId, input.actorUserId);
        const rows = Array.isArray(pending) ? pending : [];
        if (!rows.length) {
            return { handled: true, reply: "No pending approvals right now. You're all caught up." };
        }
        const lines = rows.slice(0, 5).map((o: any, i: number) => {
            const items = (o.items || []).map((it: any) => it.name).join(", ");
            const total = `₹${((o.totalPaise || 0) / 100).toFixed(0)}`;
            return `${i + 1}. ${o.partner || "Order"} — ${items || "basket"} (${total})`;
        });
        const first = rows[0];
        return {
            handled: true,
            reply: `*Pending approvals (${rows.length})*\n${lines.join("\n")}`,
            interactiveButtons: first?.orderId
                ? [
                      { id: `approve_order:${first.orderId}`, title: "✅ Approve 1st" },
                      { id: `reject_order:${first.orderId}`, title: "❌ Reject 1st" },
                  ]
                : undefined,
        };
    } catch (err) {
        console.warn("Pending approvals WA list failed:", err);
        return { handled: true, reply: "Couldn't load pending approvals right now." };
    }
}

/**
 * Wave 2 parity: simple set reminder via care schedule API
 */
export async function tryHandleSetReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();
    const looksLike =
        /\b(?:set|add|create)\s+(?:a\s+)?reminder\b/i.test(text) ||
        /\bremind\s+me\b/i.test(text) ||
        /\bevery\s+hour\b/i.test(text) ||
        /\b(yaad\s+dilao|yaad\s+dilana|yaad\s+rakhna|yaad\s+dila\s+dena)\b/i.test(text) ||
        /\b(mujhe|mere\s+ko).{0,60}\byaad\b/i.test(text);
    if (!looksLike) return { handled: false };

    const {
        createSaheliReminder,
        extractTimesFromText,
        parseHourlyWindow,
    } = await import("./saheliReminder.service");
    try {
        const window = parseHourlyWindow(text);
        const times = extractTimesFromText(text);
        const result = await createSaheliReminder({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            text,
            times: times.length ? times : undefined,
            kind: window.start != null || /\bevery\s+hour|hourly\b/i.test(text)
                ? "hourly_window"
                : "multi_time",
            windowStartMinutes: window.start,
            windowEndMinutes: window.end,
        });
        if (!result.ok) {
            return {
                handled: true,
                reply: result.askUser || result.error || "Couldn't set that reminder.",
            };
        }
        const rem = result.reminder;
        if (rem.kind === "hourly_window") {
            const fmt = (m: number | null) =>
                m == null
                    ? "?"
                    : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
            return {
                handled: true,
                reply: `I'll remind you every hour from ${fmt(rem.windowStartMinutes)} to ${fmt(rem.windowEndMinutes)}: *${rem.text}*${rem.stopConditionPhrase ? ` (until you say you ${rem.stopConditionPhrase})` : ""}.`,
            };
        }
        const when = (rem.times || []).join(" and ") || "the times you said";
        return {
            handled: true,
            reply: `Reminder set: *${rem.text}* at ${when}. I'll nudge when it's time${rem.stopConditionPhrase ? ` — say when you've ${rem.stopConditionPhrase} and I'll stop` : ""}.`,
        };
    } catch (err) {
        console.warn("Set reminder WA failed:", err);
        return {
            handled: true,
            reply: 'Couldn\'t set that reminder. Try e.g. "remind me at 6pm and 9pm until I say filled".',
        };
    }
}



/**
 * Wave 3: "Who is in my family?" — list joined members from family record (no inventing).
 */
export async function tryHandleFamilyWhoQuery(input: {
    familyId: string;
    actorUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();
    if (
        !/\bwho\s+is\s+in\s+my\s+family\b/i.test(text) &&
        !/\b(mere|meri)\s+family\s+(mein|me)\s+kaun\b/i.test(text) &&
        !/\bfamily\s+members?\b/i.test(text)
    ) {
        return { handled: false };
    }
    try {
        const { getFamilyMembersList } = await import("./familyMember.service");
        const { FamilyRole, FamilyMemberStatus } = await import("../types/family.types");
        const payload = await getFamilyMembersList(input.familyId, input.actorUserId);
        const lines = payload.members
            .filter((m) => m.status === FamilyMemberStatus.JOINED)
            .map((m) => {
                const role =
                    m.role === FamilyRole.CARE_RECIPIENT
                        ? "care recipient"
                        : m.role === FamilyRole.PRIMARY_CAREGIVER
                          ? "primary caregiver"
                          : m.role === FamilyRole.CO_CAREGIVER
                            ? "caregiver"
                            : String(m.role || "member");
                return `• ${m.name || "Member"} (${role})`;
            });
        if (!lines.length) {
            return { handled: true, reply: "I don't see family members listed yet in your care record." };
        }
        return {
            handled: true,
            reply: `Here's who I see in your family record:\n${lines.join("\n")}`,
        };
    } catch (err) {
        console.warn("Family who query failed:", err);
        return {
            handled: true,
            reply: "I couldn't load your family list just now — try again in a moment.",
        };
    }
}

/**
 * Wave 3: out-of-domain / bill exactness without inventing care facts.
 */
export async function tryHandleCompanionGuardrails(input: {
    familyId: string;
    recipientUserId: string;
    text: string;
}): Promise<DashboardParityResult> {
    const text = input.text.trim();
    const lower = text.toLowerCase();

    if (/\bweather\b/i.test(lower) && /\b(mars|jupiter|moon|venus|saturn)\b/i.test(lower)) {
        return {
            handled: true,
            reply:
                "I'm your care companion — I don't have weather on Mars. I'm right here for how you're feeling, reminders, or family updates.",
        };
    }

    if (
        (/\b(last\s+bill|bill\s+exact|exact(ly)?\s+(is|was)|how\s+much\s+(is|was)\s+my)\b/i.test(lower) &&
            /\b(bill|order|paid|cost|price|total)\b/i.test(lower)) ||
        /\bhow\s+much\s+is\s+my\s+last\s+bill\b/i.test(lower)
    ) {
        try {
            const OrderModel = (await import("../models/order.model")).default;
            const latest = await OrderModel.findOne({
                familyId: input.familyId,
                status: { $nin: [OrderStatus.CANCELLED] },
            })
                .sort({ createdAt: -1 })
                .lean();
            if (!latest) {
                return {
                    handled: true,
                    reply:
                        "I don't invent bill amounts. I don't see a recent saved order in your care record — check the dashboard or ask your caregiver.",
                };
            }
            const partnerName =
                latest.partner === OrderPartner.SWIGGY
                    ? "Swiggy"
                    : latest.partner === OrderPartner.INSTAMART
                      ? "Instamart"
                      : "Zepto";
            const total = `₹${(latest.totalPaise / 100).toFixed(0)}`;
            return {
                handled: true,
                reply: `From your last saved ${partnerName} order in the care record: *${total}* (status: ${String(latest.status).replace(/_/g, " ")}). I won't invent amounts beyond what's saved.`,
            };
        } catch (err) {
            console.warn("Bill exact query failed:", err);
            return {
                handled: true,
                reply:
                    "I don't invent bill amounts. Please check the dashboard or ask your caregiver for the exact figure.",
            };
        }
    }

    return { handled: false };
}

export async function tryHandleWhatsAppDashboardAction(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    interactiveId?: string;
    role: "caregiver" | "elder";
    recipientName?: string;
}): Promise<DashboardParityResult> {
    const familyWho = await tryHandleFamilyWhoQuery({
        familyId: input.familyId,
        actorUserId: input.actorUserId,
        text: input.text,
    });
    if (familyWho.handled) return familyWho;

    const guardrails = await tryHandleCompanionGuardrails({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        text: input.text,
    });
    if (guardrails.handled) return guardrails;

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

    const labsQuery = await tryHandleLabsQuery({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        text: input.text,
    });
    if (labsQuery.handled) return labsQuery;

    const scheduleQuery = await tryHandleCareScheduleQuery({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        text: input.text,
    });
    if (scheduleQuery.handled) return scheduleQuery;

    const setReminder = await tryHandleSetReminder({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        text: input.text,
    });
    if (setReminder.handled) return setReminder;

    if (input.role === "caregiver") {
        const pendingApprovalsList = await tryHandlePendingApprovalsList({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            text: input.text,
        });
        if (pendingApprovalsList.handled) return pendingApprovalsList;

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
