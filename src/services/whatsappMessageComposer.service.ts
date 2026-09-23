import config from "../config/app.config";
import type { OrderFlowPayload } from "./orderOrchestrator.service";
import type {
    MetaWhatsAppPayload,
    WhatsAppReplyContext,
    WhatsAppReplyKind,
} from "../types/whatsappMessage.types";
import type { OrderSessionCatalogItem } from "../models/orderSession.model";

const SAHELI_HEADER_IMAGE =
    process.env.WHATSAPP_SAHELI_HEADER_IMAGE?.trim() ||
    `${config.r2.publicUrl}/brand/saheli-whatsapp-header.png`;

function truncate(value: string, max: number): string {
    const trimmed = value.trim();
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

function formatRupee(paise: number): string {
    return `₹${(paise / 100).toFixed(0)}`;
}

function catalogItems(flow: OrderFlowPayload): OrderSessionCatalogItem[] {
    const cat = flow.catalog;
    if (!cat) return [];
    return [...(cat.restaurants ?? []), ...(cat.dishes ?? []), ...(cat.products ?? [])];
}

export function buildGuestWelcomeMessages(isFirstTurn: boolean): MetaWhatsAppPayload[] {
    const line = config.whatsapp.kavachNumber;
    if (isFirstTurn) {
        return [
            {
                type: "image",
                image: {
                    link: SAHELI_HEADER_IMAGE,
                    caption: "Saheli — your family companion on WhatsApp 💚",
                },
            },
            {
                type: "interactive",
                interactive: {
                    type: "cta_url",
                    body: {
                        text: truncate(
                            `Hi! I'm Saheli — Kavach's family companion on WhatsApp.\n\nI help with gentle check-ins, care reminders, and ordering from Swiggy, Instamart, or Zepto.\n\nOur line: ${line}`,
                            1024,
                        ),
                    },
                    footer: { text: "No extra setup — message me anytime." },
                    action: {
                        name: "cta_url",
                        parameters: {
                            display_text: "Join on Kavach",
                            url: "https://app.kavach.care",
                        },
                    },
                },
            },
            {
                type: "interactive",
                interactive: {
                    type: "button",
                    body: {
                        text: "How can I help you today?",
                    },
                    action: {
                        buttons: [
                            {
                                type: "reply",
                                reply: { id: "guest_learn", title: "What can you do?" },
                            },
                            {
                                type: "reply",
                                reply: { id: "guest_signup", title: "Sign me up" },
                            },
                        ],
                    },
                },
            },
        ];
    }

    return [
        {
            type: "text",
            text: {
                body: truncate(
                    `I don't recognise this number yet.\n\nSign up at app.kavach.care or ask your caregiver to invite you with the same mobile number you use on WhatsApp.`,
                    4096,
                ),
            },
        },
        {
            type: "interactive",
            interactive: {
                type: "cta_url",
                body: { text: "Get started with Kavach in a minute." },
                action: {
                    name: "cta_url",
                    parameters: {
                        display_text: "Open Kavach",
                        url: "https://app.kavach.care",
                    },
                },
            },
        },
    ];
}

export function buildRecipientPickMessages(
    recipients: Array<{ userId: string; name: string }>,
): MetaWhatsAppPayload[] {
    return [
        {
            type: "interactive",
            interactive: {
                type: "list",
                body: {
                    text: "Who are you asking about? Pick a care recipient and I'll answer about them.",
                },
                action: {
                    button: "Choose person",
                    sections: [
                        {
                            title: "Care recipients",
                            rows: recipients.slice(0, 10).map((r) => ({
                                id: `recipient:${r.userId}`,
                                title: truncate(r.name, 24),
                                description: "Ask Saheli about their care",
                            })),
                        },
                    ],
                },
            },
        },
    ];
}

export function buildOrderFlowMessages(flow: OrderFlowPayload): MetaWhatsAppPayload[] {
    const messages: MetaWhatsAppPayload[] = [];

    if (flow.phase === "select_address" && flow.addresses?.length) {
        const intro =
            flow.message?.trim() ||
            `Choose a delivery address for your ${flow.partnerLabel} order ("${flow.query}").`;
        messages.push({
            type: "interactive",
            interactive: {
                type: "list",
                body: {
                    text: truncate(intro, 1024),
                },
                footer: { text: "Or type cancel to stop." },
                action: {
                    button: "Pick address",
                    sections: [
                        {
                            title: "Saved addresses",
                            rows: flow.addresses.slice(0, 10).map((addr, i) => ({
                                id: `addr:${i}`,
                                title: truncate(addr.label, 24),
                                description: truncate(
                                    [addr.line1, addr.city, addr.pincode].filter(Boolean).join(", "),
                                    72,
                                ),
                            })),
                        },
                    ],
                },
            },
        });
        return messages;
    }

    if (!flow.sessionId && flow.connectUrl) {
        messages.push({
            type: "interactive",
            interactive: {
                type: "cta_url",
                body: {
                    text: truncate(
                        flow.message ??
                            `Connect ${flow.partnerLabel} so I can finish this order for you.`,
                        1024,
                    ),
                },
                action: {
                    name: "cta_url",
                    parameters: {
                        display_text: `Connect ${flow.partnerLabel}`,
                        url: flow.connectUrl,
                    },
                },
            },
        });
        return messages;
    }

    if (flow.phase === "browse") {
        const restaurants = flow.catalog?.restaurants ?? [];
        const items = catalogItems(flow);
        const cartHasItems = (flow.cartItems?.length ?? 0) > 0;
        const restaurantOnly =
            restaurants.length > 0 && !(flow.catalog?.dishes?.length || flow.catalog?.products?.length);

        if (restaurantOnly) {
            messages.push({
                type: "interactive",
                interactive: {
                    type: "list",
                    body: {
                        text: truncate(
                            `Here are restaurants for "${flow.query}" on ${flow.partnerLabel}. Tap one to see the menu.`,
                            1024,
                        ),
                    },
                    action: {
                        button: "See restaurants",
                        sections: [
                            {
                                title: flow.partnerLabel,
                                rows: restaurants.slice(0, 10).map((r, i) => ({
                                    id: `restaurant:${i}`,
                                    title: truncate(r.name, 24),
                                    description: r.restaurantName
                                        ? truncate(r.restaurantName, 72)
                                        : "View menu",
                                })),
                            },
                        ],
                    },
                },
            });
            return messages;
        }

        if (items.length) {
            const listBody = cartHasItems
                ? `Want to add more? Here are ${flow.partnerLabel} picks for "${flow.query}". Tap one to add.`
                : `Here are ${flow.partnerLabel} picks for "${flow.query}". Tap one to add to your basket.`;
            messages.push({
                type: "interactive",
                interactive: {
                    type: "list",
                    body: {
                        text: truncate(listBody, 1024),
                    },
                    action: {
                        button: cartHasItems ? "See items" : "Browse items",
                        sections: [
                            {
                                title: "Available now",
                                rows: items.slice(0, 10).map((item, i) => {
                                    const price =
                                        item.pricePaise && item.pricePaise > 0
                                            ? formatRupee(item.pricePaise)
                                            : "";
                                    return {
                                        id: `item:${i}`,
                                        title: truncate(item.name, 24),
                                        description: truncate(
                                            [price, item.restaurantName].filter(Boolean).join(" · "),
                                            72,
                                        ),
                                    };
                                }),
                            },
                        ],
                    },
                },
            });
            // Empty cart: list only — no "Happy with your basket?" CTA.
            // Cart already has items (e.g. Add more): short Place order / Cancel.
            if (cartHasItems) {
                messages.push({
                    type: "interactive",
                    interactive: {
                        type: "button",
                        body: {
                            text: truncate(
                                `Basket has ${flow.cartItems!.length} item${flow.cartItems!.length === 1 ? "" : "s"}. Ready when you are.`,
                                1024,
                            ),
                        },
                        action: {
                            buttons: [
                                {
                                    type: "reply",
                                    reply: { id: "confirm_order", title: "Place order" },
                                },
                                {
                                    type: "reply",
                                    reply: { id: "cancel_order", title: "Cancel" },
                                },
                            ],
                        },
                    },
                });
            }
            return messages;
        }
    }

    if (flow.phase === "review_cart" && flow.cartItems?.length) {
        let total = 0;
        const lines = flow.cartItems.map((item) => {
            const lineTotal = item.pricePaise * item.quantity;
            total += lineTotal;
            return `• ${item.name} ×${item.quantity} — ${formatRupee(lineTotal)}`;
        });
        messages.push({
            type: "text",
            text: {
                body: truncate(
                    `*Your ${flow.partnerLabel} basket*\n\n${lines.join("\n")}\n\n*Total:* ${formatRupee(total)}`,
                    4096,
                ),
            },
        });
        messages.push({
            type: "interactive",
            interactive: {
                type: "button",
                body: {
                    text: truncate(`Ready to place this ${flow.partnerLabel} order?`, 1024),
                },
                footer: { text: "Family approval may be needed for some orders." },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: { id: "confirm_order", title: "Place order" },
                        },
                        {
                            type: "reply",
                            reply: { id: "add_more", title: "Add more" },
                        },
                        {
                            type: "reply",
                            reply: { id: "cancel_order", title: "Cancel" },
                        },
                    ],
                },
            },
        });
        return messages;
    }

    // Other phases: include flow.message when present (avoid duplicating browse/review bodies).
    if (flow.message) {
        messages.push({
            type: "text",
            text: { body: truncate(flow.message, 4096) },
        });
    }

    if (flow.phase === "submitted") {
        let total = 0;
        const itemLines =
            flow.cartItems?.map((item) => {
                const lineTotal = item.pricePaise * item.quantity;
                total += lineTotal;
                return `• ${item.name} ×${item.quantity}`;
            }) ?? [];
        messages.push({
            type: "text",
            text: {
                body: truncate(
                    [
                        `✅ Order placed on ${flow.partnerLabel}`,
                        flow.orderId ? `Ref: ${flow.orderId}` : "",
                        itemLines.length ? `\n${itemLines.join("\n")}` : "",
                        total > 0 ? `\nTotal: ${formatRupee(total)}` : "",
                    ]
                        .filter(Boolean)
                        .join("\n"),
                    4096,
                ),
            },
        });
        messages.push({
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "I'll keep you posted on delivery updates." },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: { id: "order_status", title: "Track order" },
                        },
                    ],
                },
            },
        });
        return messages;
    }

    return messages;
}

export function buildPendingApprovalMessages(pending: {
    partner: string;
    amount: string;
    itemList: string;
}): MetaWhatsAppPayload[] {
    return [
        {
            type: "text",
            text: {
                body: truncate(
                    `🛒 *Pending ${pending.partner} order*\n${pending.itemList}\n*Total:* ${pending.amount}`,
                    4096,
                ),
            },
        },
        {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "Approve this basket for your family?" },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: { id: "approve_order", title: "Approve" },
                        },
                        {
                            type: "reply",
                            reply: { id: "reject_order", title: "Reject" },
                        },
                    ],
                },
            },
        },
    ];
}

/**
 * Phase 2: Quick order confirmation card
 */
export function buildQuickOrderConfirmMessages(input: {
    sessionId: string;
    partner: string;
    partnerLabel: string;
    items: Array<{ name: string; pricePaise: number; quantity: number }>;
    totalPaise: number;
    address: { label: string; line1?: string };
}): MetaWhatsAppPayload[] {
    const itemLines = input.items.map(
        (item) => `• ${item.name} ×${item.quantity} — ${formatRupee(item.pricePaise * item.quantity)}`,
    );

    return [
        {
            type: "text",
            text: {
                body: truncate(
                    [
                        `*${input.partnerLabel} order ready*`,
                        "",
                        ...itemLines,
                        "",
                        `*Total:* ${formatRupee(input.totalPaise)}`,
                        "",
                        `📍 *Deliver to:* ${input.address.label}${input.address.line1 ? ` — ${input.address.line1}` : ""}`,
                    ].join("\n"),
                    4096,
                ),
            },
        },
        {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "Place this order?" },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: {
                                id: `quick_confirm:${input.sessionId}`,
                                title: "✅ Confirm",
                            },
                        },
                        {
                            type: "reply",
                            reply: {
                                id: `quick_change_addr:${input.sessionId}`,
                                title: "📍 Change address",
                            },
                        },
                        {
                            type: "reply",
                            reply: { id: "cancel_order", title: "Cancel" },
                        },
                    ],
                },
            },
        },
    ];
}

/**
 * Phase 3: Interactive buttons from dashboard parity handlers
 */
export function buildInteractiveButtonMessages(
    text: string,
    buttons: Array<{ id: string; title: string }>,
): MetaWhatsAppPayload[] {
    if (buttons.length > 3) {
        return [
            { type: "text", text: { body: truncate(text, 4096) } },
            {
                type: "interactive",
                interactive: {
                    type: "list",
                    body: { text: "Choose an option" },
                    action: {
                        button: "Options",
                        sections: [
                            {
                                title: "Actions",
                                rows: buttons.slice(0, 10).map((b) => ({
                                    id: b.id,
                                    title: truncate(b.title, 24),
                                })),
                            },
                        ],
                    },
                },
            },
        ];
    }

    const messages: MetaWhatsAppPayload[] = [];
    
    const urlButton = buttons.find(b => b.id.startsWith("connect_url:"));
    if (urlButton) {
        const url = urlButton.id.replace("connect_url:", "");
        const otherButtons = buttons.filter(b => !b.id.startsWith("connect_url:"));
        
        messages.push({
            type: "interactive",
            interactive: {
                type: "cta_url",
                body: { text: truncate(text, 1024) },
                action: {
                    name: "cta_url",
                    parameters: {
                        display_text: truncate(urlButton.title, 20),
                        url,
                    },
                },
            },
        });
        
        if (otherButtons.length) {
            messages.push({
                type: "interactive",
                interactive: {
                    type: "button",
                    body: { text: "Other options" },
                    action: {
                        buttons: otherButtons.slice(0, 3).map((b) => ({
                            type: "reply" as const,
                            reply: { id: b.id, title: truncate(b.title, 20) },
                        })),
                    },
                },
            });
        }
        
        return messages;
    }

    return [
        {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: truncate(text, 1024) },
                action: {
                    buttons: buttons.slice(0, 3).map((b) => ({
                        type: "reply" as const,
                        reply: { id: b.id, title: truncate(b.title, 20) },
                    })),
                },
            },
        },
    ];
}

export function buildCareNudgeMessages(input: {
    text: string;
    nudgeKind: "pre_reminder" | "missed_followup" | "completion_praise" | "appointment_prep";
    scheduleId: string;
    title: string;
    time: string;
}): MetaWhatsAppPayload[] {
    const messages: MetaWhatsAppPayload[] = [
        { type: "text", text: { body: truncate(input.text, 4096) } },
    ];

    if (input.nudgeKind === "pre_reminder" || input.nudgeKind === "missed_followup") {
        messages.push({
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: truncate(`${input.title} (${input.time})`, 1024) },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: {
                                id: `done:${input.scheduleId}`,
                                title: "Done",
                            },
                        },
                        {
                            type: "reply",
                            reply: { id: "schedule_today", title: "Today's schedule" },
                        },
                        {
                            type: "reply",
                            reply: { id: "need_help", title: "Need help" },
                        },
                    ],
                },
            },
        });
    }

    return messages;
}

export function buildScheduleCompanionMessages(text: string): MetaWhatsAppPayload[] {
    const lower = text.toLowerCase();
    const isSchedule =
        /\b(miss(ed)?|schedule|medicine|meds|aaj|today|reminder)\b/i.test(lower);
    if (!isSchedule) return [];

    return [
        {
            type: "text",
            text: { body: truncate(text, 4096) },
        },
        {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "Anything else I can help with?" },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: { id: "schedule_today", title: "Today's schedule" },
                        },
                        {
                            type: "reply",
                            reply: { id: "order_help", title: "Order groceries" },
                        },
                        {
                            type: "reply",
                            reply: { id: "feeling_ok", title: "I'm doing fine" },
                        },
                    ],
                },
            },
        },
    ];
}

export function buildCompanionQuickActions(text: string): MetaWhatsAppPayload[] {
    if (text.length > 900) {
        return [{ type: "text", text: { body: truncate(text, 4096) } }];
    }

    return [
        {
            type: "text",
            text: { body: truncate(text, 4096) },
        },
        {
            type: "interactive",
            interactive: {
                type: "button",
                body: { text: "Quick actions" },
                action: {
                    buttons: [
                        {
                            type: "reply",
                            reply: { id: "schedule_today", title: "Today's schedule" },
                        },
                        {
                            type: "reply",
                            reply: { id: "order_help", title: "Order food" },
                        },
                        {
                            type: "reply",
                            reply: { id: "missed_today", title: "What did I miss?" },
                        },
                    ],
                },
            },
        },
    ];
}

export function composeWhatsAppReply(
    text: string,
    context: WhatsAppReplyContext = {},
): MetaWhatsAppPayload[] {
    const kind: WhatsAppReplyKind = context.kind ?? "plain";

    if (kind === "guest_welcome") {
        return buildGuestWelcomeMessages(true);
    }
    if (kind === "guest_followup") {
        return buildGuestWelcomeMessages(false);
    }
    if (kind === "recipient_pick" && context.recipientOptions?.length) {
        return buildRecipientPickMessages(context.recipientOptions);
    }
    if (kind === "order_flow" && context.orderFlow) {
        const rich = buildOrderFlowMessages(context.orderFlow);
        if (rich.length) return rich;
    }
    if (kind === "order_pending_approval" && context.pendingOrder) {
        return buildPendingApprovalMessages(context.pendingOrder);
    }
    if (kind === "schedule_missed") {
        const schedule = buildScheduleCompanionMessages(text);
        if (schedule.length) return schedule;
    }

    return [{ type: "text", text: { body: truncate(text, 4096) } }];
}

export function flattenWhatsAppPayloads(payloads: MetaWhatsAppPayload[]): string {
    return payloads
        .map((p) => {
            if (p.type === "text") return p.text.body;
            if (p.type === "image") return p.image.caption ?? "[image]";
            if (p.type === "document") return p.document.caption ?? "[document]";
            if (p.type === "interactive") {
                const body = p.interactive.body.text;
                if (p.interactive.type === "button") {
                    const labels = p.interactive.action.buttons
                        .map((b) => b.reply.title)
                        .join(" | ");
                    return `${body}\n[${labels}]`;
                }
                if (p.interactive.type === "list") {
                    return `${body}\n[${p.interactive.action.button}]`;
                }
                if (p.interactive.type === "cta_url") {
                    return `${body}\n[${p.interactive.action.parameters.display_text}]`;
                }
            }
            return "";
        })
        .filter(Boolean)
        .join("\n\n");
}
