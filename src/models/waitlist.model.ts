import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * People who asked to join while Kavach is invite-only (a dashboard sign-up without an invite, or "hi" to Saheli from
 * an unknown number). An admin approves or rejects each one; approved people may register with that email or number.
 * No unique index (Firestore's MongoDB compatibility has none): the service finds an entry by email or number first.
 */
export const WAITLIST_STATUSES = ["pending", "approved", "rejected"] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export interface IWaitlistEntry {
    waitlistId: string;
    name?: string | null;
    email?: string | null;
    /** As typed or as WhatsApp sent it, E.164 ("+919000000101"). */
    phone?: string | null;
    /** Digits only, country code included ("919000000101"): what lookups match on. */
    phoneDigits?: string | null;
    source: "dashboard" | "whatsapp";
    /** "Who are you caring for", in their words (optional, short). */
    note?: string | null;
    status: WaitlistStatus;
    attempts: number;
    lastSeenAt?: Date | null;
    approvedAt?: Date | null;
    approvedBy?: string | null;
    rejectedAt?: Date | null;
    rejectedBy?: string | null;
    approvalEmailSentAt?: Date | null;
    approvalEmailError?: string | null;
    registeredUserId?: string | null;
    registeredAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IWaitlistEntryDocument extends IWaitlistEntry, Document {}

const waitlistSchema = new Schema<IWaitlistEntryDocument>(
    {
        waitlistId: { type: String, required: true, index: true },
        name: { type: String, trim: true, maxlength: 80, default: null },
        email: { type: String, trim: true, lowercase: true, maxlength: 200, default: null, index: true },
        phone: { type: String, trim: true, maxlength: 20, default: null },
        phoneDigits: { type: String, default: null, index: true },
        source: { type: String, enum: ["dashboard", "whatsapp"], required: true },
        note: { type: String, trim: true, maxlength: 300, default: null },
        status: { type: String, enum: WAITLIST_STATUSES, default: "pending", index: true },
        attempts: { type: Number, default: 1 },
        lastSeenAt: { type: Date, default: null },
        approvedAt: { type: Date, default: null },
        approvedBy: { type: String, default: null },
        rejectedAt: { type: Date, default: null },
        rejectedBy: { type: String, default: null },
        approvalEmailSentAt: { type: Date, default: null },
        approvalEmailError: { type: String, default: null },
        registeredUserId: { type: String, default: null },
        registeredAt: { type: Date, default: null },
    },
    { timestamps: true, collection: "waitlist_entries" },
);

const WaitlistEntry: Model<IWaitlistEntryDocument> =
    (mongoose.models.WaitlistEntry as Model<IWaitlistEntryDocument>) ||
    mongoose.model<IWaitlistEntryDocument>("WaitlistEntry", waitlistSchema);

export default WaitlistEntry;
