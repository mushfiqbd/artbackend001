import { Router, type Response } from "express";
import crypto from "crypto";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { supabase } from "../config/supabase";

const router = Router();

// GET /settings/risk
router.get("/risk", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    let { data, error } = await supabase
      .from("risk_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    // Auto-create default risk settings if missing
    if (!data) {
      const defaults = {
        user_id: userId,
        size_type: "fixed_usdt",
        size_value: 500,
        max_leverage: 20,
        max_positions: 5,
      };

      const upsertResult = await supabase
        .from("risk_settings")
        .upsert(defaults)
        .select("*")
        .single();

      if (upsertResult.error) throw upsertResult.error;
      data = upsertResult.data;
    }

    return res.json({ success: true, status: "ok", message: "Risk settings fetched", details: data });
  } catch (err: any) {
    return res.status(500).json({ success: false, status: "error", message: "Failed to fetch risk settings" });
  }
});

// PUT /settings/risk
router.put("/risk", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;
    const { size_type, size_value, max_leverage, max_positions } = req.body;

    // Clamp values
    const clampedLeverage = max_leverage ? Math.min(125, Math.max(1, parseInt(max_leverage))) : undefined;
    const clampedMaxPositions = max_positions ? Math.min(50, Math.max(1, parseInt(max_positions))) : undefined;

    // First, check if risk settings exist for this user
    const { data: existingSettings } = await supabase
      .from("risk_settings")
      .select("id")
      .eq("user_id", userId)
      .single();

    let updateData: any = {
      updated_at: new Date().toISOString(),
    };

    if (size_type) updateData.size_type = size_type;
    if (size_value !== undefined && size_value !== null) updateData.size_value = parseFloat(size_value);
    if (clampedLeverage) updateData.max_leverage = clampedLeverage;
    if (clampedMaxPositions) updateData.max_positions = clampedMaxPositions;

    let result;
    if (existingSettings) {
      // Update existing
      result = await supabase
        .from("risk_settings")
        .update(updateData)
        .eq("user_id", userId)
        .select("*")
        .single();
    } else {
      // Insert new with defaults
      updateData.user_id = userId;
      if (!updateData.size_type) updateData.size_type = "fixed_usdt";
      if (!updateData.size_value) updateData.size_value = 500;
      if (!updateData.max_leverage) updateData.max_leverage = 20;
      if (!updateData.max_positions) updateData.max_positions = 5;

      result = await supabase
        .from("risk_settings")
        .insert(updateData)
        .select("*")
        .single();
    }

    if (result.error) throw result.error;

    return res.json({ success: true, status: "updated", message: "Risk settings updated", details: result.data });
  } catch (err: any) {
    console.error("Update risk settings error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: `Failed to update risk settings: ${err?.message || "Unknown error"}` });
  }
});

// GET /settings/app
router.get("/app", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    let { data, error } = await supabase
      .from("app_settings")
      .select("webhook_secret, default_exchange, mode, user_id, updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    // Auto-create default app settings if missing
    if (!data) {
      const defaultWebhookSecret = crypto.randomBytes(24).toString("hex");
      const defaults = {
        user_id: userId,
        webhook_secret: defaultWebhookSecret,
        default_exchange: "binance",
        mode: "demo",
      };

      const insertResult = await supabase
        .from("app_settings")
        .insert(defaults)
        .select("webhook_secret, default_exchange, mode, user_id, updated_at")
        .single();

      if (insertResult.error) throw insertResult.error;
      data = insertResult.data;
    }

    return res.json({ 
      success: true, 
      status: "ok", 
      message: "App settings fetched", 
      details: data,
      webhook_info: {
        secret: data.webhook_secret,
        note: "Use this secret in your TradingView alert passphrase field",
        exchange_mode: data.default_exchange === "both" ? "Trading on both Binance and Bybit" : `Trading on ${data.default_exchange} only`
      }
    });
  } catch (err: any) {
    console.error("Fetch app settings error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: "Failed to fetch app settings" });
  }
});

// PUT /settings/app
router.put("/app", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;
    const { webhook_secret, default_exchange, mode } = req.body;

    // Validate webhook_secret if provided
    if (webhook_secret && webhook_secret.length < 8) {
      return res.status(400).json({
        success: false,
        status: "validation_error",
        message: "Webhook secret must be at least 8 characters long for security"
      });
    }

    // Validate default_exchange if provided
    if (default_exchange && !["binance", "bybit", "both"].includes(default_exchange)) {
      return res.status(400).json({
        success: false,
        status: "validation_error",
        message: "Default exchange must be 'binance', 'bybit', or 'both'"
      });
    }

    // First, check if app settings exist for this user
    const { data: existingSettings } = await supabase
      .from("app_settings")
      .select("id")
      .eq("user_id", userId)
      .single();

    let updateData: any = {
      updated_at: new Date().toISOString(),
    };

    // User can set their own webhook secret or auto-generate one
    if (webhook_secret !== undefined && webhook_secret !== null) {
      updateData.webhook_secret = webhook_secret.trim();
    }
    if (default_exchange) updateData.default_exchange = default_exchange;
    if (mode && (mode === "demo" || mode === "real")) updateData.mode = mode;

    let result;
    if (existingSettings) {
      // Update existing
      result = await supabase
        .from("app_settings")
        .update(updateData)
        .eq("user_id", userId)
        .select("webhook_secret, default_exchange, mode, user_id, updated_at")
        .single();
    } else {
      // Insert new with defaults
      updateData.user_id = userId;
      if (!updateData.webhook_secret) {
        updateData.webhook_secret = crypto.randomBytes(24).toString("hex");
      }
      if (!updateData.default_exchange) updateData.default_exchange = "binance";
      if (!updateData.mode) updateData.mode = "demo";

      result = await supabase
        .from("app_settings")
        .insert(updateData)
        .select("webhook_secret, default_exchange, mode, user_id, updated_at")
        .single();
    }

    if (result.error) throw result.error;

    return res.json({ 
      success: true, 
      status: "updated", 
      message: "App settings updated successfully", 
      details: result.data,
      webhook_info: {
        secret: result.data.webhook_secret,
        note: "Your webhook secret has been updated. Use this in your TradingView alert passphrase field.",
        exchange_mode: result.data.default_exchange === "both" ? "Trading on both Binance and Bybit" : `Trading on ${result.data.default_exchange} only`
      }
    });
  } catch (err: any) {
    console.error("Update app settings error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: `Failed to update app settings: ${err?.message || "Unknown error"}` });
  }
});

// POST /settings/app/generate-webhook-secret — Generate a new random webhook secret
router.post("/app/generate-webhook-secret", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;
    const newSecret = crypto.randomBytes(24).toString("hex");

    const { data: existingSettings } = await supabase
      .from("app_settings")
      .select("id")
      .eq("user_id", userId)
      .single();

    let result;
    if (existingSettings) {
      result = await supabase
        .from("app_settings")
        .update({ 
          webhook_secret: newSecret,
          updated_at: new Date().toISOString()
        })
        .eq("user_id", userId)
        .select("webhook_secret, default_exchange, mode, user_id, updated_at")
        .single();
    } else {
      result = await supabase
        .from("app_settings")
        .insert({
          user_id: userId,
          webhook_secret: newSecret,
          default_exchange: "binance",
          mode: "demo",
        })
        .select("webhook_secret, default_exchange, mode, user_id, updated_at")
        .single();
    }

    if (result.error) throw result.error;

    return res.json({
      success: true,
      status: "generated",
      message: "New webhook secret generated successfully",
      details: {
        webhook_secret: result.data.webhook_secret,
        note: "Update your TradingView alerts with this new secret"
      }
    });
  } catch (err: any) {
    console.error("Generate webhook secret error:", err?.message || err);
    return res.status(500).json({ 
      success: false, 
      status: "error", 
      message: `Failed to generate webhook secret: ${err?.message || "Unknown error"}` 
    });
  }
});

// DELETE /settings/risk — remove risk settings row (will recreate defaults on next GET)
router.delete("/risk", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    const { error } = await supabase
      .from("risk_settings")
      .delete()
      .eq("user_id", userId);

    if (error) throw error;

    return res.json({
      success: true,
      status: "deleted",
      message: "Risk settings deleted",
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to delete risk settings",
    });
  }
});

// DELETE /settings/app — remove app settings row (will recreate defaults on next GET)
router.delete("/app", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    const { error } = await supabase
      .from("app_settings")
      .delete()
      .eq("user_id", userId);

    if (error) throw error;

    return res.json({
      success: true,
      status: "deleted",
      message: "App settings deleted",
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to delete app settings",
    });
  }
});

// GET /settings/api-keys
router.get("/api-keys", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    const { data, error } = await supabase
      .from("api_keys")
      .select("id, exchange, api_key, api_secret, testnet, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.json({
      success: true,
      status: "ok",
      message: "API keys fetched",
      details: data ?? [],
    });
  } catch (err: any) {
    console.error("Fetch API keys error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to fetch API keys",
    });
  }
});

// PUT /settings/api-keys
router.put("/api-keys", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;
    const { exchange, api_key, api_secret, testnet } = req.body ?? {};

    if (!exchange || !api_key || !api_secret) {
      return res.status(400).json({
        success: false,
        status: "validation_error",
        message: "exchange, api_key and api_secret are required",
      });
    }

    const { error } = await supabase
      .from("api_keys")
      .upsert(
        {
          user_id: userId,
          exchange,
          api_key,
          api_secret,
          testnet: !!testnet,
        },
        {
          onConflict: "user_id,exchange",
        }
      );

    if (error) throw error;

    return res.json({
      success: true,
      status: "updated",
      message: "API key saved",
    });
  } catch (err: any) {
    console.error("Save API key error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to save API key",
    });
  }
});

// DELETE /settings/api-keys/:exchange
router.delete("/api-keys/:exchange", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;
    const { exchange } = req.params;

    const { error } = await supabase
      .from("api_keys")
      .delete()
      .eq("user_id", userId)
      .eq("exchange", exchange);

    if (error) throw error;

    return res.json({
      success: true,
      status: "deleted",
      message: "API key deleted",
    });
  } catch (err: any) {
    console.error("Delete API key error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: "Failed to delete API key",
    });
  }
});

export default router;
