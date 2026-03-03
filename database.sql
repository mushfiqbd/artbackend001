-- Arts Trading Bot - Supabase schema
-- Run this in your Supabase SQL editor.

-- ===== Users =====
CREATE TABLE IF NOT EXISTS local_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===== API Keys =====
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE NOT NULL,
  exchange TEXT NOT NULL, -- 'binance' or 'bybit'
  api_key TEXT NOT NULL,
  api_secret TEXT NOT NULL,
  testnet BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, exchange)
);

-- ===== Risk Settings =====
CREATE TABLE IF NOT EXISTS risk_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  size_type TEXT DEFAULT 'fixed_usdt', -- 'fixed_usdt', 'percentage', 'base_qty'
  size_value NUMERIC DEFAULT 500,
  max_leverage INTEGER DEFAULT 20,
  max_positions INTEGER DEFAULT 5,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ===== App Settings =====
CREATE TABLE IF NOT EXISTS app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  webhook_secret TEXT NOT NULL,
  default_exchange TEXT DEFAULT 'binance',
  mode TEXT DEFAULT 'demo', -- 'demo' or 'real'
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ===== Webhook Events =====
CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  strategy_id TEXT,
  symbol TEXT NOT NULL,
  exchange TEXT DEFAULT 'binance',
  status TEXT DEFAULT 'received', -- 'received', 'processed', 'executed', 'failed', 'duplicate'
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===== Trades (Execution Log) =====
CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE NOT NULL,
  event_id TEXT,
  exchange TEXT,
  symbol TEXT NOT NULL,
  side TEXT, -- 'BUY' or 'SELL'
  event_type TEXT,
  qty NUMERIC DEFAULT 0,
  price NUMERIC DEFAULT 0,
  leverage INTEGER DEFAULT 10,
  realized_pnl NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'pending', -- 'pending', 'filled', 'failed', 'demo_executed', 'dry_run'
  mode TEXT DEFAULT 'demo', -- 'demo' or 'real'
  strategy_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ===== Positions (State Machine) =====
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE NOT NULL,
  symbol TEXT NOT NULL,
  exchange TEXT DEFAULT 'binance',
  side TEXT NOT NULL, -- 'LONG' or 'SHORT'
  state TEXT DEFAULT 'OPEN', -- 'PENDING_ENTRY', 'OPEN', 'CLOSING', 'CLOSED'
  entry_price NUMERIC,
  close_price NUMERIC,
  qty NUMERIC DEFAULT 0,
  pnl NUMERIC,
  close_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ===== Exchange Symbol Info Cache =====
CREATE TABLE IF NOT EXISTS exchange_symbol_info (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  tick_size NUMERIC NOT NULL,
  step_size NUMERIC NOT NULL,
  min_qty NUMERIC NOT NULL,
  min_notional NUMERIC DEFAULT 5,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(symbol, exchange)
);

-- ===== Indexes =====
CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_user ON webhook_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_dedup ON webhook_events(user_id, event_id, event_type);
CREATE INDEX IF NOT EXISTS idx_positions_user ON positions(user_id, state);

