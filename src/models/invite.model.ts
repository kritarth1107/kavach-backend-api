import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * A one-time link to join Kavach (founder 2026-10-13: "only invited people can register; one link for one
 * registration, invalid after using; any registered user can make 5 links a week"). kind "user": a person made it
 * from the dashboard's Invitations page. kind "waitlist": the personal link in a waitlist approval email.
 *
 * Only the token's SHA-256 is looked up. The token itself is kept (never selected by default) so the inviter can copy
 * an unused link again, and is wiped the moment the link is used, revoked or found expired.
 */
export const INVITE_STATUSES = ["active", "used", "revoked"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export interface IInvite {
    inviteId: string;
    kind: "user" | "waitlist";
    tokenHash: string;
    token?: string | null;
    inviterUserId?: string | null;
    waitlistId?: string | null;
    status: InviteStatus;
    expiresAt: Date;
    usedAt?: Date | null;
    usedByUserId?: string | null;
    usedVia?: string | null;
    revokedAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IInviteDocument extends IInvite, Document {}

const inviteSchema = new Schema<IInviteDocument>(
    {
        inviteId: { type: String, required: true, index: true },
        kind: { type: String, enum: ["user", "waitlist"], required: true },
        tokenHash: { type: String, required: true, index: true },
        token: { type: String, select: false, default: null },
        inviterUserId: { type: String, default: null, index: true },
        waitlistId: { type: String, default: null, index: true },
        status: { type: String, enum: INVITE_STATUSES, default: "active" },
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date, default: null },
        usedByUserId: { type: String, default: null },
        usedVia: { type: String, default: null },
        revokedAt: { type: Date, default: null },
    },
    { timestamps: true, collection: "invites" },
);

const Invite: Model<IInviteDocument> =
    (mongoose.models.Invite as Model<IInviteDocument>) || mongoose.model<IInviteDocument>("Invite", inviteSchema);

export default Invite;
