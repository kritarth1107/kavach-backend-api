import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import type { SaheliThreadKind } from "./saheliMessage.model";

export interface ISaheliChatSession {
    sessionId: string;
    familyId: string;
    recipientUserId: string;
    thread: SaheliThreadKind;
    actorUserId: string;
    title: string;
    aiConversationId?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface ISaheliChatSessionDocument extends ISaheliChatSession, Document {}

const saheliChatSessionSchema = new Schema<ISaheliChatSessionDocument>(
    {
        sessionId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        thread: { type: String, enum: ["elder", "caregiver"], required: true },
        actorUserId: { type: String, required: true, index: true },
        title: { type: String, default: "New chat", maxlength: 120 },
        aiConversationId: { type: String },
    },
    { timestamps: true },
);

saheliChatSessionSchema.pre("save", function (next) {
    if (!this.sessionId) this.sessionId = randomUUID();
    next();
});

saheliChatSessionSchema.index(
    { familyId: 1, recipientUserId: 1, thread: 1, actorUserId: 1, updatedAt: -1 },
);

const SaheliChatSession: Model<ISaheliChatSessionDocument> =
    (mongoose.models.SaheliChatSession as Model<ISaheliChatSessionDocument>) ||
    mongoose.model<ISaheliChatSessionDocument>("SaheliChatSession", saheliChatSessionSchema);

export default SaheliChatSession;
