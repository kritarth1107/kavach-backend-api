/**
 * One Mongo lease for the in-process schedulers.
 * A rolling deploy runs two tasks for a few minutes. Each task still starts its timers;
 * only the task that holds this lease runs the tick. The lease lasts two minutes and is
 * renewed by the holder's own tick, so a dead task is replaced inside the reminder SLO.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import mongoose, { Schema } from "mongoose";

export const SCHEDULER_LEASE = "inprocess-schedulers";
export const LEASE_TTL_MS = 120_000;

const ownerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

export function instanceOwner(): string {
    return ownerId;
}

export type LeaseStore = {
    tryAcquire(name: string, owner: string, now: number, ttlMs: number): Promise<boolean>;
};

type LeaseRow = { owner: string; until: number };

/** In-memory lease for the two-instance regression. Same rules as the Mongo lease. */
export function createMemoryLeaseStore(): LeaseStore {
    const rows = new Map<string, LeaseRow>();
    return {
        async tryAcquire(name, owner, now, ttlMs) {
            const cur = rows.get(name);
            if (cur && cur.until > now && cur.owner !== owner) return false;
            rows.set(name, { owner, until: now + ttlMs });
            return true;
        },
    };
}

/** Run `tick` only when this owner holds the lease. Returns whether the tick ran. */
export async function runIfLeader(
    store: LeaseStore,
    name: string,
    owner: string,
    now: number,
    ttlMs: number,
    tick: () => Promise<void>,
): Promise<boolean> {
    if (!(await store.tryAcquire(name, owner, now, ttlMs))) return false;
    await tick();
    return true;
}

interface ISchedulerLease {
    _id: string;
    owner: string;
    until: Date;
}

const schedulerLeaseSchema = new Schema<ISchedulerLease>(
    {
        _id: { type: String, required: true },
        owner: { type: String, required: true },
        until: { type: Date, required: true },
    },
    { versionKey: false },
);

const SchedulerLease =
    mongoose.models.SchedulerLease ||
    mongoose.model<ISchedulerLease>("SchedulerLease", schedulerLeaseSchema, "scheduler_leases");

function isDuplicateKey(err: unknown): boolean {
    return Boolean(err && typeof err === "object" && "code" in err && (err as { code: number }).code === 11000);
}

/**
 * Take or renew `name` for `owner` until now+ttl. False when another owner still holds it.
 * A missing row is inserted; the loser of that race gets the duplicate-key error and skips.
 */
export async function tryAcquireLease(name: string, owner: string, now: number, ttlMs: number): Promise<boolean> {
    const until = new Date(now + ttlMs);
    const updated = await SchedulerLease.findOneAndUpdate(
        { _id: name, $or: [{ owner }, { until: { $lte: new Date(now) } }] },
        { $set: { owner, until } },
        { new: true },
    ).lean();
    if (updated) return true;
    try {
        await SchedulerLease.create({ _id: name, owner, until });
        return true;
    } catch (err) {
        if (isDuplicateKey(err)) return false;
        throw err;
    }
}

/** False when Mongo is unreachable: the tick does not run, so two tasks cannot both run it. */
export async function holdsSchedulerLease(name: string, ttlMs = LEASE_TTL_MS): Promise<boolean> {
    try {
        return await tryAcquireLease(name, instanceOwner(), Date.now(), ttlMs);
    } catch (err) {
        console.warn(`[lease] ${name} skipped:`, err instanceof Error ? err.message : err);
        return false;
    }
}
