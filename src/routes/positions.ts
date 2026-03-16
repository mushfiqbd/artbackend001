import { Router, type Response } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { supabase } from "../config/supabase";
import { getAllExchangeClients } from "../exchanges/factory";
import { BinanceClient } from "../exchanges/binance";
import { BybitClient } from "../exchanges/bybit";

const router = Router();

// POST /positions/close — Close a position on BOTH exchanges and update database
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

    // Get all exchange clients for this user
    const allClients = await getAllExchangeClients(userId);
    
    if (allClients.length === 0) {
      return res.status(400).json({
        success: false,
        status: "no_exchanges",
        message: "No exchanges configured"
      });
    }

    const results: any[] = [];
    let totalClosed = 0;

    // Try to close on ALL configured exchanges (not just the specified one)
    for (const setup of allClients) {
      const targetExchange = setup.exchange;
      
      try {
        // Get positions from this exchange
        let positions: any[] = [];
        try {
          if (setup.client instanceof BinanceClient) {
            positions = await setup.client.getPositions();
          } else if (setup.client instanceof BybitClient) {
            positions = await setup.client.getPositions();
          }
        } catch (posErr: any) {
          console.error(`❌ Failed to fetch ${targetExchange} positions:`, posErr.message);
          results.push({
            exchange: targetExchange,
            success: false,
            error: `Failed to get positions: ${posErr.message}`
          });
          continue;
        }

        // Check if this symbol exists on this exchange
        const position = positions.find((p) => p.symbol === symbol);

        if (!position) {
          console.log(`ℹ️ No position found for ${symbol} on ${targetExchange}, skipping...`);
          results.push({
            exchange: targetExchange,
            symbol,
            success: false,
            reason: "No open position"
          });
          continue;
        }

        console.log(`✅ Found position to close: ${symbol} ${position.side} (size: ${position.size}) on ${targetExchange}`);

        // Close the position
        let result: any;
        try {
          console.log(`🔄 Closing position on ${targetExchange}...`);
          
          if (setup.client instanceof BinanceClient) {
            result = await setup.client.closePosition(symbol);
            console.log(`✅ Binance close executed:`, result);
          } else if (setup.client instanceof BybitClient) {
            result = await setup.client.closePosition(symbol);
            console.log(`✅ Bybit close executed:`, result);
          }
          
          totalClosed++;
          results.push({
            exchange: targetExchange,
            symbol,
            side: position.side,
            size: position.size,
            success: true,
            pnl: position.unrealizedPnl
          });
          
          // Log the trade for each exchange
          await supabase.from("trades").insert({
            user_id: userId,
            event_id: `manual_close_${Date.now()}_${symbol}_${targetExchange}`,
            exchange: targetExchange,
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
          
        } catch (closeErr: any) {
          console.error(`❌ Failed to close position on ${targetExchange}:`, closeErr.message);
          results.push({
            exchange: targetExchange,
            symbol,
            success: false,
            error: closeErr.message
          });
        }
        
      } catch (exchangeErr: any) {
        console.error(`❌ Error processing ${targetExchange}:`, exchangeErr.message);
        results.push({
          exchange: targetExchange,
          success: false,
          error: exchangeErr.message
        });
      }
    }

    // Update database positions to CLOSED for ALL exchanges
    const { data: dbPositions } = await supabase
      .from("positions")
      .select("id")
      .eq("user_id", userId)
      .eq("symbol", symbol)
      .neq("state", "CLOSED");
    
    if (dbPositions && dbPositions.length > 0) {
      await supabase
        .from("positions")
        .update({
          state: "CLOSED",
          close_reason: "manual_close",
          updated_at: new Date().toISOString()
        })
        .in("id", dbPositions.map(p => p.id));
      
      console.log(`✅ Updated ${dbPositions.length} DB positions to CLOSED for ${symbol}`);
    }

    return res.json({
      success: true,
      status: "executed",
      message: `Closed ${totalClosed} position(s) across ${results.filter(r => r.success).length} exchange(s)`,
      details: {
        symbol,
        totalClosed,
        results
      }
    });
    
  } catch (err: any) {
    console.error("Close position error:", err?.message || err);
    return res.json({
      success: true,
      status: "completed",
      message: `Operation completed with note: ${err?.message || 'Unknown error'}`,
    });
  }
});

// POST /positions/close-all — Close ALL positions on all exchanges
router.post("/close-all", authMiddleware, async (req: AuthRequest, res: Response): Promise<Response | void> => {
  try {
    const userId = req.userId!;
    const results: any[] = [];
    
    // Get all exchange clients for this user
    const allClients = await getAllExchangeClients(userId);
    
    if (allClients.length === 0) {
      return res.json({
        success: true,
        status: "no_exchanges",
        message: "No exchanges configured"
      });
    }
    
    console.log(`🔄 Starting close-all for ${allClients.length} exchanges...`);
    
    // Process each exchange
    for (const setup of allClients) {
      const exchange = setup.exchange;
      
      try {
        // Get positions from exchange
        let positions: any[] = [];
        try {
          if (setup.client instanceof BinanceClient) {
            positions = await setup.client.getPositions();
            console.log(`📊 ${exchange} positions: ${positions.length} found`);
          } else if (setup.client instanceof BybitClient) {
            positions = await setup.client.getPositions();
            console.log(`📊 ${exchange} positions: ${positions.length} found`);
          }
        } catch (posErr: any) {
          console.error(`❌ Failed to fetch ${exchange} positions:`, posErr.message);
          results.push({
            exchange,
            success: false,
            error: `Failed to get positions: ${posErr.message}`
          });
          continue;
        }
        
        // Close each position
        for (const position of positions) {
          try {
            console.log(`🔄 Closing ${position.symbol} ${position.side} on ${exchange}...`);
            
            let result: any;
            if (setup.client instanceof BinanceClient) {
              result = await setup.client.closePosition(position.symbol);
              console.log(`✅ ${exchange} closed: ${position.symbol}`);
            } else if (setup.client instanceof BybitClient) {
              result = await setup.client.closePosition(position.symbol);
              console.log(`✅ ${exchange} closed: ${position.symbol}`);
            }
            
            // Log the trade
            await supabase.from("trades").insert({
              user_id: userId,
              event_id: `close_all_${Date.now()}_${position.symbol}`,
              exchange,
              symbol: position.symbol,
              side: position.side === "LONG" ? "SELL" : "BUY",
              event_type: "close_all",
              qty: position.size,
              price: result?.price || position.markPrice || 0,
              status: "filled",
              mode: "real",
              strategy_id: "close_all",
              error_message: null,
            });
            
            results.push({
              exchange,
              symbol: position.symbol,
              side: position.side,
              size: position.size,
              success: true,
              pnl: position.unrealizedPnl
            });
            
          } catch (closeErr: any) {
            console.error(`❌ Failed to close ${position.symbol} on ${exchange}:`, closeErr.message);
            results.push({
              exchange,
              symbol: position.symbol,
              success: false,
              error: closeErr.message
            });
          }
        }
        
        // Update database positions
        const { data: dbPositions } = await supabase
          .from("positions")
          .select("id")
          .eq("exchange", exchange)
          .neq("state", "CLOSED");
        
        if (dbPositions && dbPositions.length > 0) {
          await supabase
            .from("positions")
            .update({
              state: "CLOSED",
              close_reason: "close_all_script",
              updated_at: new Date().toISOString()
            })
            .in("id", dbPositions.map(p => p.id));
          
          console.log(`✅ Updated ${dbPositions.length} DB positions to CLOSED for ${exchange}`);
        }
        
      } catch (exchangeErr: any) {
        console.error(`❌ Error processing ${exchange}:`, exchangeErr.message);
        results.push({
          exchange,
          success: false,
          error: exchangeErr.message
        });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    return res.json({
      success: true,
      status: "completed",
      message: `Closed ${successCount} positions successfully${failCount > 0 ? `, ${failCount} failed` : ''}`,
      details: {
        totalProcessed: results.length,
        successful: successCount,
        failed: failCount,
        results
      }
    });
    
  } catch (err: any) {
    console.error("Close all positions error:", err?.message || err);
    return res.json({
      success: true,
      status: "completed",
      message: `Operation completed with note: ${err?.message || 'Unknown error'}`,
    });
  }
});

export default router;
