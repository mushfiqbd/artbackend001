import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "4000"),
  nodeEnv: process.env.NODE_ENV || "development",
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY!,
  jwtSecret: process.env.JWT_SECRET!,
  jwtExpiresIn: (process.env.JWT_EXPIRES_IN || "7d") as string,
  fixedNotionalFallback: parseFloat(process.env.FIXED_NOTIONAL_FALLBACK_USDT || "500"),
  pendingEntryTimeout: Math.min(10, Math.max(3, parseInt(process.env.PENDING_ENTRY_TIMEOUT_MINUTES || "5"))),
};
