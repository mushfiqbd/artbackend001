/**
 * Normalize exchange symbol format
 * e.g., "BINANCE:BTCUSDT" → "BTCUSDT"
 *       "BTCUSDT.P" → "BTCUSDT"
 */
export function normalizeSymbol(raw: string): string {
  let symbol = raw.toUpperCase();
  // Remove exchange prefix
  if (symbol.includes(":")) symbol = symbol.split(":")[1];
  // Remove perpetual suffix
  if (symbol.endsWith(".P")) symbol = symbol.slice(0, -2);
  return symbol;
}

/**
 * Round quantity to exchange step size
 * e.g., qty=0.0567, stepSize=0.001 → 0.056
 */
export function roundQtyByStep(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const precision = Math.max(0, Math.ceil(-Math.log10(stepSize)));
  const rounded = Math.floor(qty / stepSize) * stepSize;
  return parseFloat(rounded.toFixed(precision));
}

/**
 * Round price to exchange tick size
 * e.g., price=67234.567, tickSize=0.01 → 67234.56
 */
export function roundPriceByTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
  const precision = Math.max(0, Math.ceil(-Math.log10(tickSize)));
  const rounded = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(precision));
}
