import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { assertFamilyMember } from "../services/family.service";
import {
    confirmFact,
    dismissDeviation,
    editFact,
    profileView,
    rejectFact,
    setCareActionStatus,
    setRetention,
} from "../services/profile/elderProfile.service";
import { dismissAlert } from "../services/profile/unusualActivity.service";

async function member(req: Request) {
    if (!req.user) throw new AppError("Not authenticated", 401);
    const { familyId, recipientUserId } = req.params;
    await assertFamilyMember(familyId, req.user.userId).catch(() => {
        throw new AppError("Family not found or access denied", 403);
    });
    return { w: { familyId, recipientUserId }, userId: req.user.userId };
}

function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await fn(req, res);
        } catch (err) {
            const e = err as { status?: number; message?: string };
            next(e.status && !(err instanceof AppError) ? new AppError(e.message || "Bad request", e.status) : err);
        }
    };
}

/** GET …/saheli/profile — what Saheli learned (care-first), care actions, unusual activity, deviations, metrics. */
export const getProfileHandler = wrap(async (req, res) => {
    const { w } = await member(req);
    res.json({ success: true, data: await profileView(w) });
});

/** POST …/saheli/profile/facts/:factId/confirm */
export const confirmFactHandler = wrap(async (req, res) => {
    const { w, userId } = await member(req);
    if (!(await confirmFact(w, req.params.factId, userId))) throw new AppError("Fact not found", 404);
    res.json({ success: true, data: await profileView(w) });
});

/** PATCH …/saheli/profile/facts/:factId  { text, category? } */
export const editFactHandler = wrap(async (req, res) => {
    const { w, userId } = await member(req);
    const text = String(req.body?.text ?? "").trim();
    if (!text) throw new AppError("text is required", 400);
    if (!(await editFact(w, req.params.factId, userId, text, req.body?.category ? String(req.body.category) : undefined))) throw new AppError("Fact not found", 404);
    res.json({ success: true, data: await profileView(w) });
});

/** DELETE …/saheli/profile/facts/:factId — rejected: hidden and never re-learned. */
export const rejectFactHandler = wrap(async (req, res) => {
    const { w, userId } = await member(req);
    if (!(await rejectFact(w, req.params.factId, userId))) throw new AppError("Fact not found", 404);
    res.json({ success: true, data: await profileView(w) });
});

/** PATCH …/saheli/profile/care-actions/:actionId { status: "used" | "dismissed" } */
export const careActionHandler = wrap(async (req, res) => {
    const { w } = await member(req);
    const status = String(req.body?.status ?? "");
    if (status !== "used" && status !== "dismissed") throw new AppError("status must be used|dismissed", 400);
    await setCareActionStatus(w, req.params.actionId, status);
    res.json({ success: true, data: await profileView(w) });
});

/** DELETE …/saheli/profile/deviations/:id  and  …/alerts/:id (dismiss) */
export const dismissDeviationHandler = wrap(async (req, res) => {
    const { w } = await member(req);
    await dismissDeviation(w, req.params.id);
    res.json({ success: true, data: await profileView(w) });
});
export const dismissAlertHandler = wrap(async (req, res) => {
    const { w } = await member(req);
    await dismissAlert(w, req.params.id);
    res.json({ success: true, data: await profileView(w) });
});

/** PATCH …/saheli/profile/retention { days: 30..730 } */
export const retentionHandler = wrap(async (req, res) => {
    const { w } = await member(req);
    const days = Number(req.body?.days);
    if (!Number.isFinite(days)) throw new AppError("days is required", 400);
    await setRetention(w, days);
    res.json({ success: true, data: await profileView(w) });
});
