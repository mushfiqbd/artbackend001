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
  let baseEventId: string | undefined;
  
  try {
    // 1. Validate basic structure
    const payload = webhookSchema.parse(req.body);

    // 2. Auth via passphrase — Support MULTIPLE users with same secret!
    const { data: allSettings } = await supabase
      .from("app_settings")
      .select("webhook_secret, user_id, mode, default_exchange")
      .eq("webhook_secret", payload.passphrase);

    if (!allSettings || allSettings.length === 0) {
      return res.status(401).json({
        success: false,
        status: "unauthorized",
        message: "Invalid passphrase",
      });
    }

    console.log(`🔑 Webhook authenticated for ${allSettings.length} user(s) with this secret`);

    // 2.5 Resolve flexible fields BEFORE distributed lock
    const eventType = resolveEventType(payload);
    const symbol = resolveSymbol(payload);

    // 3. Distributed lock - Prevent duplicate processing across multiple instances
     // 3. Distributed lock - Prevent duplicate processing across multiple instances
     baseEventId = payload.event_id || `${Date.now()}_${symbol || 'unknown'}_${eventType}`;
    const lockKey = `webhook_lock_${baseEventId}`;
    
    try {
      // Try to acquire lock (expires after 30 seconds)
      const { data: lockData, error: lockError } = await supabase.rpc('try_acquire_webhook_lock', {
        p_lock_key: lockKey,
        p_instance_id: process.env.HOSTNAME || 'local',
        p_ttl_seconds: 30
      });
      
      if (lockError || !lockData) {
        console.log(`⚠️ Webhook already being processed by another instance, skipping: ${baseEventId}`);
        return res.status(200).json({
          success: true,
          status: "already_processing",
          message: "Webhook already being processed by another instance"
        });
      }
      
      console.log(`✅ Acquired distributed lock for webhook: ${baseEventId}`);
    } catch (err: any) {
      console.warn(`⚠️ Failed to acquire distributed lock: ${err.message}. Proceeding anyway...`);
      // Don't block - just proceed without locking
    }

    // Process webhook for EACH user with this secret
    const userResults = [];
    
    for (const settings of allSettings) {
      try {
        const userId = settings.user_id;
        const userPrefix = `[User: ${userId.substring(0, 8)}]`;
        
        console.log(`${userPrefix} 🚀 Starting processing...`);
        console.log(`${userPrefix} Mode: ${settings.mode}, Exchange: ${settings.default_exchange}`);
        
        const activeMode = payload.mode || settings.mode || "demo";
        const rawExchange = (payload.exchange || settings.default_exchange || "binance").toLowerCase();
        const wantsBoth = rawExchange === "both";
        const exchangeName = rawExchange;
        
        // Make event_id unique per user to allow multiple users with same TradingView alert
        const baseEventId = payload.event_id || `${Date.now()}_${symbol}_${eventType}`;
        const eventId = `${baseEventId}_user_${userId.substring(0, 8)}`;
        
        const strategyId = payload.strategy_id || 
                           payload.strategy_name || 
                           payload.strategy_order_id ||
                           payload.alert_id ||
                           (payload.strategy && typeof payload.strategy === 'object' && 'order' in payload.strategy && payload.strategy.order && typeof payload.strategy.order === 'object' && 'id' in payload.strategy.order ? (payload.strategy.order as any).id : null) ||
                           (payload.strategy && typeof payload.strategy === 'object' && 'name' in payload.strategy ? (payload.strategy as any).name : null) ||
                           "manual";
            
        // Log if using fallback "manual"
        if (strategyId === "manual") {
          console.log(`${userPrefix} ⚠️ No strategy_id in webhook, using "manual". Send 'strategy_id' field from TradingView.`);
        }

        if (!symbol) {
          console.error(`${userPrefix} ❌ Missing symbol`);
          userResults.push({
            userId: userId.substring(0, 8),
            success: false,
            status: "missing_symbol",
            message: "No symbol/ticker/pair found in payload"
          });
          continue;
        }

        // 4. Idempotency check
        const { data: existing } = await supabase
          .from("webhook_events")
          .select("id")
          .eq("user_id", userId)
          .eq("event_id", eventId)
          .eq("event_type", eventType)
          .single();

        if (existing) {
          console.log(`${userPrefix} ℹ️ Duplicate event detected: ${eventId}`);
          userResults.push({
            userId: userId.substring(0, 8),
            success: true,
            status: "duplicate",
            message: "Event already processed"
          });
          continue;
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
          // No API keys configured - queue the signal regardless of mode
          console.log(`${userPrefix} ⏳ No API keys configured, queueing ${eventType} signal`);
        
        // Check if already queued
        const { data: existingQueue } = await supabase
          .from("exit_signal_queue")
          .select("id")
          .eq("user_id", userId)
          .eq("event_id", eventId)
          .single();

        if (existingQueue) {
          console.log(`${userPrefix} ℹ️ Signal already queued: ${eventId}`);
          await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, 0, "queued", activeMode, strategyId, "Already queued - waiting for API keys");
          await updateWebhookStatus(eventId, userId, "processed");
          
          userResults.push({
            userId: userId.substring(0, 8),
            success: true,
            status: "queued",
            message: `Signal queued for ${symbol}. Will execute when API keys are configured.`
          });
          continue;
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
            tp_price: extractTPPrice(req.body),
            sl_price: extractSLPrice(req.body),
            partial_percent: extractPartialPercentage(req.body),
            status: "pending",
            retry_count: 0,
            max_retries: 10,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          });

        if (queueError) {
          console.error(`${userPrefix} ❌ Failed to queue signal:`, queueError.message);
          userResults.push({
            userId: userId.substring(0, 8),
            success: false,
            status: "queue_error",
            message: queueError.message
          });
          continue;
        }

        console.log(`${userPrefix} ✅ Queued ${eventType} for ${symbol}`);
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, 0, "queued", activeMode, strategyId, "Queued - waiting for API keys");
        await updateWebhookStatus(eventId, userId, "processed");

        userResults.push({
          userId: userId.substring(0, 8),
          success: true,
          status: "queued",
          message: `Signal queued for ${symbol}`
        });
        continue;
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
      // First check if we have API keys
      if (allExchangeSetups.length > 0) {
        // Check if position exists on any exchange before attempting close
        let positionExists = false;
        for (const setup of allExchangeSetups) {
          try {
            const positions = await setup.client.getPositions();
            if (positions.some((p) => p.symbol === symbol)) {
              positionExists = true;
              break;
            }
          } catch (err: any) {
            console.warn(`Failed to check positions on ${setup.exchange}: ${err.message}`);
          }
        }

        if (!positionExists) {
          // No position found - add a small delay and retry once (handles API latency after entry orders)
          console.log(`⏳ No position for ${symbol}, waiting 5s before queueing...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          
          // Retry position check
          let retryPositionExists = false;
          for (const setup of allExchangeSetups) {
            try {
              const positions = await setup.client.getPositions();
              if (positions.some((p) => p.symbol === symbol)) {
                retryPositionExists = true;
                console.log(`✅ Position found on ${setup.exchange} after retry!`);
                break;
              }
            } catch (err: any) {
              console.warn(`Failed to check positions on ${setup.exchange}: ${err.message}`);
            }
          }
          
          if (!retryPositionExists) {
            // Still no position - queue the exit signal
            console.log(`⏳ No position for ${symbol} after retry, queueing ${eventType} signal`);
          
          // Check if already queued
          const { data: existingQueue } = await supabase
            .from("exit_signal_queue")
            .select("id")
            .eq("user_id", userId)
            .eq("event_id", eventId)
            .single();

          if (existingQueue) {
            console.log(`ℹ️ Signal already queued: ${eventId}`);
            await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "queued", activeMode, strategyId, "Already queued - waiting for position");
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
              tp_price: extractTPPrice(req.body),
              sl_price: extractSLPrice(req.body),
              partial_percent: extractPartialPercentage(req.body),
              status: "pending",
              retry_count: 0,
              max_retries: 10,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
            });

          if (queueError) {
            console.error("Failed to queue exit signal:", queueError.message);
            await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "failed", activeMode, strategyId, "Failed to queue");
            await updateWebhookStatus(eventId, userId, "failed");
            
            return res.status(500).json({
              success: false,
              status: "queue_error",
              message: "Failed to queue exit signal",
            });
          }

          console.log(`✅ Queued ${eventType} for ${symbol} on ${wantsBoth ? "both" : rawExchange}`);
          await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "queued", activeMode, strategyId, "Queued - no position found");
          await updateWebhookStatus(eventId, userId, "processed");

          return res.json({
            success: true,
            status: "queued",
            message: `Exit signal queued for ${symbol}. Will auto-execute when position opens.`,
            details: { 
              symbol, 
              eventType, 
              queueUntil: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
            },
          });
          } // End of if (!retryPositionExists)
        } // End of if (!positionExists)

        // Position exists - proceed with close
        const errors: string[] = [];
        
        // Get the position side for logging
        let positionSide: string | undefined;
        for (const setup of allExchangeSetups) {
          try {
            const positions = await setup.client.getPositions();
            const pos = positions.find((p) => p.symbol === symbol);
            if (pos) {
              positionSide = pos.side;
              break;
            }
          } catch (err: any) {
            console.warn(`Failed to get position side on ${setup.exchange}: ${err.message}`);
          }
        }

        for (const setup of allExchangeSetups) {
          try {
            // Check if position exists on THIS specific exchange before trying to close
            const positions = await setup.client.getPositions();
            const pos = positions.find((p) => p.symbol === symbol);
            
            if (!pos) {
              // No position on this exchange - skip and mark as ignored
              console.log(`ℹ️ ${setup.exchange.toUpperCase()}: No position for ${symbol}, skipping close`);
              errors.push(`${setup.exchange}: No open position for ${symbol} (IGNORED)`);
              continue; // Skip to next exchange
            }
            
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
              strategyId,
              undefined,
              positionSide
            );

            // Update position state in database to CLOSED
            const { data: dbPosition } = await supabase
              .from("positions")
              .select("id")
              .eq("symbol", symbol)
              .eq("exchange", setup.exchange)
              .eq("user_id", userId)
              .single();

            if (dbPosition) {
              await supabase
                .from("positions")
                .update({
                  state: "CLOSED",
                  close_reason: eventType === "tp1" || eventType === "tp2" || eventType === "tp3" || eventType === "tp4" || eventType === "tp5" || eventType === "tp" ? "take_profit" 
                             : eventType === "sl" ? "stop_loss" 
                             : "close_signal",
                  updated_at: new Date().toISOString()
                })
                .eq("id", dbPosition.id);
              
              console.log(`💾 ${setup.exchange.toUpperCase()}: Updated position state to CLOSED for ${symbol}`);
            } else {
              console.warn(`⚠️ ${setup.exchange.toUpperCase()}: No matching position record found in DB for ${symbol}`);
            }
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
              err.message,
              positionSide
            );
          }
        }

        // Separate actual errors from IGNORED (no position) cases
        const actualErrors = errors.filter(e => !e.includes("(IGNORED)"));
        const ignoredExchanges = errors.filter(e => e.includes("(IGNORED)"));
        
        if (actualErrors.length === 0) {
          // Success or partial success
          const status = ignoredExchanges.length > 0 && ignoredExchanges.length < allExchangeSetups.length ? "partially_executed" : "executed";
          const message = ignoredExchanges.length > 0 
            ? `Position closed on ${allExchangeSetups.length - ignoredExchanges.length}/${allExchangeSetups.length} exchanges. ${ignoredExchanges.length} exchange(s) had no position.`
            : `Position closed on ${wantsBoth ? "all exchanges" : exchangeName}: ${symbol}`;
          
          await updateWebhookStatus(eventId, userId, status === "executed" ? "executed" : "processed");
          return res.json({
            success: true,
            status: status,
            message: message,
            details: { symbol, eventType, mode: activeMode, ignoredCount: ignoredExchanges.length },
          });
        }

        // Real errors occurred
        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(500).json({
          success: false,
          status: "execution_failed",
          message: `Close failed on: ${actualErrors.join(", ")}`,
        });
      } else {
        // No API keys - queue the signal
        console.log(`⏳ No API keys configured, queueing ${eventType} signal`);
        
        // Check if already queued
        const { data: existingQueue } = await supabase
          .from("exit_signal_queue")
          .select("id")
          .eq("user_id", userId)
          .eq("event_id", eventId)
          .single();

        if (existingQueue) {
          console.log(`ℹ️ Signal already queued: ${eventId}`);
          await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "queued", activeMode, strategyId, "Already queued - waiting for API keys");
          await updateWebhookStatus(eventId, userId, "processed");
          
          return res.json({
            success: true,
            status: "queued",
            message: `Signal queued for ${symbol}. Will execute when API keys are configured.`,
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
            tp_price: extractTPPrice(req.body),
            sl_price: extractSLPrice(req.body),
            partial_percent: extractPartialPercentage(req.body),
            status: "pending",
            retry_count: 0,
            max_retries: 10,
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          });

        if (queueError) {
          console.error("Failed to queue signal:", queueError.message);
          await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "failed", activeMode, strategyId, "Failed to queue");
          await updateWebhookStatus(eventId, userId, "failed");
          
          return res.status(500).json({
            success: false,
            status: "queue_error",
            message: "Failed to queue signal",
          });
        }

        console.log(`✅ Queued ${eventType} for ${symbol} on ${wantsBoth ? "both" : rawExchange}`);
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "queued", activeMode, strategyId, "Queued - waiting for API keys");
        await updateWebhookStatus(eventId, userId, "processed");

        return res.json({
          success: true,
          status: "queued",
          message: `Signal queued for ${symbol}. Configure API keys to auto-execute.`,
          details: { 
            symbol, 
            eventType, 
            queueUntil: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
          },
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

      if (exchangeSetup) {
        try {
          // Get current position
          const positions = await exchangeSetup.client.getPositions();
          const position = positions.find((p) => p.symbol === symbol);

          if (!position) {
            // No position found - add a small delay and retry once (handles API latency after entry orders)
            console.log(`⏳ No position for ${symbol}, waiting 5s before queueing...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Retry position check
            const retryPositions = await exchangeSetup.client.getPositions();
            const retryPosition = retryPositions.find((p) => p.symbol === symbol);
            
            if (!retryPosition) {
              // Still no position - Queue the exit signal for later execution
              console.log(`⏳ No position for ${symbol} after retry, queueing ${eventType} signal`);
            
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
          } // End of if (!retryPosition)
          } // End of if (!position)

          // SAFETY CHECK: Block TP/SL updates if position is still in PENDING_ENTRY state
          const { data: positionRecord } = await supabase
            .from("positions")
            .select("state")
            .eq("symbol", symbol)
            .eq("exchange", exchangeName)
            .single();

          if (positionRecord?.state === "PENDING_ENTRY") {
            // Queue the TP/SL signal for later execution when position fills
            console.log(`⏳ Position in PENDING_ENTRY, queueing ${eventType} signal`);
            
            // Check if already queued
            const { data: existingQueue } = await supabase
              .from("exit_signal_queue")
              .select("id")
              .eq("user_id", userId)
              .eq("event_id", eventId)
              .single();

            if (existingQueue) {
              console.log(`ℹ️ Signal already queued: ${eventId}`);
              await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, tpPrice || markPrice, "queued", activeMode, strategyId, "Already queued - waiting for position to fill");
              await updateWebhookStatus(eventId, userId, "processed");
              
              return res.json({
                success: true,
                status: "queued",
                message: `TP/SL signal queued for ${symbol}. Will execute when position fills from PENDING_ENTRY state.`,
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
              console.error("Failed to queue TP/SL signal:", queueError.message);
              await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, tpPrice || markPrice, "failed", activeMode, strategyId, "Failed to queue");
              await updateWebhookStatus(eventId, userId, "failed");
              
              return res.status(500).json({
                success: false,
                status: "queue_error",
                message: "Failed to queue TP/SL signal",
              });
            }

            console.log(`✅ Queued ${eventType} for ${symbol} on ${wantsBoth ? "both" : rawExchange}`);
            await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, tpPrice || markPrice, "queued", activeMode, strategyId, "Queued - waiting for position to fill from PENDING_ENTRY");
            await updateWebhookStatus(eventId, userId, "processed");

            return res.json({
              success: true,
              status: "queued",
              message: `TP/SL signal queued for ${symbol}. Will auto-execute when position fills.`,
              details: { 
                symbol, 
                eventType, 
                tpPrice,
                partialPercent,
                queueUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
              },
            });
          }

          // Calculate close quantity based on percentage or default based on TP level
          let closeQty = position.size;
          
          // Default percentages for TP levels if no percentage provided
          let defaultPercent = null;
          if (!partialPercent) {
            if (eventType === "tp1") defaultPercent = 25;   // TP1 = 25% default
            else if (eventType === "tp2") defaultPercent = 50; // TP2 = 50% default
            else if (eventType === "tp3") defaultPercent = 75; // TP3 = 75% default
            else if (eventType === "tp4") defaultPercent = 90; // TP4 = 90% default
            else if (eventType === "tp5") defaultPercent = 100; // TP5 = 100% default
          }
          
          const effectivePercent = partialPercent || defaultPercent;
          
          if (effectivePercent && effectivePercent > 0 && effectivePercent <= 100) {
            closeQty = (position.size * effectivePercent) / 100;
          }

          // Round quantity and validate minimum
          let stepSize = 0.001;
          let minQty = 0.001;
          try {
            const symInfo = await exchangeSetup.client.getSymbolInfo(symbol);
            if (symInfo) {
              stepSize = symInfo.stepSize;
              minQty = symInfo.minQty || 0.001;
            }
          } catch {}
          closeQty = roundQtyByStep(closeQty, stepSize);
          
          // Ensure closeQty doesn't exceed position size
          if (closeQty > position.size) {
            console.log(`⚠️ Close qty ${closeQty} exceeds position ${position.size}, using position size`);
            closeQty = position.size;
          }
          
          // Ensure minimum quantity
          if (closeQty < minQty) {
            console.log(`⚠️ Close qty ${closeQty} below minimum ${minQty}, adjusting to minimum`);
            closeQty = Math.max(minQty, position.size); // Use position size if smaller than min
          }
          
          // If position is smaller than minimum, close entire position (exchange will accept it)
          if (position.size > 0 && position.size < minQty) {
            console.log(`⚠️ Position size ${position.size} below minimum ${minQty}, closing entire position`);
            closeQty = position.size;
          }

          // Place reduce-only order - FORCE MARKET for better fill rate
          let result: any;
          const forceMarket = true; // Always use MARKET for TP/SL to avoid price validation errors
          
          if (exchangeSetup.client instanceof BinanceClient) {
            result = await exchangeSetup.client.placeOrder({
              symbol,
              side: position.side === "LONG" ? "SELL" : "BUY",
              quantity: closeQty,
              type: forceMarket ? "MARKET" : (tpPrice ? "LIMIT" : "MARKET"),
              price: forceMarket ? undefined : tpPrice,
              reduceOnly: true,
            });
          } else if (exchangeSetup.client instanceof BybitClient) {
            result = await exchangeSetup.client.placeOrder({
              symbol,
              side: position.side === "LONG" ? "Sell" : "Buy",
              quantity: closeQty,
              type: forceMarket ? "Market" : (tpPrice ? "Limit" : "Market"),
              price: forceMarket ? undefined : tpPrice,
              reduceOnly: true,
            });
          }

          await logTrade(userId, eventId, exchangeName, symbol, eventType, closeQty, tpPrice || markPrice, "filled", activeMode, strategyId, undefined, position.side);
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
        // No API keys configured - queue the TP/SL signal
        console.log(`⏳ No API keys configured, queueing ${eventType} signal`);
        
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
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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
    }

    // 10. Handle STOP LOSS signals (sl, sl_update)
    if (eventType === "sl" || eventType === "sl_update") {
      let slPrice = extractSLPrice(payload);

      // If no SL price provided, try to get it from the payload's 'price' field or use a default calculation
      if (!slPrice) {
        // Try to extract from different possible fields
        const possiblePrice = payload.price || 
                             payload.stop_price || 
                             payload.sl || 
                             payload.stop_loss ||
                             payload.new_sl_price;
        
        if (possiblePrice) {
          slPrice = parseFloat(String(possiblePrice));
          console.log(`${userPrefix} 📊 SL price extracted from alternative field: ${slPrice}`);
        }
      }

      // Still no SL price - Check if we can calculate it based on position
      if (!slPrice && exchangeSetup) {
        try {
          const positions = await exchangeSetup.client.getPositions();
          const position = positions.find((p) => p.symbol === symbol);
          
          if (position) {
            // For LONG positions: SL should be below entry price (e.g., 2% below)
            // For SHORT positions: SL should be above entry price (e.g., 2% above)
            const entryPrice = position.entryPrice;
            const slOffset = 0.02; // 2% default SL offset
            
            if (position.side === "LONG") {
              slPrice = entryPrice * (1 - slOffset);
            } else {
              slPrice = entryPrice * (1 + slOffset);
            }
            
            console.log(`${userPrefix} ⚠️ No SL price in webhook, calculated from position entry: ${slPrice} (entry: ${entryPrice}, offset: ${slOffset * 100}%)`);
          }
        } catch (err: any) {
          console.warn(`${userPrefix} Failed to calculate SL from position:`, err?.message || err);
        }
      }

      if (!slPrice) {
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, "failed", activeMode, strategyId, "No SL price provided");
        await updateWebhookStatus(eventId, userId, "failed");
        return res.status(400).json({
          success: false,
          status: "missing_sl_price",
          message: "Stop Loss signal requires sl_price, stop_loss_price, price, or similar field",
        });
      }

      if (exchangeSetup) {
        try {
          // Get current position
          const positions = await exchangeSetup.client.getPositions();
          const position = positions.find((p) => p.symbol === symbol);

          if (!position) {
            // No position found - add a small delay and retry once (handles API latency after entry orders)
            console.log(`⏳ No position for ${symbol}, waiting 5s before queueing...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Retry position check
            const retryPositions = await exchangeSetup.client.getPositions();
            const retryPosition = retryPositions.find((p) => p.symbol === symbol);
            
            if (!retryPosition) {
              // Still no position - Queue the SL signal for later execution
              console.log(`⏳ No position for ${symbol} after retry, queueing ${eventType} signal`);
            
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
          } // End of if (!retryPosition)
          } // End of if (!position)

          // SAFETY CHECK: Block SL updates if position is still in PENDING_ENTRY state
          const { data: positionRecord } = await supabase
            .from("positions")
            .select("state")
            .eq("symbol", symbol)
            .eq("exchange", exchangeName)
            .single();

          if (positionRecord?.state === "PENDING_ENTRY") {
            // Queue the SL signal for later execution when position fills
            console.log(`⏳ Position in PENDING_ENTRY, queueing ${eventType} signal`);
            
            // Check if already queued
            const { data: existingQueue } = await supabase
              .from("exit_signal_queue")
              .select("id")
              .eq("user_id", userId)
              .eq("event_id", eventId)
              .single();

            if (existingQueue) {
              console.log(`ℹ️ Signal already queued: ${eventId}`);
              await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, slPrice, "queued", activeMode, strategyId, "Already queued - waiting for position to fill");
              await updateWebhookStatus(eventId, userId, "processed");
              
              return res.json({
                success: true,
                status: "queued",
                message: `Stop Loss queued for ${symbol}. Will execute when position fills from PENDING_ENTRY state.`,
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
            await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, slPrice, "queued", activeMode, strategyId, "Queued - waiting for position to fill from PENDING_ENTRY");
            await updateWebhookStatus(eventId, userId, "processed");

            return res.json({
              success: true,
              status: "queued",
              message: `Stop Loss queued for ${symbol}. Will auto-execute when position fills.`,
              details: { 
                symbol, 
                eventType, 
                slPrice,
                queueUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
              },
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

          await logTrade(userId, eventId, exchangeName, symbol, eventType, position.size, slPrice, "filled", activeMode, strategyId, undefined, position.side);
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
        // No API keys configured - queue the SL signal
        console.log(`⏳ No API keys configured, queueing ${eventType} signal`);
        
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
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
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

    // 10. Get symbol info for rounding (availability check moved inside exchange loop)
    let stepSize = 0.001;
    let minQty = 0.001;

    if (exchangeSetup) {
      try {
        let symInfo: any;
        if (exchangeSetup.client instanceof BinanceClient) {
          symInfo = await exchangeSetup.client.getSymbolInfo(symbol);
        } else if (exchangeSetup.client instanceof BybitClient) {
          symInfo = await (exchangeSetup.client as BybitClient).getSymbolInfo(symbol);
        }
        if (symInfo) {
          stepSize = symInfo.stepSize;
          minQty = symInfo.minQty;
        }
      } catch (err: any) {
        console.warn(`Failed to get symbol info for ${symbol}, using defaults: ${err.message}`);
      }
    }

    qty = roundQtyByStep(qty, stepSize, minQty);

    // CRITICAL SAFETY CHECK - Never proceed with zero quantity
    if (qty <= 0) {
      await logTrade(userId, eventId, exchangeName, symbol, eventType, qty, markPrice, "failed", activeMode, strategyId, `CRITICAL ERROR: Quantity is zero after rounding (qty=${qty}, stepSize=${stepSize}, minQty=${minQty})`);
      await updateWebhookStatus(eventId, userId, "failed");
      return res.status(500).json({
        success: false,
        status: "zero_quantity",
        message: "Quantity calculation failed - would result in zero order",
      });
    }

    // Resolve leverage
    const leverage = parseInt(String(payload.leverage || "10")) || 10;
    const clampedLeverage = Math.min(125, Math.max(1, leverage));
    const side = resolveSide(eventType, payload);

    // ===== SINGLE POSITION LIMIT CHECK WITH AUTO-QUEUE =====
    const maxPositions = 1; // Your requirement

    console.log(`🔒 Checking position limit (max ${maxPositions})...`);

    const { data: openPositions } = await supabase
      .from("positions")
      .select("id, symbol, exchange, side, size")
      .eq("user_id", userId)
      .neq("state", "CLOSED");

    if (openPositions && openPositions.length >= maxPositions) {
      console.log(`⛔ Position limit reached: ${openPositions.length}/${maxPositions}`);
      console.log(`⏳ Auto-queuing entry signal for later execution...`);
      
      // Check if already queued
      const { data: existingQueue } = await supabase
        .from("exit_signal_queue")
        .select("id")
        .eq("user_id", userId)
        .eq("event_id", eventId)
        .single();

      if (existingQueue) {
        console.log(`ℹ️ Entry signal already queued: ${eventId}`);
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, 
          "queued", activeMode, strategyId, `Already queued - waiting for position slot`);
        await updateWebhookStatus(eventId, userId, "processed");
        
        return res.json({
          success: true,
          status: "queued",
          message: `Entry signal queued for ${symbol}. Will execute when position slot opens.`,
          details: {
            openPositionsCount: openPositions.length,
            maxAllowed: maxPositions,
            currentPositions: openPositions.map((p: any) => ({
              symbol: p.symbol,
              side: p.side,
              size: p.size,
              exchange: p.exchange
            }))
          },
        });
      }

      // Add to queue for auto-execution when position closes
      const { error: queueError } = await supabase
        .from("exit_signal_queue")
        .insert({
          user_id: userId,
          event_id: eventId,
          event_type: eventType,
          symbol,
          exchange: wantsBoth ? "both" : rawExchange,
          side: side === "BUY" ? "LONG" : "SHORT",
          payload: req.body,
          tp_price: extractTPPrice(req.body),
          sl_price: extractSLPrice(req.body),
          partial_percent: extractPartialPercentage(req.body),
          status: "pending",
          retry_count: 0,
          max_retries: 20, // More retries for entry signals
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), // 72 hours
        });

      if (queueError) {
        console.error("❌ Failed to queue entry signal:", queueError.message);
        await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, 
          "failed", activeMode, strategyId, `Failed to queue: ${queueError.message}`);
        await updateWebhookStatus(eventId, userId, "failed");
        
        return res.status(500).json({
          success: false,
          status: "queue_error",
          message: "Failed to queue entry signal",
        });
      }

      console.log(`✅ Queued entry signal for ${symbol} on ${wantsBoth ? "both" : rawExchange}`);
      await logTrade(userId, eventId, exchangeName, symbol, eventType, 0, markPrice, 
        "queued", activeMode, strategyId, `Queued - waiting for position slot (limit: ${maxPositions})`);
      await updateWebhookStatus(eventId, userId, "processed");

      return res.json({
        success: true,
        status: "queued",
        message: `Entry signal queued for ${symbol}. Will auto-execute when a position slot opens.`,
        details: { 
          symbol, 
          eventType, 
          side: side === "BUY" ? "LONG" : "SHORT",
          openPositionsCount: openPositions.length,
          maxAllowed: maxPositions,
          queueUntil: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
        },
      });
    }
    // ===== END SINGLE POSITION LIMIT CHECK WITH AUTO-QUEUE =====

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

          // For Bybit: Check if symbol is available BEFORE proceeding
          if (setup.client instanceof BybitClient) {
            const isSymbolLive = await (setup.client as BybitClient).isSymbolAvailable(symbol);
            if (!isSymbolLive) {
              console.log(`⚠️ ${setup.exchange.toUpperCase()}: Symbol ${symbol} is not live/available, skipping this exchange`);
              errors.push(`${setup.exchange.toUpperCase()}: Symbol ${symbol} not available`);
              continue; // Skip to next exchange
            }
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

          // Place order with error handling per exchange
          let orderResult: any;
          const isLimitOrder = payload.order_type?.toUpperCase() === "LIMIT";
          
          try {
            console.log(`📤 Placing ${eventType} order on ${setup.exchange.toUpperCase()}...`);
            
            if (setup.client instanceof BinanceClient) {
              orderResult = await setup.client.placeOrder({
                symbol,
                side,
                quantity: exchangeQty,
                type: isLimitOrder ? "LIMIT" : "MARKET",
                price: isLimitOrder && payload.price ? parseFloat(String(payload.price)) : undefined,
              });
              console.log(`✅ Binance order placed: ${symbol} ${side} qty=${exchangeQty}`);
            } else if (setup.client instanceof BybitClient) {
              orderResult = await setup.client.placeOrder({
                symbol,
                side: side === "BUY" ? "Buy" : "Sell",
                quantity: exchangeQty,
                type: isLimitOrder ? "Limit" : "Market",
                // Only include price for LIMIT orders
                price: isLimitOrder && payload.price ? parseFloat(String(payload.price)) : undefined,
              });
              console.log(`✅ Bybit order placed: ${symbol} ${side === "BUY" ? "Buy" : "Sell"} qty=${exchangeQty}`);
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
            
            // Store strategy_id in positions table for display in Overview/Positions
            try {
              const positionSide = side === "BUY" ? "LONG" : "SHORT";
              
              // First, try to update existing position
              const { data: existingPosition } = await supabase
                .from("positions")
                .select("id, state")
                .eq("user_id", userId)
                .eq("exchange", setup.exchange)
                .eq("symbol", symbol)
                .eq("side", positionSide)
                .neq("state", "CLOSED")
                .single();
              
              if (existingPosition) {
                // Update existing position
                await supabase
                  .from("positions")
                  .update({
                    size: exchangeQty,
                    entry_price: orderResult?.price || markPrice,
                    strategy_id: strategyId,
                    opened_by_webhook_id: eventId,
                    state: "OPEN", // Ensure it's marked as OPEN
                    opened_at: new Date().toISOString(),
                    leverage: clampedLeverage,
                    updated_at: new Date().toISOString()
                  })
                  .eq("id", existingPosition.id);
                
                console.log(`💾 ${setup.exchange.toUpperCase()}: Updated existing position for ${symbol}`);
              } else {
                // Create new position record
                await supabase.from("positions").insert({
                  user_id: userId,
                  exchange: setup.exchange.toUpperCase(),
                  symbol,
                  side: positionSide,
                  size: exchangeQty,
                  entry_price: orderResult?.price || markPrice,
                  strategy_id: strategyId,
                  opened_by_webhook_id: eventId,
                  state: "OPEN",
                  opened_at: new Date().toISOString(),
                  leverage: clampedLeverage,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString()
                });
                console.log(`💾 ${setup.exchange.toUpperCase()}: Created new position record for ${symbol}`);
              }
            } catch (dbErr: any) {
              console.warn(`⚠️ Failed to store position in database: ${dbErr.message}`);
              // Don't fail the trade - just log warning
            }
          } catch (orderErr: any) {
            console.error(`❌ ${setup.exchange.toUpperCase()} order failed: ${orderErr.message}`);
            errors.push(`${setup.exchange.toUpperCase()}: ${orderErr.message}`);
            
            // Log the failure for this specific exchange
            await logTrade(
              userId,
              eventId,
              setup.exchange,
              symbol,
              eventType,
              exchangeQty,
              markPrice,
              "failed",
              activeMode,
              strategyId,
              orderErr.message
            );
            
            // Continue with other exchanges instead of failing all
            console.log(`⏭️ Continuing with other exchanges...`);
          }
        }

        // Determine overall status based on errors
        const successfulExchanges = allExchangeSetups.filter((_, idx) => !errors[idx]);
        const failedExchanges = allExchangeSetups.filter((_, idx) => errors[idx]);

        if (successfulExchanges.length > 0) {
          // At least one exchange succeeded - mark as executed (or partially executed)
          const status = errors.length === 0 ? "executed" : "partially_executed";
          await updateWebhookStatus(eventId, userId, status);

          const successMsg = wantsBoth 
            ? `Order executed on ${successfulExchanges.map(s => s.exchange.toUpperCase()).join(", ")}`
            : `Order executed on ${exchangeName.toUpperCase()}`;
          
          const errorMsg = errors.length > 0 
            ? `. Failed on: ${failedExchanges.map(f => f.exchange.toUpperCase()).join(", ")}. Errors: ${errors.join("; ")}`
            : "";

          return res.json({
            success: true,
            status: status,
            message: `${successMsg}: ${eventType} ${symbol} qty=${qty} lev=${clampedLeverage}x${errorMsg}`,
            details: { 
              symbol, 
              side, 
              qty, 
              leverage: clampedLeverage, 
              eventType, 
              mode: activeMode,
              successfulExchanges: successfulExchanges.map(s => s.exchange),
              failedExchanges: failedExchanges.map(f => ({ exchange: f.exchange, error: errors.find(e => e.includes(f.exchange.toUpperCase())) }))
            },
          });
        } else {
          // All exchanges failed
          await updateWebhookStatus(eventId, userId, "failed");
          return res.status(500).json({
            success: false,
            status: "execution_failed",
            message: `Order failed on all exchanges: ${errors.join(", ")}`,
          });
        }
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
      // No API keys configured - queue the entry signal
      console.log(`⏳ No API keys configured, queueing ${eventType} signal`);
      
      // Check if already queued
      const { data: existingQueue } = await supabase
        .from("exit_signal_queue")
        .select("id")
        .eq("user_id", userId)
        .eq("event_id", eventId)
        .single();

      if (existingQueue) {
        console.log(`ℹ️ Signal already queued: ${eventId}`);
        await logTrade(userId, eventId, exchangeName, symbol, eventType, qty, markPrice, "queued", activeMode, strategyId, "Already queued - waiting for API keys");
        await updateWebhookStatus(eventId, userId, "processed");
        
        return res.json({
          success: true,
          status: "queued",
          message: `Signal queued for ${symbol}. Will execute when API keys are configured.`,
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
          side: side === "BUY" ? "LONG" : "SHORT",
          payload: req.body,
          tp_price: extractTPPrice(req.body),
          sl_price: extractSLPrice(req.body),
          partial_percent: extractPartialPercentage(req.body),
          status: "pending",
          retry_count: 0,
          max_retries: 10,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        });

      if (queueError) {
        console.error("Failed to queue signal:", queueError.message);
        await logTrade(userId, eventId, exchangeName, symbol, eventType, qty, markPrice, "failed", activeMode, strategyId, "Failed to queue");
        await updateWebhookStatus(eventId, userId, "failed");
        
        return res.status(500).json({
          success: false,
          status: "queue_error",
          message: "Failed to queue signal",
        });
      }

      console.log(`✅ Queued ${eventType} for ${symbol} on ${wantsBoth ? "both" : rawExchange}`);
      await logTrade(userId, eventId, exchangeName, symbol, eventType, qty, markPrice, "queued", activeMode, strategyId, "Queued - waiting for API keys");
      await updateWebhookStatus(eventId, userId, "processed");

      return res.json({
        success: true,
        status: "queued",
        message: `Signal queued for ${symbol}. Configure API keys to auto-execute.`,
        details: { 
          symbol, 
          eventType, 
          side,
          qty,
          leverage: clampedLeverage,
          queueUntil: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
        },
      });
    }
    
    // End of per-user processing logic - continue to next user
  } catch (err: any) {
    // Per-user error handling
    console.error(`Webhook error for user ${settings?.user_id?.substring(0, 8) || "unknown"}:`, err?.message || err);
    userResults.push({
      userId: settings?.user_id?.substring(0, 8) || "unknown",
      success: false,
      status: "error",
      message: err?.message || "Processing failed"
    });
    // Continue with next user instead of failing all
  }
  } // Close the for (const settings of allSettings) loop
  
  // All users processed successfully
  const response = res.json({
    success: true,
    status: "processed",
    message: `Webhook processed for ${allSettings.length} user(s)`,
    results: userResults
  });
  
  // Release distributed lock after successful processing
  if (baseEventId) {
   const lockKey = `webhook_lock_${baseEventId}`;
    try {
      await supabase.rpc('release_webhook_lock', { p_lock_key: lockKey });
     console.log(`🔓 Released distributed lock for webhook: ${baseEventId}`);
    } catch (err: any) {
     console.warn(`⚠️ Failed to release lock: ${err.message}`);
    }
  }
  
  return response;
  
} catch (err: any) {
  // Outer error handler for validation and system errors
  if (err instanceof z.ZodError) {
    // Release lock on validation error
   if (baseEventId) {
     const lockKey = `webhook_lock_${baseEventId}`;
      try {
        await supabase.rpc('release_webhook_lock', { p_lock_key: lockKey });
      } catch (releaseErr: any) {
       console.warn(`⚠️ Failed to release lock: ${releaseErr.message}`);
      }
    }
    return res.status(400).json({
      success: false,
      status: "validation_error",
      message: err.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", "),
    });
  }
  console.error("Webhook error:", err?.message || err);
  
  // Release lock on system error
  if (baseEventId) {
   const lockKey = `webhook_lock_${baseEventId}`;
    try {
      await supabase.rpc('release_webhook_lock', { p_lock_key: lockKey });
    } catch (releaseErr: any) {
     console.warn(`⚠️ Failed to release lock: ${releaseErr.message}`);
    }
  }
  
  return res.status(500).json({ success: false, status: "error", message: "Webhook processing failed" });
}
});

// ===== Helper functions =====

async function logTrade(
  userId: string, eventId: string, exchange: string, symbol: string,
  eventType: string, qty: number, price: number, status: string,
  mode: string, strategyId: string, errorMessage?: string,
  positionSide?: string // Optional: 'LONG' or 'SHORT'
) {
  // Determine side based on position if provided, otherwise infer from event type
  let side: string;
  
  if (positionSide) {
    // For exit/close signals: use opposite of position side
    if (eventType.includes("exit") || eventType.includes("close") || 
        eventType.includes("tp") || eventType.includes("sl")) {
      side = positionSide === "LONG" ? "SELL" : "BUY";
    } else {
      // For entry signals: use same as position side
      side = positionSide === "LONG" ? "BUY" : "SELL";
    }
  } else {
    // Fallback to old behavior for backward compatibility
    side = eventType.includes("long") || eventType.includes("buy") ? "BUY" : "SELL";
  }
  
  await supabase.from("trades").insert({
    user_id: userId,
    event_id: eventId,
    exchange,
    symbol,
    side,
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
