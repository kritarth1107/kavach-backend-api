import { createHash, randomBytes, randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import {
    FamilyInvitationStatus,
    FamilyRole,
    IFamilyInvitation,
} from "../types/family.types";
import { sortByCreatedAtDesc } from "../utils/cosmos-safe-sort.util";

export interface IFamilyInvitationDocument extends IFamilyInvitation, Document {}

const familyInvitationSchema = new Schema<IFamilyInvitationDocument>(
    {
        inviteId: {
            type: String,
            unique: true,
            index: true,
        },
        familyId: {
            type: String,
            required: true,
            index: true,
        },
        email: {
            type: String,
            required: true,
            lowercase: true,
            trim: true,
            index: true,
        },
        role: {
            type: String,
            enum: Object.values(FamilyRole),
            required: true,
        },
        invitedBy: {
            type: String,
            required: true,
        },
        status: {
            type: String,
            enum: Object.values(FamilyInvitationStatus),
            default: FamilyInvitationStatus.PENDING,
        },
        tokenHash: {
            type: String,
            required: true,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: true,
        },
        inviteeName: { type: String, trim: true },
        namePrefix: { type: String, trim: true },
        relationship: { type: String, trim: true },
        phone: { type: String, trim: true },
        phoneCountryCode: { type: String, trim: true },
        location: { type: String, trim: true },
        userId: { type: String, index: true },
    },
    { timestamps: true },
);

familyInvitationSchema.pre("save", function (next) {
    if (!this.inviteId) {
        this.inviteId = randomUUID();
    }
    next();
});

familyInvitationSchema.index({ familyId: 1, email: 1, status: 1 });

export function hashInviteToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export function generateInviteToken(): string {
    return randomBytes(32).toString("hex");
}

interface IFamilyInvitationModel extends Model<IFamilyInvitationDocument> {
    findPendingByFamily(familyId: string): Promise<IFamilyInvitationDocument[]>;
    findPendingByEmail(email: string): Promise<IFamilyInvitationDocument[]>;
}

familyInvitationSchema.statics.findPendingByFamily = async function (
    familyId: string,
) {
    const docs = await this.find({
        familyId,
        status: FamilyInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
    });
    return sortByCreatedAtDesc(docs);
};

familyInvitationSchema.statics.findPendingByEmail = async function (
    email: string,
) {
    const docs = await this.find({
        email: email.toLowerCase().trim(),
        status: FamilyInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
    });
    return sortByCreatedAtDesc(docs);
};

const FamilyInvitation: IFamilyInvitationModel =
    (mongoose.models.FamilyInvitation as IFamilyInvitationModel) ||
    mongoose.model<IFamilyInvitationDocument, IFamilyInvitationModel>(
        "FamilyInvitation",
        familyInvitationSchema,
    );

export default FamilyInvitation;
