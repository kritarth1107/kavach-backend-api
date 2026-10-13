/**
 * The live check (quality plan F7, F8): thresholds, the hourly email throttle (once per check per 3 h, only when something
 * is wrong), a deploy check that always emails its problems, a check that throws is "unknown" (never a false alarm), a
 * service deployed a minute ago is "starting", not down, and only the deploy identity may run the job.
 * Runs without a database, Google or the network. Usage: npx tsx scripts/test-live-check.ts
 */
import type { AddressInfo } from "node:net";
import express from "express";
import { AdminError, type AdminConfig } from "../src/admin/auth";
import { buildJobsRouter } from "../src/admin/jobs";
import {
    hourKeyOf, judge429, judgeBackup, judgeDelivery, judgeErrors, judgeEscalations, judgeLatency, judgeRefusals, judgeReminders, judgeRoutes,
    judgeServices, judgeSql, liveCheckEmail, runLiveCheck, type ILiveCheck, type LiveCheckItem,
} from "../src/admin/liveCheck";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

// thresholds
ok("delivery: 95%+ delivered is fine", judgeDelivery({ sent: 40, delivered: 39, failed: 0, noReceipt: 1 }).status === "ok");
ok("delivery: under 90% of 10+ sends is a problem", judgeDelivery({ sent: 41, delivered: 3, failed: 0, noReceipt: 38 }).status === "problem");
ok("delivery: a few sends with no receipt yet are not a problem", judgeDelivery({ sent: 4, delivered: 1, failed: 0, noReceipt: 3 }).status === "ok");
ok("delivery: 3+ failed and over 5% is a problem", judgeDelivery({ sent: 30, delivered: 30, failed: 3, noReceipt: 0 }).status === "problem");
ok("delivery: one failure only shows", judgeDelivery({ sent: 30, delivered: 30, failed: 1, noReceipt: 0 }).status === "warn");
ok("delivery: nothing sent says so", judgeDelivery({ sent: 0, delivered: 0, failed: 0, noReceipt: 0 }).value === "no sends in the last 24 h");
ok("errors: 20 in the hour on one service is a problem, and names it", (() => {
    const c = judgeErrors({ "kawach-ai-engine": { errors: 21, fiveXx: 0 }, "kavach-backend": { errors: 2, fiveXx: 0 } });
    return c.status === "problem" && (c.detail?.over as string[]).join() === "kawach-ai-engine";
})());
ok("errors: a few only show", judgeErrors({ "kavach-backend": { errors: 3, fiveXx: 1 } }).status === "warn");
ok("errors: 10 5xx answers is a problem", judgeErrors({ "kavach-backend": { errors: 0, fiveXx: 10 } }).status === "problem");
ok("errors: none is ok", judgeErrors({}).status === "ok");
ok("latency: p90 over 35 s on 5+ replies is a problem", judgeLatency({ turns: 12, p50Ms: 6000, p90Ms: 40_000, maxMs: 90_000 }).status === "problem");
ok("latency: over 35 s on 2 replies only shows", judgeLatency({ turns: 2, p50Ms: 6000, p90Ms: 40_000, maxMs: 40_000 }).status === "warn");
ok("latency: 25 s is slow, shown", judgeLatency({ turns: 12, p50Ms: 6000, p90Ms: 25_000, maxMs: 30_000 }).status === "warn");
ok("latency: a quiet hour is fine", judgeLatency({ turns: 0, p50Ms: null, p90Ms: null, maxMs: null }).status === "ok");
ok("latency: an engine that does not say is unknown (an older engine, never an alarm)", judgeLatency(null).status === "unknown");
ok("429s: 10 in the hour is a problem", judge429({ "gemini-3.5-flash@asia-south1": 7, "gemini-3.1-pro-preview@global": 3 }).status === "problem");
ok("429s: a few only show, by route", (() => { const c = judge429({ "gemini-3.5-flash@asia-south1": 2 }); return c.status === "warn" && c.value === "2 (gemini-3.5-flash@asia-south1 2)"; })());
const now = Date.parse("2026-10-14T01:30:00+05:30");
ok("backup: last night's is fine", judgeBackup({ day: "2026-10-13", ok: true, finishedAt: "2026-10-13T03:40:00+05:30" }, now).status === "ok");
ok("backup: a failed one is a problem", judgeBackup({ day: "2026-10-13", ok: false, finishedAt: "2026-10-13T03:40:00+05:30" }, now).status === "problem");
ok("backup: older than 26 h is a problem", judgeBackup({ day: "2026-10-12", ok: true, finishedAt: "2026-10-12T03:40:00+05:30" }, now).status === "problem");
ok("backup: none recorded is a problem", judgeBackup(null, now).status === "problem");
ok("reminders: a stale tick is a problem", judgeReminders({ ok: false, ageMs: 400_000 }).status === "problem" && judgeReminders({ ok: true, ageMs: 20_000 }).status === "ok");
ok("escalations: a miss shows (the 09:00 check emails it itself)", judgeEscalations({ dateKey: "2026-10-13", onTime: 1, total: 2 }).status === "warn");
ok("cloud sql: not running is a problem; recovery off is shown", judgeSql({ state: "STOPPED", backups: true, pitr: true }).status === "problem"
    && judgeSql({ state: "RUNNABLE", backups: true, pitr: false }).status === "warn" && judgeSql({ state: "RUNNABLE", backups: true, pitr: true }).status === "ok");
ok("services: one down is a problem", judgeServices([{ name: "kavach-backend", ok: false, ms: 10 }, { name: "kavach-dashboard", ok: true, ms: 10 }], []).status === "problem");
ok("services: one deployed a minute ago and still starting is not an alarm", (() => {
    const c = judgeServices([{ name: "kavach-backend", ok: false, ms: 10, deploying: true }], []);
    return c.status === "warn" && c.value.includes("just deployed");
})());
ok("services: a Cloud Run service not ready is a problem", judgeServices([{ name: "kavach-backend", ok: true, ms: 10 }], ["kavach-admin"]).status === "problem");
ok("routes: a missing route others call is a problem, named", (() => {
    const c = judgeRoutes(["/health", "/v2/turn"], ["/health", "/v2/turn", "/v2/admin/eval-scores", "/v2/turn"]);
    return c.status === "problem" && c.value === "missing: /v2/admin/eval-scores";
})());
ok("routes: an unreadable route list is a problem", judgeRoutes(null, ["/health"]).status === "problem");
ok("refusals: a forged webhook that gets 200 is a problem", judgeRefusals([{ name: "webhook without a signature", status: 200, want: [401, 403] }]).status === "problem"
    && judgeRefusals([{ name: "webhook without a signature", status: 401, want: [401, 403] }]).status === "ok");
ok("the hour is the IST hour", hourKeyOf(new Date("2026-10-13T19:45:00Z")) === "2026-10-14T01");

// one run
type Fake = { saved: ILiveCheck[]; emailed: ILiveCheck[]; sent: Array<{ subject: string; text: string }> };
function harness(): Fake & { store: NonNullable<Parameters<typeof runLiveCheck>[0]["store"]>; send: (s: string, t: string) => Promise<void> } {
    const f: Fake = { saved: [], emailed: [], sent: [] };
    return {
        ...f,
        store: {
            recentEmails: async (since) => f.saved.filter((r) => r.trigger === "hourly" && r.emailed && r.at >= since),
            existing: async (hourKey) => f.saved.find((r) => r.hourKey === hourKey && r.trigger === "hourly") ?? null,
            save: async (row) => f.saved.push(row),
        },
        send: async (subject, text) => void f.sent.push({ subject, text }),
    };
}
const item = (key: string, status: LiveCheckItem["status"], value = "x"): LiveCheckItem => ({ key, label: key, status, value });

(async () => {
    const h = harness();
    const bad = { latency: async () => item("latency", "problem", "p90 40.0 s"), delivery: async () => item("delivery", "ok") };
    const t0 = Date.parse("2026-10-14T02:05:00+05:30");
    let row = await runLiveCheck({ trigger: "hourly", now: t0, collectors: bad, store: h.store, send: h.send });
    ok("a problem emails the team, problems first", row.emailed && h.sent.length === 1 && row.checks[0].key === "latency" && row.problems.join() === "latency");
    ok("the email says what is wrong with its value", h.sent[0].subject.includes("saheli") === false && h.sent[0].subject.includes("latency") && h.sent[0].text.includes("✗ latency: p90 40.0 s"));
    row = await runLiveCheck({ trigger: "hourly", now: t0 + 60_000, collectors: bad, store: h.store, send: h.send });
    ok("a schedule that fires twice in the hour runs once", h.saved.length === 1 && h.sent.length === 1);
    await runLiveCheck({ trigger: "hourly", now: t0 + 3_600_000, collectors: bad, store: h.store, send: h.send });
    ok("the same problem an hour later shows but does not email again", h.saved.length === 2 && h.sent.length === 1 && !h.saved[1].emailed);
    const worse = { ...bad, backup: async () => item("backup", "problem", "FAILED") };
    await runLiveCheck({ trigger: "hourly", now: t0 + 2 * 3_600_000, collectors: worse, store: h.store, send: h.send });
    ok("a new problem emails at once (with the old one listed)", h.sent.length === 2 && h.sent[1].text.includes("✗ backup") && h.sent[1].text.includes("✗ latency"));
    await runLiveCheck({ trigger: "hourly", now: t0 + 4 * 3_600_000, collectors: bad, store: h.store, send: h.send });
    ok("2 hours after the last email it is still quiet", h.sent.length === 2);
    await runLiveCheck({ trigger: "hourly", now: t0 + 5.5 * 3_600_000, collectors: bad, store: h.store, send: h.send });
    ok("after 3 hours the same problem emails again", h.sent.length === 3);
    await runLiveCheck({ trigger: "hourly", now: t0 + 6.5 * 3_600_000, collectors: { delivery: async () => item("delivery", "warn") }, store: h.store, send: h.send });
    ok("warnings alone never email", h.sent.length === 3 && h.saved.at(-1)!.ok);

    const d = harness();
    const thrown = { errors: async () => { throw new Error("403 Permission monitoring.timeSeries.list denied"); }, refusals: async () => item("refusals", "problem", "webhook without a signature: 200") };
    row = await runLiveCheck({ trigger: "deploy", service: "kavach-backend", sha: "f0d37d4abc", now: t0, collectors: thrown, store: d.store, send: d.send });
    ok("a check that throws is unknown, with why, and is not an alarm", row.checks.find((c) => c.key === "errors")?.status === "unknown"
        && row.checks.find((c) => c.key === "errors")!.value.includes("monitoring.timeSeries.list") && row.problems.join() === "refusals");
    ok("a deploy check emails its problem with the service and commit", d.sent.length === 1 && d.sent[0].subject.includes("After the kavach-backend deploy (f0d37d4)"));
    await runLiveCheck({ trigger: "deploy", service: "kavach-backend", sha: "aaaaaaa", now: t0 + 60_000, collectors: thrown, store: d.store, send: d.send });
    ok("every deploy with a problem emails (it fails loudly)", d.sent.length === 2);
    const prodState = { latency: async () => item("latency", "problem", "p90 40.0 s"), services: async () => item("services", "ok") };
    row = await runLiveCheck({ trigger: "deploy", service: "kawach-ai-engine", now: t0, collectors: prodState, store: d.store, send: d.send });
    ok("after a deploy, slow replies show but do not fail the deploy or email", row.ok && d.sent.length === 2 && row.checks[0].status === "problem");
    row = await runLiveCheck({ trigger: "hourly", now: t0 + 9 * 3_600_000, collectors: prodState, store: d.store, send: d.send });
    ok("the hourly run raises them", !row.ok && row.problems.join() === "latency" && d.sent.length === 3);
    const sendFails = async () => { throw new Error("resend down"); };
    row = await runLiveCheck({ trigger: "deploy", service: "x", now: t0, collectors: thrown, store: d.store, send: sendFails });
    ok("an email that fails is recorded, the run still saved", !row.emailed && row.emailError === "resend down" && d.saved.at(-1) === row);
    const f = harness();
    row = await runLiveCheck({ trigger: "manual", now: t0, collectors: { delivery: async () => item("delivery", "ok") }, forceTest: true, store: f.store, send: f.send });
    ok("a forced test failure (manual only) emails, labelled as a test", row.problems.join() === "forced_test" && f.sent.length === 1 && f.sent[0].subject.startsWith("TEST, ignore: "));
    row = await runLiveCheck({ trigger: "hourly", now: t0, collectors: { delivery: async () => item("delivery", "ok") }, forceTest: true, store: f.store, send: f.send });
    ok("an hourly run never takes a forced failure", row.ok && f.sent.length === 1);
    ok("email text lists every check", liveCheckEmail({ trigger: "hourly", at: new Date(t0), checks: [item("a", "problem"), item("b", "ok")], problems: ["a"] }).text.includes("✓ b: x"));

    // the job endpoint: only the deploy identity
    process.env.ADMIN_JOB_SA = "github-deploy@kavach-care.iam.gserviceaccount.com";
    const cfg = { audience: "https://admin-api.test", webServiceAccount: "kavach-admin-web@kavach-care.iam.gserviceaccount.com", insecureLocal: false } as AdminConfig;
    let lastTrigger = "";
    const app = express();
    app.use(express.json());
    app.use("/admin/jobs", buildJobsRouter(cfg, {
        verify: async (auth, c) => {
            if (auth !== "Bearer deploy") throw new AdminError(403, "caller_not_allowed");
            if (c.webServiceAccount !== "github-deploy@kavach-care.iam.gserviceaccount.com") throw new AdminError(403, "wrong_account_checked");
            return c.webServiceAccount;
        },
        run: async (o) => {
            lastTrigger = `${o.trigger}:${o.service ?? ""}:${o.sha ?? ""}${o.forceTest ? ":forced" : ""}`;
            return { hourKey: "2026-10-14T02", trigger: o.trigger, at: new Date(), ms: 1, ok: true, checks: [item("a", "ok")], problems: [], emailed: false, emailedKeys: [] };
        },
    }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/jobs/live-check`;
    const post = (auth: string, body: unknown) => fetch(base, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    let r = await post("Bearer admin-web", {});
    ok("the admin web app's identity cannot run a job", r.status === 403);
    r = await post("Bearer deploy", { trigger: "deploy", service: "kawach-ai-engine", sha: "4407d7c; rm -rf" });
    const j = await r.json() as { ok: boolean; checks: unknown[] };
    ok("the deploy identity runs it; input is cleaned", r.status === 200 && j.ok && lastTrigger === "deploy:kawach-ai-engine:4407d7c" && j.checks.length === 1, lastTrigger);
    r = await post("Bearer deploy", { trigger: "deploy", forceTest: true });
    ok("only a manual run may force a test failure", r.status === 200 && lastTrigger === "deploy::");
    r = await post("Bearer deploy", { trigger: "manual", forceTest: true });
    ok("a manual run passes the forced test on", r.status === 200 && lastTrigger === "manual:::forced", lastTrigger);
    r = await post("Bearer deploy", { trigger: "anything" });
    ok("an unknown trigger is the hourly run", r.status === 200 && lastTrigger === "hourly::");
    server.close();

    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log("live check: all passed");
})();
