import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";

export interface IZeptoOAuthSession {
    sessionId: string;
    familyId: string;
    userId: string;
    oauthState: string;
    codeVerifierEnc: string;
    authorizationUrl?: string;
    clientInfoEnc?: string;
    expiresAt: Date;
}

export interface IZeptoOAuthSessionDocument extends IZeptoOAuthSession, Document {}

const schema = new Schema<IZeptoOAuthSessionDocument>(
    {
        sessionId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        oauthState: { type: String, required: true, index: true },
        codeVerifierEnc: { type: String, required: true },
        authorizationUrl: { type: String },
        clientInfoEnc: { type: String },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true },
);

schema.pre("save", function (next) {
    if (!this.sessionId) this.sessionId = randomUUID();
    next();
});

const ZeptoOAuthSession: Model<IZeptoOAuthSessionDocument> =
    (mongoose.models.ZeptoOAuthSession as Model<IZeptoOAuthSessionDocument>) ||
    mongoose.model<IZeptoOAuthSessionDocument>("ZeptoOAuthSession", schema);

export default ZeptoOAuthSession;
