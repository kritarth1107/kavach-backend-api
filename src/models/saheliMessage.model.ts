import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";

export type SaheliThreadKind = "elder" | "caregiver";
export type SaheliMessageRole = "elder" | "saheli" | "family" | "system";

export interface ISaheliMessage {
    messageId: string;
    familyId: string;
    recipientUserId: string;
    thread: SaheliThreadKind;
    role: SaheliMessageRole;
    content: string;
    createdAt?: Date;
}

export interface ISaheliMessageDocument extends ISaheliMessage, Document {}

const saheliMessageSchema = new Schema<ISaheliMessageDocument>(
    {
        messageId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        thread: { type: String, enum: ["elder", "caregiver"], required: true },
        role: { type: String, enum: ["elder", "saheli", "family", "system"], required: true },
        content: { type: String, required: true, maxlength: 8000 },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (_doc, ret: Record<string, unknown>) => {
                delete ret.__v;
                return ret;
            },
        },
    },
);

saheliMessageSchema.pre("save", function (next) {
    if (!this.messageId) this.messageId = randomUUID();
    next();
});

saheliMessageSchema.index({ familyId: 1, recipientUserId: 1, thread: 1, createdAt: 1 });

const SaheliMessage: Model<ISaheliMessageDocument> =
    (mongoose.models.SaheliMessage as Model<ISaheliMessageDocument>) ||
    mongoose.model<ISaheliMessageDocument>("SaheliMessage", saheliMessageSchema);

export default SaheliMessage;
