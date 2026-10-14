/**
 * Google access tokens for the backend on AWS, with no Google key stored anywhere.
 *
 * The ECS task role is traded through workload identity federation (GOOGLE_WIF_AUDIENCE: pool kavach-aws, provider
 * kavach-ecs, which accepts only assumed-role/kavach-ecs-task) for a short-lived token of one service account:
 *   vertex: GOOGLE_VERTEX_SA (default kavach-brain, roles/aiplatform.user only), Gemini text and photo reading
 *   chirp:  GOOGLE_CHIRP_SA  (default kavach-chirp, roles/speech.client only)
 * One client per account is kept, so the token is reused until google-auth-library refreshes it.
 * Without GOOGLE_WIF_AUDIENCE (GCP) this returns null and callers use GoogleAuth's default chain.
 */
import { AwsClient } from "google-auth-library";

export type GoogleUse = "vertex" | "chirp";

const DEFAULT_SA: Record<GoogleUse, string> = {
    vertex: "kavach-brain@kavach-care.iam.gserviceaccount.com",
    chirp: "kavach-chirp@kavach-care.iam.gserviceaccount.com",
};

const clients = new Map<string, AwsClient>();

export function wifAudience(env: NodeJS.ProcessEnv = process.env): string | null {
    return env.GOOGLE_WIF_AUDIENCE?.trim() || null;
}

export function wifServiceAccount(use: GoogleUse, env: NodeJS.ProcessEnv = process.env): string {
    const set = use === "vertex" ? env.GOOGLE_VERTEX_SA : env.GOOGLE_CHIRP_SA;
    return set?.trim() || DEFAULT_SA[use];
}

/** The running task's AWS keys: the ECS container credentials endpoint, else the usual env vars. */
async function awsCreds(): Promise<{ accessKeyId: string; secretAccessKey: string; token?: string }> {
    const full = process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim();
    const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim();
    const url = full || (rel ? `http://169.254.170.2${rel}` : "");
    if (url) {
        const headers: Record<string, string> = {};
        const authz = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN?.trim();
        if (authz) headers.Authorization = authz;
        const res = await fetch(url, { headers });
        if (res.ok) {
            const body = (await res.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string };
            if (body.AccessKeyId && body.SecretAccessKey) {
                return { accessKeyId: body.AccessKeyId, secretAccessKey: body.SecretAccessKey, token: body.Token };
            }
        }
    }
    const id = process.env.AWS_ACCESS_KEY_ID?.trim();
    const secret = process.env.AWS_SECRET_ACCESS_KEY?.trim();
    if (id && secret) return { accessKeyId: id, secretAccessKey: secret, token: process.env.AWS_SESSION_TOKEN?.trim() || undefined };
    throw new Error("AWS task credentials are not available");
}

/** A federated access token for that use, or null when federation is not configured (GCP) or fails. */
export async function wifAccessToken(use: GoogleUse): Promise<string | null> {
    const audience = wifAudience();
    if (!audience) return null;
    const sa = wifServiceAccount(use);
    let client = clients.get(sa);
    if (!client) {
        client = new AwsClient({
            audience,
            subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
            service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateAccessToken`,
            aws_security_credentials_supplier: {
                getAwsRegion: async () => process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "ap-south-1",
                getAwsSecurityCredentials: awsCreds,
            },
        });
        clients.set(sa, client);
    }
    try {
        return (await client.getAccessToken()).token || null;
    } catch (err) {
        clients.delete(sa);
        console.warn(`Google federated token failed (${use}):`, err instanceof Error ? err.message : err);
        return null;
    }
}
