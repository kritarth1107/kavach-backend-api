/**
 * Founder-only view of how Saheli is learning across families: playbook versions and their lessons, the 10%
 * canary, score trends per situation, timing, and what people asked that she cannot do yet.
 * Access: users whose email is in KAVACH_ADMIN_EMAILS (comma-separated; default the founder account).
 */
import { Request, Response } from "express";
import { aiEngineJson } from "../clients/aiEngine.client";
import { AppError } from "../middleware/error.middleware";
import User from "../models/users.model";

function adminEmails(): string[] {
    return (process.env.KAVACH_ADMIN_EMAILS || "kritarth@kavach.care")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
}

async function requireAdmin(req: Request): Promise<string> {
    const user = await User.findOne({ userId: req.user!.userId }).lean<{ email?: string }>();
    const email = String(user?.email || "").toLowerCase();
    if (!email || !adminEmails().includes(email)) throw new AppError("Not allowed", 403);
    return req.user!.userId;
}

export async function getLearning(req: Request, res: Response) {
    await requireAdmin(req);
    const weeks = Math.min(Math.max(Number(req.query.weeks) || 8, 1), 52);
    res.json({ success: true, data: await aiEngineJson("GET", `/v2/learn/overview?weeks=${weeks}`, undefined, 45_000) });
}

export async function postPlaybookAction(req: Request, res: Response) {
    const by = await requireAdmin(req);
    const version = Number(req.params.version);
    const action = req.params.action === "block" ? "block" : "approve";
    if (!Number.isInteger(version) || version < 1) throw new AppError("Bad version", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `/v2/learn/playbooks/${version}/${action}`, { by }) });
}

export async function postRuleAction(req: Request, res: Response) {
    const by = await requireAdmin(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw new AppError("Bad rule", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `/v2/learn/rules/${id}`, { by, approve: req.params.action === "approve" }) });
}

export async function getAdminCheck(req: Request, res: Response) {
    try {
        await requireAdmin(req);
        res.json({ success: true, data: { admin: true } });
    } catch {
        res.json({ success: true, data: { admin: false } });
    }
}
