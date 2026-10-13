export enum CareScheduleType {
    MEDICINE = "MEDICINE",
    CHECK_IN = "CHECK_IN",
    VITALS = "VITALS",
    APPOINTMENT = "APPOINTMENT",
    CUSTOM = "CUSTOM",
}

export interface ICareScheduleItem {
    scheduleId: string;
    familyId: string;
    recipientUserId: string;
    type: CareScheduleType;
    title: string;
    time: string;
    dosage?: string;
    instructions?: string;
    daysOfWeek: number[];
    active: boolean;
    /** A critical medicine: its escalation is never held for quiet hours. */
    critical?: boolean;
    createdBy: string;
    updatedBy?: string;
    sourceKey?: string;
    /** The engine's why-trail id of the last change that came from Saheli's care memory (D-13). */
    lastTraceId?: string;
    createdAt: Date;
    updatedAt: Date;
}
