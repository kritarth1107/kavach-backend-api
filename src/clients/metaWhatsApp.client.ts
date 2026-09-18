import config from "../config/app.config";

export function isMetaWhatsAppEnabled(): boolean {
    const meta = config.whatsapp.meta;
    return (
        config.whatsapp.provider === "meta" &&
        Boolean(meta.phoneNumberId) &&
        Boolean(meta.accessToken)
    );
}

export function getMetaWebhookVerifyToken(): string {
    return config.whatsapp.meta.webhookVerifyToken;
}

function graphBase(): string {
    const version = config.whatsapp.meta.graphVersion || "v21.0";
    return `https://graph.facebook.com/${version}`;
}

/** Meta expects E.164 digits without + in the `to` field. */
function toMetaRecipient(e164: string): string {
    return e164.replace(/\D/g, "");
}

export async function sendViaMetaWhatsApp(to: string, text: string): Promise<void> {
    const meta = config.whatsapp.meta;
    if (!meta.phoneNumberId || !meta.accessToken) {
        throw new Error("Meta WhatsApp is not configured");
    }

    const res = await fetch(`${graphBase()}/${meta.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${meta.accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: toMetaRecipient(to),
            type: "text",
            text: { preview_url: false, body: text.slice(0, 4096) },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Meta WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`);
    }
}

export type MetaInboundMessage = {
    from: string;
    text: string;
    messageId?: string;
};

export function parseMetaWebhookMessages(body: unknown): MetaInboundMessage[] {
    if (!body || typeof body !== "object") return [];
    const root = body as Record<string, unknown>;
    if (root.object !== "whatsapp_business_account") return [];

    const entries = Array.isArray(root.entry) ? root.entry : [];
    const out: MetaInboundMessage[] = [];

    for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const changes = Array.isArray((entry as Record<string, unknown>).changes)
            ? ((entry as Record<string, unknown>).changes as unknown[])
            : [];
        for (const change of changes) {
            if (!change || typeof change !== "object") continue;
            const value = (change as Record<string, unknown>).value;
            if (!value || typeof value !== "object") continue;
            const messages = Array.isArray((value as Record<string, unknown>).messages)
                ? ((value as Record<string, unknown>).messages as unknown[])
                : [];
            for (const msg of messages) {
                if (!msg || typeof msg !== "object") continue;
                const row = msg as Record<string, unknown>;
                const from = String(row.from ?? "");
                const type = String(row.type ?? "");
                if (!from) continue;
                if (type === "text") {
                    const textObj = row.text as Record<string, unknown> | undefined;
                    const text = String(textObj?.body ?? "").trim();
                    if (text) {
                        out.push({
                            from,
                            text,
                            messageId: row.id ? String(row.id) : undefined,
                        });
                    }
                }
            }
        }
    }

    return out;
}
