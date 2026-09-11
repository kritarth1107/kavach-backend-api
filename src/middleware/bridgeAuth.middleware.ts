import { NextFunction, Request, Response } from "express";
import config from "../config/app.config";

export function requireBridgeSecret(req: Request, res: Response, next: NextFunction): void {
    const expected = config.whatsapp.bridgeSecret;
    if (!expected) {
        res.status(503).json({ success: false, message: "WhatsApp bridge secret not configured" });
        return;
    }

    const provided = req.header("X-Kavach-Bridge-Secret");
    if (!provided || provided !== expected) {
        res.status(401).json({ success: false, message: "Unauthorized" });
        return;
    }

    next();
}
