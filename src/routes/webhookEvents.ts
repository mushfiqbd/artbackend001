import { Router, type Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { supabase } from "../config/supabase";
import { config } from "../config/env";

const router = Router();

// GET /webhook-events — recent webhook events for authenticated user
router.get("/", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    const { data, error } = await supabase
      .from("webhook_events")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw error;

    return res.json({
      success: true,
      status: "ok",
      message: "Webhook events fetched",
      details: data ?? [],
      count: data?.length || 0,
    });
  } catch (err: any) {
    console.error("Fetch webhook events error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to fetch webhook events",
    });
  }
});

// GET /webhook-events/info — Get webhook URL and configuration info
router.get("/info", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    // Get user's app settings including webhook secret
    const { data: appSettings, error: appError } = await supabase
      .from("app_settings")
      .select("webhook_secret, default_exchange, mode")
      .eq("user_id", userId)
      .maybeSingle();

    if (appError) throw appError;

    // Get server/base URL from environment
    const baseUrl = process.env.BASE_URL || `http://localhost:${config.port}`;
    const webhookUrl = `${baseUrl}/webhook`;

    return res.json({
      success: true,
      status: "ok",
      message: "Webhook configuration info",
      webhook_url: webhookUrl,
      webhook_secret: appSettings?.webhook_secret || null,
      configuration: {
        default_exchange: appSettings?.default_exchange || "binance",
        mode: appSettings?.mode || "demo",
        has_secret: !!appSettings?.webhook_secret,
      },
      example_payload: {
        passphrase: appSettings?.webhook_secret || "your_secret_here",
        event_type: "entry_long",
        symbol: "{{ticker}}",
        amount: "500",
      },
      tradingview_setup: {
        alert_message: JSON.stringify({
          passphrase: appSettings?.webhook_secret || "your_secret_here",
          event_type: "entry_long",
          symbol: "{{ticker}}",
          amount: "500",
        }, null, 2),
        webhook_url: webhookUrl,
      },
    });
  } catch (err: any) {
    console.error("Fetch webhook info error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to fetch webhook configuration",
    });
  }
});

// GET /webhook-events/stats — Get webhook statistics
router.get("/stats", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    // Count total events
    const { count: totalCount } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    // Count by status
    const { data: statusCounts } = await supabase
      .from("webhook_events")
      .select("status")
      .eq("user_id", userId);

    const stats = {
      total: totalCount || 0,
      by_status: {} as Record<string, number>,
    };

    if (statusCounts) {
      statusCounts.forEach((event: any) => {
        const status = event.status;
        stats.by_status[status] = (stats.by_status[status] || 0) + 1;
      });
    }

    // Get recent activity (last 24 hours)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const { count: recentCount } = await supabase
      .from("webhook_events")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", yesterday.toISOString());

    return res.json({
      success: true,
      status: "ok",
      message: "Webhook statistics",
      stats: {
        ...stats,
        last_24_hours: recentCount || 0,
      },
    });
  } catch (err: any) {
    console.error("Fetch webhook stats error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to fetch webhook statistics",
    });
  }
});

export default router;

