import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import {
    CareScheduleCompletionStatus,
    ICareScheduleCompletion,
} from "../types/careScheduleCompletion.types";

export interface ICareScheduleCompletionDocument extends ICareScheduleCompletion, Document {}

const careScheduleCompletionSchema = new Schema<ICareScheduleCompletionDocument>(
    {
        completionId: {
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
        scheduleId: {
            type: String,
            required: true,
            index: true,
        },
        dateKey: {
            type: String,
            required: true,
            index: true,
        },
        status: {
            type: String,
            enum: ["completed", "missed"] satisfies CareScheduleCompletionStatus[],
            required: true,
        },
        markedBy: {
            type: String,
            required: true,
        },
        note: {
            type: String,
            trim: true,
            maxlength: 300,
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

careScheduleCompletionSchema.pre("save", function (next) {
    if (!this.completionId) {
        this.completionId = randomUUID();
    }
    next();
});

careScheduleCompletionSchema.index(
    { familyId: 1, recipientUserId: 1, scheduleId: 1, dateKey: 1 },
    { unique: true },
);

const CareScheduleCompletion: Model<ICareScheduleCompletionDocument> =
    (mongoose.models.CareScheduleCompletion as Model<ICareScheduleCompletionDocument>) ||
    mongoose.model<ICareScheduleCompletionDocument>(
        "CareScheduleCompletion",
        careScheduleCompletionSchema,
    );

export default CareScheduleCompletion;
