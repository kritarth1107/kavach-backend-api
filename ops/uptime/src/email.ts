/**
 * The alarm's emails, in the dashboard's Care OS look: white card on soft grey, two-tone heading, square saffron title
 * markers, pill tags (saffron = down, forest green = ok), a dark pill button. Email-safe HTML: tables and inline styles,
 * Geist with system fonts as fallback (Gmail strips web fonts), no images except the hosted logo.
 */
import { describeProbe, duration, type Alert, type Probe, type State } from "./check";

export const LOGO_URL = "https://cdn.kavach.care/brand/kavach-careos-logo.png";
const C = {
    page: "#f3f4f5", frame: "#ffffff", card: "#f3f4f5", line: "#e4e6e9", ink: "#142a22", ink2: "#66706b", ink3: "#a3aaa6",
    accent: "#d3541e", accentSoft: "#fbe4d6", accentInk: "#9c3a10", forest: "#143429", okSoft: "#e3efe9", okInk: "#1f5a43",
};
const FONT = "Geist, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function esc(s: string): string {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function ist(iso: string, withDay = false): string {
    return new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true,
        ...(withDay ? { day: "numeric", month: "short" } : {}),
    }).format(new Date(iso)) + " IST";
}

function pill(text: string, tone: "down" | "ok" | "light" | "dark"): string {
    const s = {
        down: `background:${C.accent};color:#ffffff;`, ok: `background:${C.forest};color:#ffffff;`,
        light: `background:${C.frame};color:${C.ink2};border:1px solid ${C.line};`, dark: `background:${C.ink};color:#ffffff;`,
    }[tone];
    return `<span style="${s}display:inline-block;padding:4px 10px;border-radius:999px;font:600 11px/16px ${FONT};letter-spacing:.02em;white-space:nowrap;">${esc(text)}</span>`;
}

function marker(title: string, right = ""): string {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font:500 14px/20px ${FONT};color:${C.ink};"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${C.accent};vertical-align:-1px;margin-right:8px;"></span>${esc(title)}</td>
<td align="right" style="font:400 11px/20px ${FONT};color:${C.ink3};">${right}</td></tr></table>`;
}

function heading(light: string, bold: string): string {
    return `<div style="font:300 30px/36px ${FONT};letter-spacing:-.03em;color:${C.ink3};margin:0;">${esc(light)} <span style="font-weight:500;color:${C.ink};">${esc(bold)}</span></div>`;
}

function button(label: string, href: string, dark = true): string {
    const s = dark ? `background:${C.ink};color:#ffffff;` : `background:${C.frame};color:${C.ink};border:1px solid ${C.line};`;
    return `<a href="${esc(href)}" style="${s}display:inline-block;padding:12px 20px;border-radius:999px;font:500 13px/16px ${FONT};text-decoration:none;margin:0 8px 8px 0;">${esc(label)}&nbsp;&nbsp;→</a>`;
}

function shell(preheader: string, inner: string, footer: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&display=swap" rel="stylesheet"><title>Kavach</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${C.frame};border-radius:28px;">
<tr><td style="padding:26px 28px 6px 28px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
    <td><img src="${LOGO_URL}" width="128" height="36" alt="Kavach" style="display:block;border:0;width:128px;height:auto;"></td>
    <td align="right">${pill("Monitor", "light")}</td></tr></table>
</td></tr>
${inner}
<tr><td style="padding:18px 28px 26px 28px;border-top:1px solid ${C.line};font:400 11.5px/18px ${FONT};color:${C.ink3};">${footer}</td></tr>
</table>
<div style="font:400 11px/18px ${FONT};color:${C.ink3};padding:14px 0 0 0;">Kavach Care OS · Saheli</div>
</td></tr></table></body></html>`;
}

function serviceRows(probes: Probe[], alerts: Alert[]): string {
    return probes.map((p) => {
        const a = alerts.find((x) => x.name === p.name);
        const tone = p.ok ? "ok" : "down";
        const label = p.ok ? (a?.kind === "up" ? "Back up" : "Working") : a?.kind === "still_down" ? "Still down" : "Down";
        const detail = p.ok ? `Answering · ${p.ms} ms` : describeProbe(p).replace(/^./, (c) => c.toUpperCase());
        return `<tr><td style="padding:0 0 8px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border-radius:16px;">
<tr><td style="padding:14px 16px;font:500 14px/20px ${FONT};color:${C.ink};">${esc(p.label)}
<div style="font:400 12px/18px ${FONT};color:${C.ink2};margin-top:2px;">${esc(detail)}</div></td>
<td align="right" style="padding:14px 16px;vertical-align:middle;">${pill(label, tone)}</td></tr></table></td></tr>`;
    }).join("");
}

/** "Back up after 2 h 10 min", once if they all came back together, else per part. */
export function recoveredLine(up: Alert[]): string {
    const details = [...new Set(up.map((a) => a.detail.replace(/\.$/, "")))];
    if (!details.length) return "Everything is answering again";
    if (details.length === 1) return details[0];
    return up.map((a) => `${a.label.split(" (")[0]}: ${a.detail.replace(/^Back up /, "back ").replace(/\.$/, "")}`).join(" · ");
}

/** Down / still down / recovered: one email per round, every service listed. */
export function alertEmail(alerts: Alert[], probes: Probe[], now: string): { subject: string; html: string } {
    const down = alerts.filter((a) => a.kind !== "up");
    const up = alerts.filter((a) => a.kind === "up");
    const isDown = down.length > 0;
    const since = down.map((a) => a.since).filter(Boolean).sort()[0] as string | undefined;
    const subject = isDown
        ? `Kavach is down: ${down.map((a) => a.label.split(" (")[0]).join(", ")}`
        : `Kavach is back up: ${up.map((a) => a.label.split(" (")[0]).join(", ")}`;
    const banner = isDown
        ? `<td style="background:${C.accentSoft};border-radius:18px;padding:16px 18px;font:500 14px/21px ${FONT};color:${C.accentInk};">
${esc(down.length === probes.length ? `Nothing is answering` : `${down.length} of ${probes.length} ${down.length === 1 ? "part is" : "parts are"} not answering`)}${since ? esc(` since ${ist(since)} (${duration(since, now)})`) : ""}.
<div style="font:400 12.5px/19px ${FONT};margin-top:4px;">Families may not be getting Saheli's replies or medicine reminders right now.</div></td>`
        : `<td style="background:${C.forest};border-radius:18px;padding:16px 18px;font:500 14px/21px ${FONT};color:#ffffff;">
${esc(recoveredLine(up))}.
<div style="font:400 12.5px/19px ${FONT};color:#b9cfc5;margin-top:4px;">Reminders missed while it was down are sent late, or noted for caregivers on the dashboard.</div></td>`;
    const meaning = isDown
        ? `<tr><td style="padding:10px 28px 4px 28px;">${marker("What it can mean")}
<div style="font:400 13px/21px ${FONT};color:${C.ink2};margin-top:8px;">A bad deploy, Google Cloud suspending or blocking the project, the database being down, or Cloud Run out of quota.
Run <span style="font-family:monospace;color:${C.ink};">golive/verify.sh</span>, or open the Cloud Run logs.</div></td></tr>
<tr><td style="padding:14px 28px 10px 28px;">${button("Open Cloud Run", "https://console.cloud.google.com/run?project=kavach-care")}${button("Open the dashboard", "https://app.kavach.care", false)}</td></tr>`
        : `<tr><td style="padding:14px 28px 10px 28px;">${button("Open the dashboard", "https://app.kavach.care")}</td></tr>`;
    const inner = `<tr><td style="padding:18px 28px 4px 28px;">${heading("Kavach is", isDown ? "down" : "back up")}
<div style="font:400 12px/18px ${FONT};color:${C.ink3};margin-top:6px;">${esc(ist(now, true))}</div></td></tr>
<tr><td style="padding:14px 28px 6px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${banner}</tr></table></td></tr>
<tr><td style="padding:16px 28px 6px 28px;">${marker("Every check now", `every 5 min`)}</td></tr>
<tr><td style="padding:4px 28px 0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${serviceRows(probes, alerts)}</table></td></tr>
${meaning}`;
    const footer = isDown
        ? "Checked by the Kavach monitor on Cloudflare, outside Google, so it still reaches you when Google is down. You'll get a reminder every 6 hours while it stays down, and an email when it recovers."
        : "Checked by the Kavach monitor on Cloudflare, outside Google.";
    return { subject, html: shell(isDown ? `${down.length} part(s) of Kavach are not answering.` : "Everything is answering again.", inner, esc(footer)) };
}

/** Monday check-in: each service's uptime for the week as a dark bar, so a silent alarm is noticed. */
export function weeklyEmail(state: State, now: string): { subject: string; html: string } {
    const labels: Record<string, string> = { dashboard: "Dashboard", backend: "Backend + database", engine: "Saheli's brain" };
    const rows = Object.entries(state.services).map(([name, s]) => {
        const pct = s.checks ? (100 * s.okChecks) / s.checks : 100;
        const w = Math.max(2, Math.round(pct));
        return `<tr><td style="padding:0 0 12px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="font:500 13px/20px ${FONT};color:${C.ink};">${esc(labels[name] || name)}</td>
<td align="right" style="font:500 13px/20px ${FONT};color:${pct >= 99.5 ? C.ink : C.accentInk};">${pct.toFixed(2)}%${s.down ? "&nbsp;&nbsp;" + pill("Down now", "down") : ""}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border-radius:6px;margin-top:6px;"><tr>
<td width="${w}%" style="background:${pct >= 99.5 ? C.forest : C.accent};height:10px;border-radius:6px;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr></table>
<div style="font:400 11px/16px ${FONT};color:${C.ink3};margin-top:4px;">${s.checks} checks</div></td></tr>`;
    }).join("");
    const inner = `<tr><td style="padding:18px 28px 4px 28px;">${heading("Weekly", "check-in")}
<div style="font:400 12px/18px ${FONT};color:${C.ink3};margin-top:6px;">Since ${esc(state.weekStart ? ist(state.weekStart, true) : "the monitor started")}</div></td></tr>
<tr><td style="padding:16px 28px 6px 28px;">${marker("Uptime this week")}</td></tr>
<tr><td style="padding:8px 28px 8px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>
<tr><td style="padding:4px 28px 14px 28px;">${button("Open the dashboard", "https://app.kavach.care", false)}</td></tr>`;
    return { subject: "Kavach monitor: weekly check-in", html: shell("The Kavach monitor is running.", inner, esc("The monitor is running. If this email stops arriving on Mondays, the monitor itself needs a look.")) };
}
