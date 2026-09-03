import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";

export interface IZeptoConnection {
    connectionId: string;
    familyId: string;
    userId: string;
    tokensEnc: string;
    clientInfoEnc?: string;
    connectedAt: Date;
    updatedAt?: Date;
}

export interface IZeptoConnectionDocument extends IZeptoConnection, Document {}

const zeptoConnectionSchema = new Schema<IZeptoConnectionDocument>(
    {
        connectionId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        tokensEnc: { type: String, required: true },
        clientInfoEnc: { type: String },
        connectedAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

zeptoConnectionSchema.pre("save", function (next) {
    if (!this.connectionId) this.connectionId = randomUUID();
    next();
});

zeptoConnectionSchema.index({ familyId: 1, userId: 1 }, { unique: true });

const ZeptoConnection: Model<IZeptoConnectionDocument> =
    (mongoose.models.ZeptoConnection as Model<IZeptoConnectionDocument>) ||
    mongoose.model<IZeptoConnectionDocument>("ZeptoConnection", zeptoConnectionSchema);

export default ZeptoConnection;
