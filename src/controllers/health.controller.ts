import { timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import config from "../config/app.config";
import { buildBasicHealthReport, buildHealthReport } from "../services/health.service";
import { aiEngineHealth } from "../clients/aiEngine.client";

function isValidHealthSecret(provided: unknown): boolean {
    const expected = config.health.secret;
    if (!expected || typeof provided !== "string" || !provided) {
        return false;
    }

    if (provided.length !== expected.length) {
        return false;
    }

    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/** GET /api/health/engine?HEALTH_SECRET=…: the private engine's health, asked with the backend's own identity. */
export async function getEngineHealth(req: Request, res: Response): Promise<void> {
    if (!config.health.secret || !isValidHealthSecret(req.query.HEALTH_SECRET)) {
        res.status(config.health.secret ? 401 : 503).json({ status: "error", message: "Unauthorized", checkedAt: new Date().toISOString() });
        return;
    }
    const engine = await aiEngineHealth();
    res.status(engine.ok ? 200 : 503).json({ status: engine.ok ? "ok" : "down", engine, checkedAt: new Date().toISOString() });
}

export async function getHealth(_req: Request, res: Response): Promise<void> {
    try {
        const report = await buildBasicHealthReport();
        const statusCode = report.status === "ok" ? 200 : 503;
        res.status(statusCode).json(report);
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: "Health check failed",
            checkedAt: new Date().toISOString(),
        });
    }
}

export async function getDetailedHealth(req: Request, res: Response): Promise<void> {
    if (!config.health.secret) {
        res.status(503).json({
            status: "error",
            message: "Detailed health is not configured",
            checkedAt: new Date().toISOString(),
        });
        return;
    }

    if (!isValidHealthSecret(req.query.HEALTH_SECRET)) {
        res.status(401).json({
            status: "error",
            message: "Unauthorized",
            checkedAt: new Date().toISOString(),
        });
        return;
    }

    try {
        const report = await buildHealthReport();
        const statusCode = report.status === "ok" ? 200 : 503;
        res.status(statusCode).json(report);
    } catch (error) {
        res.status(500).json({
            status: "error",
            message: "Health check failed",
            error: error instanceof Error ? error.message : "Unknown error",
            checkedAt: new Date().toISOString(),
        });
    }
}
