import { Router, type Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { supabase } from "../config/supabase";
import { getAllExchangeClients } from "../exchanges/factory";
import { BinanceClient } from "../exchanges/binance";
import { BybitClient } from "../exchanges/bybit";

const router = Router();

// POST /exchange-data — Fetch real balances, positions, trades from exchanges
router.post("/", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;

    // Get all exchange clients for user
    const clients = await getAllExchangeClients(userId);

    // Fetch from all configured exchanges in parallel
    const balances: any[] = [];
    const openPositions: any[] = [];
    const income: any[] = [];

    await Promise.all(
      clients.map(async ({ client, exchange }) => {
        try {
          // Fetch balance
          const bal = await client.getBalance();
          balances.push({
            exchange,
            asset: "USDT",
            totalBalance: bal.totalBalance,
            availableBalance: bal.availableBalance,
            unrealizedPnl: bal.unrealizedPnl,
          });

          // Fetch open positions
          if (client instanceof BinanceClient) {
            const positions = await client.getPositions();
            openPositions.push(...positions);
          } else if (client instanceof BybitClient) {
            const positions = await client.getPositions();
            openPositions.push(...positions);
          }

          // Fetch income/funding (Binance only for now)
          if (client instanceof BinanceClient) {
            try {
              const inc = await client.getIncome("FUNDING_FEE", 20);
              income.push(...inc);
            } catch {
              // Non-critical, skip
            }
          }
        } catch (err: any) {
          console.error(`Error fetching ${exchange} data:`, err.message);
          // Still return other exchanges' data
          balances.push({
            exchange,
            asset: "USDT",
            totalBalance: 0,
            availableBalance: 0,
            unrealizedPnl: 0,
            error: err.message,
          });
        }
      })
    );

    // Fetch trade history from database
    const { data: dbTrades } = await supabase
      .from("trades")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);

    return res.json({
      success: true,
      balances,
      openPositions,
      tradeHistory: dbTrades || [],
      income,
    });
  } catch (err: any) {
    console.error("Exchange data error:", err?.message || err);
    return res.status(500).json({ success: false, status: "error", message: "Failed to fetch exchange data" });
  }
});

export default router;
