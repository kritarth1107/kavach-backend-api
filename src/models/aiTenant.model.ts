import mongoose, { Document, Model, Schema } from "mongoose";

export interface IAiElderLink {
    recipientUserId: string;
    aiElderId: string;
    conversationId?: string;
    caregiverConversationId?: string;
}

export interface IAiTenantDocument extends Document {
    familyId: string;
    aiFamilyId: string;
    elders: IAiElderLink[];
}

const elderLinkSchema = new Schema<IAiElderLink>(
    {
        recipientUserId: { type: String, required: true },
        aiElderId: { type: String, required: true },
        conversationId: { type: String },
        caregiverConversationId: { type: String },
    },
    { _id: false },
);

const aiTenantSchema = new Schema<IAiTenantDocument>(
    {
        familyId: { type: String, required: true, unique: true, index: true },
        aiFamilyId: { type: String, required: true },
        elders: { type: [elderLinkSchema], default: [] },
    },
    { timestamps: true },
);

const AiTenant: Model<IAiTenantDocument> =
    (mongoose.models.AiTenant as Model<IAiTenantDocument>) ||
    mongoose.model<IAiTenantDocument>("AiTenant", aiTenantSchema);

export default AiTenant;
