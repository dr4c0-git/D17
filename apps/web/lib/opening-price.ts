// How the official pool's opening price compares with what buyers paid.
//
// When the sale closes, the launch pairs the pool's WETH (the raise minus the creator's
// share and the protocol fee, plus take-back fees) with `lpTokens x sold / saleTokens`
// tokens (D17Launch.finalize). The average price buyers paid is raise / sold tokens, so,
// leaving take-back fees aside:
//
//   opening price / average price paid = (saleTokens / lpTokens) x (1 - creator% - fee%)
//
// The contract accepts any LP allocation from 1 token up. A launch that pairs the raise
// with very few tokens opens far above what buyers paid: the first sellers can then drain
// the pool at the expense of everyone else.

/** From this multiple up, a launch is flagged as predatory everywhere in the app. */
export const PREDATORY_OPENING_MULTIPLE = 2;

/** Opening price divided by the average price paid, or null when it cannot be computed. */
export function openingPriceMultiple(saleTokens: bigint, lpTokens: bigint, creatorEthPct: number, protocolFeePct: number) {
  if (saleTokens <= 0n || lpTokens <= 0n) return null;
  return (Number(saleTokens) / Number(lpTokens)) * (1 - (creatorEthPct + protocolFeePct) / 100);
}

export function isPredatory(multiple: number | null) {
  return multiple !== null && multiple >= PREDATORY_OPENING_MULTIPLE;
}

/** "about 2.4x", "about the same as", "about 0.5x" - for plain sentences. With equal shares
 *  for buyers and the pool the multiple is just under 1 (the creator's share and the fee
 *  leave the pool), which reads as "about the same". */
export function formatMultiple(multiple: number) {
  if (multiple >= 0.85 && multiple <= 1.15) return "about the same as";
  const digits = multiple >= 10 ? 0 : 1;
  return `about ${multiple.toLocaleString("en-US", { maximumFractionDigits: digits })}x`;
}
