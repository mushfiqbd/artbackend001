/**
 * Exit Signal Queue Cleanup Service
 * 
 * Automatically cleans up expired exit signals from the queue
 * Run as background service every 5 minutes
 */

import { supabase } from "../config/supabase";

export async function cleanupExpiredExitSignals() {
  try {
   console.log(`🧹 Cleaning up expired exit signals...`);
    
   const now = new Date().toISOString();

    // Find expired exit signals
   const { data: expiredSignals, error: fetchError } = await supabase
      .from("exit_signal_queue")
      .select("*")
      .eq("status", "pending")
      .lt("expires_at", now);

    if (fetchError) {
     console.error("❌ Error fetching expired exit signals:", JSON.stringify(fetchError, null, 2));
     return;
    }

    if (!expiredSignals || expiredSignals.length === 0) {
     console.log(`✅ No expired exit signals found`);
     return; // No expired signals to process
    }

   console.log(`⏰ Found ${expiredSignals.length} expired exit signals`);

    for (const signal of expiredSignals) {
     try {
       console.log(`🗑️ Processing expiration for ${signal.symbol} (${signal.event_type})`);

        // Update signal status to expired
       const { error: updateError } = await supabase
          .from("exit_signal_queue")
          .update({
            status: "expired",
            updated_at: new Date().toISOString()
          })
          .eq("id", signal.id);

        if (updateError) {
          throw new Error(`Failed to update signal status: ${updateError.message}`);
        }

        // Log the expiration
        await supabase.from("trades").insert({
          user_id: signal.user_id,
          event_id: `expire_${signal.id}_${Date.now()}`,
          exchange: signal.exchange,
         symbol: signal.symbol,
          side: signal.side,
          event_type: signal.event_type,
          qty: 0,
          price: 0,
          leverage: 10,
         realized_pnl: 0,
          status: "cancelled",
          mode: "demo", // Demo since it's just a log
          strategy_id: "auto_expire",
          error_message: `Auto-expired after TTL - signal exceeded expiration time (${signal.expires_at})`,
          created_at: new Date().toISOString()
        });

       console.log(`✅ Successfully expired exit signal for ${signal.symbol}`);
        
      } catch (err: any) {
       console.error(`❌ Failed to expire exit signal for ${signal.symbol}:`, err.message);
        // Continue processing other signals even if one fails
      }
    }

   console.log(`✅ Exit signal cleanup completed`);
    
  } catch (err: any) {
   console.error("❌ Critical error in exit signal cleanup:", err.message);
  }
}

// Start the background cleanup
// Run every 5 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

console.log(`🚀 Starting Exit Signal Queue Cleanup Service (checking every ${CLEANUP_INTERVAL / 1000}s)`);

// Verify Supabase connection first
(async () => {
  try {
   const { error } = await supabase.from("exit_signal_queue").select("count");
    if (error) {
     console.error("❌ CRITICAL: Cannot connect to Supabase!");
     console.error("Error:", JSON.stringify(error, null, 2));
     console.warn("⚠️ Exit signal cleanup will continue running but may fail");
    } else {
     console.log("✅ Supabase connection verified");
    }
  } catch (err: any) {
   console.error("❌ CRITICAL: Supabase connection test failed:", err.message);
  }
})();

// Initial check after 10 seconds
setTimeout(() => {
  cleanupExpiredExitSignals();
  
  // Then run periodically
  setInterval(cleanupExpiredExitSignals, CLEANUP_INTERVAL);
}, 10000);

// Export for manual triggering if needed
export { cleanupExpiredExitSignals as manualCleanup };
