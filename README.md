# Arts Trading Bot — Backend Reference

> Complete Node.js/Express backend for automated trading via TradingView webhooks.
> Supports **Binance Futures** and **Bybit V5 Linear** with both **demo** and **real** execution modes.

## Quick Start

```bash
mkdir arts-trading-backend && cd arts-trading-backend
npm init -y
npm install express typescript @types/express @types/node \
  @supabase/supabase-js jsonwebtoken bcryptjs axios dotenv zod cors crypto
npm install -D ts-node-dev @types/jsonwebtoken @types/bcryptjs @types/cors
npx tsc --init
```

Add to `package.json` scripts:
```json
"dev": "ts-node-dev --respawn src/server.ts",
"build": "tsc",
"start": "node dist/server.js"
```

## Project Structure

```
/src
  /config        - env, supabase client
  /exchanges     - Binance & Bybit API clients
  /middleware     - JWT auth middleware
  /routes        - express routers
  /utils         - helpers (rounding, normalization)
  server.ts      - entry point
.env
```

## Supabase Database Schema

Run these SQL commands in your Supabase SQL editor:

```sql
-- Users table
CREATE TABLE local_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## App Settings & Webhook Secret Management

Each user has their **own unique webhook secret** stored in the database. This secret:
- ✅ Is automatically generated on registration (48-character hex string)
- ✅ Can be customized by the user (minimum 8 characters)
- ✅ Can be regenerated at any time via API
- ✅ Is used to authenticate TradingView webhook alerts
- ✅ Stored securely in `app_settings` table

### API Endpoints for Webhook Secret

#### GET `/settings/app` — Fetch App Settings including Webhook Secret
```bash
curl -X GET http://localhost:4000/settings/app \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "status": "ok",
  "message": "App settings fetched",
  "details": {
    "webhook_secret": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4",
    "default_exchange": "binance",
    "mode": "demo",
    "user_id": "uuid-here",
    "updated_at": "2024-01-01T00:00:00Z"
  },
  "webhook_info": {
    "secret": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4",
    "note": "Use this secret in your TradingView alert passphrase field"
  }
}
```

#### PUT `/settings/app` — Update App Settings & Custom Webhook Secret
```bash
curl -X PUT http://localhost:4000/settings/app \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook_secret": "my_custom_secret_123",
    "default_exchange": "bybit",
    "mode": "real"
  }'
```

**Requirements:**
- `webhook_secret`: Minimum 8 characters (optional, auto-generates if not provided)
- `default_exchange`: "binance" or "bybit"
- `mode`: "demo" or "real"

### POST /settings/app/generate-webhook-secret — Generate New Random Secret
```bash
curl -X POST http://localhost:4000/settings/app/generate-webhook-secret \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "status": "generated",
  "message": "New webhook secret generated successfully",
  "details": {
    "webhook_secret": "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a",
    "note": "Update your TradingView alerts with this new secret"
  }
}
```

## Viewing Webhook URL & Events

### GET `/webhook-events/info` — Get Your Webhook URL & Setup Info
```bash
curl -X GET http://localhost:4000/webhook-events/info \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "status": "ok",
  "message": "Webhook configuration info",
  "webhook_url": "http://localhost:4000/webhook",
  "webhook_secret": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4",
  "configuration": {
    "default_exchange": "binance",
    "mode": "demo",
    "has_secret": true
  },
  "example_payload": {
    "passphrase": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4",
    "event_type": "entry_long",
    "symbol": "{{ticker}}",
    "amount": "500"
  },
  "tradingview_setup": {
    "alert_message": "{\n  \"passphrase\": \"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4\",\n  \"event_type\": \"entry_long\",\n  \"symbol\": \"{{ticker}}\",\n  \"amount\": \"500\"\n}",
    "webhook_url": "http://localhost:4000/webhook"
  }
}
```

This endpoint gives you everything you need to set up TradingView alerts:
- ✅ Your unique webhook URL
- ✅ Your webhook secret (passphrase)
- ✅ Example JSON payload ready to copy-paste
- ✅ Pre-formatted alert message for TradingView

### GET `/webhook-events/` — View All Webhook Events (History)
```bash
curl -X GET http://localhost:4000/webhook-events \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "status": "ok",
  "message": "Webhook events fetched",
  "details": [
    {
      "id": "uuid-here",
      "user_id": "uuid-here",
      "event_id": "evt_123456",
      "event_type": "entry_long",
      "strategy_id": "manual",
      "symbol": "BTCUSDT",
      "exchange": "binance",
      "status": "executed",
      "payload": {
        "passphrase": "...",
        "event_type": "entry_long",
        "symbol": "BTCUSDT",
        "amount": "500"
      },
      "created_at": "2024-01-01T12:00:00Z"
    }
  ],
  "count": 1
}
```

Shows last 200 webhook events with full details including payloads and execution status.

### GET `/webhook-events/stats` — View Webhook Statistics
```bash
curl -X GET http://localhost:4000/webhook-events/stats \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Response:**
```json
{
  "success": true,
  "status": "ok",
  "message": "Webhook statistics",
  "stats": {
    "total": 150,
    "by_status": {
      "received": 10,
      "processed": 50,
      "executed": 80,
      "failed": 5,
      "duplicate": 5
    },
    "last_24_hours": 25
  }
}
```

Get quick insights into your webhook activity:
- Total events processed
- Breakdown by status (received, processed, executed, failed, duplicate)
- Activity in last 24 hours

### How Webhook Authentication Works

1. **User registers** → System generates unique 48-char webhook secret
2. **User views secret** via `GET /settings/app` endpoint
3. **User copies secret** to TradingView alert's "Message" JSON as `passphrase` field
4. **Webhook receives alert** → Validates `passphrase` against user's stored `webhook_secret`
5. **If match** → Processes the trade signal
6. **If no match** → Returns 401 Unauthorized

### TradingView Alert Setup Example

In your TradingView alert settings:

**Message (JSON):**
```json
{
  "passphrase": "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4",
  "event_type": "entry_long",
  "symbol": "{{ticker}}",
  "amount": "500"
}
```

⚠️ **Important:** The `passphrase` value must exactly match your `webhook_secret` from the API!


-- API Keys (encrypted in production)
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE NOT NULL,
  exchange TEXT NOT NULL, -- 'binance' or 'bybit'
  api_key TEXT NOT NULL,
  api_secret TEXT NOT NULL,
  testnet BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, exchange)
);

-- Risk Settings
CREATE TABLE risk_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  size_type TEXT DEFAULT 'fixed_usdt', -- 'fixed_usdt', 'percentage', 'base_qty'
  size_value NUMERIC DEFAULT 500,
  max_leverage INTEGER DEFAULT 20,
  max_positions INTEGER DEFAULT 5,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- App Settings
CREATE TABLE app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES local_users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  webhook_secret TEXT NOT NULL,
  default_exchange TEXT DEFAULT 'binance',
  mode TEXT DEFAULT 'demo', -- 'demo' or 'real'
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Webhook Events
CREATE TABLE webhook_events (
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

-- Trades
CREATE TABLE trades (
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

-- Positions
CREATE TABLE positions (
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

-- Exchange Symbol Info (cache)
CREATE TABLE exchange_symbol_info (
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

-- Indexes for performance
CREATE INDEX idx_trades_user ON trades(user_id, created_at DESC);
CREATE INDEX idx_webhook_events_user ON webhook_events(user_id, created_at DESC);
CREATE INDEX idx_webhook_events_dedup ON webhook_events(user_id, event_id, event_type);
CREATE INDEX idx_positions_user ON positions(user_id, state);
```

## Webhook — Accepts ANY Format

The webhook is **format-flexible**. All these payloads work:

### TradingView Standard
```json
{
  "passphrase": "your_secret",
  "event_type": "entry_long",
  "symbol": "{{ticker}}",
  "amount": "10%"
}
```

### Simple Buy/Sell
```json
{
  "passphrase": "your_secret",
  "action": "buy",
  "ticker": "BTCUSDT",
  "qty": 0.01
}
```

### Custom Strategy
```json
{
  "passphrase": "your_secret",
  "signal": "long",
  "pair": "ETHUSDT",
  "amount": "500",
  "leverage": 10,
  "exchange": "bybit",
  "mode": "real"
}
```

### Close Position
```json
{
  "passphrase": "your_secret",
  "action": "close",
  "symbol": "{{ticker}}"
}
```

### Take Profit - TP1 to TP5 (Partial/Full Exit)
```json
{
  "passphrase": "your_secret",
  "event_type": "tp1",
  "symbol": "{{ticker}}",
  "tp_price": 65000,
  "percentage": 25
}
```

**TP Levels:**
- `tp1` — 25% close (or custom percentage)
- `tp2` — 25% close (or custom percentage)
- `tp3` — 25% close (or custom percentage)
- `tp4` — 25% close (or custom percentage)
- `tp5` — Remaining 100% close

**Fields:**
- `tp_price` or `take_profit_price` — Limit order price (optional, if omitted uses market order)
- `percentage` or `percent` — Close percentage of position (optional, defaults vary by TP level)

### Stop Loss (Emergency Close)
```json
{
  "passphrase": "your_secret",
  "event_type": "sl",
  "symbol": "{{ticker}}",
  "sl_price": 62000
}
```

### Update Stop Loss (Move SL)
```json
{
  "passphrase": "your_secret",
  "event_type": "sl_update",
  "symbol": "{{ticker}}",
  "sl_price": 63000
}
```

**SL Fields:**
- `sl_price` or `stop_loss_price` — Stop loss trigger price

### Complete TradingView Alert Example with TP/SL
```json
{
  "passphrase": "your_webhook_secret",
  "event_type": "entry_long",
  "symbol": "{{ticker}}",
  "amount": "500",
  "leverage": 20,
  "tp1_price": {{strategy.order.price.tp1}},
  "tp2_price": {{strategy.order.price.tp2}},
  "tp3_price": {{strategy.order.price.tp3}},
  "sl_price": {{strategy.order.price.stop_loss}}
}
```

### Supported Event Types (auto-detected)

#### Entry Signals
| Input | Resolved As |
|-------|-------------|
| `buy`, `long`, `entry_long`, `open_long` | `entry_long` |
| `sell`, `short`, `entry_short`, `open_short` | `entry_short` |

#### Take Profit Signals
| Input | Resolved As | Description |
|-------|-------------|-------------|
| `tp1`, `take_profit_1` | `tp1` | Take profit level 1 (typically 25%) |
| `tp2`, `take_profit_2` | `tp2` | Take profit level 2 (typically 25%) |
| `tp3`, `take_profit_3` | `tp3` | Take profit level 3 (typically 25%) |
| `tp4`, `take_profit_4` | `tp4` | Take profit level 4 (typically 25%) |
| `tp5`, `take_profit_5` | `tp5` | Take profit level 5 (final exit) |
| `tp`, `take_profit` | `tp` | Generic take profit |

#### Stop Loss Signals
| Input | Resolved As | Description |
|-------|-------------|-------------|
| `sl`, `stop_loss`, `stoploss` | `sl` | Stop loss trigger (emergency close) |
| `sl_update`, `stop_loss_update`, `update_sl`, `move_sl` | `sl_update` | Update/move stop loss price |

#### Exit/Close Signals
| Input | Resolved As |
|-------|-------------|
| `close_long`, `exit_long`, `tp_long`, `sl_long` | `exit_long` |
| `close_short`, `exit_short`, `tp_short`, `sl_short` | `exit_short` |
| `close`, `exit`, `close_all`, `flatten` | `exit` / `close_all` |

## Exchange API Endpoints Used

### Binance Futures
- `GET /fapi/v2/balance` — Account balance
- `GET /fapi/v2/positionRisk` — Open positions
- `GET /fapi/v1/premiumIndex` — Mark price
- `POST /fapi/v1/leverage` — Set leverage
- `POST /fapi/v1/marginType` — Set margin type
- `POST /fapi/v1/order` — Place order
- `GET /fapi/v1/userTrades` — Trade history
- `GET /fapi/v1/income` — Funding income
- `GET /fapi/v1/exchangeInfo` — Symbol info

### Bybit V5
- `GET /v5/account/wallet-balance` — Account balance
- `GET /v5/position/list` — Open positions
- `GET /v5/market/tickers` — Mark price
- `POST /v5/position/set-leverage` — Set leverage
- `POST /v5/order/create` — Place order
- `GET /v5/execution/list` — Trade history
- `GET /v5/market/instruments-info` — Symbol info

## Demo vs Real Mode

- **Demo mode**: Webhook logs trades in DB but does NOT execute on exchange
- **Real mode**: Webhook actually places orders on Binance/Bybit using your API keys
- Mode can be set per-webhook (`"mode": "real"`) or globally in app settings
