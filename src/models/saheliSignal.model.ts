import mongoose, { Schema } from "mongoose";

/** Empty in this build. The context loader still queries it. */
const schema = new Schema(
    {
        elderId: { type: String, required: true, index: true },
        kind: { type: String, required: true },
        payload: { type: Schema.Types.Mixed, default: {} },
        at: { type: Date, default: Date.now },
    },
    { versionKey: false, collection: "saheli_signals" },
);

schema.index({ elderId: 1, at: -1 });

export default mongoose.models.SaheliSignal || mongoose.model("SaheliSignal", schema);
