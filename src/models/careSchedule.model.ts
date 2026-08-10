import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import { CareScheduleType, ICareScheduleItem } from "../types/careSchedule.types";

export interface ICareScheduleDocument extends ICareScheduleItem, Document {}

const careScheduleSchema = new Schema<ICareScheduleDocument>(
    {
        scheduleId: {
            type: String,
            unique: true,
            index: true,
        },
        familyId: {
            type: String,
            required: true,
            index: true,
        },
        recipientUserId: {
            type: String,
            required: true,
            index: true,
        },
        type: {
            type: String,
            enum: Object.values(CareScheduleType),
            required: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        time: {
            type: String,
            required: true,
            trim: true,
            maxlength: 20,
        },
        dosage: {
            type: String,
            trim: true,
            maxlength: 80,
        },
        instructions: {
            type: String,
            trim: true,
            maxlength: 300,
        },
        daysOfWeek: {
            type: [Number],
            default: [],
        },
        active: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: String,
            required: true,
        },
        updatedBy: {
            type: String,
        },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (_doc, ret: Record<string, unknown>) => {
                delete ret.__v;
                return ret;
            },
        },
    },
);

careScheduleSchema.pre("save", function (next) {
    if (!this.scheduleId) {
        this.scheduleId = randomUUID();
    }
    next();
});

careScheduleSchema.index({ familyId: 1, recipientUserId: 1, active: 1 });

const CareSchedule: Model<ICareScheduleDocument> =
    (mongoose.models.CareSchedule as Model<ICareScheduleDocument>) ||
    mongoose.model<ICareScheduleDocument>("CareSchedule", careScheduleSchema);

export default CareSchedule;
