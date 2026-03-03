import crypto from "crypto";
import axios, { AxiosInstance } from "axios";

interface BinanceConfig {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export class BinanceClient {
  private client: AxiosInstance;
  private secret: string;

  constructor(config: BinanceConfig) {
    const baseURL = config.testnet
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";

    this.secret = config.apiSecret;
    this.client = axios.create({
      baseURL,
      headers: { "X-MBX-APIKEY": config.apiKey },
      timeout: 10000,
    });
  }

  private sign(params: Record<string, any>): string {
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const signature = crypto
      .createHmac("sha256", this.secret)
      .update(query)
      .digest("hex");
    return `${query}&signature=${signature}`;
  }

  // ===== Account & Balance =====

  async getBalance(): Promise<{
    totalBalance: number;
    availableBalance: number;
    unrealizedPnl: number;
  }> {
    const params: Record<string, any> = {
      timestamp: Date.now(),
      recvWindow: 5000,
    };
    const { data } = await this.client.get(`/fapi/v2/balance?${this.sign(params)}`);
    const usdt = data.find((b: any) => b.asset === "USDT") || {};
    return {
      totalBalance: parseFloat(usdt.balance || "0"),
      availableBalance: parseFloat(usdt.availableBalance || "0"),
      unrealizedPnl: parseFloat(usdt.crossUnPnl || "0"),
    };
  }

  // ===== Positions =====

  async getPositions(): Promise<any[]> {
    const params: Record<string, any> = { timestamp: Date.now(), recvWindow: 5000 };
    const { data } = await this.client.get(`/fapi/v2/positionRisk?${this.sign(params)}`);
    return data
      .filter((p: any) => parseFloat(p.positionAmt) !== 0)
      .map((p: any) => ({
        exchange: "binance",
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
        size: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        unrealizedPnl: parseFloat(p.unRealizedProfit),
        leverage: parseInt(p.leverage),
        marginType: p.marginType,
        liquidationPrice: parseFloat(p.liquidationPrice),
      }));
  }

  // ===== Mark Price =====

  async getMarkPrice(symbol: string): Promise<number> {
    const { data } = await this.client.get(`/fapi/v1/premiumIndex?symbol=${symbol}`);
    return parseFloat(data.markPrice);
  }

  // ===== Set Leverage =====

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const params: Record<string, any> = {
      symbol,
      leverage: Math.min(125, Math.max(1, leverage)),
      timestamp: Date.now(),
      recvWindow: 5000,
    };
    try {
      await this.client.post(`/fapi/v1/leverage?${this.sign(params)}`);
    } catch (err: any) {
      // Ignore "No need to change leverage" error
      if (err?.response?.data?.code !== -4028) throw err;
    }
  }

  // ===== Set Margin Type =====

  async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED"): Promise<void> {
    const params: Record<string, any> = {
      symbol,
      marginType,
      timestamp: Date.now(),
      recvWindow: 5000,
    };
    try {
      await this.client.post(`/fapi/v1/marginType?${this.sign(params)}`);
    } catch (err: any) {
      // Ignore "No need to change margin type" error
      if (err?.response?.data?.code !== -4046) throw err;
    }
  }

  // ===== Place Order =====

  async placeOrder(params: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    type?: "MARKET" | "LIMIT";
    price?: number;
    reduceOnly?: boolean;
  }): Promise<any> {
    const orderParams: Record<string, any> = {
      symbol: params.symbol,
      side: params.side,
      type: params.type || "MARKET",
      quantity: params.quantity,
      timestamp: Date.now(),
      recvWindow: 5000,
    };

    if (params.reduceOnly) orderParams.reduceOnly = "true";
    if (params.type === "LIMIT" && params.price) {
      orderParams.price = params.price;
      orderParams.timeInForce = "GTC";
    }

    const { data } = await this.client.post(`/fapi/v1/order?${this.sign(orderParams)}`);
    return {
      orderId: data.orderId,
      symbol: data.symbol,
      side: data.side,
      type: data.type,
      qty: parseFloat(data.origQty),
      price: parseFloat(data.avgPrice || data.price || "0"),
      status: data.status,
      executedQty: parseFloat(data.executedQty || "0"),
    };
  }

  // ===== Close Position =====

  async closePosition(symbol: string): Promise<any> {
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) throw new Error(`No open position for ${symbol}`);

    return this.placeOrder({
      symbol,
      side: pos.side === "LONG" ? "SELL" : "BUY",
      quantity: pos.size,
      reduceOnly: true,
    });
  }

  // ===== Symbol Info =====

  async getSymbolInfo(symbol: string): Promise<{
    tickSize: number;
    stepSize: number;
    minQty: number;
    minNotional: number;
  } | null> {
    const { data } = await this.client.get("/fapi/v1/exchangeInfo");
    const info = data.symbols.find((s: any) => s.symbol === symbol);
    if (!info) return null;

    const priceFilter = info.filters.find((f: any) => f.filterType === "PRICE_FILTER");
    const lotFilter = info.filters.find((f: any) => f.filterType === "LOT_SIZE");
    const minNotionalFilter = info.filters.find((f: any) => f.filterType === "MIN_NOTIONAL");

    return {
      tickSize: parseFloat(priceFilter?.tickSize || "0.01"),
      stepSize: parseFloat(lotFilter?.stepSize || "0.001"),
      minQty: parseFloat(lotFilter?.minQty || "0.001"),
      minNotional: parseFloat(minNotionalFilter?.notional || "5"),
    };
  }

  // ===== Trade History =====

  async getTradeHistory(symbol?: string, limit = 50): Promise<any[]> {
    const params: Record<string, any> = {
      timestamp: Date.now(),
      recvWindow: 5000,
      limit,
    };
    if (symbol) params.symbol = symbol;

    const { data } = await this.client.get(`/fapi/v1/userTrades?${this.sign(params)}`);
    return data.map((t: any) => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      price: parseFloat(t.price),
      qty: parseFloat(t.qty),
      realizedPnl: parseFloat(t.realizedPnl),
      commission: parseFloat(t.commission),
      time: new Date(t.time).toISOString(),
    }));
  }

  // ===== Income (Funding Rate) =====

  async getIncome(incomeType?: string, limit = 50): Promise<any[]> {
    const params: Record<string, any> = {
      timestamp: Date.now(),
      recvWindow: 5000,
      limit,
    };
    if (incomeType) params.incomeType = incomeType;

    const { data } = await this.client.get(`/fapi/v1/income?${this.sign(params)}`);
    return data.map((i: any) => ({
      asset: i.asset,
      income: parseFloat(i.income),
      incomeType: i.incomeType,
      time: new Date(i.time).toISOString(),
      symbol: i.symbol,
    }));
  }
}
