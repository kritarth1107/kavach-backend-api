/**
 * One-off privacy audit (mock-secret gated): where did a leaked address string end up, and in
 * which families? Returns counts per family with masked ids only (no message content).
 * cleanup=true removes it from OTHER families' open order drafts (never touches history).
 */
import SaheliMessage from "../models/saheliMessage.model";
import OutboundMessage from "../models/outboundMessage.model";
import ActivityLog from "../models/activityLog.model";
import WhatsappSession from "../models/whatsappSession.model";
import ChannelIdentity from "../models/channelIdentity.model";
import Order from "../models/order.model";
import OrderPreview from "../models/orderPreview.model";

const LEAK = /sunita\s*park|labhandih|\b492001\b/i;
const mask = (s?: string | null) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-3)}` : null);
const maskPhone = (s?: string | null) => (s ? `…${String(s).replace(/\D/g, "").slice(-4)}` : null);

type Group = { family: string | null; owner: boolean; count: number; first?: string; last?: string; phones?: string[]; roles?: Record<string, number> };

function group(rows: Array<{ familyId?: string; createdAt?: Date; phone?: string; role?: string }>, ownerFamilies: Set<string>): Group[] {
    const by = new Map<string, Group>();
    for (const r of rows) {
        const fam = r.familyId || "none";
        const g = by.get(fam) || { family: mask(fam), owner: ownerFamilies.has(fam), count: 0, phones: [], roles: {} };
        g.count++;
        const at = r.createdAt ? new Date(r.createdAt).toISOString() : undefined;
        if (at && (!g.first || at < g.first)) g.first = at;
        if (at && (!g.last || at > g.last)) g.last = at;
        const p = maskPhone(r.phone);
        if (p && !g.phones!.includes(p)) g.phones!.push(p);
        if (r.role) g.roles![r.role] = (g.roles![r.role] || 0) + 1;
        by.set(fam, g);
    }
    return [...by.values()];
}

export async function runAddressLeakAudit(input: { ownerPhone: string; since?: string; cleanup?: boolean }) {
    const digits = input.ownerPhone.replace(/\D/g, "");
    const ids = await ChannelIdentity.find({ channelIdentifier: { $in: [digits, `+${digits}`, digits.slice(-10)] } }).lean();
    const ownerFamilies = new Set(ids.map((i) => i.familyId));
    const ownerSession = await WhatsappSession.findOne({ phone: { $in: [`+${digits}`, digits] } }, { familyId: 1 }).lean();
    if ((ownerSession as { familyId?: string } | null)?.familyId) ownerFamilies.add((ownerSession as { familyId: string }).familyId);
    const since = new Date(input.since || "2026-09-24T00:00:00Z");

    const msgs = await SaheliMessage.find({ createdAt: { $gte: since }, content: LEAK }, { familyId: 1, createdAt: 1, role: 1 }).lean();
    const outs = await OutboundMessage.find({ createdAt: { $gte: since }, content: LEAK }, { familyId: 1, createdAt: 1, channelIdentifier: 1 }).lean();
    const acts = await ActivityLog.find(
        { createdAt: { $gte: since }, $or: [{ detail: LEAK }, { title: LEAK }] },
        { familyId: 1, createdAt: 1, kind: 1 },
    ).lean();
    const orders = await Order.find({ deliveryAddress: LEAK }, { familyId: 1, createdAt: 1 }).lean();
    const previews = await OrderPreview.find({ deliveryAddress: LEAK }, { familyId: 1, createdAt: 1 }).lean();
    const sessions = (await WhatsappSession.find({}, { phone: 1, familyId: 1, browserTaskDraft: 1, pharmacyDraft: 1, updatedAt: 1 }).lean()) as Array<{
        _id: unknown;
        phone: string;
        familyId?: string;
        browserTaskDraft?: unknown;
        pharmacyDraft?: unknown;
        updatedAt?: Date;
    }>;
    const leakedDrafts = sessions.filter((s) => LEAK.test(JSON.stringify([s.browserTaskDraft ?? null, s.pharmacyDraft ?? null])));
    let cleaned = 0;
    if (input.cleanup) {
        for (const s of leakedDrafts) {
            if (s.familyId && ownerFamilies.has(s.familyId)) continue;
            await WhatsappSession.updateOne({ _id: s._id }, { $unset: { browserTaskDraft: 1, pharmacyDraft: 1, pendingCommerceOtp: 1 } });
            cleaned++;
        }
    }
    return {
        ownerFamilies: [...ownerFamilies].map(mask),
        since: since.toISOString(),
        saheliMessages: group(msgs.map((m) => ({ familyId: m.familyId, createdAt: m.createdAt, role: m.role })), ownerFamilies),
        outboundMessages: group(outs.map((o) => ({ familyId: o.familyId, createdAt: o.createdAt, phone: o.channelIdentifier })), ownerFamilies),
        activityLogs: group(acts.map((a) => ({ familyId: a.familyId, createdAt: a.createdAt, role: a.kind })), ownerFamilies),
        orders: group(orders.map((o) => ({ familyId: o.familyId, createdAt: (o as { createdAt?: Date }).createdAt })), ownerFamilies),
        orderPreviews: group(previews.map((o) => ({ familyId: o.familyId, createdAt: (o as { createdAt?: Date }).createdAt })), ownerFamilies),
        openDrafts: group(leakedDrafts.map((s) => ({ familyId: s.familyId, createdAt: s.updatedAt, phone: s.phone })), ownerFamilies),
        cleanedOtherFamilyDrafts: cleaned,
    };
}
