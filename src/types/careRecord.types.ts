import { FamilyRole } from "./family.types";

export enum CareRecordEventType {
    MESSAGE = "message",
    DOSE = "dose",
    CHECK_IN = "check_in",
    VITAL = "vital",
    DOCUMENT = "document",
    SYMPTOM = "symptom",
    ORDER_SUGGESTED = "order_suggested",
    ORDER_APPROVED = "order_approved",
    ORDER_PAID = "order_paid",
    ORDER_DELIVERED = "order_delivered",
    CONTEXT_SIGNAL = "context_signal",
    SYSTEM = "system",
}

export enum CareRecordSource {
    DASHBOARD = "dashboard",
    WHATSAPP = "whatsapp",
    PHONE = "phone",
    SMART_SPEAKER = "smart_speaker",
    SAHELI = "saheli",
    SYSTEM = "system",
}

export enum ChannelType {
    DASHBOARD = "dashboard",
    WHATSAPP = "whatsapp",
    PHONE = "phone",
    SMART_SPEAKER = "smart_speaker",
}

export enum OrderStatus {
    SUGGESTED = "suggested",
    AWAITING_APPROVAL = "awaiting_approval",
    APPROVED = "approved",
    PAID = "paid",
    DELIVERED = "delivered",
    CANCELLED = "cancelled",
}

export enum OrderPartner {
    ZEPTO = "zepto",
    SWIGGY = "swiggy",
    INSTAMART = "instamart",
}

/** Phase 1 inviteable roles (Family Doctor shelved in UI). */
export const PHASE1_INVITE_ROLES = new Set<FamilyRole>([
    FamilyRole.CARE_RECIPIENT,
    FamilyRole.CO_CAREGIVER,
    FamilyRole.VIEW_ONLY,
]);

export type CareRecordPermission =
    | "read"
    | "write_message"
    | "upload_document"
    | "manage_schedule"
    | "approve_order"
    | "caregiver_chat";

const ROLE_PERMISSIONS: Record<FamilyRole, Set<CareRecordPermission>> = {
    [FamilyRole.CARE_RECIPIENT]: new Set(["read", "write_message"]),
    [FamilyRole.PRIMARY_CAREGIVER]: new Set([
        "read",
        "upload_document",
        "manage_schedule",
        "approve_order",
        "caregiver_chat",
    ]),
    [FamilyRole.CO_CAREGIVER]: new Set([
        "read",
        "upload_document",
        "manage_schedule",
        "approve_order",
        "caregiver_chat",
    ]),
    [FamilyRole.VIEW_ONLY]: new Set(["read"]),
    [FamilyRole.FAMILY_DOCTOR]: new Set(["read"]),
};

export function roleHasPermission(role: FamilyRole, permission: CareRecordPermission): boolean {
    return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

export function isPhase1InviteRole(role: FamilyRole): boolean {
    return PHASE1_INVITE_ROLES.has(role);
}
