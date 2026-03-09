import crypto from "crypto";
import axios, { AxiosInstance } from "axios";

interface BybitConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export class BybitClient {
  private client: AxiosInstance;
  private apiKey: string;
  private secret: string;

  constructor(config: BybitConfig) {
    const baseURL = config.testnet
      ? "https://api-testnet.bybit.com"
      : "https://api.bybit.com";

    this.apiKey = config.apiKey;
    this.secret = config.apiSecret;
    this.client = axios.create({ baseURL, timeout: 10000 });
  }

  private getHeaders(params: string): Record<string, string> {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const preSign = `${timestamp}${this.apiKey}${recvWindow}${params}`;
    const signature = crypto
      .createHmac("sha256", this.secret)
      .update(preSign)
      .digest("hex");

    return {
      "X-BAPI-API-KEY": this.apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
      "Content-Type": "application/json",
    };
  }

  private async get(path: string, params: Record<string, any> = {}): Promise<any> {
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const { data } = await this.client.get(`${path}?${query}`, {
      headers: this.getHeaders(query),
    });
    if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);
    return data.result;
  }

  private async post(path: string, body: Record<string, any>): Promise<any> {
    const bodyStr = JSON.stringify(body);
    const { data } = await this.client.post(path, body, {
      headers: this.getHeaders(bodyStr),
    });
    if (data.retCode !== 0) throw new Error(`Bybit: ${data.retMsg}`);
    return data.result;
  }

  // ===== Balance =====

  async getBalance(): Promise<{
    totalBalance: number;
    availableBalance: number;
    unrealizedPnl: number;
  }> {
    const result = await this.get("/v5/account/wallet-balance", {
      accountType: "UNIFIED",
    });
    const usdtCoin = result.list?.[0]?.coin?.find((c: any) => c.coin === "USDT") || {};
    return {
      totalBalance: parseFloat(usdtCoin.walletBalance || "0"),
      availableBalance: parseFloat(usdtCoin.availableToWithdraw || "0"),
      unrealizedPnl: parseFloat(usdtCoin.unrealisedPnl || "0"),
    };
  }

  // ===== Positions =====

  async getPositions(symbol?: string): Promise<any[]> {
    const params: Record<string, any> = { category: "linear", settleCoin: "USDT" };
    if (symbol) params.symbol = symbol;

    const result = await this.get("/v5/position/list", params);
    return (result.list || [])
      .filter((p: any) => parseFloat(p.size) > 0)
      .map((p: any) => ({
        exchange: "bybit",
        symbol: p.symbol,
        side: p.side === "Buy" ? "LONG" : "SHORT",
        size: parseFloat(p.size),
        entryPrice: parseFloat(p.avgPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedPnl: parseFloat(p.unrealisedPnl),
        leverage: parseInt(p.leverage),
        marginType: p.tradeMode === 0 ? "cross" : "isolated",
        liquidationPrice: parseFloat(p.liqPrice || "0"),
      }));
  }

  // ===== Mark Price =====

  async getMarkPrice(symbol: string): Promise<number> {
    const result = await this.get("/v5/market/tickers", {
      category: "linear",
      symbol,
    });
    return parseFloat(result.list?.[0]?.markPrice || "0");
  }

  // ===== Set Leverage =====

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.post("/v5/position/set-leverage", {
        category: "linear",
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      });
    } catch (err: any) {
      // Ignore "leverage not modified" error (110043)
      if (!err.message?.includes("110043")) throw err;
    }
  }

  // ===== Symbol Info & Availability =====

  async getSymbolInfo(symbol: string): Promise<{
    tickSize: number;
    stepSize: number;
    minQty: number;
    minNotional: number;
  } | null> {
    const result = await this.get("/v5/market/instruments-info", {
      category: "linear",
      symbol,
    });
    const info = result.list?.[0];
    if (!info) return null;

    return {
      tickSize: parseFloat(info.priceFilter?.tickSize || "0.01"),
      stepSize: parseFloat(info.lotSizeFilter?.qtyStep || "0.001"),
      minQty: parseFloat(info.lotSizeFilter?.minOrderQty || "0.001"),
      minNotional: parseFloat(info.lotSizeFilter?.minNotionalValue || "5"),
    };
  }

  async isSymbolAvailable(symbol: string): Promise<boolean> {
    try {
      const result = await this.get("/v5/market/instruments-info", {
        category: "linear",
        symbol,
      });
      
      return result.list && result.list.length > 0;
    } catch (err: any) {
      console.warn(`Bybit: Symbol ${symbol} not available:`, err?.message || err);
      return false;
    }
  }

  // ===== Place Order =====

  async placeOrder(params: {
    symbol: string;
    side: "Buy" | "Sell";
    quantity: number;
    type?: "Market" | "Limit";
    price?: number;
    reduceOnly?: boolean;
  }): Promise<any> {
    const orderBody: Record<string, any> = {
      category: "linear",
      symbol: params.symbol,
      side: params.side,
      orderType: params.type || "Market",
      qty: String(params.quantity),
    };

    if (params.reduceOnly) orderBody.reduceOnly = true;
    
    // For Limit orders, add price and timeInForce
    if (params.type === "Limit" && params.price) {
      orderBody.price = String(params.price);
      orderBody.timeInForce = "GTC";
    } else if (params.type === "Market") {
      // For Market orders, explicitly set timeInForce
      orderBody.timeInForce = "IOC"; // Immediate or Cancel for market orders
    } else {
      // Default for unspecified type (treat as Market)
      orderBody.orderType = "Market";
      orderBody.timeInForce = "IOC";
    }

    const result = await this.post("/v5/order/create", orderBody);
    return {
      orderId: result.orderId,
      symbol: params.symbol,
      side: params.side,
      qty: params.quantity,
      status: "submitted",
    };
  }

  // ===== Close Position =====

  async closePosition(symbol: string): Promise<any> {
    // Get ALL positions first (more reliable than filtering by symbol)
    const allPositions = await this.getPositions();
    
    // Find the specific position
    const pos = allPositions.find((p) => p.symbol === symbol);
    
    if (!pos) {
      console.error(`❌ Bybit: No open position found for ${symbol}. Available: ${allPositions.map(p => p.symbol).join(", ") || "NONE"}`);
      throw new Error(`No open position for ${symbol}`);
    }

    console.log(`📤 Bybit: Closing ${symbol} ${pos.side} position of size ${pos.size}`);
    
    try {
      const result = await this.placeOrder({
        symbol,
        side: pos.side === "LONG" ? "Sell" : "Buy",
        quantity: pos.size,
        reduceOnly: true,
      });
      
      console.log(`✅ Bybit: Position closed successfully for ${symbol}`);
      return result;
    } catch (err: any) {
      console.error(`❌ Bybit: Failed to close position for ${symbol}:`, err.message);
      throw err;
    }
  }

  // ===== Trade History =====

  async getTradeHistory(symbol?: string, limit = 50): Promise<any[]> {
    const params: Record<string, any> = { category: "linear", limit };
    if (symbol) params.symbol = symbol;

    const result = await this.get("/v5/execution/list", params);
    return (result.list || []).map((t: any) => ({
      id: t.execId,
      symbol: t.symbol,
      side: t.side,
      price: parseFloat(t.execPrice),
      qty: parseFloat(t.execQty),
      realizedPnl: parseFloat(t.closedPnl || "0"),
      commission: parseFloat(t.execFee),
      time: new Date(parseInt(t.execTime)).toISOString(),
    }));
  }
}
