import "./utils/asyncRouteErrors";
import onboardingRoutes from "./routes/onboarding.routes";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import connectDB from "./config/db";
import config from "./config/app.config";
import authRoutes from "./routes/auth.routes";
import userRoutes from "./routes/user.routes";
import familyRoutes from "./routes/family.routes";
import documentRoutes from "./routes/document.routes";
import linkRoutes from "./routes/link.routes";
import analyticsRoutes from "./routes/analytics.routes";
import healthRoutes from "./routes/health.routes";
import publicRoutes from "./routes/public.routes";
import careRecordRoutes from "./routes/careRecord.routes";
import learningRoutes from "./routes/learning.routes";
import webhookRoutes from "./routes/webhook.routes";
import callsRoutes from "./routes/calls.routes";
import zeptoPublicRoutes, { familyZeptoRouter } from "./routes/zeptoIntegration.routes";
import mcpPublicRoutes, { familyMcpRouter } from "./routes/mcpIntegration.routes";
import { errorHandler } from "./middleware/error.middleware";
import { familyAccess } from "./middleware/familyAccess.middleware";
import { startCareNudgeScheduler } from "./workers/careNudgeScheduler";
import { startBrainRetryScheduler } from "./workers/brainRetryScheduler";
import internalRoutes from "./routes/internal.routes";
import delegateRoutes from "./routes/delegate.routes";
import { inviteRouter, waitlistRouter } from "./routes/invite.routes";

dotenv.config();

const app = express();
const PORT = config.server.port || 5000;
// Run as the server (node dist/app.js), or imported by a test that wants the app without a port, timers or a DB connect.
const IS_SERVER = require.main === module;

if (IS_SERVER) {
  connectDB();
  void import("./services/featureFlags.service").then(({ startFlagRefresh }) => startFlagRefresh());
}

app.use(
  cors({
    origin: config.server.corsOrigins,
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(
    express.json({
        // Keep the raw bytes for the Meta webhook so its X-Hub-Signature-256 can be verified.
        verify: (req, _res, buf) => {
            const url = (req as { url?: string }).url ?? "";
            if (url.startsWith("/api/webhooks/whatsapp/meta") || url.startsWith("/api/calls/post-call")) {
                (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
            }
        },
    }),
);
app.use(express.urlencoded({ extended: true }));

app.use("/api/auth", authRoutes);
app.use("/api/invites", inviteRouter);
app.use("/api/waitlist", waitlistRouter);
app.use("/api/users", userRoutes);
// every /api/families/<familyId>/… route: a joined member of that family (each route still checks the role it needs)
app.use("/api/families/:familyId", familyAccess);
app.use("/api/families", familyRoutes);
app.use("/api/onboarding", onboardingRoutes);
app.use("/api/families", careRecordRoutes);
app.use("/api/admin", learningRoutes);
app.use("/api/families", familyZeptoRouter);
app.use("/api/families", familyMcpRouter);
app.use("/api/families", delegateRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/calls", callsRoutes);
app.use("/api/integrations", zeptoPublicRoutes);
app.use("/api/integrations", mcpPublicRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/links", linkRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use("/api/health", healthRoutes);
app.use("/api/public", publicRoutes);
app.use("/internal", internalRoutes);

app.use(errorHandler);

export default app;

if (IS_SERVER) {
// A stray rejected promise (async route without try/catch, background browser work) must
// never take the whole service down mid-conversation for every family.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack || reason.message : reason);
});


app.listen(PORT, () => {
  console.log(`Kavach Backend running on port ${PORT}`);
  startCareNudgeScheduler();
  // Held WhatsApp turns (the brain could not answer) are retried every 30 s; the daily "0 old-store writes" check.
  startBrainRetryScheduler();
  // In-chat Ola rides: driver search / assignment watch (durable — resumes after a restart).
  void import("./services/rideBooking/ola/olaInChat.service").then(({ startOlaWatcher }) => startOlaWatcher());
  // Legacy per-person delivery addresses → family address book (idempotent, once per row).
  setTimeout(() => {
    void import("./services/familyAddressBook.service")
      .then(({ migrateAllLegacyAddresses }) => migrateAllLegacyAddresses())
      .then((n) => console.log(`[address-book] migrated ${n} legacy address row(s)`))
      .catch((err) => console.warn("[address-book] migration failed:", err instanceof Error ? err.message : err));
  }, 8000);

  if (config.whatsapp.provider === "meta") {
    void import("./clients/metaWhatsApp.client")
      .then(({ isMetaWhatsAppEnabled, setupMetaWhatsAppWebhooks }) => {
        if (!isMetaWhatsAppEnabled()) return null;
        return setupMetaWhatsAppWebhooks();
      })
      .then((report) => {
        if (report) console.log("WhatsApp Meta webhook auto-setup:", report.summary);
      })
      .catch((err) => {
        console.error("WhatsApp Meta webhook auto-setup failed:", err);
      });
  }
});
}
