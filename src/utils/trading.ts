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
 * Round quantity to exchange step size with SAFETY CHECKS
 * - Never returns zero
 * - Respects minimum quantity
 * - Ensures valid order size
 * 
 * e.g., qty=0.0567, stepSize=0.001, minQty=0.001 → 0.056
 * e.g., qty=0.0005, stepSize=0.001, minQty=0.001 → 0.001 (enforced minimum)
 */
export function roundQtyByStep(qty: number, stepSize: number, minQty: number = 0): number {
  if (stepSize <= 0) stepSize = 0.001; // Default step size
  
  // Step 1: Round down by step size
  let rounded = Math.floor(qty / stepSize) * stepSize;
  
  // Step 2: CRITICAL - Never allow zero!
  if (rounded <= 0) {
    console.log(`⚠️ QTY ROUNDING: Quantity ${qty} would round to zero with stepSize ${stepSize}, enforcing minimum`);
    rounded = minQty > 0 ? minQty : stepSize;
  }
  
  // Step 3: Enforce minimum quantity if specified
  if (minQty > 0 && rounded < minQty) {
    console.log(`⚠️ QTY ROUNDING: Rounded qty ${rounded} below minQty ${minQty}, using minimum`);
    rounded = minQty;
  }
  
  // Step 4: Ensure precision matches step size
  const precision = Math.max(0, Math.ceil(-Math.log10(stepSize)));
  rounded = parseFloat(rounded.toFixed(precision));
  
  // Step 5: Final safety check
  if (rounded <= 0) {
    rounded = stepSize; // Absolute fallback
  }
  
  return rounded;
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
