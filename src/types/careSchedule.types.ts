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
    createdBy: string;
    updatedBy?: string;
    createdAt: Date;
    updatedAt: Date;
}
