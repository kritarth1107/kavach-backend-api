/**
 * AWS: daily cost per service from Cost Explorer, with a read-only billing key (AWS_BILLING_ACCESS_KEY_ID /
 * AWS_BILLING_SECRET_ACCESS_KEY; IAM policy: ce:GetCostAndUsage only). Signed with AWS Signature V4, no SDK.
 */
import { createHash, createHmac } from "crypto";
import { USD_INR, istDay } from "./pricing";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

export type SignInput = {
    method: string; host: string; path: string; query?: string; headers: Record<string, string>; body: string;
    region: string; service: string; accessKey: string; secretKey: string; amzDate: string; // YYYYMMDDTHHMMSSZ
};

/** AWS Signature Version 4: returns the Authorization header value. */
export function sigv4(i: SignInput): string {
    const date = i.amzDate.slice(0, 8);
    const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: i.host, "x-amz-date": i.amzDate };
    const names = Object.keys(headers).sort();
    const canonical = [i.method, i.path, i.query || "", names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), sha(i.body)].join("\n");
    const scope = `${date}/${i.region}/${i.service}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha(canonical)].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${i.secretKey}`, date), i.region), i.service), "aws4_request");
    return `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
}

export type AwsBill = { connected: boolean; daily: Record<string, number>; byService: Record<string, Record<string, number>>; credits: Record<string, number>; note?: string };

export function awsConfigured(): boolean {
    return !!process.env.AWS_BILLING_ACCESS_KEY_ID && !!process.env.AWS_BILLING_SECRET_ACCESS_KEY;
}

type Creds = { accessKey: string; secretKey: string; token?: string };

/** The ECS task role. Absent when this process is not on Fargate. */
async function taskCreds(): Promise<Creds | null> {
    const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    if (!rel) return null;
    const res = await fetch(`http://169.254.170.2${rel}`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string };
    if (!j.AccessKeyId || !j.SecretAccessKey) return null;
    return { accessKey: j.AccessKeyId, secretKey: j.SecretAccessKey, token: j.Token };
}

async function ecsJson<T>(target: string, body: unknown, creds: Creds): Promise<T> {
    const host = "ecs.ap-south-1.amazonaws.com";
    const payload = JSON.stringify(body);
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", "x-amz-target": target };
    if (creds.token) headers["x-amz-security-token"] = creds.token;
    const auth = sigv4({ method: "POST", host, path: "/", headers, body: payload, region: "ap-south-1", service: "ecs", accessKey: creds.accessKey, secretKey: creds.secretKey, amzDate });
    const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body: payload, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`ECS ${res.status}`);
    return (await res.json()) as T;
}

export type EcsService = { name: string; desired: number; running: number; pending: number; rollout: string | null; taskDef: string };

/** Live services in cluster kavach. Null when this process cannot read ECS. */
export async function ecsServices(): Promise<EcsService[] | null> {
    const creds = await taskCreds();
    if (!creds) return null;
    const listed = await ecsJson<{ serviceArns?: string[] }>("AmazonEC2ContainerServiceV20141113.ListServices", { cluster: "kavach" }, creds);
    const arns = listed.serviceArns || [];
    if (!arns.length) return [];
    const described = await ecsJson<{ services?: Array<{ serviceName?: string; desiredCount?: number; runningCount?: number; pendingCount?: number; taskDefinition?: string; deployments?: Array<{ status?: string; rolloutState?: string }> }> }>(
        "AmazonEC2ContainerServiceV20141113.DescribeServices", { cluster: "kavach", services: arns }, creds);
    return (described.services || []).map((s) => ({
        name: s.serviceName || "",
        desired: s.desiredCount ?? 0,
        running: s.runningCount ?? 0,
        pending: s.pendingCount ?? 0,
        rollout: s.deployments?.find((d) => d.status === "PRIMARY")?.rolloutState || null,
        taskDef: (s.taskDefinition || "").split("/").pop() || "",
    }));
}

/** Timed work on the AWS copy. The backend tick also sends the daily snapshot after 21:00 IST. */
export const AWS_SCHEDULES: Array<{ name: string; schedule: string; owner: "backend" | "cron" }> = [
    { name: "Care reminders", schedule: "* * * * *", owner: "backend" },
    { name: "Task runner", schedule: "* * * * *", owner: "cron" },
    { name: "Saheli wake", schedule: "*/5 * * * *", owner: "cron" },
    { name: "Browser sweep", schedule: "*/10 * * * *", owner: "cron" },
    { name: "Fact extract", schedule: "*/30 * * * *", owner: "cron" },
    { name: "Saheli's night", schedule: "0 2 * * *", owner: "cron" },
    { name: "Memory consolidate", schedule: "15 2 * * *", owner: "cron" },
    { name: "Elder reflection", schedule: "30 2 * * *", owner: "cron" },
    { name: "Morning report", schedule: "0 8 * * *", owner: "cron" },
    { name: "Daily jobs", schedule: "0 10 * * *", owner: "cron" },
    { name: "Weekly learning", schedule: "0 8 * * 0", owner: "cron" },
];

/** Cost per AWS service per day (UTC days from Cost Explorer, close enough to IST for a daily view). */
export async function awsBill(days: number, now = Date.now()): Promise<AwsBill> {
    if (!awsConfigured()) return { connected: false, daily: {}, byService: {}, credits: {}, note: "No AWS billing key yet" };
    const host = "ce.us-east-1.amazonaws.com";
    const start = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(now + 86_400_000).toISOString().slice(0, 10);
    const body = JSON.stringify({
        TimePeriod: { Start: start, End: end }, Granularity: "DAILY", Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }, { Type: "DIMENSION", Key: "RECORD_TYPE" }],
    });
    const amzDate = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers = { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage" };
    const auth = sigv4({ method: "POST", host, path: "/", headers, body, region: "us-east-1", service: "ce", accessKey: process.env.AWS_BILLING_ACCESS_KEY_ID!, secretKey: process.env.AWS_BILLING_SECRET_ACCESS_KEY!, amzDate });
    try {
        const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body, signal: AbortSignal.timeout(15_000) });
        type R = { ResultsByTime?: Array<{ TimePeriod: { Start: string }; Groups?: Array<{ Keys: string[]; Metrics: { UnblendedCost: { Amount: string; Unit: string } } }> }>; message?: string; Message?: string };
        const data = (await res.json().catch(() => ({}))) as R;
        if (!res.ok) return { connected: false, daily: {}, byService: {}, credits: {}, note: (data.message || data.Message || `AWS answered ${res.status}`).slice(0, 200) };
        const out: AwsBill = { connected: true, daily: {}, byService: {}, credits: {} };
        for (const t of data.ResultsByTime || []) {
            const day = istDay(new Date(`${t.TimePeriod.Start}T12:00:00Z`));
            for (const g of t.Groups || []) {
                const [service, recordType] = g.Keys;
                const amt = Number(g.Metrics.UnblendedCost.Amount) * (g.Metrics.UnblendedCost.Unit === "USD" ? USD_INR : 1);
                if (recordType === "Credit") out.credits[day] = (out.credits[day] ?? 0) + amt;
                else {
                    out.daily[day] = (out.daily[day] ?? 0) + amt;
                    (out.byService[service] ??= {})[day] = ((out.byService[service] ?? {})[day] ?? 0) + amt;
                }
            }
        }
        return out;
    } catch {
        return { connected: false, daily: {}, byService: {}, credits: {}, note: "AWS didn't answer" };
    }
}
