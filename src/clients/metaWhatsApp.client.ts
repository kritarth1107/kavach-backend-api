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
        throw new Error(formatMetaSendError(res.status, body));
    }
}

export function formatMetaSendError(status: number, body: string): string {
    let detail = body.slice(0, 300);
    try {
        const parsed = JSON.parse(body) as {
            error?: { message?: string; code?: number; error_subcode?: number };
        };
        const err = parsed.error;
        if (err?.message) {
            detail = `${err.message}${err.code != null ? ` (code ${err.code})` : ""}${err.error_subcode != null ? ` sub ${err.error_subcode}` : ""}`;
        }
    } catch {
        // keep raw body slice
    }
    if (detail.includes("131030") || detail.includes("not in allowed list")) {
        return `Meta WhatsApp: recipient not on test allow-list or outside 24h window — ${detail}`;
    }
    return `Meta WhatsApp send failed (${status}): ${detail}`;
}

export type MetaInboundMessage = {
    from: string;
    text: string;
    messageId?: string;
};

export type MetaWabaSubscription = {
    id?: string;
    name?: string;
    link?: string;
};

export type MetaWhatsAppCredentialProbe = {
    phoneLookupOk: boolean;
    phoneDisplay?: string;
    phoneVerifiedName?: string;
    phoneLookupError?: string;
    tokenDebugOk: boolean;
    tokenAppId?: string;
    tokenType?: string;
    tokenScopes?: string[];
    tokenExpiresAt?: string | null;
    tokenDebugError?: string;
    sendEndpointOk: boolean;
    sendProbeError?: string;
    wabaSubscribedApps?: MetaWabaSubscription[];
    wabaAppSubscribed?: boolean;
    wabaSubscribeError?: string;
    diagnosis: string;
};

export async function listWabaSubscribedApps(): Promise<MetaWabaSubscription[]> {
    const meta = config.whatsapp.meta;
    if (!meta.wabaId || !meta.accessToken) return [];

    const res = await fetch(`${graphBase()}/${meta.wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${meta.accessToken}` },
    });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(formatMetaSendError(res.status, body));
    }
    const parsed = JSON.parse(body) as {
        data?: Array<{ whatsapp_business_api_data?: MetaWabaSubscription }>;
    };
    return (parsed.data ?? [])
        .map((row) => row.whatsapp_business_api_data)
        .filter((row): row is MetaWabaSubscription => Boolean(row?.id));
}

/** Required for real inbound message webhooks (Test button alone is not enough). */
export async function subscribeWabaToApp(): Promise<MetaWabaSubscription[]> {
    const meta = config.whatsapp.meta;
    if (!meta.wabaId || !meta.accessToken) {
        throw new Error("WHATSAPP_META_WABA_ID or access token not configured");
    }

    const res = await fetch(`${graphBase()}/${meta.wabaId}/subscribed_apps`, {
        method: "POST",
        headers: { Authorization: `Bearer ${meta.accessToken}` },
    });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(formatMetaSendError(res.status, body));
    }

    return listWabaSubscribedApps();
}

/** Live Graph API checks — does not send a message. */
export async function probeMetaWhatsAppCredentials(): Promise<MetaWhatsAppCredentialProbe> {
    const meta = config.whatsapp.meta;
    const result: MetaWhatsAppCredentialProbe = {
        phoneLookupOk: false,
        tokenDebugOk: false,
        sendEndpointOk: false,
        diagnosis: "",
    };

    if (!meta.phoneNumberId || !meta.accessToken) {
        result.diagnosis =
            "Missing WHATSAPP_META_PHONE_NUMBER_ID or WHATSAPP_META_ACCESS_TOKEN on the server.";
        return result;
    }

    try {
        const phoneRes = await fetch(
            `${graphBase()}/${meta.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
            { headers: { Authorization: `Bearer ${meta.accessToken}` } },
        );
        const phoneBody = await phoneRes.text();
        if (phoneRes.ok) {
            result.phoneLookupOk = true;
            try {
                const parsed = JSON.parse(phoneBody) as {
                    display_phone_number?: string;
                    verified_name?: string;
                };
                result.phoneDisplay = parsed.display_phone_number;
                result.phoneVerifiedName = parsed.verified_name;
            } catch {
                // ignore parse
            }
        } else {
            result.phoneLookupError = formatMetaSendError(phoneRes.status, phoneBody);
        }
    } catch (err) {
        result.phoneLookupError = err instanceof Error ? err.message : String(err);
    }

    if (meta.appId && meta.appSecret) {
        try {
            const debugRes = await fetch(
                `${graphBase()}/debug_token?input_token=${encodeURIComponent(meta.accessToken)}&access_token=${encodeURIComponent(`${meta.appId}|${meta.appSecret}`)}`,
            );
            const debugBody = await debugRes.text();
            if (debugRes.ok) {
                result.tokenDebugOk = true;
                try {
                    const parsed = JSON.parse(debugBody) as {
                        data?: {
                            app_id?: string;
                            type?: string;
                            scopes?: string[];
                            expires_at?: number;
                        };
                    };
                    const data = parsed.data;
                    result.tokenAppId = data?.app_id;
                    result.tokenType = data?.type;
                    result.tokenScopes = data?.scopes ?? [];
                    result.tokenExpiresAt =
                        data?.expires_at && data.expires_at > 0
                            ? new Date(data.expires_at * 1000).toISOString()
                            : null;
                } catch {
                    // ignore parse
                }
            } else {
                result.tokenDebugError = formatMetaSendError(debugRes.status, debugBody);
            }
        } catch (err) {
            result.tokenDebugError = err instanceof Error ? err.message : String(err);
        }
    } else {
        result.tokenDebugError = "WHATSAPP_META_APP_ID or WHATSAPP_META_APP_SECRET not set — cannot inspect token scopes.";
    }

    // Meta rejects invalid recipient; we only need to see if the phone-number-id accepts POST at all.
    try {
        const sendRes = await fetch(`${graphBase()}/${meta.phoneNumberId}/messages`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${meta.accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: "0000000000",
                type: "text",
                text: { body: "probe" },
            }),
        });
        const sendBody = await sendRes.text();
        if (sendRes.ok) {
            result.sendEndpointOk = true;
        } else {
            result.sendProbeError = formatMetaSendError(sendRes.status, sendBody);
            const lower = result.sendProbeError.toLowerCase();
            // These mean auth/scopes are OK — the probe used a fake recipient on purpose.
            if (
                lower.includes("recipient") ||
                lower.includes("131009") ||
                lower.includes("131030") ||
                lower.includes("131026") ||
                lower.includes("parameter value is not valid") ||
                lower.includes("phone number")
            ) {
                result.sendEndpointOk = true;
                result.sendProbeError = undefined;
            }
        }
    } catch (err) {
        result.sendProbeError = err instanceof Error ? err.message : String(err);
    }

    if (meta.wabaId && meta.accessToken) {
        try {
            result.wabaSubscribedApps = await listWabaSubscribedApps();
            result.wabaAppSubscribed = result.wabaSubscribedApps.some(
                (app) => app.id === meta.appId,
            );
        } catch (err) {
            result.wabaSubscribeError = err instanceof Error ? err.message : String(err);
        }
    }

    const scopes = result.tokenScopes ?? [];
    const hasMessagingScope =
        scopes.includes("whatsapp_business_messaging") ||
        scopes.includes("whatsapp_business_management");

    if (!result.phoneLookupOk) {
        result.diagnosis =
            "Access token cannot read the configured Phone Number ID — regenerate a System User token and confirm the ID in WhatsApp Manager → API Setup.";
    } else if (!result.sendEndpointOk) {
        result.diagnosis =
            "Token cannot POST to /messages on this Phone Number ID. Regenerate a System User token with whatsapp_business_messaging + whatsapp_business_management, then update Cloud Run via the set-whatsapp-gcp-env workflow.";
    } else if (result.tokenDebugOk && !hasMessagingScope) {
        result.diagnosis =
            `Token is valid but missing whatsapp_business_messaging scope (current: ${scopes.join(", ") || "none"}). Regenerate the System User token with messaging permissions.`;
    } else if (result.wabaAppSubscribed === false) {
        result.diagnosis =
            "App is Live and token is OK, but this WhatsApp Business Account is NOT subscribed to your app for real message webhooks. POST /api/webhooks/whatsapp/meta/subscribe-waba?verify_token=... once, then send HI again.";
    } else if (result.tokenExpiresAt) {
        result.diagnosis = `Token expires at ${result.tokenExpiresAt}. Send permission looks OK — if replies still fail, check Webhooks → Recent deliveries in Meta.`;
    } else {
        result.diagnosis =
            "Credentials and WABA subscription look OK. Send HI to +919203497046 — if debug stays empty, check Meta → Webhooks → Recent deliveries.";
    }

    return result;
}

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
