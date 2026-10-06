/** Uptime alarm: when it alerts, what it says, and what it checks (fake network, fake storage). */
import { decide, duration, formatAlerts, resetWeek, weeklySummary, type Probe, type State } from "./src/check";
import { probe, runChecks, sendEmail, targets } from "./src/index";
import { alertEmail, esc, LOGO_URL, recoveredLine, weeklyEmail } from "./src/email";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const P = (name: string, good: boolean): Probe => ({ name, label: name, ok: good, status: good ? 200 : 503, ms: 50 });
const t = (min: number) => new Date(Date.UTC(2026, 9, 5, 0, min)).toISOString();

// one blip never alerts; two in a row does, once
let s: State = { services: {} };
let r = decide(s, [P("backend", false)], t(0));
ok("one failure: no alert", r.alerts.length === 0 && r.next.services.backend.fails === 1);
r = decide(r.next, [P("backend", false)], t(5));
ok("two failures: down alert", r.alerts.length === 1 && r.alerts[0].kind === "down" && r.alerts[0].since === t(0));
const downState = JSON.stringify(r.next);
r = decide(r.next, [P("backend", false)], t(10));
ok("still down soon after: no repeat", r.alerts.length === 0);
ok("still down: state unchanged, so nothing is written", JSON.stringify(r.next) === downState);
r = decide(r.next, [P("backend", false)], t(5 + 6 * 60));
ok("6 h later: no reminder yet", r.alerts.length === 0);
r = decide(r.next, [P("backend", false)], t(5 + 24 * 60));
ok("a day later: one reminder", r.alerts.length === 1 && r.alerts[0].kind === "still_down");
r = decide(r.next, [P("backend", true)], t(25 * 60));
ok("recovered: up alert with duration", r.alerts.length === 1 && r.alerts[0].kind === "up" && r.alerts[0].detail.includes("25 h"), r.alerts);
ok("state cleared after recovery", !r.next.services.backend.down && r.next.services.backend.fails === 0);
ok("downtime kept for the week", r.next.services.backend.downMs === 25 * 3_600_000, r.next.services.backend);
const fine = decide({ services: { backend: { fails: 0, down: false, downMs: 0 } } }, [P("backend", true)], t(30));
ok("all fine: state unchanged", JSON.stringify(fine.next) === JSON.stringify({ services: { backend: { fails: 0, down: false, downMs: 0 } } }));
ok("old stored state (per-check counters) is cleaned", JSON.stringify(decide({ services: { a: { fails: 0, down: false, checks: 5, okChecks: 5 } as never } }, [P("a", true)], t(0)).next.services.a) === '{"fails":0,"down":false,"downMs":0}');
s = { services: {} };
r = decide(s, [P("engine", false)], t(0));
r = decide(r.next, [P("engine", true)], t(5));
ok("blip then fine: nothing sent", r.alerts.length === 0);
ok("durations read well", duration(t(0), t(45)) === "45 min" && duration(t(0), t(130)) === "2 h 10 min");

// one email per round, saying what it can mean
const mail = formatAlerts([{ kind: "down", name: "engine", label: "Saheli's brain", detail: "answered 404", since: t(0) }],
    [P("dashboard", true), { ...P("engine", false), label: "Saheli's brain" }], t(5));
ok("down subject names the service", mail.subject.includes("down") && mail.subject.includes("Saheli's brain"));
ok("body lists every check and next step", mail.text.includes("All checks now") && mail.text.includes("verify.sh"));
const upMail = formatAlerts([{ kind: "up", name: "engine", label: "Saheli's brain", detail: "Back up after 2 h 0 min." }], [P("engine", true)], t(5));
ok("recovery subject", upMail.subject.includes("recovered"));
ok("reminder wording says once a day", alertEmail([{ kind: "down", name: "engine", label: "Saheli's brain", since: t(0), detail: "" }], [P("engine", false)], t(5)).html.includes("once a day"));

// weekly check-in proves the alarm is alive
const week = weeklySummary({ services: { backend: { fails: 0, down: false, downMs: 30 * 60_000 } }, weekStart: t(0) }, t(7 * 24 * 60));
ok("weekly uptime percent from downtime", week.text.includes("99.70% up"), week.text);
const ongoing = { services: { a: { fails: 2, down: true, since: t(0), downMs: 60_000 } }, weekStart: t(0) };
const reset = resetWeek(ongoing, t(60));
ok("new week: downtime from zero, outage kept and counted from now", reset.services.a.downMs === 0 && reset.services.a.down && reset.services.a.countFrom === t(60));
const after = decide(reset, [P("a", true)], t(90));
ok("outage across weeks: only this week's part counted", after.next.services.a.downMs === 30 * 60_000 && after.alerts[0]?.detail.includes("1 h 30 min"), after);

// the designed email (dashboard look)
const probesNow: Probe[] = [{ name: "engine", label: "Saheli's brain (AI engine)", ok: false, status: 404, ms: 90, error: "x <b>y</b>" }, P("dashboard", true)];
const html = alertEmail([{ kind: "down", name: "engine", label: "Saheli's brain (AI engine)", since: t(0), detail: "" }], probesNow, t(5));
ok("html: logo, two-tone heading, saffron pill", html.html.includes(LOGO_URL) && html.html.includes("Kavach is") && html.html.includes(">down<")
    && html.html.includes("#d3541e"));
ok("html: page text escaped", html.html.includes("x &lt;b&gt;y&lt;/b&gt;") && !html.html.includes("<b>y</b>"));
ok("html subject short", html.subject === "Kavach is down: Saheli's brain", html.subject);
ok("recovered once when together", recoveredLine([{ kind: "up", name: "a", label: "A", detail: "Back up after 2 h 0 min." },
    { kind: "up", name: "b", label: "B", detail: "Back up after 2 h 0 min." }]) === "Back up after 2 h 0 min");
ok("recovered per part when different", recoveredLine([{ kind: "up", name: "a", label: "A (x)", detail: "Back up after 5 min." },
    { kind: "up", name: "b", label: "B", detail: "Back up after 2 h 0 min." }]) === "A: back after 5 min · B: back after 2 h 0 min");
ok("weekly html bars", weeklyEmail({ services: { engine: { fails: 0, down: false, downMs: 60_000 } }, weekStart: t(0) }, t(10)).html.includes("90.00%"));
ok("esc", esc(`a"<&>`) === "a&quot;&lt;&amp;&gt;");

// checks against a fake network
const env = {
    STATE: (() => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => void m.set(k, v) }; })(),
    RESEND_API_KEY: "re_test", HEALTH_SECRET: "hs", ALERT_TO: "a@x.com, b@x.com", ALERT_FROM: "Kavach <alerts@emails.kavach.care>",
    DASHBOARD_URL: "https://app.kavach.care", BACKEND_URL: "https://be.test", ENGINE_URL: "https://en.test",
};
ok("backend check uses detailed health with the secret", targets(env)[1].url === "https://be.test/api/health/detailed?HEALTH_SECRET=hs");
ok("private engine checked through the backend", targets(env)[2].url === "https://be.test/api/health/engine?HEALTH_SECRET=hs");
ok("without the secret, the engine directly", targets({ ...env, HEALTH_SECRET: undefined })[2].url === "https://en.test/health");
const sent: Array<{ url: string; body?: string }> = [];
let mode: "up" | "down" = "down";
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    sent.push({ url: u, body: init?.body as string | undefined });
    if (u.startsWith("https://api.resend.com")) return new Response("{}", { status: 200 });
    if (mode === "down" && !u.startsWith("https://app.kavach.care"))
        return new Response('{"error":{"status":"PERMISSION_DENIED","details":"CONSUMER_SUSPENDED"}}', { status: 404 });
    if (u.includes("/api/health/detailed") || u.includes("/api/health/engine")) return new Response('{"status":"ok"}', { status: 200 });
    if (u.endsWith("/health")) return new Response('{"status":"ok"}', { status: 200 });
    return new Response("<html>", { status: 200 });
}) as typeof fetch;

void (async () => {
    const p = await probe(targets(env)[2], fakeFetch);
    ok("suspension spotted in the answer", !p.ok && p.error === "Google project suspended", p);
    const gone = await probe(targets(env)[2], (async () => new Response("<html><title>404 Page not found</title></html>", { status: 404 })) as typeof fetch);
    ok("Google's empty 404 explained", !gone.ok && !!gone.error?.includes("Cloud Run has no service"), gone);
    const degraded = await probe(targets(env)[1], (async () => new Response('{"status":"degraded"}', { status: 200 })) as typeof fetch);
    ok("backend up but database down = fail", !degraded.ok);
    const timeout = await probe({ name: "x", label: "x", url: "https://x" }, (async () => { throw new Error("The operation timed out"); }) as typeof fetch);
    ok("no answer = fail with reason", !timeout.ok && !!timeout.error?.includes("timed out"));

    await runChecks(env, t(0), fakeFetch);
    ok("first failure: no email", !sent.some((x) => x.url.startsWith("https://api.resend.com")));
    await runChecks(env, t(5), fakeFetch);
    const email = sent.find((x) => x.url.startsWith("https://api.resend.com"));
    const body = JSON.parse(email?.body || "{}");
    ok("second failure: one email to both people", !!email && body.to.length === 2 && body.subject.includes("down"), body);
    ok("sent as designed html plus plain text", typeof body.html === "string" && body.html.includes(LOGO_URL) && body.text.includes("All checks now"));
    ok("names backend and engine, not the dashboard", body.subject.includes("Backend") && body.subject.includes("brain") && !body.subject.includes("Dashboard"), body.subject);
    mode = "up";
    sent.length = 0;
    await runChecks(env, t(65), fakeFetch);
    const back = JSON.parse(sent.find((x) => x.url.startsWith("https://api.resend.com"))?.body || "{}");
    ok("recovery email after an hour", back.subject?.includes("back up") && back.text.includes("1 h 5 min"), back.subject);
    const quiet = await runChecks(env, t(70), fakeFetch);
    ok("all fine again: nothing written", quiet.wrote === false);
    ok("no Resend key: nothing sent, no crash", (await sendEmail({ ...env, RESEND_API_KEY: undefined }, "s", "t", fakeFetch)) === false);

    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log("all passed");
})();
