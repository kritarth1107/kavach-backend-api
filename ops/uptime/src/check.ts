/**
 * The alarm's decisions, kept free of Cloudflare and network code so they can be tested anywhere.
 *
 * A service is "down" after FAILS_TO_ALERT checks in a row fail (one blip never wakes anyone). Down sends one alert,
 * then a reminder once a day while it stays down; coming back sends a "recovered" note with how long.
 *
 * The state changes only when something happens (a failure starts, it counts as down, an alert goes out, it recovers),
 * so the Worker writes to KV a few times a day, not every 5 minutes (the free tier allows 1,000 writes a day).
 * Weekly uptime comes from the time spent failing, not from counting checks.
 */

export const FAILS_TO_ALERT = 2;
export const REMIND_EVERY_H = 24;

export type Target = { name: string; label: string; url: string; expect?: (status: number, body: string) => boolean };

export type Probe = { name: string; label: string; ok: boolean; status?: number; ms: number; error?: string };

export type ServiceState = {
    fails: number; // capped at FAILS_TO_ALERT, so a long outage doesn't change the state every round
    down: boolean;
    since?: string; // when the current trouble started
    countFrom?: string; // set when a new week starts mid-outage: downtime before it belongs to last week
    lastAlertAt?: string;
    downMs: number; // time spent failing this week, closed periods only
};
export type State = { services: Record<string, ServiceState>; weekStart?: string };

export type Alert = { kind: "down" | "still_down" | "up"; name: string; label: string; since?: string; detail: string };

const hours = (a: string, b: string) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
const ms = (a: string, b: string) => Math.max(0, new Date(b).getTime() - new Date(a).getTime());

/** Only the known fields (older stored states had per-check counters). */
export function clean(s: Partial<ServiceState> & Record<string, unknown>): ServiceState {
    const out: ServiceState = { fails: Number(s.fails) || 0, down: !!s.down, downMs: Number(s.downMs) || 0 };
    if (s.since) out.since = s.since;
    if (s.countFrom) out.countFrom = s.countFrom;
    if (s.lastAlertAt) out.lastAlertAt = s.lastAlertAt;
    return out;
}

/** Time spent failing this week, counting an outage still going on. */
export function downtimeMs(s: ServiceState, now: string): number {
    return s.downMs + (s.since ? ms(s.countFrom ?? s.since, now) : 0);
}

/** Uptime over the week so far. */
export function uptimePct(s: ServiceState, weekStart: string | undefined, now: string): number {
    const span = weekStart ? ms(weekStart, now) : 0;
    return span ? Math.max(0, 100 * (1 - downtimeMs(s, now) / span)) : 100;
}

export function duration(fromIso: string, toIso: string): string {
    return formatMs(new Date(toIso).getTime() - new Date(fromIso).getTime());
}

export function formatMs(span: number): string {
    const m = Math.max(0, Math.round(span / 60_000));
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
        const s = clean(prev.services[p.name] ?? {});
        if (p.ok) {
            if (s.down) {
                alerts.push({ kind: "up", name: p.name, label: p.label, since: s.since,
                              detail: `Back up after ${s.since ? duration(s.since, now) : "a while"}.` });
            }
            services[p.name] = { fails: 0, down: false, downMs: downtimeMs(s, now) };
            continue;
        }
        s.fails = Math.min(s.fails + 1, FAILS_TO_ALERT);
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
        if (!s.since) s.since = now; // when the trouble started, even before it counts as down
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
        return `  ${name}: ${uptimePct(clean(s), state.weekStart, now).toFixed(2)}% up${s.down ? " — DOWN NOW" : ""}`;
    });
    return {
        subject: `Kavach monitor: weekly check-in`,
        text: ["The Kavach monitor is running. Uptime since " + (state.weekStart || "it started") + ":", ...rows, "", `Sent ${now}.`].join("\n"),
    };
}

/** After the summary, downtime starts again from zero (an outage going on is kept, counted from now). */
export function resetWeek(state: State, now: string): State {
    const services: Record<string, ServiceState> = {};
    for (const [k, raw] of Object.entries(state.services)) {
        const s = clean(raw);
        services[k] = { ...s, downMs: 0, ...(s.since ? { countFrom: now } : {}) };
    }
    return { services, weekStart: now };
}
