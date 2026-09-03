import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import { ChannelType } from "../types/careRecord.types";
import { FamilyRole } from "../types/family.types";

export interface IChannelIdentity {
    identityId: string;
    channelType: ChannelType;
    channelIdentifier: string;
    familyId: string;
    userId: string;
    role: FamilyRole;
    label?: string;
    active: boolean;
}

export interface IChannelIdentityDocument extends IChannelIdentity, Document {}

const channelIdentitySchema = new Schema<IChannelIdentityDocument>(
    {
        identityId: { type: String, unique: true, index: true },
        channelType: { type: String, enum: Object.values(ChannelType), required: true },
        channelIdentifier: { type: String, required: true, trim: true },
        familyId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        role: { type: String, enum: Object.values(FamilyRole), required: true },
        label: { type: String, trim: true, maxlength: 80 },
        active: { type: Boolean, default: true },
    },
    { timestamps: true },
);

channelIdentitySchema.pre("save", function (next) {
    if (!this.identityId) {
        this.identityId = randomUUID();
    }
    next();
});

channelIdentitySchema.index(
    { channelType: 1, channelIdentifier: 1 },
    { unique: true, name: "channel_identity_unique" },
);

const ChannelIdentity: Model<IChannelIdentityDocument> =
    (mongoose.models.ChannelIdentity as Model<IChannelIdentityDocument>) ||
    mongoose.model<IChannelIdentityDocument>("ChannelIdentity", channelIdentitySchema);

export default ChannelIdentity;
