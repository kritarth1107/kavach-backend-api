import mongoose, { Schema } from "mongoose";

/**
 * The daily due-vs-sent report (trust plan B1.6; founder D6: the Kavach team email + the admin "Delivery" page), one per
 * IST day, built at 23:30. Counts only, with first names: per family and in total due, sent, delivered, read, held and
 * failed by reason, missed, the on-time rate, and every dose that did not reach the phone.
 */
export type DeliveryCounts = {
    due: number;
    sent: number;
    delivered: number;
    read: number;
    held: Record<string, number>;
    failed: Record<string, number>;
    missed: number;
    /** Sent on time: doses within 2 minutes of their time, other reminders within 15. */
    onTime: number;
    /** Slots whose time had come (the on-time rate's denominator: due minus held). */
    attemptable: number;
    later: number;
    /** A Done, Later or Skip tap recorded on the slot. */
    answered?: number;
};

export interface IDeliveryReport {
    dateKey: string;
    builtAt: Date;
    totals: DeliveryCounts;
    /** Per kind: dose and reminder. Habits and appointments that are not on the due list are not in these rows. */
    byKind?: Array<{ kind: string; counts: DeliveryCounts }>;
    families: Array<{ family: string; people: string[]; counts: DeliveryCounts }>;
    notDelivered: Array<{ family: string; person: string; medicine: string; time: string; state: string; reason?: string; attempts?: number }>;
    /** Sends with a wamid and with a receipt (the ledger's own health: B1 done-when). */
    ledger?: { sends: number; withWamid: number; withReceipt: number; failed: number };
    /** Slots sent before the ledger was watching them (the first build after a deploy): no receipt to wait for. */
    untracked?: number;
    emailedAt?: Date;
    emailError?: string;
}

const schema = new Schema<IDeliveryReport>(
    {
        dateKey: { type: String, required: true, unique: true },
        builtAt: { type: Date, required: true },
        totals: { type: Schema.Types.Mixed, required: true },
        byKind: { type: Schema.Types.Mixed },
        families: { type: Schema.Types.Mixed, default: [] },
        notDelivered: { type: Schema.Types.Mixed, default: [] },
        ledger: { type: Schema.Types.Mixed },
        untracked: { type: Number },
        emailedAt: { type: Date },
        emailError: { type: String },
    },
    { versionKey: false, collection: "delivery_reports" },
);

export default (mongoose.models.DeliveryReport as mongoose.Model<IDeliveryReport>) ||
    mongoose.model<IDeliveryReport>("DeliveryReport", schema);
