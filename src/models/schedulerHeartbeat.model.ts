import mongoose, { Schema } from "mongoose";

/**
 * The reminder tick's heartbeat (every minute) and the gaps when it did not run (the backend was down or restarting).
 * A dose due inside a gap with no reminder was missed because of the outage; the catch-up sends or notes it.
 * Also holds medicine reminders the nudge gate held back (an order in progress), so they go out once it is clear.
 */
export interface ISchedulerHeartbeat {
    _id: string;
    lastTickAt: Date;
    gaps: Array<{ from: Date; to: Date }>;
}

const schedulerHeartbeatSchema = new Schema<ISchedulerHeartbeat>(
    {
        _id: { type: String, required: true },
        lastTickAt: { type: Date, required: true },
        gaps: { type: [{ from: Date, to: Date, _id: false }], default: [] },
    },
    { versionKey: false },
);

export default mongoose.models.SchedulerHeartbeat ||
    mongoose.model<ISchedulerHeartbeat>("SchedulerHeartbeat", schedulerHeartbeatSchema, "scheduler_heartbeats");

export interface INudgeDeferral {
    familyId: string;
    recipientUserId: string;
    scheduleId: string;
    dateKey: string;
    reason: string;
    at: Date;
}

const nudgeDeferralSchema = new Schema<INudgeDeferral>({
    familyId: { type: String, required: true },
    recipientUserId: { type: String, required: true },
    scheduleId: { type: String, required: true },
    dateKey: { type: String, required: true },
    reason: { type: String, default: "" },
    at: { type: Date, required: true, expires: 2 * 24 * 60 * 60 },
});
nudgeDeferralSchema.index({ familyId: 1, recipientUserId: 1, dateKey: 1, scheduleId: 1 }, { unique: true });

export const NudgeDeferral =
    mongoose.models.NudgeDeferral || mongoose.model<INudgeDeferral>("NudgeDeferral", nudgeDeferralSchema, "nudge_deferrals");
