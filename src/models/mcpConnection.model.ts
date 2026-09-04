import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import type { McpPartnerKey } from "../partners/mcp/types";

export interface IMcpConnection {
    connectionId: string;
    partner: McpPartnerKey;
    familyId: string;
    userId: string;
    tokensEnc: string;
    clientInfoEnc?: string;
    connectedAt: Date;
    updatedAt?: Date;
}

export interface IMcpConnectionDocument extends IMcpConnection, Document {}

const mcpConnectionSchema = new Schema<IMcpConnectionDocument>(
    {
        connectionId: { type: String, unique: true, index: true },
        partner: { type: String, required: true, index: true },
        familyId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        tokensEnc: { type: String, required: true },
        clientInfoEnc: { type: String },
        connectedAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

mcpConnectionSchema.pre("save", function (next) {
    if (!this.connectionId) this.connectionId = randomUUID();
    next();
});

mcpConnectionSchema.index({ partner: 1, familyId: 1, userId: 1 }, { unique: true });

const McpConnection: Model<IMcpConnectionDocument> =
    (mongoose.models.McpConnection as Model<IMcpConnectionDocument>) ||
    mongoose.model<IMcpConnectionDocument>("McpConnection", mcpConnectionSchema);

export default McpConnection;
