import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import {
    FamilyMemberStatus,
    FamilyRole,
    FamilyStatus,
    IFamily,
    IFamilyMember,
} from "../types/family.types";

export interface IFamilyDocument extends IFamily, Document {
    memberCount: number;
    careRecipient: IFamilyMember | undefined;
    addMember(
        userId: string,
        role: FamilyRole,
        options?: {
            invitedBy?: string;
            status?: FamilyMemberStatus;
        },
    ): Promise<IFamilyDocument>;
    removeMember(userId: string): Promise<IFamilyDocument>;
    updateMemberStatus(
        userId: string,
        status: FamilyMemberStatus,
    ): Promise<IFamilyDocument>;
    getMemberRole(userId: string): FamilyRole | null;
    hasMember(userId: string): boolean;
    hasJoinedMember(userId: string): boolean;
}

const LEGACY_JOINED_STATUSES = new Set([
    FamilyMemberStatus.JOINED,
    "ACTIVE" as FamilyMemberStatus,
]);

function isJoinedStatus(status: FamilyMemberStatus | string): boolean {
    return LEGACY_JOINED_STATUSES.has(status as FamilyMemberStatus);
}

function normalizeLegacyMemberStatuses(members: IFamilyMember[]): void {
    for (const member of members) {
        if ((member.status as string) === "ACTIVE") {
            member.status = FamilyMemberStatus.JOINED;
        }
    }
}

const familyMemberSchema = new Schema<IFamilyMember>(
    {
        userId: {
            type: String,
            required: true,
            index: true,
        },
        role: {
            type: String,
            enum: Object.values(FamilyRole),
            required: true,
        },
        status: {
            type: String,
            enum: Object.values(FamilyMemberStatus),
            default: FamilyMemberStatus.JOINED,
        },
        joinedAt: {
            type: Date,
            default: Date.now,
        },
        invitedBy: {
            type: String,
        },
        invitedAt: {
            type: Date,
        },
    },
    { _id: false },
);

const familySchema = new Schema<IFamilyDocument>(
    {
        familyId: {
            type: String,
            unique: true,
            index: true,
        },
        name: {
            type: String,
            required: [true, "Family name is required"],
            trim: true,
            maxlength: 100,
        },
        description: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        members: {
            type: [familyMemberSchema],
            default: [],
            validate: {
                validator(members: IFamilyMember[]) {
                    const activeUserIds = members
                        .filter((m) => m.status !== FamilyMemberStatus.REMOVED)
                        .map((m) => m.userId);
                    return activeUserIds.length === new Set(activeUserIds).size;
                },
                message: "A user can only appear once in a family",
            },
        },
        createdBy: {
            type: String,
            required: true,
            index: true,
        },
        status: {
            type: String,
            enum: Object.values(FamilyStatus),
            default: FamilyStatus.ACTIVE,
        },
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true },
    },
);

familySchema.virtual("memberCount").get(function (this: IFamilyDocument) {
    return this.members.filter((m) => isJoinedStatus(m.status)).length;
});

familySchema.virtual("careRecipient").get(function (this: IFamilyDocument) {
    return this.members.find(
        (m) => m.role === FamilyRole.CARE_RECIPIENT && isJoinedStatus(m.status),
    );
});

familySchema.pre("validate", function (next) {
    normalizeLegacyMemberStatuses(this.members);
    next();
});

familySchema.pre("save", function (next) {
    normalizeLegacyMemberStatuses(this.members);
    if (!this.familyId) {
        this.familyId = randomUUID();
    }
    next();
});

familySchema.methods.hasMember = function (this: IFamilyDocument, userId: string): boolean {
    return this.members.some(
        (m) => m.userId === userId && m.status !== FamilyMemberStatus.REMOVED,
    );
};

familySchema.methods.hasJoinedMember = function (
    this: IFamilyDocument,
    userId: string,
): boolean {
    return this.members.some(
        (m) => m.userId === userId && isJoinedStatus(m.status),
    );
};

familySchema.methods.getMemberRole = function (
    this: IFamilyDocument,
    userId: string,
): FamilyRole | null {
    const member = this.members.find(
        (m) => m.userId === userId && isJoinedStatus(m.status),
    );
    return member?.role ?? null;
};

familySchema.methods.addMember = async function (
    this: IFamilyDocument,
    userId: string,
    role: FamilyRole,
    options: {
        invitedBy?: string;
        status?: FamilyMemberStatus;
    } = {},
): Promise<IFamilyDocument> {
    const status = options.status ?? FamilyMemberStatus.JOINED;
    const existing = this.members.find((m) => m.userId === userId);

    if (existing) {
        if (
            existing.status === FamilyMemberStatus.REMOVED ||
            existing.status === FamilyMemberStatus.REJECTED
        ) {
            existing.status = status;
            existing.role = role;
            existing.joinedAt = new Date();
            existing.invitedBy = options.invitedBy;
            existing.invitedAt = options.invitedBy ? new Date() : undefined;
        } else if (
            existing.status === FamilyMemberStatus.PENDING &&
            status === FamilyMemberStatus.JOINED
        ) {
            existing.status = FamilyMemberStatus.JOINED;
            existing.joinedAt = new Date();
        } else {
            throw new Error("User is already a member of this family");
        }
    } else {
        this.members.push({
            userId,
            role,
            status,
            joinedAt: new Date(),
            invitedBy: options.invitedBy,
            invitedAt: options.invitedBy ? new Date() : undefined,
        });
    }

    return this.save();
};

familySchema.methods.updateMemberStatus = async function (
    this: IFamilyDocument,
    userId: string,
    status: FamilyMemberStatus,
): Promise<IFamilyDocument> {
    const member = this.members.find((m) => m.userId === userId);

    if (!member || member.status === FamilyMemberStatus.REMOVED) {
        throw new Error("User is not a member of this family");
    }

    member.status = status;
    return this.save();
};

familySchema.methods.removeMember = async function (
    this: IFamilyDocument,
    userId: string,
): Promise<IFamilyDocument> {
    const member = this.members.find((m) => m.userId === userId);

    if (!member || member.status === FamilyMemberStatus.REMOVED) {
        throw new Error("User is not an active member of this family");
    }

    member.status = FamilyMemberStatus.REMOVED;
    return this.save();
};

familySchema.statics.findByUserId = function (userId: string) {
    return this.find({
        status: FamilyStatus.ACTIVE,
        members: {
            $elemMatch: {
                userId,
                status: { $in: [FamilyMemberStatus.JOINED, "ACTIVE"] },
            },
        },
    });
};

familySchema.index({ "members.userId": 1, status: 1 });

interface IFamilyModel extends Model<IFamilyDocument> {
    findByUserId(userId: string): mongoose.Query<IFamilyDocument[], IFamilyDocument>;
}

const Family: IFamilyModel =
    (mongoose.models.Family as IFamilyModel) ||
    mongoose.model<IFamilyDocument, IFamilyModel>("Family", familySchema);

export default Family;
