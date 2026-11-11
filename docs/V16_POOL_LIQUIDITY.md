# V16 note - the liquidity that stays in the pool

A discussion note for V16, not a decision: the problem in numbers, the options we see,
their trade-offs, and a recommendation. Nothing here is implemented.

## 1. The problem

Every D17 pool is a full-range Uniswap V2 pair whose LP tokens the vault holds forever.
On a constant-product curve, selling tokens can never take all of the WETH out: each
token sold gets less than the previous one, and the last WETH is only reached with an
infinite number of tokens.

Take a pool opened with `W` WETH and `L` tokens, and `S` tokens in holders' hands (the
tokens bought in the sale, plus the creator allocation as it vests). If every holder
sells everything into the pool, the pool ends with

```
WETH left = W x L / (L + S)
```

With the default split (45% of supply for buyers, 45% in the pool, 5% for the creator)
and a sale that sold out, `L = 45`, `S = 45 + 5`: **47% of the pool's WETH stays in the
pair**. The pool receives about 93% of the raise (after the creator's 5% and the 2% fee),
so that is **about 44% of the raise**. The ratio does not depend on how much of the sale
sold (the LP allocation is scaled to it), only on the split.

That WETH is not lost while holders remain: it is what they sell into, and it keeps a
price floor under the last holders. It becomes dead value only once trading has
stopped: nobody can withdraw it, ever.

Constraints any fix must keep:

- **No rug path.** No person (creator, D17, anyone) may be able to take liquidity out
  while the token is alive.
- **The value belongs to the token's holders first**, not to the creator, the early
  participants or D17.
- **No new trust**: no keeper, oracle or multisig deciding when it happens.
- **Not gameable** by someone who accumulates tokens or manipulates the pool just before
  a trigger.

## 2. Options

### A. Keep it as it is

Permanent lock, no change. Simple and already audited by then, but about 44% of every
raise ends up frozen once a token is no longer traded. This is the baseline the others
are measured against.

### B. Harvest only the trading fees

Uniswap V2 adds its 0.3% swap fee to the reserves, so the pool's `k` grows with volume.
The vault could periodically burn exactly the LP share that corresponds to that growth
since the last harvest (the standard "fee-only" calculation: remove
`LP x (1 - sqrt(k_last / k_now))`), keep the original depth intact, burn the token side
and send the WETH side to buybacks.

- Pros: the original liquidity never moves; simple to reason about; turns trading into a
  steady flow for the token (or the ecosystem).
- Cons: **does not touch the residue at all**. Fees are 0.3% of volume: a token that
  trades its whole pool once yields 0.3% of it. Useful as an extra, not a fix.

### C. Dormancy then redemption by the holders (recommended core)

If a pool has been inactive for a long time, the vault removes the liquidity and lets
every remaining holder burn tokens for their exact share of the WETH.

- **Dormancy is read on-chain, with no oracle**: the pair stores `blockTimestampLast`,
  updated by every swap, mint and burn. If it is older than a long, published delay
  (for example 180 days), anyone can call `enterRedemption()` on the vault.
- **Redemption**: the vault burns its LP, burns the token side it receives, and from then
  on anyone can burn `x` tokens to receive `x / circulating supply` of the vault's WETH
  (`circulating = totalSupply - tokens at the dead address - tokens still in the vault`).
  Everyone gets the same price per token, there is no curve.
- **Cannot be rushed**: any trade resets the clock, so nobody can trigger redemption on a
  live token. Someone who wants to stop it can do a tiny swap, which only keeps the
  status quo (option A); it costs them a fee each time.
- **Cannot be captured**: accumulating tokens before the trigger requires buying them,
  and buying from the pool resets the clock. Tokens bought over the counter redeem at the
  same pro-rata rate as everyone else's.
- **What is left**: tokens that are never redeemed (lost keys, dead wallets) leave WETH
  behind. After a second long delay (for example another year), that unclaimed remainder
  could go to the ecosystem buybacks, which is where xbt's "secondary venue" fits without
  ever competing with live holders.

Pros: every holder gets the full residue instead of 0, the creator and early
participants gain nothing extra, no trust added. Cons: a new irreversible mode in the
vault (needs careful review), the dormancy delay is a judgement call, and holders must
come back to redeem.

### D. Send the residue to the ecosystem token

Recover the liquidity of dead pools and use it for ecosystem buybacks directly.

Simple, and it funds the ecosystem, but it takes value that belongs to the last holders
and needs a trigger anyway (the same dormancy problem as C). We would only use it for
the unclaimed remainder of C, as above.

### E. Concentrated liquidity instead of a full-range V2 pool

Open the pool as a Uniswap V3 (or V4) position over a range `[floor, infinity)` instead
of a full-range V2 pair, the floor being for example the round-1 price minus a margin.
On a concentrated position, sellers can take **all** of the WETH down to the floor: the
residue is not frozen, it is paid out to sellers as the price falls.

- Pros: fixes the problem at the root, without any trigger or redemption mode; deeper
  liquidity around the price for the same capital (the "thicker" liquidity xbt
  mentioned).
- Cons: below the floor there is no liquidity at all; a much bigger change (position
  NFT, ticks, a different router and pricing everywhere in the app and the indexer);
  a new set of integration risks, so a new audit of that part.

This is the most elegant answer but a redesign: a candidate for V17 rather than V16.

## 3. Recommendation

1. **V16: option C** (dormancy then pro-rata redemption), with the unclaimed remainder
   going to ecosystem buybacks after a second delay. It recovers the residue for the
   people it belongs to, adds no trust and keeps the pool untouchable while the token
   lives.
2. **Optionally, option B** on top, if a steady fee flow to buybacks is wanted while the
   token trades.
3. **Study option E for V17**, with numbers on real launches first (the Dune dashboards
   would help).

Parameters to decide together: the dormancy delay, the second delay for unclaimed WETH,
who receives that remainder, and whether option B is in.

## 4. Other V16 candidates

- **A contract rule for the opening price**: require the LP allocation to be at least a
  share of the sale allocation (for example `lpTokens >= saleTokens / 2`), so a creator
  can no longer open the pool far above what buyers paid. Today only the web app flags it.
- **Bump the contract identity constants** for every new version (V15.1 kept V15's).
- **Settlement cost**: every buyer must be settled before the pool opens; measuring the
  real cost on Sepolia for many small positions would tell us whether a cheaper settlement
  path is worth it.
