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

/** A little under 24 hours, so a message sent at the edge never lands just after the window shut. */
export const WINDOW_MS = 24 * 3_600_000 - 10 * 60_000;

export function phoneKey(phone: string): string {
    return String(phone ?? "").replace(/\D/g, "");
}

export async function noteInbound(phone: string, at: Date = new Date()): Promise<void> {
    const key = phoneKey(phone);
    if (key.length < 8) return;
    await WhatsAppWindow.updateOne({ phone: key }, { $set: { lastInboundAt: at }, $unset: { closedAt: 1 } }, { upsert: true });
}

/** Meta could not deliver a free message (outside the window): close it, so the next send uses a template. */
export async function noteClosed(phone: string, at: Date = new Date()): Promise<void> {
    const key = phoneKey(phone);
    if (key.length < 8) return;
    await WhatsAppWindow.updateOne({ phone: key }, { $set: { closedAt: at }, $setOnInsert: { lastInboundAt: new Date(0) } }, { upsert: true });
}

/**
 * Is the chat with this number open? A number with no row yet (it has not written since windows were kept) counts as
 * open: the message is tried as before, and if Meta says the chat was closed (131047) the row records it.
 */
export async function windowOpen(phone: string, now: Date = new Date()): Promise<boolean> {
    const row = await WhatsAppWindow.findOne({ phone: phoneKey(phone) }).lean<{ lastInboundAt?: Date; closedAt?: Date }>();
    if (!row) return true;
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

export async function keepWaiting(input: { phone: string; familyId: string; toUserId?: string; purpose: string; text: string }): Promise<void> {
    const text = input.text.trim();
    if (!text) return;
    await WhatsAppWaiting.create({ phone: phoneKey(input.phone), familyId: input.familyId, toUserId: input.toUserId, purpose: input.purpose, text: text.slice(0, 4000) });
}

/** What waited for this person (oldest first, from any of their families), now handed to Saheli's turn: marked given. */
export async function takeWaiting(toUserId: string): Promise<Array<{ purpose: string; text: string; at: string }>> {
    if (!toUserId) return [];
    const q = { toUserId, deliveredAt: { $exists: false } };
    const rows = await WhatsAppWaiting.find(q).sort({ createdAt: 1 }).limit(8).lean<Array<{ _id: unknown; purpose: string; text: string; createdAt: Date }>>();
    if (!rows.length) return [];
    await WhatsAppWaiting.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { deliveredAt: new Date() } });
    return rows.map((r) => ({ purpose: r.purpose, text: r.text, at: new Date(r.createdAt).toISOString() }));
}
