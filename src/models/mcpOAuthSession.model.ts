import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import type { McpPartnerKey } from "../partners/mcp/types";

export interface IMcpOAuthSession {
    sessionId: string;
    partner: McpPartnerKey;
    familyId: string;
    userId: string;
    oauthState: string;
    codeVerifierEnc: string;
    authorizationUrl?: string;
    clientInfoEnc?: string;
    expiresAt: Date;
}

export interface IMcpOAuthSessionDocument extends IMcpOAuthSession, Document {}

const schema = new Schema<IMcpOAuthSessionDocument>(
    {
        sessionId: { type: String, unique: true, index: true },
        partner: { type: String, required: true, index: true },
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

const McpOAuthSession: Model<IMcpOAuthSessionDocument> =
    (mongoose.models.McpOAuthSession as Model<IMcpOAuthSessionDocument>) ||
    mongoose.model<IMcpOAuthSessionDocument>("McpOAuthSession", schema);

export default McpOAuthSession;
