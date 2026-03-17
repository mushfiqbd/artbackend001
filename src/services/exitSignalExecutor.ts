/**
 * Exit Signal Queue Executor Service
 * 
 * Automatically checks queued exit signals and executes them when positions exist
 * Runs every 30 seconds to check for executable signals
 */

import { supabase } from "../config/supabase";
import { getAllExchangeClients } from "../exchanges/factory";
import { BinanceClient } from "../exchanges/binance";
import { BybitClient } from "../exchanges/bybit";

export async function executeQueuedExitSignals() {
  try {
    console.log(`🔍 Checking for executable exit signals...`);
    
    const now = new Date().toISOString();

    // Get pending exit signals that haven't expired
    const { data: pendingSignals, error: fetchError } = await supabase
      .from("exit_signal_queue")
      .select("*")
      .eq("status", "pending")
      .gt("expires_at", now)
      .order("created_at", { ascending: true }); // Process oldest first

    if (fetchError) {
      console.error("❌ Error fetching pending exit signals:", JSON.stringify(fetchError, null, 2));
      return;
    }

    if (!pendingSignals || pendingSignals.length === 0) {
      console.log(`✅ No pending exit signals to execute`);
      return;
    }

    console.log(`⏰ Found ${pendingSignals.length} pending exit signal(s)`);

    for (const signal of pendingSignals) {
      try {
        console.log(`🔍 Checking if position exists for ${signal.symbol} (${signal.event_type})...`);
        
        // Get all exchange clients for this user
        const allClients = await getAllExchangeClients(signal.user_id);
        
        if (allClients.length === 0) {
          console.log(`⚠️ No exchanges configured for user ${signal.user_id}`);
          continue;
        }

        let positionFound = false;
        let positionFoundOnExchange = '';

        // Check if position exists on any exchange
        for (const setup of allClients) {
          try {
            const positions = await setup.client.getPositions();
            const position = positions.find((p: any) => p.symbol === signal.symbol);
            
            if (position) {
              positionFound = true;
              positionFoundOnExchange = setup.exchange;
              console.log(`✅ Position found for ${signal.symbol} on ${setup.exchange}`);
              break;
            }
          } catch (err: any) {
            console.warn(`Failed to check positions on ${setup.exchange}: ${err.message}`);
          }
        }

        if (!positionFound) {
          console.log(`⏳ No position yet for ${signal.symbol}, keeping in queue (retry ${signal.retry_count}/${signal.max_retries})`);
          
          // Increment retry count
          if (signal.retry_count >= signal.max_retries) {
            console.log(`❌ Max retries reached for ${signal.symbol}, marking as failed`);
            await supabase
              .from("exit_signal_queue")
              .update({
                status: "failed",
                failure_reason: `Max retries (${signal.max_retries}) reached - no position found`,
                updated_at: new Date().toISOString()
              })
              .eq("id", signal.id);
          } else {
            await supabase
              .from("exit_signal_queue")
              .update({
                retry_count: signal.retry_count + 1,
                updated_at: new Date().toISOString()
              })
              .eq("id", signal.id);
          }
          continue;
        }

        // Position found - execute the exit signal!
        console.log(`🚀 Executing exit signal for ${signal.symbol} on ${positionFoundOnExchange}...`);
        
        // Find the exchange client
        const targetSetup = allClients.find(s => s.exchange === positionFoundOnExchange);
        if (!targetSetup) {
          console.error(`❌ Could not find exchange client for ${positionFoundOnExchange}`);
          continue;
        }

        // Execute close based on event type
        try {
          let result: any;
          
          if (targetSetup.client instanceof BinanceClient) {
            result = await targetSetup.client.closePosition(signal.symbol);
            console.log(`✅ ${positionFoundOnExchange} close executed:`, result);
          } else if (targetSetup.client instanceof BybitClient) {
            result = await targetSetup.client.closePosition(signal.symbol);
            console.log(`✅ ${positionFoundOnExchange} close executed:`, result);
          }

          // Update signal status to executed
          await supabase
            .from("exit_signal_queue")
            .update({
              status: "executed",
              executed_at: new Date().toISOString(),
              execution_result: result,
              updated_at: new Date().toISOString()
            })
            .eq("id", signal.id);

          // Update database position state to CLOSED
          try {
            const { data: dbPosition } = await supabase
              .from("positions")
              .select("id")
              .eq("user_id", signal.user_id)
              .eq("symbol", signal.symbol)
              .eq("exchange", positionFoundOnExchange)
              .neq("state", "CLOSED")
              .single();
            
            if (dbPosition) {
              await supabase
                .from("positions")
                .update({
                  state: "CLOSED",
                  close_reason: signal.event_type.includes("tp") ? "take_profit" 
                             : signal.event_type.includes("sl") ? "stop_loss" 
                             : "close_signal",
                  updated_at: new Date().toISOString()
                })
                .eq("id", dbPosition.id);
              
              console.log(`💾 ${positionFoundOnExchange.toUpperCase()}: Updated position state to CLOSED for ${signal.symbol}`);
            }
          } catch (dbErr: any) {
            console.warn(`⚠️ Failed to update position state in database: ${dbErr.message}`);
          }

          // Log the successful execution
          await supabase.from("trades").insert({
            user_id: signal.user_id,
            event_id: `queued_exit_${signal.id}_${Date.now()}`,
            exchange: positionFoundOnExchange,
            symbol: signal.symbol,
            side: signal.side === "LONG" ? "SELL" : "BUY",
            event_type: signal.event_type,
            qty: result?.size || 0,
            price: result?.price || 0,
            leverage: 10,
            realized_pnl: result?.unrealizedPnl || 0,
            status: "filled",
            mode: "real",
            strategy_id: signal.strategy_id || "queued_exit",
            error_message: null,
          });

          // Also log to webhook_events
          await supabase
            .from("webhook_events")
            .update({
              status: "executed",
              updated_at: new Date().toISOString()
            })
            .eq("event_id", signal.event_id);

          console.log(`✅ Successfully executed queued exit for ${signal.symbol}`);

        } catch (execErr: any) {
          console.error(`❌ Failed to execute exit for ${signal.symbol}:`, execErr.message);
          
          await supabase
            .from("exit_signal_queue")
            .update({
              status: "failed",
              failure_reason: `Execution error: ${execErr.message}`,
              updated_at: new Date().toISOString()
            })
            .eq("id", signal.id);
        }

      } catch (err: any) {
        console.error(`❌ Failed to process exit signal for ${signal.symbol}:`, err.message);
        // Continue processing other signals even if one fails
      }
    }

    console.log(`✅ Exit signal queue check completed`);
    
  } catch (err: any) {
    console.error("❌ Critical error in exit signal executor:", err.message);
  }
}

// Start the background executor
// Run every 30 seconds
const EXECUTE_INTERVAL = 30_000; // 30 seconds

console.log(`🚀 Starting Exit Signal Queue Executor Service (checking every ${EXECUTE_INTERVAL / 1000}s)`);

// Verify Supabase connection first
(async () => {
  try {
    const { error } = await supabase.from("exit_signal_queue").select("count");
    if (error) {
      console.error("❌ CRITICAL: Cannot connect to Supabase!");
      console.error("Error:", JSON.stringify(error, null, 2));
      console.warn("⚠️ Exit signal executor will continue running but may fail");
    } else {
      console.log("✅ Supabase connection verified");
    }
  } catch (err: any) {
    console.error("❌ CRITICAL: Supabase connection test failed:", err.message);
  }
})();

// Initial check after 5 seconds
setTimeout(() => {
  executeQueuedExitSignals();
  
  // Then run periodically
  setInterval(executeQueuedExitSignals, EXECUTE_INTERVAL);
}, 5000);

// Export for manual triggering if needed
export { executeQueuedExitSignals as manualExecute };
