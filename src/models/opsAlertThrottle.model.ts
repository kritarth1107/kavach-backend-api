import mongoose, { Schema } from "mongoose";

/** One row per alert key per window, so two backend tasks cannot both email the same crisis. */
const schema = new Schema(
    { key: { type: String, required: true, unique: true }, at: { type: Date, required: true, expires: 7 * 24 * 60 * 60 } },
    { versionKey: false, collection: "ops_alert_throttle" },
);

export default mongoose.models.OpsAlertThrottle || mongoose.model("OpsAlertThrottle", schema);
