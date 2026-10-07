/**
 * The admin API's line to Saheli's engine: its own Google identity (kavach-admin-api) and its own secret
 * (ENGINE_ADMIN_SECRET), only for the engine's /v2/admin routes. It never uses the public backend's engine secret.
 */
import { GoogleAuth, type IdTokenClient } from "google-auth-library";
import { AdminError } from "./auth";

let client: Promise<IdTokenClient> | null = null;

function base(): string {
    return (process.env.ENGINE_URL || "").replace(/\/$/, "");
}

export function engineConfigured(): boolean {
    return !!base() && !!process.env.ENGINE_ADMIN_SECRET;
}

async function authHeaders(): Promise<Record<string, string>> {
    if (!base().includes(".run.app")) return {};
    client ??= new GoogleAuth().getIdTokenClient(base());
    const headers = await (await client).getRequestHeaders(base());
    const out: Record<string, string> = {};
    (headers as unknown as Headers).forEach((v, k) => (out[k] = v));
    return out;
}

export async function engine<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 25_000): Promise<T> {
    if (!engineConfigured()) throw new AdminError(503, "engine_not_configured");
    let res: Response;
    try {
        res = await fetch(`${base()}/v2/admin${path}`, {
            method,
            headers: {
                ...(await authHeaders()),
                "x-admin-secret": process.env.ENGINE_ADMIN_SECRET as string,
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new AdminError(503, "engine_unreachable");
    }
    if (res.status === 404) throw new AdminError(404, "not_found");
    if (!res.ok) throw new AdminError(502, "engine_error", `engine answered ${res.status}`);
    return (await res.json()) as T;
}

/** For pages that can live without the engine: the value, or null and a note. */
export async function engineOrNull<T>(method: "GET" | "POST", path: string): Promise<{ data: T | null; error?: string }> {
    try {
        return { data: await engine<T>(method, path) };
    } catch (e) {
        return { data: null, error: e instanceof AdminError ? e.code : "engine_error" };
    }
}
