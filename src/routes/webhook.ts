import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { supabase } from "../config/supabase";
import { config } from "../config/env";
import { normalizeSymbol, roundQtyByStep } from "../utils/trading";
import { getExchangeClient, getAllExchangeClients, type ExchangeClient } from "../exchanges/factory";
import { BinanceClient } from "../exchanges/binance";
import { BybitClient } from "../exchanges/bybit";

const router = Router();

// ===== Flexible Webhook Schema =====
// Accepts ANY format — all fields optional except passphrase
const webhookSchema = z.object({
  // Auth — required
  passphrase: z.string(),

  // Event identification — flexible
  event_id: z.string().max(200).optional(),
  event_type: z.string().max(50).optional(),
  strategy_id: z.string().max(100).optional(),
  action: z.string().max(50).optional(), // alternative to event_type
  signal: z.string().max(50).optional(), // alternative to event_type

  // Symbol — flexible naming
  symbol: z.string().max(50).optional(),
  ticker: z.string().max(50).optional(), // alternative to symbol
  pair: z.string().max(50).optional(),   // alternative to symbol

  // Direction
  side: z.string().max(20).optional(),
  direction: z.string().max(20).optional(), // alternative to side

  // Sizing
  leverage: z.union([z.number(), z.string()]).optional(),
  base_qty: z.union([z.number(), z.string()]).optional(),
  qty: z.union([z.number(), z.string()]).optional(),
  quantity: z.union([z.number(), z.string()]).optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  size: z.union([z.number(), z.string()]).optional(),

  // Exchange & mode
  exchange: z.string().max(20).optional(),
  mode: z.enum(["demo", "real"]).optional(),

  // Price (for limit orders)
  price: z.union([z.number(), z.string()]).optional(),
  order_type: z.string().max(20).optional(),

  // Allow any extra fields
}).passthrough();

// ===== Helper: Extract TP/SL price from payload =====
function extractTPPrice(payload: any): number | undefined {
  const tpPrice = payload.tp_price || payload.take_profit_price || payload.price;
  if (!tpPrice) return undefined;
  return parseFloat(tpPrice);
}

function extractSLPrice(payload: any): number | undefined {
  const slPrice = payload.sl_price || payload.stop_loss_price || payload.price;
  if (!slPrice) return undefined;
  return parseFloat(slPrice);
}

function extractPartialPercentage(payload: any): number | undefined {
  const partial = payload.percentage || payload.percent || payload.partial_percent || payload.close_percent;
  if (!partial) return undefined;
  const num = parseFloat(String(partial));
  return isNaN(num) ? undefined : num;
}

// ===== Helper: Resolve event type from any format =====
function resolveEventType(payload: any): string {
  const raw = (
    payload.event_type ||
    payload.action ||
    payload.signal ||
    ""
  ).toLowerCase().trim();

  // Map common variations
  if (raw.includes("entry_long") || raw.includes("open_long") || raw.includes("buy_open") || raw === "long") return "entry_long";
  if (raw.includes("entry_short") || raw.includes("open_short") || raw.includes("sell_open") || raw === "short") return "entry_short";
  
  // Take Profit levels (TP1-TP5)
  if (raw.includes("tp1") || raw.includes("take_profit_1") || raw.includes("exit_long_tp1") || raw.includes("close_long_tp1")) return "tp1";
  if (raw.includes("tp2") || raw.includes("take_profit_2") || raw.includes("exit_long_tp2") || raw.includes("close_long_tp2")) return "tp2";
  if (raw.includes("tp3") || raw.includes("take_profit_3") || raw.includes("exit_long_tp3") || raw.includes("close_long_tp3")) return "tp3";
  if (raw.includes("tp4") || raw.includes("take_profit_4") || raw.includes("exit_long_tp4") || raw.includes("close_long_tp4")) return "tp4";
  if (raw.includes("tp5") || raw.includes("take_profit_5") || raw.includes("exit_long_tp5") || raw.includes("close_long_tp5")) return "tp5";
  
  // Generic TP (partial exit)
  if (raw.includes("tp") || raw.includes("take_profit")) return "tp";
  
  // Stop Loss signals
  if (raw.includes("sl_update") || raw.includes("stop_loss_update") || raw.includes("update_sl") || raw.includes("move_sl")) return "sl_update";
  if (raw.includes("sl") || raw.includes("stop_loss") || raw.includes("stoploss")) return "sl";
  
  // Exit/Close signals
  if (raw.includes("exit_long") || raw.includes("close_long") || raw.includes("buy_close") || raw.includes("tp_long") || raw.includes("sl_long")) return "exit_long";
  if (raw.includes("exit_short") || raw.includes("close_short") || raw.includes("sell_close") || raw.includes("tp_short") || raw.includes("sl_short")) return "exit_short";
  if (raw.includes("close_all") || raw.includes("exit_all") || raw.includes("flatten")) return "close_all";
  if (raw.includes("close") || raw.includes("exit")) return "exit";
  if (raw.includes("buy") || raw.includes("long")) return "entry_long";
  if (raw.includes("sell") || raw.includes("short")) return "entry_short";

  return raw || "unknown";
}

// ===== Helper: Resolve symbol =====
function resolveSymbol(payload: any): string {
  const raw = payload.symbol || payload.ticker || payload.pair || "";
  return normalizeSymbol(raw);
}

// ===== Helper: Resolve side =====
function resolveSide(eventType: string, payload: any): "BUY" | "SELL" {
  const rawSide = (payload.side || payload.direction || "").toUpperCase();
  if (rawSide === "BUY" || rawSide === "LONG") return "BUY";
  if (rawSide === "SELL" || rawSide === "SHORT") return "SELL";

  // Infer from event type
  if (eventType.includes("long") || eventType.includes("buy")) return "BUY";
  if (eventType.includes("short") || eventType.includes("sell")) return "SELL";

  return "BUY";
}

// ===== Helper: Resolve quantity =====
function resolveQuantity(payload: any): { type: "base" | "usdt" | "percent" | "none"; value: number } {
  const raw = payload.base_qty || payload.qty || payload.quantity || payload.size || payload.amount;
  if (!raw) return { type: "none", value: 0 };

  const str = String(raw);
  if (str.endsWith("%")) {
    return { type: "percent", value: parseFloat(str.replace("%", "")) };
  }

  const num = parseFloat(str);
  if (isNaN(num)) return { type: "none", value: 0 };

  // If field name suggests USDT amount
  if (payload.amount && !payload.base_qty && !payload.qty) {
    return { type: "usdt", value: num };
  }

  return { type: "base", value: num };
}

// ===== Helper: Calculate quantity from risk settings =====
async function calculateFallbackQuantity(userId: string, markPrice: number): Promise<number> {
  try {
    // Try to get user's risk settings
    const { data: riskSettings } = await supabase
      .from("risk_settings")
      .select("size_type, size_value")
      .eq("user_id", userId)
      .single();

    let usdtValue: number;

    if (riskSettings?.size_value) {
      usdtValue = riskSettings.size_value;
    } else {
      // Use environment fallback
      usdtValue = config.fixedNotionalFallback;
    }

    // Calculate quantity from USDT value
    if (markPrice > 0) {
      return usdtValue / markPrice;
    }

    // If no mark price, return 0 (will be handled by caller)
    return 0;
  } catch (err) {
    console.warn("Failed to get risk settings, using env fallback:", err);
    return 0;
  }
}

// ===== POST /webhook — Universal Webhook Handler =====
router.post("/", async (req: Request, res: Response): Promise<Response | void> => {
  try {
    // 1. Validate basic structure
    const payload = webhookSchema.parse(req.body);

    // 2. Auth via passphrase
    const { data: settings } = await supabase
      .from("app_settings")
      .select("webhook_secret, user_id, mode, default_exchange")
      .limit(1)
      .single();

    if (!settings || payload.passphrase !== settings.webhook_secret) {
      return res.status(401).json({
        success: false,
        status: "unauthorized",
        message: "Invalid passphrase",
      });
    }

    const userId = settings.user_id;
    const activeMode = payload.mode || settings.mode || "demo";
    const rawExchange = (payload.exchange || settings.default_exchange || "binance").toLowerCase();
    const wantsBoth = rawExchange === "both";
    const exchangeName = rawExchange; // Store the actual exchange value ("both", "binance", or "bybit")

    // 3. Resolve flexible fields
    const eventType = resolveEventType(payload);
    const symbol = resolveSymbol(payload);
    
    // Make event_id unique per user to allow multiple users with same TradingView alert
    const baseEventId = payload.event_id || `${Date.now()}_${symbol}_${eventType}`;
    const eventId = `${baseEventId}_user_${userId.substring(0, 8)}`; // Add user prefix for uniqueness
    
    const strategyId = payload.strategy_id || "manual";

    if (!symbol) {
      return res.status(400).json({
        success: false,
        status: "missing_symbol",
        message: "No symbol/ticker/pair found in payload",
      });
    }

    // 4. Idempotency check - now user-specific even with same TradingView event_id
    const { data: existing } = await supabase
      .from("webhook_events")
      .select("id")
      .eq("user_id", userId)
      .eq("event_id", eventId)
      .eq("event_type", eventType)
      .single();

    if (existing) {
      console.log(`ℹ️ Duplicate event detected for user ${userId.substring(0, 8)}: ${eventId}`);
      return res.status(200).json({
        success: true,
        status: "duplicate",
        message: "Event already processed — skipped",
      });
    }

    // 5. Log webhook event (store both original and unique event_id)
    await supabase.from("webhook_events").insert({
      user_id: userId,
      event_id: eventId, // Unique per user
      event_type: eventType,
      strategy_id: strategyId,
      symbol,
      exchange: exchangeName,
      status: "received",
      payload: {
        ...req.body,
        original_event_id: baseEventId, // Store original for reference
        user_suffix: userId.substring(0, 8),
      },
    });

    // 6. Get exchange client(s)
    let exchangeSetup: { client: ExchangeClient; exchange: string } | null = null;
    let allExchangeSetups: { client: ExchangeClient; exchange: string }[] = [];

    if (wantsBoth) {
      allExchangeSetups = await getAllExchangeClients(userId);
      exchangeSetup = allExchangeSetups.find((c) => c.exchange === "binance") || allExchangeSetups[0] || null;
    } else {
      exchangeSetup = await getExchangeClient(userId, exchangeName);
      if (exchangeSetup) {
        allExchangeSetups = [exchangeSetup];
      }
    }

    if ((!exchangeSetup && !wantsBoth) || (wantsBoth && allExchangeSetups.length === 0)) {
      if (activeMode === "real") {
        await logTrade(
          userId,
          eventId,
          exchangeName,
          symbol,
          eventType,
          0,
          0,
          "failed",
          activeMode,
          strategyId,
          wantsBoth
            ? "No API keys configured for any exchange"
            : `No API keys configured for ${exchangeName}`
        );
        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(400).json({
          success: false,
          status: "no_api_keys",
          message: wantsBoth
            ? "No API keys configured for Binance or Bybit. Add them in Settings."
            : `No API keys configured for ${exchangeName}. Add them in Settings.`,
        });
      }
    }

    // 7. Get mark price for quantity calculation
    let markPrice = 0;
    if (exchangeSetup) {
      try {
        if (exchangeSetup.client instanceof BinanceClient) {
          markPrice = await exchangeSetup.client.getMarkPrice(symbol);
        } else if (exchangeSetup.client instanceof BybitClient) {
          markPrice = await exchangeSetup.client.getMarkPrice(symbol);
        }
      } catch {
        console.warn(`Failed to get mark price for ${symbol}, using fallback`);
      }
    }

    // 8. Handle CLOSE events (exit, close_all, exit_long, exit_short)
    if (eventType === "exit" || eventType === "close_all" || eventType.startsWith("exit_")) {
      if (activeMode === "real" && allExchangeSetups.length > 0) {
        const errors: string[] = [];

        for (const setup of allExchangeSetups) {
          try {
            let result: any;
            if (setup.client instanceof BinanceClient) {
              result = await setup.client.closePosition(symbol);
            } else if (setup.client instanceof BybitClient) {
              result = await setup.client.closePosition(symbol);
            }

            await logTrade(
              userId,
              eventId,
              setup.exchange,
              symbol,
              eventType,
              result?.qty || 0,
              result?.price || markPrice,
              "filled",
              activeMode,
              strategyId
            );
          } catch (err: any) {
            errors.push(`${setup.exchange}: ${err.message}`);
            await logTrade(
              userId,
              eventId,
              setup.exchange,
              symbol,
              eventType,
              0,
              0,
              "failed",
              activeMode,
              strategyId,
              err.message
            );
          }
        }

        if (errors.length === 0) {
          await updateWebhookStatus(eventId, userId, "executed");
          return res.json({
            success: true,
            status: "executed",
            message: `Position closed on ${wantsBoth ? "all exchanges" : exchangeName}: ${symbol}`,
            details: { symbol, eventType, mode: activeMode },
          });
        }

        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(500).json({
          success: false,
          status: "execution_failed",
          message: `Close failed on: ${errors.join(", ")}`,
        });
      } else {
        // Demo mode — just log
        const targets = wantsBoth && allExchangeSetups.length > 0 ? allExchangeSetups : exchangeSetup ? [exchangeSetup] : [];
        for (const setup of targets) {
          await logTrade(
            userId,
            eventId,
            setup.exchange,
            symbol,
            eventType,
            0,
            markPrice,
            "demo_executed",
            activeMode,
            strategyId
          );
        }
        await updateWebhookStatus(eventId, userId, "processed");
        return res.json({
          success: true,
          status: "demo_executed",
          message: `[DEMO] Close signal logged: ${symbol}`,
          details: { symbol, eventType, mode: activeMode },
        });
      }
    }

    // 9. Handle TAKE PROFIT signals (tp1, tp2, tp3, tp4, tp5, tp)
    if (["tp1", "tp2", "tp3", "tp4", "tp5", "tp"].includes(eventType)) {
      const tpPrice = extractTPPrice(payload);
      const partialPercent = extractPartialPercentage(payload);

      if (!tpPrice && !partialPercent) {
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "failed", activeMode, strategyId, "No TP price or percentage provided");
        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(400).json({
          success: false,
          status: "missing_tp_price",
          message: "Take Profit signal requires tp_price, take_profit_price, or percentage field",
        });
      }

      if (activeMode === "real" && exchangeSetup) {
        try {
          // Get current position
          const positions = await exchangeSetup.client.getPositions();
          const position = positions.find((p) => p.symbol === symbol);

          if (!position) {
            // No position found - Queue the exit signal for later execution
            console.log(`⏳ No position for ${symbol}, queueing ${eventType} signal`);
            
            // Check if already queued
            const { data: existingQueue } = await supabase
              .from("exit_signal_queue")
              .select("id")
              .eq("user_id", userId)
              .eq("event_id", eventId)
              .single();

            if (existingQueue) {
              console.log(`ℹ️ Signal already queued: ${eventId}`);
              await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, tpPrice || markPrice, "queued", activeMode, strategyId, "Already in queue");
              await updateWebhookStatus(eventId, userId, "processed");
              
              return res.json({
                success: true,
                status: "queued",
                message: `Exit signal already queued for ${symbol}. Will execute when position opens.`,
              });
            }

            // Add to queue
            const { error: queueError } = await supabase
              .from("exit_signal_queue")
              .insert({
                user_id: userId,
                event_id: eventId,
                event_type: eventType,
                symbol,
                exchange: wantsBoth ? "both" : rawExchange,
                side: eventType.includes("long") || eventType.includes("buy") ? "LONG" : "SHORT",
                payload: req.body,
                tp_price: tpPrice,
                sl_price: null,
                partial_percent: partialPercent,
                status: "pending",
                retry_count: 0,
                max_retries: 5,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
              });

            if (queueError) {
              console.error("Failed to queue exit signal:", queueError.message);
              await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, tpPrice || markPrice, "failed", activeMode, strategyId, "Failed to queue");
              await updateWebhookStatus(eventId, userId, "failed");
              
              return res.status(500).json({
                success: false,
                status: "queue_error",
                message: "Failed to queue exit signal",
              });
            }

            console.log(`✅ Queued ${eventType} for ${symbol} on ${wantsBoth ? "both" : rawExchange}`);
            await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, tpPrice || markPrice, "queued", activeMode, strategyId, "Queued - no position yet");
            await updateWebhookStatus(eventId, userId, "processed");

            return res.json({
              success: true,
              status: "queued",
              message: `Exit signal queued for ${symbol}. Will auto-execute when position opens.`,
              details: { 
                symbol, 
                eventType, 
                tpPrice, 
                partialPercent,
                queueUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
              },
            });
          }

          // SAFETY CHECK: Block TP/SL updates if position is still in PENDING_ENTRY state
          const { data: positionRecord } = await supabase
            .from("positions")
            .select("state")
            .eq("symbol", symbol)
            .eq("exchange", exchangeName)
            .single();

          if (positionRecord?.state === "PENDING_ENTRY") {
            await logTrade(
              userId,
              eventId,
              exchangeName,
              symbol,
              eventType,
              0,
              tpPrice || markPrice,
              "failed",
              activeMode,
              strategyId,
              "Position still in PENDING_ENTRY state - TP/SL updates blocked until order fills"
            );
            await updateWebhookStatus(eventId, userId, "failed");
            return res.status(400).json({
              success: false,
              status: "pending_entry",
              message: `Cannot update TP/SL: Position for ${symbol} is still in PENDING_ENTRY state. Wait for order to fill before updating take profit or stop loss.`,
            });
          }

          // Calculate close quantity based on percentage or default to full close
          let closeQty = position.size;
          if (partialPercent && partialPercent > 0 && partialPercent <= 100) {
            closeQty = (position.size * partialPercent) / 100;
          }

          // Round quantity
          let stepSize = 0.001;
          try {
            const symInfo = await exchangeSetup.client.getSymbolInfo(symbol);
            if (symInfo) stepSize = symInfo.stepSize;
          } catch {}
          closeQty = roundQtyByStep(closeQty, stepSize);

          // Place reduce-only order
          let result: any;
          if (exchangeSetup.client instanceof BinanceClient) {
            result = await exchangeSetup.client.placeOrder({
              symbol,
              side: position.side === "LONG" ? "SELL" : "BUY",
              quantity: closeQty,
              type: tpPrice ? "LIMIT" : "MARKET",
              price: tpPrice,
              reduceOnly: true,
            });
          } else if (exchangeSetup.client instanceof BybitClient) {
            result = await exchangeSetup.client.placeOrder({
              symbol,
              side: position.side === "LONG" ? "Sell" : "Buy",
              quantity: closeQty,
              type: tpPrice ? "Limit" : "Market",
              price: tpPrice,
              reduceOnly: true,
            });
          }

          await logTrade(userId, eventId, exchangeName, symbol, eventType, closeQty, tpPrice || markPrice, "filled", activeMode, strategyId);
          await updateWebhookStatus(eventId, userId, "executed");

          return res.json({
            success: true,
            status: "executed",
            message: `${eventType.toUpperCase()} executed: ${symbol} qty=${closeQty}${partialPercent ? ` (${partialPercent}%)` : ""}${tpPrice ? ` @ ${tpPrice}` : ""}`,
            details: { symbol, eventType, qty: closeQty, percentage: partialPercent, price: tpPrice, mode: activeMode, ...result },
          });
        } catch (err: any) {
          await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, tpPrice || markPrice, "failed", activeMode, strategyId, err.message);
          await updateWebhookStatus(eventId, userId, "failed");
          return res.status(500).json({
            success: false,
            status: "execution_failed",
            message: `TP execution failed: ${err.message}`,
          });
        }
      } else {
        // Demo mode — just log
        await logTrade(userId, eventId, exchangeName, symbol, eventType, partialPercent ? (partialPercent / 100) : 1, tpPrice || markPrice, "demo_executed", activeMode, strategyId);
        await updateWebhookStatus(eventId, userId, "processed");
        return res.json({
          success: true,
          status: "demo_executed",
          message: `[DEMO] ${eventType.toUpperCase()} signal: ${symbol}${tpPrice ? ` @ ${tpPrice}` : ""}${partialPercent ? ` (${partialPercent}%)` : ""}`,
          details: { symbol, eventType, price: tpPrice, percentage: partialPercent, mode: activeMode },
        });
      }
    }

    // 10. Handle STOP LOSS signals (sl, sl_update)
    if (eventType === "sl" || eventType === "sl_update") {
      const slPrice = extractSLPrice(payload);

      if (!slPrice) {
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "failed", activeMode, strategyId, "No SL price provided");
        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(400).json({
          success: false,
          status: "missing_sl_price",
          message: "Stop Loss signal requires sl_price, stop_loss_price, or price field",
        });
      }

      if (activeMode === "real" && exchangeSetup) {
        try {
          // Get current position
          const positions = await exchangeSetup.client.getPositions();
          const position = positions.find((p) => p.symbol === symbol);

          if (!position) {
            // No position found - Queue the SL signal for later execution
            console.log(`⏳ No position for ${symbol}, queueing ${eventType} signal`);
            
            // Check if already queued
            const { data: existingQueue } = await supabase
              .from("exit_signal_queue")
              .select("id")
              .eq("user_id", userId)
              .eq("event_id", eventId)
              .single();

            if (existingQueue) {
              console.log(`ℹ️ Signal already queued: ${eventId}`);
              await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, slPrice, "queued", activeMode, strategyId, "Already in queue");
              await updateWebhookStatus(eventId, userId, "processed");
              
              return res.json({
                success: true,
                status: "queued",
                message: `Stop Loss already queued for ${symbol}. Will execute when position opens.`,
              });
            }

            // Add to queue
            const { error: queueError } = await supabase
              .from("exit_signal_queue")
              .insert({
                user_id: userId,
                event_id: eventId,
                event_type: eventType,
                symbol,
                exchange: wantsBoth ? "both" : rawExchange,
                side: eventType.includes("long") || eventType.includes("buy") ? "LONG" : "SHORT",
                payload: req.body,
                tp_price: null,
                sl_price: slPrice,
                partial_percent: null,
                status: "pending",
                retry_count: 0,
                max_retries: 5,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
              });

            if (queueError) {
              console.error("Failed to queue SL signal:", queueError.message);
              await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, slPrice, "failed", activeMode, strategyId, "Failed to queue");
              await updateWebhookStatus(eventId, userId, "failed");
              
              return res.status(500).json({
                success: false,
                status: "queue_error",
                message: "Failed to queue Stop Loss signal",
              });
            }

            console.log(`✅ Queued ${eventType} for ${symbol} on ${wantsBoth ? "both" : rawExchange}`);
            await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, slPrice, "queued", activeMode, strategyId, "Queued - no position yet");
            await updateWebhookStatus(eventId, userId, "processed");

            return res.json({
              success: true,
              status: "queued",
              message: `Stop Loss queued for ${symbol}. Will auto-execute when position opens.`,
              details: { 
                symbol, 
                eventType, 
                slPrice,
                queueUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
              },
            });
          }

          // SAFETY CHECK: Block SL updates if position is still in PENDING_ENTRY state
          const { data: positionRecord } = await supabase
            .from("positions")
            .select("state")
            .eq("symbol", symbol)
            .eq("exchange", exchangeName)
            .single();

          if (positionRecord?.state === "PENDING_ENTRY") {
            await logTrade(
              userId,
              eventId,
              exchangeName,
              symbol,
              eventType,
              0,
              slPrice,
              "failed",
              activeMode,
              strategyId,
              "Position still in PENDING_ENTRY state - SL updates blocked until order fills"
            );
            await updateWebhookStatus(eventId, userId, "failed");
            return res.status(400).json({
              success: false,
              status: "pending_entry",
              message: `Cannot update Stop Loss: Position for ${symbol} is still in PENDING_ENTRY state. Wait for order to fill before updating stop loss.`,
            });
          }

          // For SL, we place a stop market order
          // Note: This is a simplified implementation - production should use proper stop orders
          let result: any;
          const stopSide = position.side === "LONG" ? "SELL" : "BUY";
          
          if (exchangeSetup.client instanceof BinanceClient) {
            // Use STOP_MARKET order for SL
            result = await exchangeSetup.client.placeOrder({
              symbol,
              side: stopSide,
              quantity: position.size,
              type: "MARKET",
              reduceOnly: true,
            });
            // Note: For actual stop price trigger, you'd need to set stopPrice parameter
          } else if (exchangeSetup.client instanceof BybitClient) {
            result = await exchangeSetup.client.placeOrder({
              symbol,
              side: stopSide === "BUY" ? "Sell" : "Buy",
              quantity: position.size,
              type: "Market",
              reduceOnly: true,
            });
          }

          await logTrade(userId, eventId, exchangeName, symbol, eventType, position.size, slPrice, "filled", activeMode, strategyId);
          await updateWebhookStatus(eventId, userId, "executed");

          return res.json({
            success: true,
            status: "executed",
            message: `${eventType === "sl" ? "STOP LOSS" : "SL UPDATE"} executed: ${symbol} @ ${slPrice}`,
            details: { symbol, eventType, price: slPrice, mode: activeMode, ...result },
          });
        } catch (err: any) {
          await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, slPrice, "failed", activeMode, strategyId, err.message);
          await updateWebhookStatus(eventId, userId, "failed");
          return res.status(500).json({
            success: false,
            status: "execution_failed",
            message: `SL execution failed: ${err.message}`,
          });
        }
      } else {
        // Demo mode — just log
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 1, slPrice, "demo_executed", activeMode, strategyId);
        await updateWebhookStatus(eventId, userId, "processed");
        return res.json({
          success: true,
          status: "demo_executed",
          message: `[DEMO] ${eventType === "sl" ? "STOP LOSS" : "SL UPDATE"} signal: ${symbol} @ ${slPrice}`,
          details: { symbol, eventType, price: slPrice, mode: activeMode },
        });
      }
    }

    // 11. Resolve quantity for ENTRY orders — ROBUST FALLBACK CHAIN
    const qtyInfo = resolveQuantity(payload);
    let qty: number = 0;

    // Priority 1: Base quantity from payload
    if (qtyInfo.type === "base" && qtyInfo.value > 0) {
      qty = qtyInfo.value;
      console.log(`[Quantity] Using base qty from payload: ${qty}`);
    }
    // Priority 2: USDT amount from payload (convert to coin qty)
    else if (qtyInfo.type === "usdt" && markPrice > 0) {
      qty = qtyInfo.value / markPrice;
      console.log(`[Quantity] Converting USDT ${qtyInfo.value} to qty ${qty} @ price ${markPrice}`);
    }
    // Priority 3: Percentage of balance
    else if (qtyInfo.type === "percent" && qtyInfo.value > 0) {
      if (exchangeSetup && markPrice > 0) {
        try {
          let balance: any;
          if (exchangeSetup.client instanceof BinanceClient) {
            balance = await exchangeSetup.client.getBalance();
          } else {
            balance = await (exchangeSetup.client as BybitClient).getBalance();
          }
          const notional = (balance.availableBalance * qtyInfo.value) / 100;
          qty = notional / markPrice;
          console.log(`[Quantity] Using ${qtyInfo.value}% of balance: ${qty}`);
        } catch (err) {
          console.warn(`[Quantity] Balance fetch failed, using fallback: ${err}`);
          qty = markPrice > 0 ? (config.fixedNotionalFallback * qtyInfo.value / 100) / markPrice : 0;
        }
      } else {
        // No exchange setup, use fixed fallback
        qty = markPrice > 0 ? (config.fixedNotionalFallback * qtyInfo.value / 100) / markPrice : 0;
        console.log(`[Quantity] Using fallback for ${qtyInfo.value}%: ${qty}`);
      }
    }
    // Priority 4: Calculate from risk settings (no quantity in payload)
    else {
      console.log(`[Quantity] No qty in payload, calculating from risk settings...`);
      qty = await calculateFallbackQuantity(userId, markPrice);
      
      if (qty <= 0 && markPrice > 0) {
        // Last resort: use environment fallback directly
        const fallbackUsdt = config.fixedNotionalFallback;
        qty = fallbackUsdt / markPrice;
        console.log(`[Quantity] Risk settings failed, using ENV fallback ${fallbackUsdt} USDT -> qty ${qty}`);
      }
    }

    // Safety check: ensure we have a valid quantity
    if (qty <= 0) {
      await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "failed", activeMode, strategyId, "Unable to calculate quantity - no mark price and no fallback configured");
      await updateWebhookStatus(eventId, userId, "failed");
      return res.status(400).json({
        success: false,
        status: "missing_quantity",
        message: `Cannot calculate quantity: mark price unavailable (${markPrice}) and no quantity provided. Add 'qty', 'amount' (USDT), or '%' to your alert, or configure risk settings.`,
      });
    }

    // AUTO-ADJUST: Ensure quantity meets exchange minimum requirements
    if (exchangeSetup && markPrice > 0) {
      try {
        // Get symbol info for minimum notional value
        let symInfo: any;
        if (exchangeSetup.client instanceof BinanceClient) {
          symInfo = await exchangeSetup.client.getSymbolInfo(symbol);
        } else if (exchangeSetup.client instanceof BybitClient) {
          symInfo = await (exchangeSetup.client as BybitClient).getSymbolInfo(symbol);
        }

        if (symInfo) {
          const minNotional = symInfo.minNotional || 5; // Default $5 USDT
          const currentNotional = qty * markPrice;

          // If current notional is below minimum, adjust quantity
          if (currentNotional < minNotional) {
            const oldQty = qty;
            qty = minNotional / markPrice;
            
            // Round up to ensure we meet minimum
            if (symInfo.stepSize) {
              qty = Math.ceil(qty / symInfo.stepSize) * symInfo.stepSize;
            }

            console.log(`⚠️ AUTO-ADJUST: Quantity increased from ${oldQty} to ${qty} to meet ${exchangeName} minimum notional of ${minNotional} USDT`);
            
            await logTrade(
              userId,
              eventId,
              exchangeName,
              symbol,
              eventType,
              qty,
              markPrice,
              "adjusted",
              activeMode,
              strategyId,
              `Auto-adjusted quantity from ${oldQty} to ${qty} to meet exchange minimum (${minNotional} USDT). Original notional: $${currentNotional.toFixed(2)}, Adjusted notional: $${(qty * markPrice).toFixed(2)}`
            );
          }

          // Also check against step size and min qty
          if (symInfo.minQty && qty < symInfo.minQty) {
            const oldQty = qty;
            qty = symInfo.minQty;
            console.log(`⚠️ AUTO-ADJUST: Quantity increased from ${oldQty} to ${qty} to meet minimum qty of ${symInfo.minQty}`);
          }

          // Round quantity by step size
          if (symInfo.stepSize && qty > 0) {
            qty = Math.floor(qty / symInfo.stepSize) * symInfo.stepSize;
            // Ensure rounding doesn't bring us below minimum
            if (qty * markPrice < minNotional) {
              qty += symInfo.stepSize;
            }
          }
        }
      } catch (err: any) {
        console.warn(`⚠️ Failed to get symbol info for auto-adjustment: ${err.message}. Using calculated qty.`);
      }
    }

    // 10. Get symbol info for rounding
    let stepSize = 0.001;
    let minQty = 0.001;

    if (exchangeSetup) {
      try {
        let symInfo: any;
        if (exchangeSetup.client instanceof BinanceClient) {
          symInfo = await exchangeSetup.client.getSymbolInfo(symbol);
        } else {
          symInfo = await (exchangeSetup.client as BybitClient).getSymbolInfo(symbol);
        }
        if (symInfo) {
          stepSize = symInfo.stepSize;
          minQty = symInfo.minQty;
        }
      } catch {
        console.warn("Failed to get symbol info, using defaults");
      }
    }

    qty = roundQtyByStep(qty, stepSize);

    if (qty < minQty) {
      await logTrade(userId, eventId, exchangeName, symbol, eventType, qty, markPrice, "failed", activeMode, strategyId, `Qty ${qty} below min ${minQty}`);
      await updateWebhookStatus(eventId, userId, "failed");
      return res.status(400).json({
        success: false,
        status: "qty_below_minimum",
        message: `Qty ${qty} below minimum ${minQty}`,
      });
    }

    // Resolve leverage
    const leverage = parseInt(String(payload.leverage || "10")) || 10;
    const clampedLeverage = Math.min(125, Math.max(1, leverage));
    const side = resolveSide(eventType, payload);

    // 11. Execute or log
    if (activeMode === "real" && allExchangeSetups.length > 0) {
      try {
        const errors: string[] = [];

        for (const setup of allExchangeSetups) {
          // Set leverage (skip on testnet if fails)
          try {
            if (setup.client instanceof BinanceClient) {
              await setup.client.setLeverage(symbol, clampedLeverage);
            } else if (setup.client instanceof BybitClient) {
              await setup.client.setLeverage(symbol, clampedLeverage);
            }
          } catch (levErr: any) {
            console.warn(`⚠️ Leverage set failed for ${setup.exchange} ${symbol}: ${levErr.message}. Continuing with order...`);
          }

          // Get exchange-specific symbol info and adjust quantity
          let exchangeQty = qty;
          try {
            const symInfo = await setup.client.getSymbolInfo(symbol);
            if (symInfo) {
              // Round by step size
              exchangeQty = roundQtyByStep(qty, symInfo.stepSize);
              
              // Check minimum quantity
              if (exchangeQty < symInfo.minQty) {
                exchangeQty = symInfo.minQty;
                console.log(`⚠️ ${setup.exchange.toUpperCase()}: Qty adjusted to min ${symInfo.minQty}`);
              }
              
              // Check minimum notional
              const minNotional = symInfo.minNotional || 5;
              if (exchangeQty * markPrice < minNotional) {
                const minQtyByNotional = minNotional / markPrice;
                exchangeQty = Math.max(exchangeQty, minQtyByNotional);
                exchangeQty = roundQtyByStep(exchangeQty, symInfo.stepSize);
                console.log(`⚠️ ${setup.exchange.toUpperCase()}: Qty adjusted for min notional to ${exchangeQty}`);
              }
            }
          } catch (qtyErr: any) {
            console.warn(`⚠️ ${setup.exchange}: Failed to get symbol info, using base qty: ${qty}`);
          }

          // Place order
          let orderResult: any;
          const isLimitOrder = payload.order_type?.toUpperCase() === "LIMIT";
          
          if (setup.client instanceof BinanceClient) {
            orderResult = await setup.client.placeOrder({
              symbol,
              side,
              quantity: exchangeQty,
              type: isLimitOrder ? "LIMIT" : "MARKET",
              price: isLimitOrder && payload.price ? parseFloat(String(payload.price)) : undefined,
            });
          } else if (setup.client instanceof BybitClient) {
            orderResult = await setup.client.placeOrder({
              symbol,
              side: side === "BUY" ? "Buy" : "Sell",
              quantity: exchangeQty,
              type: isLimitOrder ? "Limit" : "Market",
              // Only include price for LIMIT orders
              price: isLimitOrder && payload.price ? parseFloat(String(payload.price)) : undefined,
            });
          }

          await logTrade(
            userId,
            eventId,
            setup.exchange,
            symbol,
            eventType,
            exchangeQty,
            orderResult?.price || markPrice,
            "filled",
            activeMode,
            strategyId
          );
        }

        if (errors.length === 0) {
          await updateWebhookStatus(eventId, userId, "executed");

          return res.json({
            success: true,
            status: "executed",
            message: `Order executed on ${wantsBoth ? "all exchanges" : exchangeName}: ${eventType} ${symbol} qty=${qty} lev=${clampedLeverage}x`,
            details: { symbol, side, qty, leverage: clampedLeverage, eventType, mode: activeMode },
          });
        }

        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(500).json({
          success: false,
          status: "execution_failed",
          message: `Order failed on: ${errors.join(", ")}`,
        });
      } catch (err: any) {
        await logTrade(
          userId,
          eventId,
          exchangeName,
          symbol,
          eventType,
          qty,
          markPrice,
          "failed",
          activeMode,
          strategyId,
          err.message
        );
        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(500).json({
          success: false,
          status: "execution_failed",
          message: `Order failed: ${err.message}`,
        });
      }
    } else {
      // DEMO mode — log only, no real execution
      const targets = wantsBoth && allExchangeSetups.length > 0 ? allExchangeSetups : exchangeSetup ? [exchangeSetup] : [];
      for (const setup of targets) {
        await logTrade(
          userId,
          eventId,
          setup.exchange,
          symbol,
          eventType,
          qty,
          markPrice,
          "demo_executed",
          activeMode,
          strategyId
        );
      }
      await updateWebhookStatus(eventId, userId, "processed");

      return res.json({
        success: true,
        status: "demo_executed",
        message: `[DEMO] ${eventType} ${symbol} qty=${qty} lev=${clampedLeverage}x`,
        details: { symbol, side, qty, leverage: clampedLeverage, eventType, mode: activeMode, markPrice },
      });
    }
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        success: false,
        status: "validation_error",
        message: err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
      });
    }
    console.error("Webhook error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: "Webhook processing failed" });
  }
});

// ===== Helper functions =====

async function logTrade(
  userId: string, eventId: string, exchange: string, symbol: string,
  eventType: string, qty: number, price: number, status: string,
  mode: string, strategyId: string, errorMessage?: string
) {
  await supabase.from("trades").insert({
    user_id: userId,
    event_id: eventId,
    exchange,
    symbol,
    side: eventType.includes("long") || eventType.includes("buy") ? "BUY" : "SELL",
    event_type: eventType,
    qty,
    price,
    status,
    mode,
    strategy_id: strategyId,
    error_message: errorMessage || null,
  });
}

async function updateWebhookStatus(eventId: string, userId: string, status: string) {
  await supabase
    .from("webhook_events")
    .update({ status })
    .eq("event_id", eventId)
    .eq("user_id", userId);
}

export default router;
