/**
 * WhatsApp's 24-hour rule (founder 2026-10-12: "WhatsApp has its limitation of a 24-hour window"). A business may write
 * freely only within 24 hours of the person's last message; after that only an approved template reaches them, and a
 * free message fails quietly (Meta reports error 131047 later). Every inbound message notes the number here, so each
 * send knows whether the chat is open, for everyone (not just the person cared for).
 *
 * When it is closed, the sender passes a template (see whatsappTemplates.service): the person gets a short notice, and
 * the full message waits here until they write or tap it. Saheli gives it in that turn.
 */
import WhatsAppWindow from "../models/whatsappWindow.model";
import WhatsAppWaiting from "../models/whatsappWaiting.model";
import { clockNow } from "../utils/clock.util";

/** A little under 24 hours, so a message sent at the edge never lands just after the window shut. */
export const WINDOW_MS = 24 * 3_600_000 - 10 * 60_000;

export function phoneKey(phone: string): string {
    return String(phone ?? "").replace(/\D/g, "");
}

export async function noteInbound(phone: string, at: Date = clockNow()): Promise<void> {
    const key = phoneKey(phone);
    if (key.length < 8) return;
    await WhatsAppWindow.updateOne({ phone: key }, { $set: { lastInboundAt: at }, $unset: { closedAt: 1 } }, { upsert: true });
}

/** Meta could not deliver a free message (outside the window): close it, so the next send uses a template. */
export async function noteClosed(phone: string, at: Date = clockNow()): Promise<void> {
    const key = phoneKey(phone);
    if (key.length < 8) return;
    await WhatsAppWindow.updateOne({ phone: key }, { $set: { closedAt: at }, $setOnInsert: { lastInboundAt: new Date(0) } }, { upsert: true });
}

/**
 * Is the chat with this number open? A number with no row has not written to Saheli since windows were kept (12 Oct,
 * more than 24 hours ago), so its chat is closed (trust plan B3.1: a free message to it would fail quietly). Every inbound
 * message writes the row before it is answered, so a reply always finds it open.
 */
export async function windowOpen(phone: string, now: Date = clockNow()): Promise<boolean> {
    const row = await WhatsAppWindow.findOne({ phone: phoneKey(phone) }).lean<{ lastInboundAt?: Date; closedAt?: Date }>();
    if (!row) return false;
    const last = row.lastInboundAt ? new Date(row.lastInboundAt).getTime() : 0;
    if (row.closedAt && new Date(row.closedAt).getTime() >= last) return false;
    return now.getTime() - last < WINDOW_MS;
}

/** Status webhooks: a free message Meta refused because the window was closed (131047) closes it here too. */
export async function noteStatusFailures(body: unknown): Promise<number> {
    let closed = 0;
    const entries = (body as { entry?: Array<{ changes?: Array<{ value?: { statuses?: unknown[] } }> }> } | null)?.entry ?? [];
    for (const entry of entries) {
        for (const change of entry.changes ?? []) {
            for (const raw of change.value?.statuses ?? []) {
                const s = raw as { status?: string; recipient_id?: string; errors?: Array<{ code?: number }> };
                if (s?.status === "failed" && s.recipient_id && (s.errors ?? []).some((e) => Number(e?.code) === 131047)) {
                    await noteClosed(s.recipient_id).catch(() => undefined);
                    closed += 1;
                }
            }
        }
    }
    return closed;
}

export async function keepWaiting(input: { phone: string; familyId: string; toUserId?: string; purpose: string; kind?: string; text: string }): Promise<void> {
    const text = input.text.trim();
    if (!text) return;
    await WhatsAppWaiting.create({
        phone: phoneKey(input.phone), familyId: input.familyId, toUserId: input.toUserId, purpose: input.purpose,
        ...(input.kind ? { kind: input.kind } : {}), text: text.slice(0, 4000),
    });
}

/** A nudge or a check-in is written for its moment ("it is 8:30, had breakfast?"). Waited longer than this, it is dropped
 *  instead of given word for word (live 16 Oct: a breakfast nudge given at 13:35). Saheli writes a fresh one for now. */
export const MOMENT_KINDS = new Set(["nudge", "checkin"]);
export const MOMENT_MS = 2 * 60 * 60_000;

function pastItsMoment(r: { kind?: string; createdAt: Date }, now: Date): boolean {
    return MOMENT_KINDS.has(String(r.kind ?? "")) && now.getTime() - new Date(r.createdAt).getTime() > MOMENT_MS;
}

/**
 * Everything that waited for this number (oldest first), taken to be given now (trust plan B3.4: on every message they
 * send, all of it). Marked given.
 */
export async function takeWaitingByPhone(phone: string): Promise<Array<{ purpose: string; text: string; at: string; toUserId?: string }>> {
    const key = phoneKey(phone);
    if (key.length < 8) return [];
    const all = await WhatsAppWaiting.find({ phone: key, deliveredAt: { $exists: false } }).sort({ createdAt: 1 }).limit(200)
        .lean<Array<{ _id: unknown; purpose: string; kind?: string; text: string; createdAt: Date; toUserId?: string }>>();
    if (!all.length) return [];
    const now = clockNow();
    const stale = all.filter((r) => pastItsMoment(r, now));
    const rows = all.filter((r) => !pastItsMoment(r, now));
    if (stale.length) {
        await WhatsAppWaiting.updateMany({ _id: { $in: stale.map((r) => r._id) } }, { $set: { deliveredAt: now, expired: true } });
        console.log(`WhatsApp: ${stale.length} waiting nudge(s) past their moment dropped, not given`);
    }
    if (!rows.length) return [];
    await WhatsAppWaiting.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { deliveredAt: now } });
    return rows.map((r) => ({ purpose: r.purpose, text: r.text, at: new Date(r.createdAt).toISOString(), ...(r.toUserId ? { toUserId: r.toUserId } : {}) }));
}

/** At most this many waiting messages go one by one; more become one summary, newest first. */
export const WAITING_ONE_BY_ONE = 8;

/** Pure: the WhatsApp texts for what waited (each with its time if it is older than 30 minutes; > 8 → one summary). */
export function waitingTexts(items: Array<{ text: string; at: string }>, now: Date = clockNow()): string[] {
    const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
    const stamp = (w: { at: string }) => (now.getTime() - new Date(w.at).getTime() > 30 * 60_000 ? `🕘 ${clock(w.at)}` : "");
    if (items.length <= WAITING_ONE_BY_ONE) return items.map((w) => [stamp(w), w.text].filter(Boolean).join("\n"));
    const newest = [...items].reverse();
    return [[`📬 ${items.length}`, ...newest.map((w) => `🕘 ${clock(w.at)}\n${w.text}`)].join("\n\n")];
}

/** What waited for this person (oldest first, from any of their families), now handed to Saheli's turn: marked given. */
export async function takeWaiting(toUserId: string): Promise<Array<{ purpose: string; text: string; at: string }>> {
    if (!toUserId) return [];
    const q = { toUserId, deliveredAt: { $exists: false } };
    const found = await WhatsAppWaiting.find(q).sort({ createdAt: 1 }).limit(8).lean<Array<{ _id: unknown; purpose: string; kind?: string; text: string; createdAt: Date }>>();
    if (!found.length) return [];
    const now = clockNow();
    const stale = found.filter((r) => pastItsMoment(r, now));
    if (stale.length) await WhatsAppWaiting.updateMany({ _id: { $in: stale.map((r) => r._id) } }, { $set: { deliveredAt: now, expired: true } });
    const rows = found.filter((r) => !pastItsMoment(r, now));
    if (!rows.length) return [];
    await WhatsAppWaiting.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { deliveredAt: now } });
    return rows.map((r) => ({ purpose: r.purpose, text: r.text, at: new Date(r.createdAt).toISOString() }));
}
