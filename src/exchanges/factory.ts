import { BinanceClient } from "./binance";
import { BybitClient } from "./bybit";
import { supabase } from "../config/supabase";

export type ExchangeClient = BinanceClient | BybitClient;

/**
 * Create exchange client from user's stored API keys
 */
export async function getExchangeClient(
  userId: string,
  exchange: string
): Promise<{ client: ExchangeClient; exchange: string } | null> {
  const { data: apiKey } = await supabase
    .from("api_keys")
    .select("api_key, api_secret, testnet")
    .eq("user_id", userId)
    .eq("exchange", exchange.toLowerCase())
    .single();

  if (!apiKey) return null;

  const config = {
    apiKey: apiKey.api_key,
    apiSecret: apiKey.api_secret,
    testnet: apiKey.testnet || false,
  };

  if (exchange.toLowerCase() === "binance") {
    return { client: new BinanceClient(config), exchange: "binance" };
  } else if (exchange.toLowerCase() === "bybit") {
    return { client: new BybitClient(config), exchange: "bybit" };
  }

  return null;
}

/**
 * Get all configured exchange clients for a user
 */
export async function getAllExchangeClients(
  userId: string
): Promise<{ client: ExchangeClient; exchange: string }[]> {
  const { data: apiKeys } = await supabase
    .from("api_keys")
    .select("exchange, api_key, api_secret, testnet")
    .eq("user_id", userId);

  if (!apiKeys || apiKeys.length === 0) return [];

  return apiKeys
    .map((key) => {
      const config = {
        apiKey: key.api_key,
        apiSecret: key.api_secret,
        testnet: key.testnet || false,
      };

      if (key.exchange === "binance") {
        return { client: new BinanceClient(config), exchange: "binance" };
      } else if (key.exchange === "bybit") {
        return { client: new BybitClient(config), exchange: "bybit" };
      }
      return null;
    })
    .filter(Boolean) as { client: ExchangeClient; exchange: string }[];
}
