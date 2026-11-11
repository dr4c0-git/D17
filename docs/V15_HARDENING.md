# D17 V15 - hardened launch rules and protocol fee

This fork of [0xlocker/D17](https://github.com/0xlocker/D17) (MIT) changes the launch
contracts. Every launch created by the V15 factory follows the rules below; they are
enforced by the contracts, published in each launch's `rulesHash` and cannot be changed
after the launch is created.

> **Status:** this source tree is **V15.1** (see [V15.1 fixes](#v151-fixes)). It is
> **deployed on Sepolia** (2026-11-11, factory `0x260cbEA5Af1669446353d2B80D75a145016C1228`, protocol fee 1% to a fee splitter
> with no owner, fee settings renounced, 45/45 deployment checks), where it runs
> complete successful and cancelled test launches before anything else.
> It is **not deployed on mainnet** (`deployments/mainnet.json` says `"not-deployed"`),
> and it goes to mainnet only after an independent audit. The upstream V14 deployment is
> **not** compatible with this source tree.

## What participants can rely on

| Rule | V14 (upstream) | V15 |
| --- | --- | --- |
| Creator treasury share of each successful commitment | 0–20% | **0–10%** |
| Protocol fee | none | **0–2%**, fixed per launch at creation, on successful settlement only |
| Minimum share of every successful commitment locked in the official pool | 80% | **88%** |
| Refund penalty, rounds 1–2 | free | **1% fixed**, paid into the official pool |
| Refund penalty, rounds 3–4 | 0–50%, paid to the creator's treasury | **1–25%, paid into the official pool** |
| Penalties when a launch fails | - (rounds 1–2 were free) | **returned to the buyers who paid them** (V15.1; V15 burned them) |
| Unsold sale tokens | burned **or sent to the creator's treasury** | **always burned** |
| Final round price | whole final pool handed to whoever commits, at any price | **never below the round-1 anchor price**; the rest is burned |
| LP token allocation | fixed, even if the sale under-sells | **scaled to the share actually sold**; the unused part is burned |
| Creator token allocation (≤10% of supply) | sent to the creator's wallet, sellable at open | **vested linearly over 180 days** from pool creation |
| Late settlers' liquidity | added at the launch ratio, surplus donated to the pair | **none**: the pool opens only once every buyer is settled; anyone can settle absent buyers (V15.1) |
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
- **Who controls it.** Nobody, on the D17 deployments. The deployment renounces the
  `D17FeeConfig` ownership as its last transaction (`RENOUNCE_FEE_CONFIG_OWNER=1`), which
  freezes the rate and the recipient forever; on mainnet the factory even refuses to
  create a launch while the fee config still has an owner (`MAINNET_FEE_NOT_FROZEN`).
  Changing the fee means deploying a new suite. While an owner exists (possible on test
  networks), ownership moves in two steps (`transferOwnership` then `acceptOwnership`),
  and the owner still cannot touch any existing launch or any participant's funds: the
  fee config holds nothing and is only read at launch creation.

- **Split between several recipients (optional).** The fee recipient can be a
  `D17FeeSplitter`, deployed with the suite when `FEE_SPLIT_RECIPIENTS` and
  `FEE_SPLIT_BPS` are set. It has no owner and no setter: its recipients and their shares
  (adding up to 100%) are fixed in its constructor and readable on-chain with
  `recipients()`. Anyone can call `distribute(token)` to forward its whole balance of a
  token (the fee arrives in WETH) to the recipients, the last one receiving the rounding
  remainder; `distributeEth()` wraps plain ETH and splits it the same way.
  `npm run distribute:fees -w @d17/contracts` triggers the split of the published
  splitter and prints what each recipient received.

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
  sold, so the opening price follows the average sale price instead of being set by
  tokens nobody bought. It equals the average sale price net of fees when the LP
  allocation equals the sale allocation; otherwise it differs by the published
  `saleTokens / lpTokens` ratio.
- **Late liquidity sandwich.** In V14 a late settler's liquidity was added at the
  launch ratio even after the market moved, donating a one-sided surplus a sandwich could
  capture. V15.1 has no late liquidity at all: every buyer is settled before the pool
  opens.
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

## V15.1 fixes

Three issues reported by the project lead after the Sepolia test launches, fixed in V15.1
from the project lead's own review candidate (ported here, without its fixed 2% mainnet
fee). Each is replayed by `contracts/test/v15-1-regressions-e2e.mjs`; the project lead's
suites for failed-launch refunds, callback safety and minimum liquidity are part of
`npm test` too.

- **Pool creation could revert forever.** The fees are taken per position (each rounded
  down), while V15 computed the pool's expected WETH once on the total. The settled WETH
  could exceed it by a few wei, and when every position settled before the pool opened,
  the pool asked for more LP tokens than reserved: the transfer reverted, the pool could
  never open and the tokens, which cannot move before it exists, were stuck. Ordinary
  amounts could trigger it, and anyone could on purpose with odd wei amounts. V15.1 keeps
  the exact sum of every position's pool share (`exactCommittedLiquidityWeth`), updated on
  each commitment and refund, and the pool receives exactly that WETH with exactly the
  reserved LP tokens.
- **Supply above Uniswap V2's limit.** Uniswap V2 stores each reserve as a `uint112`. A
  launch with a larger supply could collect funds and then fail to open its pool.
  `createLaunch` now rejects any `tokenSupply` above `2^112 - 1` raw units, about 5.19
  million billion tokens with 18 decimals (`MAX_TOKEN_SUPPLY`, `SUPPLY_ABOVE_V2_RESERVE`).
- **Late settlement burned pool value.** In V15 the pool could open while some buyers had
  not collected yet; their liquidity was then added at the moved market price and the
  unmatched part burned. In V15.1 the pool opens **only once every final commitment is
  settled** (`UNSETTLED_COMMITMENTS` otherwise). Nobody can block it: after the claim
  window anyone can settle an absent buyer (`D17Locker.settleAfterGrace`), or up to 4 at a
  time with 3,000,000 gas each (`D17LockerFactory.settleAfterGraceBatch`; the first port
  gave 1,000,000, which the first Sepolia test showed was too little); the tokens always go to the buyer's own
  vault. The late-settlement functions remain in the ABI but always revert.

Also in V15.1:

- **A cancelled launch returns everything.** When round 1 misses its minimum, every buyer
  gets back all of their ETH **including the take-back fees** they paid in round 1's
  window; those fees are no longer burned. The policy is part of each launch's `rulesHash`
  (`FAILED_REFUND_POLICY`).
- **Mainnet launches need a frozen fee.** On chain id 1 the factory refuses to create a
  launch while the fee config has an owner or a pending owner, so the fee rate and its
  recipient can never change for the whole suite (`MAINNET_FEE_NOT_FROZEN`).
- **Ordering hardening.** Lockers update their accounting before every value-moving call,
  and the fee splitter's `distributeEth` is guarded against reentrancy.

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
- **Opening the pool costs the absent buyers' settlement gas.** Every buyer must be
  settled before trading opens. Someone (usually the creator) pays the gas to settle
  absent buyers, 4 per transaction; a launch with many small positions costs more to
  open. Each position needs at least the launch's minimum commitment.
- **Opening price set by the creator's split.** The contract accepts any LP allocation
  from 1 token, so a creator can open the pool far above the average price paid. The web
  app flags such launches as predatory; a contract rule is planned for V16.
- **Copycat tokens.** Anyone can deploy a token with the same name elsewhere; only
  launches registered by the canonical factory (`isCanonicalLaunch`) are shown by the
  terminal and accepted by lockers.

## Deploying

Never put a private key in the repository; keys live only in `contracts/.env`, which git
ignores. Deploy to Sepolia first and run a full launch there before mainnet.

```bash
cp contracts/.env.example contracts/.env   # fill RPC_URL, keys, FEE_CONFIG_OWNER, PROTOCOL_FEE_*
npm run check:env -w @d17/contracts      # checks .env without printing any key
npm run compile -w @d17/contracts
npm run deploy:factory -w @d17/contracts    # deploys, pins and renounces the suite
npm run verify:factory -w @d17/contracts    # every check must pass
npm run publish:deployment -w @d17/contracts  # writes deployments/*.json + release provenance
npm run release:checksums && npm run check:release
```
