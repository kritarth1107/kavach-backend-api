import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";

export interface ICareRecordEvent {
    eventId: string;
    familyId: string;
    subjectUserId: string;
    actorUserId?: string;
    type: CareRecordEventType;
    source: CareRecordSource;
    channel: ChannelType;
    title: string;
    detail: string;
    payload: Record<string, unknown>;
    phiTokenRefs: string[];
    status?: string;
    createdAt?: Date;
}

export interface ICareRecordEventDocument extends ICareRecordEvent, Document {}

const careRecordEventSchema = new Schema<ICareRecordEventDocument>(
    {
        eventId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        subjectUserId: { type: String, required: true, index: true },
        actorUserId: { type: String, index: true },
        type: {
            type: String,
            enum: Object.values(CareRecordEventType),
            required: true,
            index: true,
        },
        source: {
            type: String,
            enum: Object.values(CareRecordSource),
            required: true,
        },
        channel: {
            type: String,
            enum: Object.values(ChannelType),
            required: true,
        },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        detail: { type: String, default: "", maxlength: 2000 },
        payload: { type: Schema.Types.Mixed, default: {} },
        phiTokenRefs: { type: [String], default: [] },
        status: { type: String, trim: true, maxlength: 40 },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        toJSON: {
            transform: (_doc, ret: Record<string, unknown>) => {
                delete ret.__v;
                return ret;
            },
        },
    },
);

careRecordEventSchema.pre("save", function (next) {
    if (!this.eventId) {
        this.eventId = randomUUID();
    }
    next();
});

careRecordEventSchema.index({ familyId: 1, subjectUserId: 1, createdAt: -1 });
careRecordEventSchema.index({ familyId: 1, type: 1, createdAt: -1 });

const CareRecordEvent: Model<ICareRecordEventDocument> =
    (mongoose.models.CareRecordEvent as Model<ICareRecordEventDocument>) ||
    mongoose.model<ICareRecordEventDocument>("CareRecordEvent", careRecordEventSchema);

export default CareRecordEvent;
