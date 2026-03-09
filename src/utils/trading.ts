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
 * Round price to exchange tick size
 * e.g., price=67234.567, tickSize=0.01→ 67234.56
 */
export function roundPriceByTick(price: number, tickSize: number): number {
  if (tickSize <= 0) return price;
 const precision = Math.max(0, Math.ceil(-Math.log10(tickSize)));
 const rounded = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(precision));
}

/**
 * Round quantity to exchange step size with SAFETY CHECKS
 * - Never returns zero
 * - Respects minimum quantity
 * - When qty is too small, rounds UP to minQty instead of truncating to zero
 * - Ensures valid order size
 * 
 * e.g., qty=0.0567, stepSize=0.001→ 0.056
 * e.g., qty=0.0005, stepSize=0.001, minQty=0.001→ 0.001 (enforced minimum, NOT zero)
 */
export function roundQtyByStep(qty: number, stepSize: number, minQty: number= 0): number {
  if (stepSize <= 0) stepSize = 0.001; // Default step size
  
  // Step 1: Round down by step size
  let rounded = Math.floor(qty / stepSize) * stepSize;
  
  // Step 2: CRITICAL - If rounding results in zero, CEIL to stepSize instead
  if (rounded <= 0) {
   console.log(`⚠️ QTY ROUNDING: Quantity ${qty} would round to zero with stepSize ${stepSize}, rounding UP to stepSize`);
    rounded = stepSize;
  }
  
  // Step 3: Enforce minimum quantity if specified (overrides stepSize rounding if larger)
  if (minQty > 0 && rounded < minQty) {
  console.log(`⚠️ QTY ROUNDING: Rounded qty ${rounded} below minQty ${minQty}, using minimum`);
    rounded = minQty;
  }
  
  // Step 4: Ensure precision matches step size
 const precision = Math.max(0, Math.ceil(-Math.log10(stepSize)));
  rounded = parseFloat(rounded.toFixed(precision));
  
  // Step 5: Final safety check - should never reach here but just in case
  if (rounded <= 0) {
    rounded = Math.max(minQty, stepSize); // Use larger of minQty or stepSize
  }
  
 console.log(`✅ QTY ROUNDING: Original ${qty} -> Rounded ${rounded} (stepSize=${stepSize}, minQty=${minQty})`);
  return rounded;
}
