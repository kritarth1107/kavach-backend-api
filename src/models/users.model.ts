import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import {
    AuthProvider,
    IPhone,
    ISocialAccount,
    IUser,
    UserStatus,
} from "../types/user.types";

export interface IUserDocument extends IUser, Document {
    fullName: string;
    linkedProviders: AuthProvider[];
    hasPassword: boolean;
    linkSocialAccount(account: Omit<ISocialAccount, "linkedAt">): Promise<IUserDocument>;
    unlinkSocialAccount(provider: AuthProvider): Promise<IUserDocument>;
    hasSocialAccount(provider: AuthProvider): boolean;
    getSocialAccount(provider: AuthProvider): ISocialAccount | undefined;
}

const phoneSchema = new Schema<IPhone>(
    {
        countryCode: {
            type: String,
            required: true,
            trim: true,
            match: [/^\+\d{1,4}$/, "Country code must be in E.164 format (e.g. +91)"],
        },
        number: {
            type: String,
            required: true,
            trim: true,
            match: [/^\d{6,15}$/, "Phone number must contain 6–15 digits"],
        },
    },
    { _id: false },
);

const socialAccountSchema = new Schema<ISocialAccount>(
    {
        provider: {
            type: String,
            enum: Object.values(AuthProvider).filter((p) => p !== AuthProvider.EMAIL),
            required: true,
        },
        providerId: {
            type: String,
            required: true,
            trim: true,
        },
        email: {
            type: String,
            lowercase: true,
            trim: true,
        },
        displayName: {
            type: String,
            trim: true,
            maxlength: 100,
        },
        avatarUrl: {
            type: String,
            trim: true,
        },
        linkedAt: {
            type: Date,
            default: Date.now,
        },
        lastUsedAt: {
            type: Date,
        },
    },
    { _id: false },
);

const userSchema = new Schema<IUserDocument>(
    {
        userId: {
            type: String,
            unique: true,
            index: true,
        },
        email: {
            type: String,
            required: [true, "Email is required"],
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\S+@\S+\.\S+$/, "Please provide a valid email address"],
        },
        phone: {
            type: phoneSchema,
            required: false,
        },
        firstName: {
            type: String,
            trim: true,
            maxlength: 50,
        },
        lastName: {
            type: String,
            trim: true,
            maxlength: 50,
        },
        avatarUrl: {
            type: String,
            trim: true,
        },
        passwordHash: {
            type: String,
            select: false,
        },
        primaryAuthProvider: {
            type: String,
            enum: Object.values(AuthProvider),
            default: AuthProvider.EMAIL,
        },
        socialAccounts: {
            type: [socialAccountSchema],
            default: [],
            validate: {
                validator(accounts: ISocialAccount[]) {
                    const keys = accounts.map((a) => `${a.provider}:${a.providerId}`);
                    return keys.length === new Set(keys).size;
                },
                message: "Each social provider can only be linked once per user",
            },
        },
        status: {
            type: String,
            enum: Object.values(UserStatus),
            default: UserStatus.ACTIVE,
        },
        emailVerified: {
            type: Boolean,
            default: false,
        },
        activeFamilyId: {
            type: String,
            index: true,
        },
        primaryFamilyId: {
            type: String,
            index: true,
        },
        preferences: {
            emailAlerts: { type: Boolean, default: true },
            pushReminders: { type: Boolean, default: true },
            weeklyDigest: { type: Boolean, default: false },
            familyActivity: { type: Boolean, default: true },
            medicineReminders: { type: Boolean, default: true },
            checkInReminders: { type: Boolean, default: true },
        },
    },
    {
        timestamps: true,
        toJSON: {
            virtuals: true,
            transform: (_doc, ret: Record<string, unknown>) => {
                delete ret.passwordHash;
                delete ret.__v;
                return ret;
            },
        },
        toObject: { virtuals: true },
    },
);

userSchema.virtual("fullName").get(function (this: IUserDocument) {
    return [this.firstName, this.lastName].filter(Boolean).join(" ") || this.email;
});

userSchema.virtual("linkedProviders").get(function (this: IUserDocument) {
    const providers = this.socialAccounts.map((a) => a.provider);
    if (this.passwordHash) {
        providers.unshift(AuthProvider.EMAIL);
    }
    return [...new Set(providers)];
});

userSchema.virtual("hasPassword").get(function (this: IUserDocument) {
    return Boolean(this.passwordHash);
});

userSchema.pre("save", function (next) {
    if (!this.userId) {
        this.userId = randomUUID();
    }
    next();
});

userSchema.pre("validate", function (next) {
    if (!this.isNew) {
        return next();
    }

    const hasPassword = Boolean(this.passwordHash);
    const hasSocial = this.socialAccounts.length > 0;

    if (!hasPassword && !hasSocial) {
        return next(
            new Error("User must have a password or at least one linked social account"),
        );
    }

    next();
});

userSchema.methods.hasSocialAccount = function (
    this: IUserDocument,
    provider: AuthProvider,
): boolean {
    return this.socialAccounts.some((a) => a.provider === provider);
};

userSchema.methods.getSocialAccount = function (
    this: IUserDocument,
    provider: AuthProvider,
): ISocialAccount | undefined {
    return this.socialAccounts.find((a) => a.provider === provider);
};

userSchema.methods.linkSocialAccount = async function (
    this: IUserDocument,
    account: Omit<ISocialAccount, "linkedAt">,
): Promise<IUserDocument> {
    if (account.provider === AuthProvider.EMAIL) {
        throw new Error("Use password registration to link email authentication");
    }

    const existing = this.getSocialAccount(account.provider);

    if (existing) {
        existing.providerId = account.providerId;
        existing.email = account.email ?? existing.email;
        existing.displayName = account.displayName ?? existing.displayName;
        existing.avatarUrl = account.avatarUrl ?? existing.avatarUrl;
        existing.lastUsedAt = new Date();
    } else {
        this.socialAccounts.push({
            ...account,
            linkedAt: new Date(),
            lastUsedAt: new Date(),
        });
    }

    if (!this.avatarUrl && account.avatarUrl) {
        this.avatarUrl = account.avatarUrl;
    }

    if (account.displayName && !this.firstName) {
        const [first, ...rest] = account.displayName.split(" ");
        this.firstName = first;
        this.lastName = rest.join(" ") || undefined;
    }

    if (account.email && account.provider !== AuthProvider.APPLE) {
        this.emailVerified = true;
    }

    return this.save();
};

userSchema.methods.unlinkSocialAccount = async function (
    this: IUserDocument,
    provider: AuthProvider,
): Promise<IUserDocument> {
    if (provider === AuthProvider.EMAIL) {
        throw new Error("Cannot unlink email provider — remove password instead");
    }

    const authMethods =
        (this.passwordHash ? 1 : 0) +
        this.socialAccounts.filter((a) => a.provider !== provider).length;

    if (authMethods < 1) {
        throw new Error("Cannot unlink the only authentication method");
    }

    this.socialAccounts = this.socialAccounts.filter((a) => a.provider !== provider);

    if (this.primaryAuthProvider === provider) {
        this.primaryAuthProvider = this.passwordHash
            ? AuthProvider.EMAIL
            : this.socialAccounts[0].provider;
    }

    return this.save();
};

userSchema.statics.findBySocialAccount = function (
    provider: AuthProvider,
    providerId: string,
) {
    return this.findOne({
        socialAccounts: {
            $elemMatch: { provider, providerId },
        },
    });
};

userSchema.statics.findByEmailOrSocial = function (
    email: string,
    provider?: AuthProvider,
    providerId?: string,
) {
    const query: Record<string, unknown> = { email: email.toLowerCase() };

    if (provider && providerId) {
        return this.findOne({
            $or: [
                query,
                { socialAccounts: { $elemMatch: { provider, providerId } } },
            ],
        });
    }

    return this.findOne(query);
};

userSchema.index(
    { "phone.countryCode": 1, "phone.number": 1 },
    {
        unique: true,
        sparse: true,
        partialFilterExpression: {
            "phone.countryCode": { $exists: true },
            "phone.number": { $exists: true },
        },
    },
);

userSchema.index(
    { "socialAccounts.provider": 1, "socialAccounts.providerId": 1 },
    { unique: true, sparse: true },
);

interface IUserModel extends Model<IUserDocument> {
    findBySocialAccount(
        provider: AuthProvider,
        providerId: string,
    ): mongoose.Query<IUserDocument | null, IUserDocument>;
    findByEmailOrSocial(
        email: string,
        provider?: AuthProvider,
        providerId?: string,
    ): mongoose.Query<IUserDocument | null, IUserDocument>;
}

const User: IUserModel =
    (mongoose.models.User as IUserModel) ||
    mongoose.model<IUserDocument, IUserModel>("User", userSchema);

export default User;
