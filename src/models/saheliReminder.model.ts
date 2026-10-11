import mongoose, { Document, Schema } from "mongoose";

export type SaheliReminderStatus = "active" | "completed" | "cancelled";
export type SaheliReminderKind = "multi_time" | "hourly_window";
/** daily (default, also every older reminder) | weekly on daysOfWeek | once on date. */
export type SaheliReminderRepeat = "daily" | "weekly" | "once";

export interface ISaheliReminder {
    reminderId: string;
    familyId: string;
    recipientUserId: string;
    companionId?: string;
    text: string;
    /** HH:MM 24h slots for multi_time daily reminders (Asia/Kolkata). */
    times: string[];
    kind: SaheliReminderKind;
    timezone: string;
    /** Minutes since midnight for hourly window start. */
    windowStartMinutes?: number;
    /** Minutes since midnight for hourly window end; null = slot-fill needed. */
    windowEndMinutes?: number | null;
    /** Semantic stop phrase e.g. "I filled it" / "done". */
    stopConditionPhrase?: string;
    /** When it repeats (missing = daily). */
    repeat?: SaheliReminderRepeat;
    /** YYYY-MM-DD (IST): the one day of a once reminder. */
    date?: string;
    /** Weekly reminders: 0 = Sunday … 6 = Saturday (the same as care schedules). */
    daysOfWeek?: number[];
    /** YYYY-MM-DD (IST): first and last day it may go out (inclusive); either may be missing. */
    startDate?: string;
    endDate?: string;
    /** Occurrences someone skipped: "YYYY-MM-DD" (the whole day) or "YYYY-MM-DD@HH:MM" (one time). */
    skips?: string[];
    status: SaheliReminderStatus;
    createdBy: string;
    updatedBy?: string;
    /** Who stopped it and when (a stop from WhatsApp or the dashboard, or a once reminder that went out). */
    stoppedAt?: Date;
    stoppedBy?: string;
    /** The engine's why-trail id of the last change that came through Saheli (D-13). */
    lastTraceId?: string;
    /** The care-record item it is for (a fact key such as "medicine:metformin"), when it is about one: a medicine
     *  reminder is held back once the dose it belongs to is marked taken. */
    aboutKey?: string;
    lastFiredAt?: Date;
    lastFiredSlotKey?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface ISaheliReminderDocument extends ISaheliReminder, Document {}

const saheliReminderSchema = new Schema<ISaheliReminderDocument>(
    {
        reminderId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        companionId: { type: String },
        text: { type: String, required: true, trim: true, maxlength: 400 },
        times: { type: [String], default: [] },
        kind: {
            type: String,
            enum: ["multi_time", "hourly_window"],
            default: "multi_time",
        },
        timezone: { type: String, default: "Asia/Kolkata" },
        windowStartMinutes: { type: Number },
        windowEndMinutes: { type: Number, default: null },
        stopConditionPhrase: { type: String, trim: true, maxlength: 200 },
        repeat: { type: String, enum: ["daily", "weekly", "once"], default: "daily" },
        date: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        daysOfWeek: { type: [Number], default: undefined },
        startDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        endDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
        skips: { type: [String], default: undefined },
        status: {
            type: String,
            enum: ["active", "completed", "cancelled"],
            default: "active",
            index: true,
        },
        createdBy: { type: String, required: true },
        updatedBy: { type: String },
        stoppedAt: { type: Date },
        stoppedBy: { type: String },
        lastTraceId: { type: String },
        aboutKey: { type: String, trim: true, maxlength: 200 },
        lastFiredAt: { type: Date },
        lastFiredSlotKey: { type: String },
    },
    { timestamps: true },
);

saheliReminderSchema.index({ familyId: 1, recipientUserId: 1, status: 1 });
saheliReminderSchema.index({ status: 1, kind: 1 });

export default mongoose.model<ISaheliReminderDocument>("SaheliReminder", saheliReminderSchema);
