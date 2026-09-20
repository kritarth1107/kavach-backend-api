import config from "../config/app.config";
import type { MetaWhatsAppPayload } from "../types/whatsappMessage.types";

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

export function getMetaWebhookPublicUrl(): string {
    const fromEnv = process.env.WHATSAPP_META_WEBHOOK_PUBLIC_URL?.trim();
    if (fromEnv) return fromEnv;
    return "https://kavach-backend-303943038694.asia-south1.run.app/api/webhooks/whatsapp/meta";
}

function appAccessToken(): string {
    const meta = config.whatsapp.meta;
    return `${meta.appId}|${meta.appSecret}`;
}

/** Meta expects E.164 digits without + in the `to` field. */
function toMetaRecipient(e164: string): string {
    return e164.replace(/\D/g, "");
}

const WHATSAPP_TEXT_LIMIT = 4096;

function splitWhatsAppText(text: string, limit = WHATSAPP_TEXT_LIMIT): string[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    if (trimmed.length <= limit) return [trimmed];

    const chunks: string[] = [];
    let rest = trimmed;
    while (rest.length > limit) {
        let splitAt = rest.lastIndexOf("\n\n", limit);
        if (splitAt < limit * 0.5) splitAt = rest.lastIndexOf("\n", limit);
        if (splitAt < limit * 0.5) splitAt = rest.lastIndexOf(" ", limit);
        if (splitAt < limit * 0.5) splitAt = limit;
        chunks.push(rest.slice(0, splitAt).trim());
        rest = rest.slice(splitAt).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

async function postMetaWhatsAppMarkRead(input: {
    messageId: string;
    showTyping: boolean;
}): Promise<boolean> {
    const meta = config.whatsapp.meta;
    if (!meta.phoneNumberId || !meta.accessToken) {
        return false;
    }

    const payload: Record<string, unknown> = {
        messaging_product: "whatsapp",
        status: "read",
        message_id: input.messageId,
    };
    if (input.showTyping) {
        payload.typing_indicator = { type: "text" };
    }

    const res = await fetch(`${graphBase()}/${meta.phoneNumberId}/messages`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${meta.accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(formatMetaSendError(res.status, body));
    }

    const parsed = (await res.json().catch(() => ({}))) as { success?: boolean };
    return parsed.success !== false;
}

/** Mark an inbound message read and optionally show the WhatsApp typing indicator. */
export async function markMetaWhatsAppInboundSeen(input: {
    messageId: string;
    showTyping?: boolean;
}): Promise<boolean> {
    const messageId = input.messageId.trim();
    if (!messageId) return false;

    const wantTyping = input.showTyping !== false;
    if (wantTyping) {
        try {
            return await postMetaWhatsAppMarkRead({ messageId, showTyping: true });
        } catch (err) {
            console.warn(
                "Meta WhatsApp read+typing failed, retrying read-only:",
                err instanceof Error ? err.message : err,
            );
        }
    }

    return postMetaWhatsAppMarkRead({ messageId, showTyping: false });
}

/** Re-send typing while Saheli composes a long reply (Meta clears typing after ~25s). */
export function startMetaWhatsAppTypingRefresh(messageId: string): () => void {
    if (!isMetaWhatsAppEnabled() || !messageId.trim()) {
        return () => undefined;
    }
    const intervalMs = Math.max(
        10_000,
        Number(process.env.WHATSAPP_TYPING_REFRESH_MS) || 20_000,
    );
    const timer = setInterval(() => {
        markMetaWhatsAppInboundSeen({ messageId, showTyping: true }).catch((err) => {
            console.warn(
                "Meta WhatsApp typing refresh failed:",
                err instanceof Error ? err.message : err,
            );
        });
    }, intervalMs);
    return () => clearInterval(timer);
}

async function sendSingleMetaWhatsAppText(to: string, text: string): Promise<void> {
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
            text: { preview_url: false, body: text.slice(0, WHATSAPP_TEXT_LIMIT) },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(formatMetaSendError(res.status, body));
    }
}

async function sendSingleMetaWhatsAppPayload(to: string, payload: MetaWhatsAppPayload): Promise<void> {
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
            ...payload,
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(formatMetaSendError(res.status, body));
    }
}

export async function sendWhatsAppPayloads(to: string, payloads: MetaWhatsAppPayload[]): Promise<void> {
    for (const payload of payloads) {
        if (payload.type === "text") {
            const parts = splitWhatsAppText(payload.text.body);
            for (const part of parts) {
                await sendSingleMetaWhatsAppText(to, part);
            }
            continue;
        }
        try {
            await sendSingleMetaWhatsAppPayload(to, payload);
        } catch (err) {
            if (payload.type === "image" || payload.type === "document") {
                console.warn("WhatsApp media send failed, falling back to text:", err);
                const caption =
                    payload.type === "image"
                        ? payload.image.caption
                        : payload.document.caption;
                if (caption) await sendSingleMetaWhatsAppText(to, caption);
                continue;
            }
            throw err;
        }
    }
}

export async function sendMetaWhatsAppTemplate(input: {
    to: string;
    templateName: string;
    languageCode?: string;
    bodyParameters?: string[];
}): Promise<void> {
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
            to: toMetaRecipient(input.to),
            type: "template",
            template: {
                name: input.templateName,
                language: { code: input.languageCode ?? "en" },
                components: input.bodyParameters?.length
                    ? [
                          {
                              type: "body",
                              parameters: input.bodyParameters.map((text) => ({
                                  type: "text",
                                  text,
                              })),
                          },
                      ]
                    : undefined,
            },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(formatMetaSendError(res.status, body));
    }
}

export async function sendViaMetaWhatsApp(
    to: string,
    text: string,
    payloads?: MetaWhatsAppPayload[],
): Promise<void> {
    if (payloads?.length) {
        await sendWhatsAppPayloads(to, payloads);
        return;
    }
    const parts = splitWhatsAppText(text);
    for (const part of parts) {
        await sendSingleMetaWhatsAppText(to, part);
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
    inboundType?: string;
    interactiveId?: string;
    mediaType?: string;
    mediaId?: string;
    mediaCaption?: string;
};

function normalizeInteractiveInboundId(id: string): string {
    const lower = id.toLowerCase();
    if (lower === "confirm_order" || lower === "add_more") return "confirm";
    if (lower === "cancel_order") return "cancel";
    if (lower === "approve_order") return "approve";
    if (lower === "reject_order") return "reject";
    if (lower === "schedule_today") return "what is my schedule today";
    if (lower === "missed_today") return "what did i miss today";
    if (lower === "order_help") return "order groceries from instamart";
    if (lower === "feeling_ok") return "I'm doing fine today";
    if (lower === "need_help") return "I need help please";
    if (lower === "order_status") return "what is my order status";

    const done = id.match(/^done:(.+)$/i);
    if (done) return `I completed schedule ${done[1]}`;
    if (lower === "guest_learn") return "what can you help me with";
    if (lower === "guest_signup") return "how do I sign up for kavach";

    const addr = id.match(/^addr:(\d+)$/i);
    if (addr) return String(Number(addr[1]) + 1);

    const item = id.match(/^item:(\d+)$/i);
    if (item) return String(Number(item[1]) + 1);

    const restaurant = id.match(/^restaurant:(\d+)$/i);
    if (restaurant) return String(Number(restaurant[1]) + 1);

    const recipient = id.match(/^recipient:(.+)$/i);
    if (recipient) return recipient[1]!;

    return id;
}

function extractInboundText(row: Record<string, unknown>): string {
    const type = String(row.type ?? "");
    if (type === "text") {
        const textObj = row.text as Record<string, unknown> | undefined;
        return String(textObj?.body ?? "").trim();
    }
    if (type === "interactive") {
        const interactive = row.interactive as Record<string, unknown> | undefined;
        const interactiveType = String(interactive?.type ?? "");
        if (interactiveType === "button_reply") {
            const reply = interactive?.button_reply as Record<string, unknown> | undefined;
            const id = String(reply?.id ?? reply?.title ?? "").trim();
            return normalizeInteractiveInboundId(id);
        }
        if (interactiveType === "list_reply") {
            const reply = interactive?.list_reply as Record<string, unknown> | undefined;
            const id = String(reply?.id ?? reply?.title ?? "").trim();
            return normalizeInteractiveInboundId(id);
        }
    }
    if (type === "button") {
        const button = row.button as Record<string, unknown> | undefined;
        const payload = String(button?.payload ?? button?.text ?? "").trim();
        if (payload) return normalizeInteractiveInboundId(payload);
    }
    if (type === "image") {
        const image = row.image as Record<string, unknown> | undefined;
        const caption = String(image?.caption ?? "").trim();
        return caption || "[image message]";
    }
    if (type === "document") {
        const doc = row.document as Record<string, unknown> | undefined;
        const caption = String(doc?.caption ?? "").trim();
        const filename = String(doc?.filename ?? "").trim();
        return caption || filename || "[document message]";
    }
    if (type === "audio" || type === "voice") return "[voice message]";
    if (type === "video") {
        const video = row.video as Record<string, unknown> | undefined;
        return String(video?.caption ?? "").trim() || "[video message]";
    }
    if (type === "location") return "[location shared]";
    if (type === "contacts") return "[contact shared]";
    return "";
}

function extractInboundMedia(row: Record<string, unknown>): {
    mediaType?: string;
    mediaId?: string;
    mediaCaption?: string;
} {
    const type = String(row.type ?? "");
    if (type === "image") {
        const image = row.image as Record<string, unknown> | undefined;
        return {
            mediaType: "image",
            mediaId: image?.id ? String(image.id) : undefined,
            mediaCaption: String(image?.caption ?? "").trim() || undefined,
        };
    }
    if (type === "document") {
        const doc = row.document as Record<string, unknown> | undefined;
        return {
            mediaType: "document",
            mediaId: doc?.id ? String(doc.id) : undefined,
            mediaCaption: String(doc?.caption ?? doc?.filename ?? "").trim() || undefined,
        };
    }
    if (type === "audio" || type === "voice") {
        const audio = (row.audio ?? row.voice) as Record<string, unknown> | undefined;
        return {
            mediaType: type === "voice" ? "voice" : "audio",
            mediaId: audio?.id ? String(audio.id) : undefined,
        };
    }
    if (type === "video") {
        const video = row.video as Record<string, unknown> | undefined;
        return {
            mediaType: "video",
            mediaId: video?.id ? String(video.id) : undefined,
            mediaCaption: String(video?.caption ?? "").trim() || undefined,
        };
    }
    return {};
}

export type MetaWabaSubscription = {
    id?: string;
    name?: string;
    link?: string;
    category?: string;
    overrideCallbackUri?: string;
};

export type MetaAppWebhookSubscription = {
    object?: string;
    callbackUrl?: string;
    fields?: string[];
    active?: boolean;
};

export type MetaWhatsAppSetupReport = {
    webhookUrl: string;
    wabaSubscribed: boolean;
    wabaOverrideSet: boolean;
    appWebhookConfigured: boolean;
    phoneOnWaba: boolean;
    phoneStatus?: string;
    overrideCallbackUri?: string;
    appSubscriptions: MetaAppWebhookSubscription[];
    subscribedApps: MetaWabaSubscription[];
    steps: Array<{ step: string; ok: boolean; detail?: string }>;
    summary: string;
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
    wabaOverrideCallbackUri?: string;
    wabaSubscribeError?: string;
    appWebhookSubscriptions?: MetaAppWebhookSubscription[];
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
        data?: Array<{
            whatsapp_business_api_data?: MetaWabaSubscription;
            override_callback_uri?: string;
        }>;
        override_callback_uri?: string;
    };
    const topOverride = parsed.override_callback_uri;
    const out: MetaWabaSubscription[] = [];
    for (const row of parsed.data ?? []) {
        const app = row.whatsapp_business_api_data;
        if (!app?.id) continue;
        out.push({
            ...app,
            overrideCallbackUri: row.override_callback_uri ?? topOverride,
        });
    }
    return out;
}

export async function listAppWebhookSubscriptions(): Promise<MetaAppWebhookSubscription[]> {
    const meta = config.whatsapp.meta;
    if (!meta.appId || !meta.appSecret) return [];

    const res = await fetch(
        `${graphBase()}/${meta.appId}/subscriptions?access_token=${encodeURIComponent(appAccessToken())}`,
    );
    const body = await res.text();
    if (!res.ok) {
        throw new Error(formatMetaSendError(res.status, body));
    }
    const parsed = JSON.parse(body) as {
        data?: Array<{
            object?: string;
            callback_url?: string;
            fields?: string[];
            active?: boolean;
        }>;
    };
    return (parsed.data ?? []).map((row) => ({
        object: row.object,
        callbackUrl: row.callback_url,
        fields: row.fields,
        active: row.active,
    }));
}

/** Step 1: link WABA to app for real inbound webhooks. */
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

/** Step 2: point WABA webhooks at our Cloud Run URL (required when App Dashboard URL is wrong/missing). */
export async function overrideWabaWebhookCallback(): Promise<MetaWabaSubscription[]> {
    const meta = config.whatsapp.meta;
    if (!meta.wabaId || !meta.accessToken) {
        throw new Error("WHATSAPP_META_WABA_ID or access token not configured");
    }

    const res = await fetch(`${graphBase()}/${meta.wabaId}/subscribed_apps`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${meta.accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            override_callback_uri: getMetaWebhookPublicUrl(),
            verify_token: meta.webhookVerifyToken,
        }),
    });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(formatMetaSendError(res.status, body));
    }

    return listWabaSubscribedApps();
}

/** Step 3: subscribe app to whatsapp_business_account + messages field. */
export async function configureAppWhatsAppWebhook(): Promise<void> {
    const meta = config.whatsapp.meta;
    if (!meta.appId || !meta.appSecret) {
        throw new Error("WHATSAPP_META_APP_ID or WHATSAPP_META_APP_SECRET not configured");
    }

    const params = new URLSearchParams({
        object: "whatsapp_business_account",
        callback_url: getMetaWebhookPublicUrl(),
        verify_token: meta.webhookVerifyToken,
        fields: "messages",
        access_token: appAccessToken(),
    });

    const res = await fetch(`${graphBase()}/${meta.appId}/subscriptions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
    });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(formatMetaSendError(res.status, body));
    }
}

async function getPhoneRegistrationStatus(): Promise<{ onWaba: boolean; status?: string }> {
    const meta = config.whatsapp.meta;
    if (!meta.wabaId || !meta.phoneNumberId || !meta.accessToken) {
        return { onWaba: false };
    }

    const listRes = await fetch(`${graphBase()}/${meta.wabaId}/phone_numbers`, {
        headers: { Authorization: `Bearer ${meta.accessToken}` },
    });
    const listBody = await listRes.text();
    let onWaba = false;
    if (listRes.ok) {
        const parsed = JSON.parse(listBody) as { data?: Array<{ id?: string }> };
        onWaba = (parsed.data ?? []).some(
            (row) => String(row.id) === String(meta.phoneNumberId),
        );
    }

    const phoneRes = await fetch(
        `${graphBase()}/${meta.phoneNumberId}?fields=status,display_phone_number,code_verification_status,platform_type`,
        { headers: { Authorization: `Bearer ${meta.accessToken}` } },
    );
    const phoneBody = await phoneRes.text();
    let status: string | undefined;
    if (phoneRes.ok) {
        const parsed = JSON.parse(phoneBody) as { status?: string };
        status = parsed.status;
    }

    return { onWaba, status };
}

/** Full Meta WhatsApp webhook fix: WABA subscribe + callback override + app messages subscription. */
export async function setupMetaWhatsAppWebhooks(): Promise<MetaWhatsAppSetupReport> {
    const meta = config.whatsapp.meta;
    const webhookUrl = getMetaWebhookPublicUrl();
    const report: MetaWhatsAppSetupReport = {
        webhookUrl,
        wabaSubscribed: false,
        wabaOverrideSet: false,
        appWebhookConfigured: false,
        phoneOnWaba: false,
        appSubscriptions: [],
        subscribedApps: [],
        steps: [],
        summary: "",
    };

    try {
        await subscribeWabaToApp();
        report.wabaSubscribed = true;
        report.steps.push({ step: "waba_subscribe", ok: true });
    } catch (err) {
        report.steps.push({
            step: "waba_subscribe",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
        });
    }

    try {
        report.subscribedApps = await overrideWabaWebhookCallback();
        const override =
            report.subscribedApps.find((a) => a.id === meta.appId)?.overrideCallbackUri ??
            report.subscribedApps[0]?.overrideCallbackUri;
        report.overrideCallbackUri = override;
        report.wabaOverrideSet = override === webhookUrl;
        report.steps.push({
            step: "waba_callback_override",
            ok: report.wabaOverrideSet,
            detail: override ? `override=${override}` : "no override returned",
        });
    } catch (err) {
        report.steps.push({
            step: "waba_callback_override",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
        });
    }

    try {
        await configureAppWhatsAppWebhook();
        report.appWebhookConfigured = true;
        report.steps.push({ step: "app_messages_subscription", ok: true });
    } catch (err) {
        report.steps.push({
            step: "app_messages_subscription",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
        });
    }

    try {
        report.appSubscriptions = await listAppWebhookSubscriptions();
    } catch (err) {
        report.steps.push({
            step: "app_subscriptions_read",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
        });
    }

    try {
        if (!report.subscribedApps.length) {
            report.subscribedApps = await listWabaSubscribedApps();
        }
        report.wabaSubscribed = report.subscribedApps.some((a) => a.id === meta.appId);
    } catch {
        // ignore
    }

    try {
        const phone = await getPhoneRegistrationStatus();
        report.phoneOnWaba = phone.onWaba;
        report.phoneStatus = phone.status;
        report.steps.push({
            step: "phone_on_waba",
            ok: phone.onWaba,
            detail: phone.status ? `status=${phone.status}` : undefined,
        });
    } catch (err) {
        report.steps.push({
            step: "phone_on_waba",
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
        });
    }

    const phoneReady = report.phoneOnWaba || report.phoneStatus === "CONNECTED";
    const ok =
        report.wabaSubscribed &&
        report.wabaOverrideSet &&
        report.appWebhookConfigured &&
        phoneReady;

    report.summary = ok
        ? "WhatsApp webhooks fully configured. Send HI to +919203497046 and refresh /debug."
        : "Setup partially failed — see steps[].detail.";

    return report;
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
            result.wabaOverrideCallbackUri =
                result.wabaSubscribedApps.find((a) => a.id === meta.appId)?.overrideCallbackUri ??
                result.wabaSubscribedApps[0]?.overrideCallbackUri;
        } catch (err) {
            result.wabaSubscribeError = err instanceof Error ? err.message : String(err);
        }
    }

    if (meta.appId && meta.appSecret) {
        try {
            result.appWebhookSubscriptions = await listAppWebhookSubscriptions();
        } catch {
            // optional
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
            "WABA is not subscribed to Kavach app. POST /api/webhooks/whatsapp/meta/setup?verify_token=... then send HI again.";
    } else if (
        result.wabaOverrideCallbackUri &&
        result.wabaOverrideCallbackUri !== getMetaWebhookPublicUrl()
    ) {
        result.diagnosis = `WABA webhook override points elsewhere (${result.wabaOverrideCallbackUri}). POST /api/webhooks/whatsapp/meta/setup?verify_token=... to fix.`;
    } else if (result.tokenExpiresAt) {
        result.diagnosis = `Token expires at ${result.tokenExpiresAt}. Send permission looks OK — if replies still fail, run /setup and send HI again.`;
    } else {
        result.diagnosis =
            "Credentials look OK. POST /api/webhooks/whatsapp/meta/setup?verify_token=... if real messages still missing, then send HI to +919203497046.";
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
                const text = extractInboundText(row);
                const media = extractInboundMedia(row);
                if (text || media.mediaType) {
                    out.push({
                        from,
                        text: text || `[${media.mediaType ?? type} shared]`,
                        messageId: row.id ? String(row.id) : undefined,
                        inboundType: type,
                        interactiveId:
                            type === "interactive"
                                ? String(
                                      (
                                          (row.interactive as Record<string, unknown> | undefined)
                                              ?.button_reply as Record<string, unknown> | undefined
                                      )?.id ??
                                          (
                                              (row.interactive as Record<string, unknown> | undefined)
                                                  ?.list_reply as Record<string, unknown> | undefined
                                          )?.id ??
                                          "",
                                  ) || undefined
                                : undefined,
                        ...media,
                    });
                }
            }
        }
    }

    return out;
}
