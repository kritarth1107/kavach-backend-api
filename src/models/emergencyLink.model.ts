import mongoose, { Document, Model, Schema } from "mongoose";

/** A read-only emergency card anyone with the link can open (hospital, neighbour, ambulance). */
export interface IEmergencyLink {
    token: string;
    familyId: string;
    subjectUserId: string;
    createdBy: string;
    revokedAt?: Date | null;
    lastOpenedAt?: Date | null;
    opens: number;
    createdAt?: Date;
}

export interface IEmergencyLinkDocument extends IEmergencyLink, Document {}

const emergencyLinkSchema = new Schema<IEmergencyLinkDocument>(
    {
        token: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        subjectUserId: { type: String, required: true },
        createdBy: { type: String, required: true },
        revokedAt: { type: Date, default: null },
        lastOpenedAt: { type: Date, default: null },
        opens: { type: Number, default: 0 },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
);

emergencyLinkSchema.index({ familyId: 1, subjectUserId: 1 });

const EmergencyLink: Model<IEmergencyLinkDocument> =
    (mongoose.models.EmergencyLink as Model<IEmergencyLinkDocument>) ||
    mongoose.model<IEmergencyLinkDocument>("EmergencyLink", emergencyLinkSchema);

export default EmergencyLink;
