/**
 * Read-only calls to Google Cloud APIs as the admin API's own identity (kavach-admin-api, viewer roles only).
 * On Cloud Run the identity comes from the metadata server; locally from application-default credentials.
 */
import { GoogleAuth } from "google-auth-library";

const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });

export class CloudError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export async function gapi<T>(url: string, opts: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const client = await auth.getClient();
    const token = (await client.getAccessToken()).token;
    if (!token) throw new CloudError(401, "no Google credentials");
    const res = await fetch(url, {
        method: opts.method || "GET",
        headers: { Authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = `${res.status}`;
        try {
            message = (JSON.parse(text) as { error?: { message?: string } }).error?.message || message;
        } catch {
            /* not JSON */
        }
        throw new CloudError(res.status, message.slice(0, 300));
    }
    return (await res.json()) as T;
}

/** Follows nextPageToken; `key` is the list field (services, jobs, instances…). */
export async function gapiAll<T>(url: string, key: string, max = 10): Promise<T[]> {
    const out: T[] = [];
    let token = "";
    for (let i = 0; i < max; i++) {
        const page = await gapi<Record<string, unknown>>(token ? `${url}${url.includes("?") ? "&" : "?"}pageToken=${encodeURIComponent(token)}` : url);
        out.push(...((page[key] as T[]) || []));
        token = (page.nextPageToken as string) || "";
        if (!token) break;
    }
    return out;
}

/** Runs one collector; a failure becomes a note instead of breaking the page. */
export async function settle<T>(name: string, fn: () => Promise<T>, errors: string[]): Promise<T | null> {
    try {
        return await fn();
    } catch (e) {
        const msg = e instanceof CloudError ? `${e.status} ${e.message}` : (e as Error).message;
        errors.push(`${name}: ${msg}`.slice(0, 300));
        return null;
    }
}
