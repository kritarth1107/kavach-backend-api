import mongoose, { Document, Schema } from "mongoose";

export interface IOutboundMessage {
    messageId: string;
    familyId: string;
    recipientUserId: string;
    channel: "whatsapp" | "phone" | "dashboard";
    channelIdentifier: string;
    content: string;
    direction: "outbound";
    deliveredAt?: Date;
    createdAt?: Date;
}

export interface IOutboundMessageDocument extends IOutboundMessage, Document {}

const outboundMessageSchema = new Schema<IOutboundMessageDocument>(
    {
        messageId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        channel: {
            type: String,
            enum: ["whatsapp", "phone", "dashboard"],
            required: true,
        },
        channelIdentifier: { type: String, required: true },
        content: { type: String, required: true },
        direction: { type: String, default: "outbound" },
        deliveredAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

export default mongoose.model<IOutboundMessageDocument>(
    "OutboundMessage",
    outboundMessageSchema,
);
