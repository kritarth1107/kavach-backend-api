import mongoose, { Schema } from "mongoose";

/** Ola / Rapido availability per city key (persisted so it survives deploys). TTL via expiresAt. */
export interface IRideAvailability {
    key: string;
    service: "ola" | "rapido";
    status: "yes" | "no" | "unknown";
    checkedAt: Date;
    expiresAt: Date;
    detail?: string;
}

const schema = new Schema<IRideAvailability>(
    {
        key: { type: String, required: true },
        service: { type: String, required: true },
        status: { type: String, required: true },
        checkedAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        detail: { type: String },
    },
    { collection: "ride_availability", versionKey: false },
);
schema.index({ key: 1, service: 1 }, { unique: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default (mongoose.models.RideAvailability as mongoose.Model<IRideAvailability>) ||
    mongoose.model<IRideAvailability>("RideAvailability", schema);
