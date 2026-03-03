import { Router, type Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { supabase } from "../config/supabase";
import { getAllExchangeClients } from "../exchanges/factory";
import { BinanceClient } from "../exchanges/binance";
import { BybitClient } from "../exchanges/bybit";

const router = Router();

// POST /positions/close — Close a position on a specific exchange
router.post("/close", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;
    const { symbol, exchange } = req.body;

    // Validate required fields
    if (!symbol || !exchange) {
      return res.status(400).json({
        success: false,
        status: "missing_parameters",
        message: "Symbol and exchange are required"
      });
    }

    // Get the exchange client
    const allClients = await getAllExchangeClients(userId);
    const setup = allClients.find((c) => c.exchange === exchange);

    if (!setup) {
      return res.status(400).json({
        success: false,
        status: "no_api_keys",
        message: `No API keys configured for ${exchange}`
      });
    }

    // Check if position exists
    let positions: any[] = [];
    if (setup.client instanceof BinanceClient) {
      positions = await setup.client.getPositions();
    } else if (setup.client instanceof BybitClient) {
      positions = await setup.client.getPositions();
    }

    const position = positions.find((p) => p.symbol === symbol);

    if (!position) {
      return res.status(400).json({
        success: false,
        status: "no_position",
        message: `No open position for ${symbol} on ${exchange}`
      });
    }

    // Close the position
    let result: any;
    if (setup.client instanceof BinanceClient) {
      result = await setup.client.closePosition(symbol);
    } else if (setup.client instanceof BybitClient) {
      result = await setup.client.closePosition(symbol);
    }

    // Log the trade
    await supabase.from("trades").insert({
      user_id: userId,
      event_id: `manual_close_${Date.now()}_${symbol}`,
      exchange,
      symbol,
      side: position.side === "LONG" ? "SELL" : "BUY",
      event_type: "manual_close",
      qty: position.size,
      price: result?.price || position.markPrice || 0,
      status: "filled",
      mode: "real",
      strategy_id: "manual",
      error_message: null,
    });

    // Update position state in database if it exists
    const { data: dbPosition } = await supabase
      .from("positions")
      .select("id")
      .eq("symbol", symbol)
      .eq("exchange", exchange)
      .single();

    if (dbPosition) {
      await supabase
        .from("positions")
        .update({
          state: "CLOSED",
          close_reason: "manual_close",
          updated_at: new Date().toISOString()
        })
        .eq("id", dbPosition.id);
    }

    return res.json({
      success: true,
      status: "executed",
      message: `Position closed successfully on ${exchange}: ${symbol}`,
      details: {
        symbol,
        exchange,
        side: position.side,
        size: position.size,
        entryPrice: position.entryPrice,
        closePrice: result?.price || position.markPrice,
        pnl: position.unrealizedPnl
      }
    });
  } catch (err: any) {
    console.error("Close position error:", err?.message || err);
    return res.status(500).json({
      success: false,
      status: "error",
      message: `Failed to close position: ${err.message}`
    });
  }
});

export default router;
