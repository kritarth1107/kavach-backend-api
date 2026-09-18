import config from "../config/app.config";
import { isMetaWhatsAppEnabled } from "../clients/metaWhatsApp.client";

const MAX_EVENTS = 100;

export type WhatsAppWebhookLogEntry = {
    id: string;
    receivedAt: string;
    objectType: string;
    changeFields: string[];
    messagesParsed: number;
    statusesParsed: number;
    inbound: Array<{ from: string; text: string; messageId?: string }>;
    statuses: Array<{ recipientId?: string; status?: string; messageId?: string }>;
    replySent: boolean;
    replyPreview?: string;
    replyTo?: string;
    error?: string;
    sendError?: string;
    likelySynthetic?: boolean;
    metaEnabled: boolean;
    processed: number;
    rawSummary: string;
};

const events: WhatsAppWebhookLogEntry[] = [];
let eventCounter = 0;

function redactPhone(value: string): string {
    const digits = value.replace(/\D/g, "");
    if (digits.length <= 4) return "****";
    return `${digits.slice(0, 2)}…${digits.slice(-4)}`;
}

function summarizePayload(body: unknown): {
    objectType: string;
    changeFields: string[];
    inbound: WhatsAppWebhookLogEntry["inbound"];
    statuses: WhatsAppWebhookLogEntry["statuses"];
    rawSummary: string;
} {
    if (!body || typeof body !== "object") {
        return {
            objectType: "invalid",
            changeFields: [],
            inbound: [],
            statuses: [],
            rawSummary: "non-object body",
        };
    }

    const root = body as Record<string, unknown>;
    const objectType = String(root.object ?? "unknown");
    const changeFields: string[] = [];
    const inbound: WhatsAppWebhookLogEntry["inbound"] = [];
    const statuses: WhatsAppWebhookLogEntry["statuses"] = [];

    const entries = Array.isArray(root.entry) ? root.entry : [];
    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const changes = Array.isArray((entry as Record<string, unknown>).changes)
            ? ((entry as Record<string, unknown>).changes as unknown[])
            : [];
        for (const change of changes) {
            if (!change || typeof change !== "object") continue;
            const row = change as Record<string, unknown>;
            const field = String(row.field ?? "unknown");
            changeFields.push(field);
            const value = row.value;
            if (!value || typeof value !== "object") continue;

            const messages = Array.isArray((value as Record<string, unknown>).messages)
                ? ((value as Record<string, unknown>).messages as unknown[])
                : [];
            for (const msg of messages) {
                if (!msg || typeof msg !== "object") continue;
                const m = msg as Record<string, unknown>;
                const from = String(m.from ?? "");
                const type = String(m.type ?? "");
                if (type === "text") {
                    const textObj = m.text as Record<string, unknown> | undefined;
                    const text = String(textObj?.body ?? "").trim();
                    if (from && text) {
                        inbound.push({
                            from: redactPhone(from),
                            text: text.slice(0, 120),
                            messageId: m.id ? String(m.id) : undefined,
                        });
                    }
                } else if (from) {
                    inbound.push({
                        from: redactPhone(from),
                        text: `[${type || "unknown"} message]`,
                        messageId: m.id ? String(m.id) : undefined,
                    });
                }
            }

            const statusRows = Array.isArray((value as Record<string, unknown>).statuses)
                ? ((value as Record<string, unknown>).statuses as unknown[])
                : [];
            for (const statusRow of statusRows) {
                if (!statusRow || typeof statusRow !== "object") continue;
                const s = statusRow as Record<string, unknown>;
                statuses.push({
                    recipientId: s.recipient_id ? redactPhone(String(s.recipient_id)) : undefined,
                    status: s.status ? String(s.status) : undefined,
                    messageId: s.id ? String(s.id) : undefined,
                });
            }
        }
    }

    const rawSummary = JSON.stringify(body).slice(0, 500);

    return { objectType, changeFields, inbound, statuses, rawSummary };
}

export function recordWhatsAppWebhookEvent(input: {
    body: unknown;
    messagesParsed: number;
    processed: number;
    replySent?: boolean;
    replyPreview?: string;
    replyTo?: string;
    error?: string;
    sendError?: string;
}): WhatsAppWebhookLogEntry {
    const summary = summarizePayload(input.body);
    const firstInbound = summary.inbound[0];
    const likelySynthetic =
        firstInbound?.text === "diag ping" ||
        firstInbound?.messageId === "wamid.test" ||
        firstInbound?.from.endsWith("9999");

    const entry: WhatsAppWebhookLogEntry = {
        id: `wa-${Date.now()}-${++eventCounter}`,
        receivedAt: new Date().toISOString(),
        objectType: summary.objectType,
        changeFields: summary.changeFields,
        messagesParsed: input.messagesParsed,
        statusesParsed: summary.statuses.length,
        inbound: summary.inbound,
        statuses: summary.statuses,
        replySent: input.replySent ?? false,
        replyPreview: input.replyPreview?.slice(0, 200),
        replyTo: input.replyTo ? redactPhone(input.replyTo) : undefined,
        error: input.error,
        sendError: input.sendError,
        likelySynthetic,
        metaEnabled: isMetaWhatsAppEnabled(),
        processed: input.processed,
        rawSummary: summary.rawSummary,
    };

    events.unshift(entry);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
    return entry;
}

export function listWhatsAppWebhookEvents(limit = 50): WhatsAppWebhookLogEntry[] {
    return events.slice(0, Math.min(limit, MAX_EVENTS));
}

export function getWhatsAppWebhookDebugSnapshot() {
    const meta = config.whatsapp.meta;
    return {
        provider: config.whatsapp.provider,
        metaEnabled: isMetaWhatsAppEnabled(),
        phoneNumberId: meta.phoneNumberId ? `${meta.phoneNumberId.slice(0, 4)}…` : null,
        wabaId: meta.wabaId ? `${meta.wabaId.slice(0, 4)}…` : null,
        graphVersion: meta.graphVersion,
        webhookVerifyTokenConfigured: Boolean(meta.webhookVerifyToken),
        accessTokenConfigured: Boolean(meta.accessToken),
        appSecretConfigured: Boolean(meta.appSecret),
        kavachNumber: config.whatsapp.kavachNumber,
        webhookUrl: "https://kavach-backend-303943038694.asia-south1.run.app/api/webhooks/whatsapp/meta",
        eventCount: events.length,
        latestEventAt: events[0]?.receivedAt ?? null,
        hint:
            events.length === 0
                ? "No webhook POSTs recorded yet on this instance. Send a WhatsApp message, then refresh. If still empty, Meta is not delivering to this URL."
                : events[0]?.messagesParsed === 0
                  ? "Meta is hitting the webhook but no text messages were parsed — check that the messages field is subscribed."
                  : null,
    };
}
