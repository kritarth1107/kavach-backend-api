/**
 * Read-only calls to Google Cloud APIs as the admin API's own identity (kavach-admin-api, viewer roles only).
 * On Cloud Run the identity comes from the metadata server; locally from application-default credentials.
 */
import { AwsClient, GoogleAuth } from "google-auth-library";
import { taskCreds } from "./aws";
import { googleEnabled, NOT_ON_GCP } from "../../config/cloudProvider";

let auth: GoogleAuth | null = null;
let wif: AwsClient | null = null;

/**
 * On AWS: the ECS task role signs in to Google through workload identity (pool kavach-aws, provider kavach-ecs) and acts
 * as kavach-admin-reader (project viewer, BigQuery jobs, billing viewer). No Google key is stored anywhere.
 * GOOGLE_WIF_AUDIENCE: the provider's full name; GOOGLE_ADMIN_SA: the account to act as.
 */
export function wifConfigured(): boolean {
    return !!process.env.GOOGLE_WIF_AUDIENCE && !!process.env.GOOGLE_ADMIN_SA;
}

function wifClient(): AwsClient {
    wif ??= new AwsClient({
        type: "external_account",
        audience: process.env.GOOGLE_WIF_AUDIENCE as string,
        subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
        token_url: "https://sts.googleapis.com/v1/token",
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${process.env.GOOGLE_ADMIN_SA}:generateAccessToken`,
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        aws_security_credentials_supplier: {
            getAwsRegion: async () => process.env.AWS_REGION || "ap-south-1",
            getAwsSecurityCredentials: async () => {
                const c = await taskCreds();
                if (!c) throw new Error("no AWS task role");
                return { accessKeyId: c.accessKey, secretAccessKey: c.secretKey, token: c.token };
            },
        },
    });
    return wif;
}

/** The Google bill and Google reads work here: on Google Cloud, or on AWS through workload identity. */
export function gcpReadable(): boolean {
    return googleEnabled() || wifConfigured();
}

export class CloudError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

/** Off on a copy outside Google Cloud (GOOGLE_SERVICES=off or LLM_PROVIDER_BACKEND=bedrock): callers show "not on GCP". */
export function onGcp(): boolean {
    return googleEnabled();
}

export async function gapi<T>(url: string, opts: { method?: "GET" | "POST"; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    if (!gcpReadable()) throw new CloudError(0, NOT_ON_GCP);
    let token: string | null | undefined;
    if (!onGcp() && wifConfigured()) {
        token = (await wifClient().getAccessToken()).token;
    } else {
        auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        token = (await (await auth.getClient()).getAccessToken()).token;
    }
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
