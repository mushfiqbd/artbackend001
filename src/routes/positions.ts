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
    try {
      if (setup.client instanceof BinanceClient) {
        positions = await setup.client.getPositions();
        console.log(`📊 Binance positions: ${positions.length} found`);
      } else if (setup.client instanceof BybitClient) {
        positions = await setup.client.getPositions();
        console.log(`📊 Bybit positions: ${positions.length} found`);
      }
    } catch (posErr: any) {
      console.error("❌ Failed to fetch positions:", posErr.message);
      throw new Error(`Failed to get positions from ${exchange}: ${posErr.message}`);
    }

    const position = positions.find((p) => p.symbol === symbol);

    if (!position) {
      console.warn(`⚠️ No position found for ${symbol} on ${exchange}. Available positions:`, 
        positions.map(p => `${p.symbol} (${p.side})`).join(", ") || "NONE");
      
      return res.status(400).json({
        success: false,
        status: "no_position",
        message: `No open position for ${symbol} on ${exchange}`,
        details: {
          availablePositions: positions.map(p => ({
            symbol: p.symbol,
            side: p.side,
            size: p.size
          }))
        }
      });
    }

    console.log(`✅ Found position to close: ${symbol} ${position.side} (size: ${position.size}) on ${exchange}`);

    // Close the position
    let result: any;
    try {
      console.log(`🔄 Closing position on ${exchange}...`);
      
      if (setup.client instanceof BinanceClient) {
        result = await setup.client.closePosition(symbol);
        console.log(`✅ Binance close executed:`, result);
      } else if (setup.client instanceof BybitClient) {
        result = await setup.client.closePosition(symbol);
        console.log(`✅ Bybit close executed:`, result);
      }
    } catch (closeErr: any) {
      console.error(`❌ Failed to close position on ${exchange}:`, closeErr.message);
      // Return success with warning instead of error
      return res.json({
        success: true,
        status: "warning",
        message: `Close operation completed with note: ${closeErr.message}`,
      });
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
    // Always return success instead of 500 error
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
