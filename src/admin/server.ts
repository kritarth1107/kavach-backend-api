/**
 * Kavach admin API: a separate Cloud Run service (kavach-admin-api), never part of the public backend.
 * Only the admin web app's service account can call it (Cloud Run IAM), and every route goes through the locks,
 * permission, reason and audit in router.ts. Start: node dist/admin/server.js
 */
import dotenv from "dotenv";
dotenv.config();
import express from "express";
import { connectDB } from "../config/db";
import { loadAdminConfig, seedOwner } from "./auth";
import { adminRoutes } from "./routes";
import { buildAdminRouter } from "./router";

const cfg = loadAdminConfig();
const app = express();
app.disable("x-powered-by");
app.disable("etag");
app.use((_req, res, next) => {
    res.set({
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    });
    next();
});
app.use(express.json({ limit: "100kb" }));
app.get("/admin/healthz", (_req, res) => res.json({ ok: true }));
app.use("/admin/v1", buildAdminRouter(adminRoutes(cfg), { cfg }));
app.use((_req, res) => res.status(404).json({ error: "not_found" }));

const PORT = Number(process.env.PORT) || 8080;
void connectDB().then(async () => {
    await seedOwner(cfg).catch((err) => console.error("admin owner seed failed", err));
    app.listen(PORT, () => console.log(`Kavach admin API on :${PORT}`));
});
