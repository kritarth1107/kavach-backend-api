import mongoose, { Schema } from "mongoose";

/**
 * Alerts the Kavach team got by email, as rows for the admin console (trust plan B1.5: "an immediate email … plus an
 * admin alert row"): a dose reminder that did not go or did not reach the phone, an escalation that did not fire on time.
 */
export interface IOpsAlertLog {
    kind: "dose" | "escalation" | "template" | "tick";
    subject: string;
    text: string;
    /** One line per case (family short id, first name, what, when, why). */
    items: Array<Record<string, unknown>>;
    /** Handled: emailed, or (since 17 Oct 2026, founder: only a crisis emails the team) kept here without an email. */
    emailed: boolean;
    error?: string;
    at: Date;
}

const schema = new Schema<IOpsAlertLog>(
    {
        kind: { type: String, required: true },
        subject: { type: String, required: true },
        text: { type: String, default: "" },
        items: { type: Schema.Types.Mixed, default: [] },
        emailed: { type: Boolean, default: false },
        error: { type: String },
        at: { type: Date, required: true, expires: 180 * 24 * 60 * 60 },
    },
    { versionKey: false, collection: "ops_alerts" },
);
schema.index({ kind: 1, at: -1 });

export default (mongoose.models.OpsAlertLog as mongoose.Model<IOpsAlertLog>) || mongoose.model<IOpsAlertLog>("OpsAlertLog", schema);
