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
            console.log(`🔍 Binance: Found ${positions.length} position(s) from exchange API`);
            
        // Enrich with strategy_id from database
        const enrichedPositions = await Promise.all(positions.map(async (pos: any) => {
          try {
            // Normalize symbol for DB lookup
          const normalizedSymbol = pos.symbol
              .replace('BINANCE:', '')
              .replace('BYBIT:', '')
              .replace('.P', '');
            
            // Try multiple symbol variations
          const symbolVariations = [
              pos.symbol,                    // IMXUSDT
              normalizedSymbol,              // IMXUSDT
              `BINANCE:${normalizedSymbol}.P`, // BINANCE:IMXUSDT.P
              `BYBIT:${normalizedSymbol}`,   // BYBIT:IMXUSDT
            ];
            
            // Normalize side for DB lookup (handle LONG/SHORT vs Buy/Sell)
          const sideVariations = [
              pos.side,                      // "LONG" or "SHORT"
              pos.side === 'LONG' ? 'Buy' : 'Sell', // Convert to webhook format
              pos.side === 'SHORT' ? 'Buy' : 'Sell',
            ];
            
          console.log(`🔍 Looking up DB for ${pos.symbol}, normalized: ${normalizedSymbol}`);
            
            let dbPos = null;
            
            // Try all combinations
            for (const symVar of symbolVariations) {
            if (dbPos?.data) break;
              for (const sideVar of sideVariations) {
              if (dbPos?.data) break;
                
                // Try uppercase exchange
                dbPos = await supabase
                  .from("positions")
                  .select("strategy_id, opened_by_webhook_id, state")
                  .eq("user_id", userId)
                  .eq("exchange", exchange.toUpperCase())
                  .eq("symbol", symVar)
                  .eq("side", sideVar)
                  .order("created_at", { ascending: false })
                  .limit(1)
                  .maybeSingle();
                
              if (!dbPos?.data) {
                  // Try lowercase exchange
                  dbPos = await supabase
                    .from("positions")
                    .select("strategy_id, opened_by_webhook_id, state")
                    .eq("user_id", userId)
                    .eq("exchange", exchange)
                    .eq("symbol", symVar)
                    .eq("side", sideVar)
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .maybeSingle();
                }
              }
            }
            
          if (dbPos?.data) {
            console.log(`✅ Found DB match: strategy_id="${dbPos.data.strategy_id}"`);
            return { ...pos, strategy_id: dbPos.data.strategy_id || null, db_state: dbPos.data.state };
            } else {
            console.log(`⚠️ No DB match found for ${pos.symbol}`);
            return pos;
            }
          } catch (err: any) {
          console.log(`⚠️ DB lookup failed: ${err.message}`);
          return pos;
          }
        }));
            openPositions.push(...enrichedPositions);
          } else if (client instanceof BybitClient) {
           const positions = await client.getPositions();
           console.log(`🔍 Bybit: Found ${positions.length} position(s) from exchange API`);
            
        // Enrich with strategy_id from database
       const enrichedPositions = await Promise.all(positions.map(async (pos: any) => {
          try {
            // Normalize symbol for DB lookup
        const normalizedSymbol = pos.symbol
             .replace('BINANCE:', '')
             .replace('BYBIT:', '')
             .replace('.P', '');
           
           // Try multiple symbol variations
        const symbolVariations = [
           pos.symbol,                    // IMXUSDT
             normalizedSymbol,              // IMXUSDT
             `BINANCE:${normalizedSymbol}.P`, // BINANCE:IMXUSDT.P
             `BYBIT:${normalizedSymbol}`,   // BYBIT:IMXUSDT
           ];
           
           // Normalize side for DB lookup (handle LONG/SHORT vs Buy/Sell)
        const sideVariations = [
           pos.side,                      // "LONG"or "SHORT"
           pos.side === 'LONG' ? 'Buy' : 'Sell', // Convert to webhook format
           pos.side === 'SHORT' ? 'Buy' : 'Sell',
           ];
           
        console.log(`🔍 Looking up DB for ${pos.symbol}, normalized: ${normalizedSymbol}`);
           
           let dbPos = null;
           
           // Try all combinations
           for (const symVar of symbolVariations) {
         if (dbPos?.data) break;
             for (const sideVar of sideVariations) {
           if (dbPos?.data) break;
               
               // Try uppercase exchange
               dbPos = await supabase
                 .from("positions")
                 .select("strategy_id, opened_by_webhook_id, state")
                 .eq("user_id", userId)
                 .eq("exchange", exchange.toUpperCase())
                 .eq("symbol", symVar)
                 .eq("side", sideVar)
                 .order("created_at", { ascending: false })
                 .limit(1)
                 .maybeSingle();
               
           if (!dbPos?.data) {
                 // Try lowercase exchange
                 dbPos = await supabase
                   .from("positions")
                   .select("strategy_id, opened_by_webhook_id, state")
                   .eq("user_id", userId)
                   .eq("exchange", exchange)
                   .eq("symbol", symVar)
                   .eq("side", sideVar)
                   .order("created_at", { ascending: false })
                   .limit(1)
                   .maybeSingle();
               }
             }
           }
           
        if (dbPos?.data) {
         console.log(`✅ Found DB match: strategy_id="${dbPos.data.strategy_id}"`);
         return { ...pos, strategy_id: dbPos.data.strategy_id || null, db_state: dbPos.data.state };
           } else {
         console.log(`⚠️ No DB match found for ${pos.symbol}`);
         return pos;
           }
          } catch (err: any) {
        console.log(`⚠️ DB lookup failed: ${err.message}`);
        return pos;
          }
        }));
            openPositions.push(...enrichedPositions);
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
    // Always return success with empty data instead of 500 error
    return res.json({
      success: true,
      balances: [],
      openPositions: [],
      tradeHistory: [],
      income: [],
    });
  }
});

export default router;
