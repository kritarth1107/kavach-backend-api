import mongoose, { Schema } from "mongoose";

/**
 * One row per IST day: how many writes the retired memory stores got in the 24 hours before the check (trust plan A1:
 * must be 0, for 7 days running). Written by services/legacyWriteCheck.service.ts; any non-zero day emails the team.
 */
export interface ILegacyWriteCheck {
    day: string;
    at: Date;
    since: Date;
    counts: Record<string, number>;
    total: number;
    /** The engine's Instinct tables were counted (false: the engine could not be reached, which also alerts). */
    engineChecked: boolean;
    alerted: boolean;
}

const schema = new Schema<ILegacyWriteCheck>(
    {
        day: { type: String, required: true, unique: true },
        at: { type: Date, required: true },
        since: { type: Date, required: true },
        counts: { type: Schema.Types.Mixed, default: {} },
        total: { type: Number, default: 0 },
        engineChecked: { type: Boolean, default: false },
        alerted: { type: Boolean, default: false },
    },
    { collection: "legacy_write_checks" },
);

const LegacyWriteCheck =
    (mongoose.models.LegacyWriteCheck as mongoose.Model<ILegacyWriteCheck>) || mongoose.model<ILegacyWriteCheck>("LegacyWriteCheck", schema);
export default LegacyWriteCheck;
