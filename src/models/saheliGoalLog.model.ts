import mongoose, { Schema } from "mongoose";

/** Append-only. One row per tool the loop actually ran. */
const schema = new Schema(
    {
        elderId: { type: String, required: true, index: true },
        goalId: { type: String, required: true },
        tool: { type: String, required: true },
        ok: { type: Boolean, required: true },
        error: { type: String, default: null },
        userSaidRight: { type: Boolean, default: null },
        at: { type: Date, default: Date.now },
    },
    { versionKey: false, collection: "saheli_goal_log" },
);

export default mongoose.models.SaheliGoalLog || mongoose.model("SaheliGoalLog", schema);
