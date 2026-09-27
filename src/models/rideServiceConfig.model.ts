import mongoose, { Schema } from "mongoose";

/**
 * Operator-editable ride config (one doc, _id "default"). Any field left out falls back to the
 * built-in defaults in rideConfig.ts — so city lists / chains can change without a deploy.
 */
const schema = new Schema(
    {
        _id: { type: String, default: "default" },
        /** tier → extra city names (lower-case words) added to that tier. */
        cities: { type: Schema.Types.Mixed },
        /** tier → cab chain, e.g. { tier2: ["uber","rapido","ola"] }. */
        cabChains: { type: Schema.Types.Mixed },
        autoChain: { type: [String] },
        /** Services switched off everywhere (e.g. ["ola"]). */
        disabled: { type: [String] },
        /** Extra tier-3 towns where Uber runs (lower-case). */
        uberExtraCities: { type: [String] },
        probeTtlHours: { type: Number },
        probeTimeoutMs: { type: Number },
        maxProbesPerHour: { type: Number },
        olaInChat: { type: Boolean },
        olaSearchTimeoutSec: { type: Number },
        olaUpdateEverySec: { type: Number },
        olaAssignedWatchMin: { type: Number },
        updatedAt: { type: Date },
    },
    { collection: "ride_service_config", versionKey: false },
);

export default (mongoose.models.RideServiceConfig as mongoose.Model<Record<string, unknown>>) ||
    mongoose.model("RideServiceConfig", schema);
