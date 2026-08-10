import { createHash, randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import config from "../config/app.config";
import { AuthProvider } from "../types/user.types";
import { ISession, SessionStatus } from "../types/session.types";

export interface ISessionDocument extends ISession, Document {
    isExpired: boolean;
    revoke(): Promise<ISessionDocument>;
    touch(): Promise<ISessionDocument>;
}

const hashToken = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

const sessionSchema = new Schema<ISessionDocument>(
    {
        sessionId: {
            type: String,
            unique: true,
            index: true,
        },
        userId: {
            type: String,
            required: true,
            index: true,
        },
        tokenHash: {
            type: String,
            required: true,
            index: true,
        },
        fingerprint: {
            type: String,
            required: true,
            default: "N/A",
            trim: true,
        },
        authProvider: {
            type: String,
            enum: Object.values(AuthProvider),
            required: true,
        },
        userAgent: {
            type: String,
            trim: true,
            maxlength: 512,
        },
        ipAddress: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            enum: Object.values(SessionStatus),
            default: SessionStatus.ACTIVE,
        },
        expiresAt: {
            type: Date,
            required: true,
            index: true,
        },
        lastActiveAt: {
            type: Date,
            default: Date.now,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (_doc, ret: Record<string, unknown>) => {
                delete ret.tokenHash;
                delete ret.__v;
                return ret;
            },
        },
    },
);

sessionSchema.virtual("isExpired").get(function (this: ISessionDocument) {
    return this.expiresAt.getTime() <= Date.now();
});

sessionSchema.pre("save", function (next) {
    if (!this.sessionId) {
        this.sessionId = randomUUID();
    }
    next();
});

sessionSchema.methods.revoke = async function (this: ISessionDocument): Promise<ISessionDocument> {
    this.status = SessionStatus.REVOKED;
    return this.save();
};

sessionSchema.methods.touch = async function (this: ISessionDocument): Promise<ISessionDocument> {
    this.lastActiveAt = new Date();
    return this.save();
};

sessionSchema.statics.hashToken = function (token: string): string {
    return hashToken(token);
};

sessionSchema.statics.findActive = function (
    userId: string,
    token: string,
    fingerprint: string,
) {
    return this.findOne({
        userId,
        tokenHash: hashToken(token),
        fingerprint,
        status: SessionStatus.ACTIVE,
        expiresAt: { $gt: new Date() },
    });
};

sessionSchema.statics.findBySessionId = function (sessionId: string) {
    return this.findOne({
        sessionId,
        status: SessionStatus.ACTIVE,
        expiresAt: { $gt: new Date() },
    });
};

sessionSchema.statics.createSession = async function (params: {
    userId: string;
    token: string;
    authProvider: AuthProvider;
    fingerprint?: string;
    userAgent?: string;
    ipAddress?: string;
    expiresIn?: string;
}) {
    const expiresIn = params.expiresIn ?? config.jwt.validity;
    const expiresAt = new Date(
        Date.now() + parseJwtExpiryMs(expiresIn),
    );

    return this.create({
        userId: params.userId,
        tokenHash: hashToken(params.token),
        fingerprint: params.fingerprint ?? "N/A",
        authProvider: params.authProvider,
        userAgent: params.userAgent,
        ipAddress: params.ipAddress,
        status: SessionStatus.ACTIVE,
        expiresAt,
        lastActiveAt: new Date(),
    });
};

sessionSchema.statics.revokeAllForUser = function (userId: string) {
    return this.updateMany(
        { userId, status: SessionStatus.ACTIVE },
        { status: SessionStatus.REVOKED },
    );
};

sessionSchema.index({ userId: 1, status: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

interface ISessionModel extends Model<ISessionDocument> {
    hashToken(token: string): string;
    findActive(
        userId: string,
        token: string,
        fingerprint: string,
    ): mongoose.Query<ISessionDocument | null, ISessionDocument>;
    findBySessionId(
        sessionId: string,
    ): mongoose.Query<ISessionDocument | null, ISessionDocument>;
    createSession(params: {
        userId: string;
        token: string;
        authProvider: AuthProvider;
        fingerprint?: string;
        userAgent?: string;
        ipAddress?: string;
        expiresIn?: string;
    }): Promise<ISessionDocument>;
    revokeAllForUser(userId: string): mongoose.Query<mongoose.UpdateWriteOpResult, ISessionDocument>;
}

function parseJwtExpiryMs(expiry: string): number {
    const match = expiry.match(/^(\d+)([smhd])$/);
    if (!match) {
        return 24 * 60 * 60 * 1000;
    }

    const value = Number(match[1]);
    const unit = match[2];

    switch (unit) {
        case "s":
            return value * 1000;
        case "m":
            return value * 60 * 1000;
        case "h":
            return value * 60 * 60 * 1000;
        case "d":
            return value * 24 * 60 * 60 * 1000;
        default:
            return 24 * 60 * 60 * 1000;
    }
}

const Session: ISessionModel =
    (mongoose.models.Session as ISessionModel) ||
    mongoose.model<ISessionDocument, ISessionModel>("Session", sessionSchema);

export default Session;
