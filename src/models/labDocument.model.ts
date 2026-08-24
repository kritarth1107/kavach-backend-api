import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";

export interface ILabDocument {
    documentId: string;
    familyId: string;
    recipientUserId: string;
    title: string;
    rawText: string;
    kind: string;
    recordDate?: string;
    createdBy: string;
    createdAt?: Date;
}

export interface ILabDocumentRecord extends ILabDocument, Document {}

const labDocumentSchema = new Schema<ILabDocumentRecord>(
    {
        documentId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        rawText: { type: String, required: true, maxlength: 50000 },
        kind: { type: String, default: "lab", maxlength: 40 },
        recordDate: { type: String, trim: true, maxlength: 80 },
        createdBy: { type: String, required: true },
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

labDocumentSchema.pre("save", function (next) {
    if (!this.documentId) this.documentId = randomUUID();
    next();
});

labDocumentSchema.index({ familyId: 1, recipientUserId: 1, createdAt: -1 });

const LabDocument: Model<ILabDocumentRecord> =
    (mongoose.models.LabDocument as Model<ILabDocumentRecord>) ||
    mongoose.model<ILabDocumentRecord>("LabDocument", labDocumentSchema);

export default LabDocument;
