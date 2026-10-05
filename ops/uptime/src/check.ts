/**
 * The alarm's decisions, kept free of Cloudflare and network code so they can be tested anywhere.
 *
 * A service is "down" after FAILS_TO_ALERT checks in a row fail (one blip never wakes anyone). Down sends one alert,
 * then a reminder every REMIND_EVERY_H hours while it stays down; coming back sends a "recovered" note with how long.
 */

export const FAILS_TO_ALERT = 2;
export const REMIND_EVERY_H = 6;

export type Target = { name: string; label: string; url: string; expect?: (status: number, body: string) => boolean };

export type Probe = { name: string; label: string; ok: boolean; status?: number; ms: number; error?: string };

export type ServiceState = { fails: number; down: boolean; since?: string; lastAlertAt?: string; checks: number; okChecks: number };
export type State = { services: Record<string, ServiceState>; weekStart?: string };

export type Alert = { kind: "down" | "still_down" | "up"; name: string; label: string; since?: string; detail: string };

const hours = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;

export function duration(fromIso: string, toIso: string): string {
    const m = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days ${h % 24} h`;
}

export function describeProbe(p: Probe): string {
    return p.ok ? `OK in ${p.ms} ms` : p.status ? `answered ${p.status}${p.error ? ` (${p.error})` : ""}` : `no answer (${p.error || "timeout"})`;
}

/** Next state and the alerts to send, from the previous state and this round of checks. */
export function decide(prev: State, probes: Probe[], now: string): { next: State; alerts: Alert[] } {
    const services: Record<string, ServiceState> = {};
    const alerts: Alert[] = [];
    for (const p of probes) {
        const s: ServiceState = { fails: 0, down: false, checks: 0, okChecks: 0, ...(prev.services[p.name] ?? {}) };
        s.checks += 1;
        if (p.ok) {
            s.okChecks += 1;
            if (s.down) {
                alerts.push({ kind: "up", name: p.name, label: p.label, since: s.since,
                              detail: `Back up after ${s.since ? duration(s.since, now) : "a while"}.` });
            }
            services[p.name] = { ...s, fails: 0, down: false, since: undefined, lastAlertAt: undefined };
            continue;
        }
        s.fails += 1;
        if (!s.down && s.fails >= FAILS_TO_ALERT) {
            s.down = true;
            s.since = s.since ?? now;
            s.lastAlertAt = now;
            alerts.push({ kind: "down", name: p.name, label: p.label, since: s.since, detail: describeProbe(p) });
        } else if (s.down && s.lastAlertAt && hours(s.lastAlertAt, now) >= REMIND_EVERY_H) {
            s.lastAlertAt = now;
            alerts.push({ kind: "still_down", name: p.name, label: p.label, since: s.since,
                          detail: `Still down after ${s.since ? duration(s.since, now) : "a while"}: ${describeProbe(p)}` });
        }
        if (s.fails === 1 && !s.since) s.since = now; // when the trouble started, even before it counts as down
        services[p.name] = s;
    }
    return { next: { ...prev, services }, alerts };
}

/** Email subject and body for a batch of alerts (one email per round, never one per service). */
export function formatAlerts(alerts: Alert[], probes: Probe[], now: string): { subject: string; text: string } {
    const down = alerts.filter((a) => a.kind !== "up");
    const up = alerts.filter((a) => a.kind === "up");
    const subject = down.length
        ? `🔴 Kavach down: ${down.map((a) => a.label).join(", ")}`
        : `🟢 Kavach recovered: ${up.map((a) => a.label).join(", ")}`;
    const lines = [
        ...alerts.map((a) => `${a.kind === "up" ? "RECOVERED" : a.kind === "down" ? "DOWN" : "STILL DOWN"} — ${a.label}: ${a.detail}`),
        "",
        "All checks now:",
        ...probes.map((p) => `  ${p.ok ? "ok  " : "FAIL"}  ${p.label}: ${describeProbe(p)}`),
        "",
        down.length
            ? "What it can mean: a bad deploy, Google Cloud suspending or blocking the project, the database down, or Cloud Run out of " +
              "quota. Families may not be getting reminders or replies. Run golive/verify.sh, or check the Cloud Run logs."
            : "Families get replies and reminders again. Reminders missed while it was down are sent late or noted for caregivers.",
        "",
        `Checked ${now} by the Kavach monitor on Cloudflare (outside Google).`,
    ];
    return { subject, text: lines.join("\n") };
}

/** Monday summary: proof the alarm itself is alive, with each service's uptime over the week. */
export function weeklySummary(state: State, now: string): { subject: string; text: string } {
    const rows = Object.entries(state.services).map(([name, s]) => {
        const pct = s.checks ? (100 * s.okChecks) / s.checks : 100;
        return `  ${name}: ${pct.toFixed(2)}% up (${s.checks} checks)${s.down ? " — DOWN NOW" : ""}`;
    });
    return {
        subject: `Kavach monitor: weekly check-in`,
        text: ["The Kavach monitor is running. Uptime since " + (state.weekStart || "it started") + ":", ...rows, "", `Sent ${now}.`].join("\n"),
    };
}

/** After the summary, counts start again (down state is kept). */
export function resetWeek(state: State, now: string): State {
    const services: Record<string, ServiceState> = {};
    for (const [k, s] of Object.entries(state.services)) services[k] = { ...s, checks: 0, okChecks: 0 };
    return { services, weekStart: now };
}
