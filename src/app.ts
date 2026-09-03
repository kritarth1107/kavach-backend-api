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
import careRecordRoutes from "./routes/careRecord.routes";
import webhookRoutes from "./routes/webhook.routes";
import zeptoPublicRoutes, { familyZeptoRouter } from "./routes/zeptoIntegration.routes";
import { errorHandler } from "./middleware/error.middleware";

dotenv.config();

const app = express();
const PORT = config.server.port || 5000;

connectDB();

app.use(
  cors({
    origin: config.server.corsOrigins,
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/families", familyRoutes);
app.use("/api/families", careRecordRoutes);
app.use("/api/families", familyZeptoRouter);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/integrations", zeptoPublicRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/links", linkRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use("/api/health", healthRoutes);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`Kavach Backend running on port ${PORT}`);
});
