/** Meta Cloud API outbound message payloads (in-session / 24h window). */

export type MetaWhatsAppTextPayload = {
    type: "text";
    text: {
        body: string;
        preview_url?: boolean;
    };
};

export type MetaWhatsAppReplyButton = {
    type: "reply";
    reply: {
        id: string;
        title: string;
    };
};

export type MetaWhatsAppInteractiveButtonsPayload = {
    type: "interactive";
    interactive: {
        type: "button";
        body: { text: string };
        footer?: { text: string };
        action: {
            buttons: MetaWhatsAppReplyButton[];
        };
    };
};

export type MetaWhatsAppListRow = {
    id: string;
    title: string;
    description?: string;
};

export type MetaWhatsAppInteractiveListPayload = {
    type: "interactive";
    interactive: {
        type: "list";
        body: { text: string };
        footer?: { text: string };
        action: {
            button: string;
            sections: Array<{
                title?: string;
                rows: MetaWhatsAppListRow[];
            }>;
        };
    };
};

export type MetaWhatsAppInteractiveCtaPayload = {
    type: "interactive";
    interactive: {
        type: "cta_url";
        body: { text: string };
        footer?: { text: string };
        action: {
            name: "cta_url";
            parameters: {
                display_text: string;
                url: string;
            };
        };
    };
};

export type MetaWhatsAppImagePayload = {
    type: "image";
    image: {
        link: string;
        caption?: string;
    };
};

export type MetaWhatsAppDocumentPayload = {
    type: "document";
    document: {
        link: string;
        caption?: string;
        filename?: string;
    };
};

export type MetaWhatsAppPayload =
    | MetaWhatsAppTextPayload
    | MetaWhatsAppInteractiveButtonsPayload
    | MetaWhatsAppInteractiveListPayload
    | MetaWhatsAppInteractiveCtaPayload
    | MetaWhatsAppImagePayload
    | MetaWhatsAppDocumentPayload;

/** Hints for composing rich WhatsApp replies from routing / Saheli. */
export type WhatsAppReplyKind =
    | "guest_welcome"
    | "guest_followup"
    | "recipient_pick"
    | "order_flow"
    | "order_pending_approval"
    | "schedule_missed"
    | "companion"
    | "plain";

export type WhatsAppReplyContext = {
    kind?: WhatsAppReplyKind;
    orderFlow?: import("../services/orderOrchestrator.service").OrderFlowPayload;
    recipientOptions?: Array<{ userId: string; name: string }>;
    pendingOrder?: {
        partner: string;
        amount: string;
        itemList: string;
    };
    includeSaheliHeader?: boolean;
};
