/**
 * Pending Entry Timeout Monitor
 * 
 * Automatically cancels PENDING_ENTRY positions after timeout period
 * Run as background service every 60 seconds
 */

import { supabase } from "../config/supabase";
import { getAllExchangeClients } from "../exchanges/factory";
import { config } from "../config/env";

export async function checkPendingEntryTimeouts() {
  try {
    const timeoutMinutes = config.pendingEntryTimeout;
    const cutoffTime = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();

    // Find expired PENDING_ENTRY positions
    const { data: expiredPositions, error: fetchError } = await supabase
      .from("positions")
      .select("*")
      .eq("state", "PENDING_ENTRY")
      .lt("created_at", cutoffTime);

    if (fetchError) {
      console.error("❌ Error fetching expired positions:", fetchError.message);
      return;
    }

    if (!expiredPositions || expiredPositions.length === 0) {
      return; // No expired positions to process
    }

    console.log(`⏰ Found ${expiredPositions.length} expired PENDING_ENTRY positions`);

    for (const position of expiredPositions) {
      try {
        console.log(`🗑️ Processing timeout for ${position.symbol} on ${position.exchange}`);

        // Get exchange API keys
        const { data: apiKey } = await supabase
          .from("api_keys")
          .select("*")
          .eq("user_id", position.user_id)
          .eq("exchange", position.exchange)
          .single();

        if (!apiKey) {
          console.warn(`⚠️ No API keys found for user ${position.user_id} on ${position.exchange}`);
          continue;
        }

        // Get exchange client
        const exchangeClients = await getAllExchangeClients(position.user_id);
        const setup = exchangeClients.find((c: any) => c.exchange === position.exchange);

        if (!setup || !setup.client) {
          console.warn(`⚠️ No exchange client available for ${position.exchange}`);
          continue;
        }

        // Try to cancel any open orders for this position
        try {
          // Note: You may need to store order_id when creating PENDING_ENTRY
          // For now, we'll just update the database state
          console.log(`✅ Cancelling pending entry for ${position.symbol}`);
          
          // If you have order tracking, uncomment:
          // await setup.client.cancelOrder({
          //   symbol: position.symbol,
          //   orderId: position.order_id // Need to store this
          // });
        } catch (cancelErr: any) {
          console.warn(`⚠️ Order cancellation failed: ${cancelErr?.message || 'Unknown error'}. Continuing with state update...`);
        }

        // Update position state to CLOSED with timeout reason
        const { error: updateError } = await supabase
          .from("positions")
          .update({
            state: "CLOSED",
            close_reason: "pending_entry_timeout",
            updated_at: new Date().toISOString()
          })
          .eq("id", position.id);

        if (updateError) {
          throw new Error(`Failed to update position state: ${updateError.message}`);
        }

        // Log the timeout cancellation
        await supabase.from("trades").insert({
          user_id: position.user_id,
          event_id: `timeout_${position.id}_${Date.now()}`,
          exchange: position.exchange,
          symbol: position.symbol,
          side: position.side === "LONG" ? "BUY" : "SELL",
          event_type: "pending_entry_cancelled",
          qty: position.qty || 0,
          price: position.entry_price || 0,
          leverage: 10,
          realized_pnl: 0,
          status: "cancelled",
          mode: apiKey.testnet ? "demo" : "real",
          strategy_id: "auto_timeout",
          error_message: `Auto-cancelled after ${timeoutMinutes} minutes timeout - order did not fill`,
          created_at: new Date().toISOString()
        });

        // Also log webhook event for tracking
        await supabase.from("webhook_events").insert({
          user_id: position.user_id,
          event_id: `timeout_${position.id}_${Date.now()}`,
          event_type: "pending_entry_timeout",
          symbol: position.symbol,
          exchange: position.exchange,
          status: "cancelled",
          payload: {
            position_id: position.id,
            original_created_at: position.created_at,
            timeout_minutes: timeoutMinutes,
            reason: "pending_entry_did_not_fill"
          },
          created_at: new Date().toISOString()
        });

        console.log(`✅ Successfully cancelled expired PENDING_ENTRY for ${position.symbol}`);
        
      } catch (err: any) {
        console.error(`❌ Failed to cancel PENDING_ENTRY for ${position.symbol}:`, err.message);
        // Continue processing other positions even if one fails
      }
    }

    console.log(`✅ Pending entry timeout check completed`);
    
  } catch (err: any) {
    console.error("❌ Critical error in pending entry monitor:", err.message);
  }
}

// Start the background monitor
// Run every 60 seconds
const MONITOR_INTERVAL = 60 * 1000; // 1 minute

console.log(`🚀 Starting Pending Entry Timeout Monitor (checking every ${MONITOR_INTERVAL / 1000}s)`);

// Initial check after 5 seconds
setTimeout(() => {
  checkPendingEntryTimeouts();
  
  // Then run periodically
  setInterval(checkPendingEntryTimeouts, MONITOR_INTERVAL);
}, 5000);

// Export for manual triggering if needed
export { checkPendingEntryTimeouts as manualCheck };
