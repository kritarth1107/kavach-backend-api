import { createSign } from "crypto";
/**
 * GitHub: each repo's deploys, checks and pull requests, plus GitHub's own status page. Public repos read without a
 * key; the private ones (admin, infra) need GITHUB_TOKEN (read-only: actions, contents, pull requests). Cached 2 minutes
 * so the console stays inside GitHub's hourly limit.
 */
type Run = { id: number; name: string; status: string; conclusion: string | null; event: string; branch: string; sha: string; title: string; at: string; updatedAt: string; url: string; minutes: number | null };
export type RepoView = {
    repo: string; label: string; deploys: string; private: boolean; readable: boolean; note?: string;
    lastCommit: { sha: string; title: string; at: string; author: string } | null;
    deploy: Run | null; lastGoodDeploy: Run | null; runs: Run[];
    day: { runs: number; failed: number; cancelled: number; medianDeployMin: number | null };
    openPrs: Array<{ number: number; title: string; at: string; url: string; author: string }>;
};
export type AwsCheck = { name: string; what: string; status: string; lastAt: string | null; lastMs: number | null; nextAt: string | null; history: number };
export type GithubView = { at: string; token: boolean; awsChecks: AwsCheck[]; evals: Array<Run & { repo: string }>; status: { indicator: string; description: string; components: Array<{ name: string; status: string }> } | null; repos: RepoView[] };

const REPOS: Array<{ repo: string; label: string; deploys: string; workflow: string }> = [
    { repo: "kritarth1107/kawach-ai-engine", label: "AI engine", deploys: "ECS engine", workflow: "deploy-aws.yml" },
    { repo: "kritarth1107/kavach-backend-api", label: "Backend API", deploys: "ECS backend + admin-api", workflow: "deploy-aws.yml" },
    { repo: "kritarth1107/kavach-dashbaord", label: "Family dashboard", deploys: "ECS dashboard", workflow: "deploy-aws.yml" },
    { repo: "kritarth1107/kavach-admin", label: "Admin console", deploys: "ECS admin", workflow: "deploy-aws.yml" },
    { repo: "kritarth1107/kavach-infra-aws", label: "AWS infrastructure", deploys: "Terraform (cron, network, IAM)", workflow: "" },
];

/**
 * How the admin API reads GitHub: a read-only GitHub App (ADMIN_GITHUB_APP_ID + ADMIN_GITHUB_APP_KEY, installed on the
 * Kavach repos with Actions, Contents, Pull requests and Metadata: read) whose installation token lasts an hour, or a
 * GITHUB_TOKEN. Without either GitHub allows 60 calls an hour per address, which the page uses up.
 */
let appToken: { token: string; until: number } | null = null;
async function readToken(): Promise<string | null> {
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    const id = process.env.ADMIN_GITHUB_APP_ID, key = process.env.ADMIN_GITHUB_APP_KEY;
    if (!id || !key) return null;
    if (appToken && appToken.until > Date.now()) return appToken.token;
    const b64 = (x: Buffer | string) => Buffer.from(x).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" })), body = b64(JSON.stringify({ iat: now - 60, exp: now + 540, iss: id }));
    const jwt = `${head}.${body}.${b64(createSign("RSA-SHA256").update(`${head}.${body}`).sign(key.replace(/\\n/g, "\n")))}`;
    const call = async <T>(method: string, path: string): Promise<T> => {
        const res = await fetch(`https://api.github.com${path}`, { method, headers: { accept: "application/vnd.github+json", "user-agent": "kavach-admin", authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`GitHub app ${res.status}`);
        return (await res.json()) as T;
    };
    const inst = await call<{ id: number }>("GET", `/users/${process.env.ADMIN_GITHUB_OWNER || "kritarth1107"}/installation`);
    const t = await call<{ token: string; expires_at: string }>("POST", `/app/installations/${inst.id}/access_tokens`);
    appToken = { token: t.token, until: Date.parse(t.expires_at) - 5 * 60_000 };
    return t.token;
}

async function gh<T>(path: string): Promise<T> {
    const token = await readToken().catch(() => null);
    const res = await fetch(`https://api.github.com${path}`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "kavach-admin", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub ${res.status}`), { status: res.status });
    return (await res.json()) as T;
}

type ApiRun = { id: number; name: string; status: string; conclusion: string | null; event: string; head_branch: string; head_sha: string; display_title: string; created_at: string; updated_at: string; run_started_at?: string; html_url: string };
const run = (r: ApiRun): Run => {
    const start = Date.parse(r.run_started_at || r.created_at);
    const end = Date.parse(r.updated_at);
    return {
        id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, event: r.event, branch: r.head_branch, sha: r.head_sha.slice(0, 7),
        title: (r.display_title || "").split("\n")[0].slice(0, 120), at: r.created_at, updatedAt: r.updated_at, url: r.html_url,
        minutes: r.status === "completed" && end > start ? Math.round((end - start) / 6000) / 10 : null,
    };
};

async function repoView(c: (typeof REPOS)[number]): Promise<RepoView> {
    const base: RepoView = { repo: c.repo, label: c.label, deploys: c.deploys, private: false, readable: false, lastCommit: null, deploy: null, lastGoodDeploy: null, runs: [], day: { runs: 0, failed: 0, cancelled: 0, medianDeployMin: null }, openPrs: [] };
    try {
        const meta = await gh<{ private: boolean; default_branch: string }>(`/repos/${c.repo}`);
        const [commits, runs, deploys, prs] = await Promise.all([
            gh<Array<{ sha: string; commit: { message: string; author: { date: string; name: string } } }>>(`/repos/${c.repo}/commits?per_page=1&sha=${meta.default_branch}`),
            gh<{ workflow_runs: ApiRun[] }>(`/repos/${c.repo}/actions/runs?per_page=30`),
            c.workflow ? gh<{ workflow_runs: ApiRun[] }>(`/repos/${c.repo}/actions/workflows/${c.workflow}/runs?per_page=20`).catch(() => ({ workflow_runs: [] })) : Promise.resolve({ workflow_runs: [] as ApiRun[] }),
            gh<Array<{ number: number; title: string; created_at: string; html_url: string; user: { login: string } }>>(`/repos/${c.repo}/pulls?state=open&per_page=10`),
        ]);
        const all = runs.workflow_runs.map(run);
        const dep = deploys.workflow_runs.map(run);
        const since = Date.now() - 86_400_000;
        const today = all.filter((r) => Date.parse(r.at) >= since);
        const mins = dep.filter((r) => r.conclusion === "success" && r.minutes != null).slice(0, 10).map((r) => r.minutes!).sort((a, b) => a - b);
        const head = commits[0];
        return {
            ...base, private: meta.private, readable: true,
            lastCommit: head ? { sha: head.sha.slice(0, 7), title: head.commit.message.split("\n")[0].slice(0, 120), at: head.commit.author.date, author: head.commit.author.name } : null,
            deploy: dep[0] ?? null, lastGoodDeploy: dep.find((r) => r.conclusion === "success") ?? null, runs: all.slice(0, 12),
            day: { runs: today.length, failed: today.filter((r) => r.conclusion === "failure").length, cancelled: today.filter((r) => r.conclusion === "cancelled").length, medianDeployMin: mins.length ? mins[Math.floor(mins.length / 2)] : null },
            openPrs: prs.map((p) => ({ number: p.number, title: p.title.slice(0, 120), at: p.created_at, url: p.html_url, author: p.user.login })),
        };
    } catch (e) {
        const status = (e as { status?: number }).status;
        return { ...base, private: status === 404, note: status === 404 ? "Private repo: install the read-only GitHub App (kavach-admin-reader) on it" : status === 403 ? "GitHub rate limit: the admin API has no GitHub App or token yet" : (e as Error).message };
    }
}

/** The latest run of each AI check workflow (they spend on kavach-eval-1015, not production). */
const EVALS: Array<[string, string]> = [["kritarth1107/kawach-ai-engine", "nightly-saheli.yml"], ["kritarth1107/kawach-ai-engine", "replay.yml"], ["kritarth1107/kawach-ai-engine", "saheli-eval.yml"], ["kritarth1107/kawach-ai-engine", "learn-gate.yml"]];
async function evalRuns(): Promise<GithubView["evals"]> {
    const out = await Promise.all(EVALS.map(([repo, wf]) => gh<{ workflow_runs: ApiRun[] }>(`/repos/${repo}/actions/workflows/${wf}/runs?per_page=3`)
        .then((r) => r.workflow_runs.map((x) => ({ ...run(x), repo }))).catch(() => [])));
    return out.flat().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The AI checks that moved from GitHub to AWS on 16 Oct (founder decision): their runs come from the scheduler page's data. */
const AWS_CHECKS = ["Saheli check (night)", "Nightly trainer", "Draft replay gate", "Saheli's night (dream)"];
async function awsChecks(): Promise<AwsCheck[]> {
    try {
        const { cronView } = await import("./ops");
        const c = await cronView();
        return c.jobs.filter((j) => AWS_CHECKS.includes(j.name)).map((j) => ({ name: j.name, what: j.what, status: j.status, lastAt: j.lastAt, lastMs: j.lastMs, nextAt: j.nextAt, history: j.history.length }));
    } catch {
        return [];
    }
}

async function githubStatus(): Promise<GithubView["status"]> {
    try {
        const res = await fetch("https://www.githubstatus.com/api/v2/summary.json", { signal: AbortSignal.timeout(6_000) });
        if (!res.ok) return null;
        const j = (await res.json()) as { status: { indicator: string; description: string }; components: Array<{ name: string; status: string; group?: boolean }> };
        const want = /^(Git Operations|API Requests|Actions|Pull Requests|Webhooks|Packages)$/;
        return { indicator: j.status.indicator, description: j.status.description, components: j.components.filter((c) => want.test(c.name)).map((c) => ({ name: c.name, status: c.status })) };
    } catch {
        return null;
    }
}

let cached: { at: number; view: GithubView } | null = null;
let building: Promise<GithubView> | null = null;

export async function github(fresh = false): Promise<GithubView> {
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < 120_000 && !(fresh && age > 20_000)) return cached.view;
    building ??= Promise.all([githubStatus(), Promise.all(REPOS.map(repoView)), evalRuns(), awsChecks(), readToken().catch(() => null)]).then(([status, repos, evals, aws, tok]) => {
        const view = { at: new Date().toISOString(), token: !!tok, status, repos, evals, awsChecks: aws };
        cached = { at: Date.now(), view };
        return view;
    }).finally(() => {
        building = null;
    });
    return building;
}
