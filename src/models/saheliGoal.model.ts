import mongoose, { Schema } from "mongoose";

/**
 * One open or waiting goal per elder. Dropped goals stay as history.
 * The loop writes this document before a tool runs.
 */
const schema = new Schema(
    {
        elderId: { type: String, required: true, index: true },
        familyId: { type: String, required: true },
        goal: { type: String, default: "" },
        step: { type: String, default: "" },
        status: { type: String, enum: ["open", "waiting_confirm", "waiting_user", "done", "dropped"], default: "open" },
        tool: { type: String, default: null },
        toolArgs: { type: Schema.Types.Mixed, default: {} },
        query: { type: String, default: null },
        page: { type: Number, default: 0 },
        hits: { type: Schema.Types.Mixed, default: [] },
        lastResult: { type: Schema.Types.Mixed, default: null },
        waitingFor: { type: String, default: null },
        language: { type: String, default: "en" },
        toldFare: { type: Number, default: null },
        toldPickup: { type: String, default: null },
        history: { type: Schema.Types.Mixed, default: [] },
    },
    { timestamps: true, collection: "saheli_goals" },
);

schema.index(
    { elderId: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ["open", "waiting_confirm", "waiting_user"] } } },
);
schema.index({ elderId: 1, status: 1 });

export default mongoose.models.SaheliGoal || mongoose.model("SaheliGoal", schema);
