/**
 * Invite links (dashboard: Invitations) and the public side of invite-only sign-up (the join page, the waitlist form).
 *   /api/invites           GET list + this week's quota · POST make one link now
 *   /api/invites/:id/revoke POST cancel an unused link
 *   /api/invites/lookup/:token  GET (public) what the join page shows: who invited, still usable?
 *   /api/waitlist          POST (public) join the waitlist
 */
import { NextFunction, Request, Response, Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { AppError } from "../middleware/error.middleware";
import { createInvite, listInvites, lookupInvite, revokeInvite } from "../services/invite.service";
import { joinWaitlist } from "../services/waitlist.service";

/** A small in-memory limiter for the public routes (per client and overall), enough to blunt a script. */
const hits = new Map<string, number[]>();
function allow(key: string, max: number, windowMs: number, now = Date.now()): boolean {
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
        hits.set(key, list);
        return false;
    }
    list.push(now);
    hits.set(key, list);
    if (hits.size > 20_000) hits.clear();
    return true;
}
const clientKey = (req: Request) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.ip || "unknown";

const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
};

export const inviteRouter = Router();

inviteRouter.get(
    "/lookup/:token",
    wrap(async (req, res) => {
        if (!allow(`lookup:${clientKey(req)}`, 60, 60_000)) throw new AppError("Too many tries. Please wait a minute.", 429);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Robots-Tag", "noindex");
        res.json({ success: true, data: await lookupInvite(req.params.token) });
    }),
);

inviteRouter.get(
    "/",
    protect,
    wrap(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.json({ success: true, data: await listInvites(req.user!.userId) });
    }),
);

inviteRouter.post(
    "/",
    protect,
    wrap(async (req, res) => {
        const out = await createInvite(req.user!.userId);
        res.status(201).json({ success: true, message: "Invite link ready", data: out });
    }),
);

inviteRouter.post(
    "/:inviteId/revoke",
    protect,
    wrap(async (req, res) => {
        res.json({ success: true, message: "Invite link cancelled", data: await revokeInvite(req.user!.userId, String(req.params.inviteId)) });
    }),
);

export const waitlistRouter = Router();

waitlistRouter.post(
    "/",
    wrap(async (req, res) => {
        if (!allow(`waitlist:${clientKey(req)}`, 10, 3_600_000) || !allow("waitlist:all", 600, 3_600_000)) {
            throw new AppError("Too many requests. Please try again in a little while.", 429);
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        await joinWaitlist({
            name: body.name,
            email: body.email,
            phone: body.phone,
            phoneCountryCode: body.phoneCountryCode,
            note: body.note,
            source: "dashboard",
        });
        // the same answer whoever asks, so the form never tells anyone what we know about an email
        res.status(201).json({ success: true, message: "You're on the waitlist", data: { onWaitlist: true } });
    }),
);
