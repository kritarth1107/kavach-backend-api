import config from "../config/app.config";

function bridgeConfigured(): boolean {
    return (
        config.whatsapp.provider === "baileys" &&
        Boolean(config.whatsapp.bridgeUrl) &&
        Boolean(config.whatsapp.bridgeSecret)
    );
}

export function isBaileysWhatsAppEnabled(): boolean {
    return bridgeConfigured();
}

export async function sendViaBaileysBridge(to: string, text: string): Promise<void> {
    if (!bridgeConfigured()) {
        throw new Error("Baileys bridge is not configured");
    }

    const base = config.whatsapp.bridgeUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/v1/send`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Kavach-Bridge-Secret": config.whatsapp.bridgeSecret,
        },
        body: JSON.stringify({ to, text }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Baileys bridge send failed (${res.status}): ${body.slice(0, 200)}`);
    }
}

export async function getBaileysBridgeStatus(): Promise<{
    connected: boolean;
    state: string;
} | null> {
    if (!bridgeConfigured()) return null;

    try {
        const base = config.whatsapp.bridgeUrl.replace(/\/$/, "");
        const res = await fetch(`${base}/health`, { method: "GET" });
        if (!res.ok) return { connected: false, state: "unreachable" };
        const json = (await res.json()) as { whatsapp?: string };
        const state = json.whatsapp ?? "unknown";
        return { connected: state === "connected", state };
    } catch {
        return { connected: false, state: "unreachable" };
    }
}
