import mongoose, { Schema } from "mongoose";

const schema = new Schema(
    {
        elderId: { type: String, required: true, index: true },
        goalId: { type: String, required: true },
        question: { type: String, required: true },
        answer: { type: String, default: null },
        at: { type: Date, default: Date.now },
    },
    { versionKey: false, collection: "saheli_feedback" },
);

export default mongoose.models.SaheliFeedback || mongoose.model("SaheliFeedback", schema);
