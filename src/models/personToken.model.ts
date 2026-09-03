import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";

export interface IPersonToken {
    tokenId: string;
    familyId: string;
    tokenType: "phone" | "address" | "aadhaar_like" | "email" | "name";
    tokenHash: string;
    createdAt?: Date;
}

export interface IPersonTokenDocument extends IPersonToken, Document {}

const personTokenSchema = new Schema<IPersonTokenDocument>(
    {
        tokenId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        tokenType: {
            type: String,
            enum: ["phone", "address", "aadhaar_like", "email", "name"],
            required: true,
        },
        tokenHash: { type: String, required: true },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
    },
);

personTokenSchema.pre("save", function (next) {
    if (!this.tokenId) {
        this.tokenId = randomUUID();
    }
    next();
});

personTokenSchema.index({ familyId: 1, tokenHash: 1 }, { unique: true });

const PersonToken: Model<IPersonTokenDocument> =
    (mongoose.models.PersonToken as Model<IPersonTokenDocument>) ||
    mongoose.model<IPersonTokenDocument>("PersonToken", personTokenSchema);

export default PersonToken;
