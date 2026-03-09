import express from "express";
import cors from "cors";
import { config } from "./config/env";
import authRoutes from "./routes/auth";
import webhookRoutes from "./routes/webhook";
import exchangeDataRoutes from "./routes/exchangeData";
import clearHistoryRoutes from "./routes/clearHistory";
import settingsRoutes from "./routes/settings";
import tradesRoutes from "./routes/trades";
import webhookEventsRoutes from "./routes/webhookEvents";
import positionsRoutes from "./routes/positions";

// Start background services
import "./services/pendingEntryMonitor"; // Auto-starts pending entry timeout monitor
import "./services/exitSignalCleanup"; // Auto-starts exit signal queue cleanup

const app = express();

app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok", message: "Arts Trading Bot is running" });
});

// Routes
app.use("/auth", authRoutes);
app.use("/webhook", webhookRoutes);
app.use("/exchange-data", exchangeDataRoutes);
app.use("/clear-execution-history", clearHistoryRoutes);
app.use("/settings", settingsRoutes);
app.use("/trades", tradesRoutes);
app.use("/webhook-events", webhookEventsRoutes);
app.use("/positions", positionsRoutes);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({
    success: false,
    status: "error",
    message: "Internal server error",
  });
});

app.listen(config.port, () => {
  console.log(`🚀 Arts Trading Bot running on port ${config.port}`);
});
