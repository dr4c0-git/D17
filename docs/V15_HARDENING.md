# D17 V15 — hardened launch rules and protocol fee

This fork of [0xlocker/D17](https://github.com/0xlocker/D17) (MIT) changes the launch
contracts. Every launch created by the V15 factory follows the rules below; they are
enforced by the contracts, published in each launch's `rulesHash` and cannot be changed
after the launch is created.

> **Status:** V15 is **not deployed** on any network yet. The public manifests in
> `deployments/` say `"status": "not-deployed"` until the suite is deployed, verified
> and published (see "Deploying" below). The upstream V14 deployment is **not**
> compatible with this source tree. V15 has **not** been professionally audited.

## What participants can rely on

| Rule | V14 (upstream) | V15 |
| --- | --- | --- |
| Creator treasury share of each successful commitment | 0–20% | **0–10%** |
| Protocol fee | none | **0–2%**, fixed per launch at creation, on successful settlement only |
| Minimum share of every successful commitment locked in the official pool | 80% | **88%** |
| Refund penalty, rounds 1–2 | free | **1% fixed**, paid into the official pool |
| Refund penalty, rounds 3–4 | 0–50%, paid to the creator's treasury | **1–25%, paid into the official pool** |
| Penalties when a launch fails | — (rounds 1–2 were free) | burned (sent to `0x…dEaD`), never paid to anyone |
| Unsold sale tokens | burned **or sent to the creator's treasury** | **always burned** |
| Final round price | whole final pool handed to whoever commits, at any price | **never below the round-1 anchor price**; the rest is burned |
| LP token allocation | fixed, even if the sale under-sells | **scaled to the share actually sold**; the unused part is burned |
| Creator token allocation (≤10% of supply) | sent to the creator's wallet, sellable at open | **vested linearly over 180 days** from pool creation |
| Late settlers' liquidity | added at the launch ratio, surplus donated to the pair | added **at the pair's live ratio**; the unpairable remainder is burned |
| Admin keys while launches exist | factory owners could stay unrenounced | **launch creation reverts until every factory owner key is renounced** |
| Mainnet launch notice | none | start **≥ 24 hours** after creation; every window ≥ 1 hour |

Unchanged guarantees: each participant's WETH stays in their own locker until it is
refunded or settled, the official pool's LP tokens are owned by the vault forever (there
is no withdrawal path), tokens cannot be transferred before the official pool exists,
and anyone can settle a forgotten locker after the grace period without being able to
redirect its tokens.

## The protocol fee, in full

- **Rate and cap.** `D17FeeConfig` holds a rate and a recipient. The rate can never
  exceed `MAX_PROTOCOL_FEE_BPS = 200` (2%), a constant in the contract.
- **Frozen per launch.** `D17Factory.createLaunch` copies the current (recipient, rate)
  into the new launch's immutables, which are part of its `rulesHash`. Changing the fee
  later only affects launches created afterwards.
- **Creator consent.** The launch config carries `maxProtocolFeeBps`. Creation reverts
  with `PROTOCOL_FEE_ABOVE_MAX` if the fee is above that value when the transaction
  executes, so a fee raised while the creator's transaction is pending cannot be imposed.
  The `/deploy` page sends exactly the fee it displayed.
- **When it is charged.** Only when a successful commitment is settled:
  `gross = pool share + treasury share + protocol fee` (each fee rounded down, the pool
  gets the remainder). Refunds, refund penalties and failed launches never pay it.
- **Who controls it.** The `D17FeeConfig` owner (use a multisig; the deploy script
  refuses an EOA on mainnet). Ownership moves in two steps (`transferOwnership` then
  `acceptOwnership`) and can be renounced, which freezes the fee forever. The owner
  cannot touch any existing launch or any participant's funds: the fee config holds
  nothing and is only read at launch creation.

`D17FeeConfig` is the only contract in the suite that keeps an owner after deployment.

## What the creator receives

1. The treasury share (≤10%) of each settled commitment, in WETH, to the treasury
   address published in the rules.
2. The creator allocation (≤10% of supply), vested linearly over 180 days from pool
   creation. Anyone can call `D17LiquidityVault.releaseCreatorTokens()`; the tokens
   always go to the creator address fixed in the rules.
3. Stray donations sent directly to the vault or the launch (forced ETH is wrapped and
   sent as WETH so it can always be swept).

The creator never receives refund penalties, unsold sale tokens or unused LP tokens.

## Anti-manipulation details

- **Anchor griefing.** In V14 a large round-1 commitment could be refunded for free at
  the last second, scaring other participants away and possibly failing the launch at
  no cost. Every early refund now costs 1%, paid into the pool (or burned if the launch
  fails).
- **Final-round sniping.** In V14 the final round's whole token pool (its share plus
  everything rounds 2–4 did not sell) went to whoever committed, at whatever price. In
  V15 the final round sells at or above the round-1 anchor price, like rounds 2–4; what
  it cannot sell at that price is burned.
- **Opening price.** The LP allocation is scaled to the share of the sale that actually
  sold, so the pool opens near the average sale price net of fees instead of at a price
  set by tokens nobody bought.
- **Late liquidity sandwich.** In V14 a late settler's liquidity was added at the
  launch ratio even after the market moved, donating a one-sided surplus a sandwich could
  capture. V15 adds it at the pair's live ratio and burns what cannot be paired.
- **Pre-seeding the pair.** Tokens cannot reach the pair before the official pool exists
  (transfer gate). Anyone may donate WETH to the pair beforehand; it can only raise the
  opening price and is lost by the donor to the locked pool.
- **Stealth launches.** On mainnet a launch must be announced at least 24 hours before
  round 1, and every round, refund and claim window lasts at least one hour.

## Bugs fixed while hardening

- `D17LaunchFactory` was 107 bytes under the 24,576-byte contract size limit, which made
  any change impossible. Launch creation now goes through `D17LaunchDeployer`.
- Per-position fee rounding could make the per-position liquidity shares sum to a few wei
  more than the launch total, so the **last late settler could revert forever** with
  `LP_RESERVE_EXCEEDED`. Late LP releases are now capped at the remaining reserve.
- A dust-sized late position could revert in the pair's `mint`; it is now burned instead.
- The deploy script failed with "nonce has already been used" on fast-mining nodes; it
  now uses one nonce manager per key.

## Known limits (not fixed)

- **No professional audit.** Static analysis (Slither 0.11.6) reports only benign
  findings: reentrancy into our own token/WETH/pair behind `nonReentrant` guards,
  intended timestamp comparisons, intended strict equality (pre-seed check), default-zero
  locals and a missing zero check on the two-step fee owner handover (setting zero cancels
  a pending transfer).
- **Block timestamps.** Round boundaries use `block.timestamp`; validators can shift it by
  a few seconds.
- **Sybil participation.** Nothing stops a creator from participating through other
  wallets on the same terms as everyone else.
- **Liquidity-add MEV.** A late settlement is a liquidity add; an attacker who moves the
  price around it pays swap fees on both legs and gains at most the impermanent loss of the
  late position. Most positions settle before pool creation.
- **Copycat tokens.** Anyone can deploy a token with the same name elsewhere; only
  launches registered by the canonical factory (`isCanonicalLaunch`) are shown by the
  terminal and accepted by lockers.

## Deploying

Never put a private key in the repository; keys live only in `contracts/.env`, which git
ignores. Deploy to Sepolia first and run a full launch there before mainnet.

```bash
cp contracts/.env.example contracts/.env   # fill RPC_URL, keys, FEE_CONFIG_OWNER, PROTOCOL_FEE_*
npm run compile -w @d17/contracts
npm run deploy:factory -w @d17/contracts    # deploys, pins and renounces the suite
npm run verify:factory -w @d17/contracts    # every check must pass
npm run publish:deployment -w @d17/contracts  # writes deployments/*.json + release provenance
npm run release:checksums && npm run check:release
```
