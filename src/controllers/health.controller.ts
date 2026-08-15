import { Request, Response } from "express";
import { buildHealthReport } from "../services/health.service";

export async function getHealth(_req: Request, res: Response): Promise<void> {
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
