import mongoose, { Document, Schema } from "mongoose";

export interface IEmergencyEscalationLog {
    escalationId: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    channel: string;
    caregiversNotified: number;
    createdAt: Date;
}

export interface IEmergencyEscalationLogDocument extends IEmergencyEscalationLog, Document {}

const emergencyEscalationLogSchema = new Schema<IEmergencyEscalationLogDocument>(
    {
        escalationId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        actorUserId: { type: String, required: true },
        message: { type: String, required: true },
        channel: { type: String, default: "whatsapp" },
        caregiversNotified: { type: Number, default: 0 },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
);

emergencyEscalationLogSchema.index({ familyId: 1, recipientUserId: 1, createdAt: -1 });

export default mongoose.model<IEmergencyEscalationLogDocument>(
    "EmergencyEscalationLog",
    emergencyEscalationLogSchema,
);
