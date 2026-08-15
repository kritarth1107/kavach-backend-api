import { timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import config from "../config/app.config";
import { buildBasicHealthReport, buildHealthReport } from "../services/health.service";

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
