/**
 * Admin-only collections. admin_audit is append-only: updates and deletes throw, and each entry carries an HMAC of its
 * content (key only in the admin services), so an edit made straight in the database shows up as a bad signature.
 */
import { createHmac } from "crypto";
import mongoose, { Schema } from "mongoose";
import { ROLES, type Role } from "./permissions";

export interface IAdminUser {
    email: string; // lower case, @kavach.care Workspace account
    role: Role;
    active: boolean;
    expiresAt?: Date | null;
    addedBy: string;
    addedAt: Date;
    lastSeenAt?: Date | null;
    note?: string;
}

const adminUserSchema = new Schema<IAdminUser>(
    {
        email: { type: String, required: true, lowercase: true, trim: true, index: true },
        role: { type: String, enum: ROLES as unknown as string[], required: true },
        active: { type: Boolean, default: true },
        expiresAt: { type: Date, default: null },
        addedBy: { type: String, required: true },
        addedAt: { type: Date, default: () => new Date() },
        lastSeenAt: { type: Date, default: null },
        note: { type: String, maxlength: 200 },
    },
    { collection: "admin_users", versionKey: false },
);

export const AdminUser = mongoose.models.AdminUser || mongoose.model<IAdminUser>("AdminUser", adminUserSchema);

export interface IAdminAudit {
    at: Date;
    admin: string; // email
    role: string;
    sessionId?: string;
    action: string; // e.g. "admins.add", "family.view"
    method: string;
    path: string;
    target?: string; // what it touched: "family:…", "user:…", "admin:…"
    reason?: string;
    result: "ok" | "denied" | "error";
    status: number;
    detail?: Record<string, unknown>; // small, never personal data
    ip?: string;
    ua?: string;
    sig: string;
}

const auditSchema = new Schema<IAdminAudit>(
    {
        at: { type: Date, required: true, index: true },
        admin: { type: String, required: true, index: true },
        role: { type: String, required: true },
        sessionId: String,
        action: { type: String, required: true, index: true },
        method: { type: String, required: true },
        path: { type: String, required: true },
        target: { type: String, index: true },
        reason: String,
        result: { type: String, enum: ["ok", "denied", "error"], required: true },
        status: { type: Number, required: true },
        detail: { type: Schema.Types.Mixed },
        ip: String,
        ua: String,
        sig: { type: String, required: true },
    },
    { collection: "admin_audit", versionKey: false },
);

const refuse = function () {
    throw new Error("admin_audit is append-only");
};
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "findOneAndReplace"] as const) {
    auditSchema.pre(op, refuse);
}
auditSchema.pre("save", function (next) {
    if (!this.isNew) return next(new Error("admin_audit is append-only"));
    next();
});

export const AdminAudit = mongoose.models.AdminAudit || mongoose.model<IAdminAudit>("AdminAudit", auditSchema);

type Signable = Omit<IAdminAudit, "sig">;

export function auditSig(entry: Signable, key: string): string {
    const canonical = JSON.stringify([
        new Date(entry.at).toISOString(), entry.admin, entry.role, entry.sessionId ?? "", entry.action, entry.method, entry.path,
        entry.target ?? "", entry.reason ?? "", entry.result, entry.status, entry.detail ?? null, entry.ip ?? "", entry.ua ?? "",
    ]);
    return createHmac("sha256", key).update(canonical).digest("hex");
}
