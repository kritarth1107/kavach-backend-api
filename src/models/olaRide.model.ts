import mongoose, { Schema } from "mongoose";

/**
 * A booked in-chat Ola ride being watched (driver search → driver assigned → done). Durable: the
 * watcher picks these up again after a restart and reopens Ola with the saved sign-in.
 */
export type OlaRideStatus =
    | "searching"
    | "assigned"
    | "cancelling"
    | "cancelled"
    | "no_driver"
    | "driver_cancelled"
    | "started"
    | "ended"
    | "failed";

export interface IOlaRide {
    rideId: string;
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    lang?: string | null;
    status: OlaRideStatus;
    /** Why a cancel was asked: user / timeout / no_driver. */
    cancelReason?: "user" | "timeout" | "no_driver";
    vehicle: string;
    fare?: number;
    pickupLabel?: string;
    dropLabel?: string;
    pickup?: Record<string, unknown>;
    drop?: Record<string, unknown>;
    bookedAt: Date;
    lastUpdateAt?: Date;
    updateIdx: number;
    driver?: { name?: string; vehicle?: string; plate?: string; etaMin?: number; otp?: string };
    assignedAt?: Date;
    cancelAttempts: number;
    cancelNotifiedStuck?: boolean;
    endedAt?: Date;
    /** Test numbers only: scripted page states + time acceleration. */
    fake?: { scenario: string; timeScale: number };
    createdAt?: Date;
    updatedAt?: Date;
}

const schema = new Schema<IOlaRide>(
    {
        rideId: { type: String, required: true, unique: true },
        phone: { type: String, required: true, index: true },
        familyId: { type: String, required: true },
        recipientUserId: { type: String, required: true },
        actorUserId: { type: String, required: true },
        lang: { type: String },
        status: { type: String, required: true, index: true },
        cancelReason: { type: String },
        vehicle: { type: String, required: true },
        fare: { type: Number },
        pickupLabel: { type: String },
        dropLabel: { type: String },
        pickup: { type: Schema.Types.Mixed },
        drop: { type: Schema.Types.Mixed },
        bookedAt: { type: Date, required: true },
        lastUpdateAt: { type: Date },
        updateIdx: { type: Number, default: 0 },
        driver: { type: Schema.Types.Mixed },
        assignedAt: { type: Date },
        cancelAttempts: { type: Number, default: 0 },
        cancelNotifiedStuck: { type: Boolean },
        endedAt: { type: Date },
        fake: { type: Schema.Types.Mixed },
    },
    { collection: "ola_rides", timestamps: true, versionKey: false },
);

export default (mongoose.models.OlaRide as mongoose.Model<IOlaRide>) || mongoose.model<IOlaRide>("OlaRide", schema);
