import mongoose, { Schema } from "mongoose";

/**
 * What Saheli already knows about one elder: facts she stored, and the recent chat.
 * The loop loads this before it decides, and writes it back after each turn.
 */
const schema = new Schema(
    {
        elderId: { type: String, required: true, unique: true },
        familyId: { type: String, required: true },
        facts: { type: [String], default: [] },
        episodes: { type: [String], default: [] },
        record: { type: String, default: "" },
        medicines: { type: [Schema.Types.Mixed], default: [] },
        reminders: { type: [Schema.Types.Mixed], default: [] },
        readings: { type: [Schema.Types.Mixed], default: [] },
        routines: { type: [String], default: [] },
        moods: { type: [String], default: [] },
        alerts: {
            type: [
                {
                    reason: { type: String, default: "" },
                    note: { type: String, default: "" },
                    at: { type: String, default: "" },
                    speaker: { type: String, default: "" },
                },
            ],
            default: [],
        },
    },
    { timestamps: true, collection: "saheli_family_histories" },
);

export default mongoose.models.SaheliFamilyHistory || mongoose.model("SaheliFamilyHistory", schema);
