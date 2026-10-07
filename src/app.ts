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
import zeptoPublicRoutes, { familyZeptoRouter } from "./routes/zeptoIntegration.routes";
import mcpPublicRoutes, { familyMcpRouter } from "./routes/mcpIntegration.routes";
import { errorHandler } from "./middleware/error.middleware";
import { startOutreachScheduler } from "./workers/outreachScheduler";
import { startCareNudgeScheduler } from "./workers/careNudgeScheduler";
import { startMemoryConsolidationScheduler } from "./workers/memoryConsolidationScheduler";
import internalRoutes from "./routes/internal.routes";
import delegateRoutes from "./routes/delegate.routes";

dotenv.config();

const app = express();
const PORT = config.server.port || 5000;

connectDB();
void import("./services/featureFlags.service").then(({ startFlagRefresh }) => startFlagRefresh());

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
            if ((req as { url?: string }).url?.startsWith("/api/webhooks/whatsapp/meta")) {
                (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
            }
        },
    }),
);
app.use(express.urlencoded({ extended: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/families", familyRoutes);
app.use("/api/families", careRecordRoutes);
app.use("/api/admin", learningRoutes);
app.use("/api/families", familyZeptoRouter);
app.use("/api/families", familyMcpRouter);
app.use("/api/families", delegateRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/integrations", zeptoPublicRoutes);
app.use("/api/integrations", mcpPublicRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/links", linkRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use("/api/health", healthRoutes);
app.use("/api/public", publicRoutes);
app.use("/internal", internalRoutes);

app.use(errorHandler);

// A stray rejected promise (async route without try/catch, background browser work) must
// never take the whole service down mid-conversation for every family.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack || reason.message : reason);
});

// Cloud Run sends SIGTERM before stopping an instance (deploy / scale-in): answer every search this
// instance still owes (honest "interrupted — want me to try again?") within the ~10 s grace, then exit.
process.once("SIGTERM", () => {
  console.log("[shutdown] SIGTERM — answering in-flight searches");
  const done = import("./services/commerceAutomation/browserTaskWhatsApp.service")
    .then(({ answerInflightOnShutdown }) => answerInflightOnShutdown())
    .then((n) => console.log(`[shutdown] answered ${n} in-flight search(es)`))
    .catch((err) => console.warn("[shutdown] in-flight answer failed:", err instanceof Error ? err.message : err));
  void Promise.race([done, new Promise((r) => setTimeout(r, 7000))]).finally(() => process.exit(0));
});

app.listen(PORT, () => {
  console.log(`Kavach Backend running on port ${PORT}`);
  startOutreachScheduler();
  startCareNudgeScheduler();
  startMemoryConsolidationScheduler();
  // Never leave anyone hanging after "I'll send the options in a moment": searches promised by a
  // previous revision / a lost promise get an honest answer + retry offer (startup, then every minute).
  const sweepSearches = () =>
    void import("./services/commerceAutomation/browserTaskWhatsApp.service")
      .then(({ sweepLostSearches }) => sweepLostSearches())
      .then((n) => n && console.log(`[guest-browse] answered ${n} lost search(es)`))
      .catch((err) => console.warn("[guest-browse] sweep failed:", err instanceof Error ? err.message : err));
  setTimeout(sweepSearches, 30_000);
  setInterval(sweepSearches, 60_000).unref();
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
