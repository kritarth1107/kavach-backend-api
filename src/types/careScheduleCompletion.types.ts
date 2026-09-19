export type CareScheduleCompletionStatus = "completed" | "missed";

export type CareScheduleDayStatus =
    | "upcoming"
    | "due"
    | "completed"
    | "missed";

export interface ICareScheduleCompletion {
    completionId: string;
    familyId: string;
    recipientUserId: string;
    scheduleId: string;
    dateKey: string;
    status: CareScheduleCompletionStatus;
    markedBy: string;
    note?: string;
    createdAt: Date;
    updatedAt: Date;
}

export type ScheduleDayItem = {
    scheduleId: string;
    title: string;
    time: string;
    dosage?: string | null;
    type: string;
    status: CareScheduleDayStatus;
    markedBy?: string | null;
    markedAt?: string | null;
};
