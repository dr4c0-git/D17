# D17 Contract Suite - Technical Reference

> **Version note.** This reference was written for the upstream V14 contracts. Its
> line citations and several rules (free early refunds, penalties and unsold tokens
> paid to the treasury, 20%/50% caps, creator allocation sent to the creator's wallet,
> canonical-ratio late liquidity) do **not** describe V15. Read
> [V15_HARDENING.md](./V15_HARDENING.md) for every change until this reference is
> rewritten.

Audience: Solidity/EVM engineers integrating with, extending, or reviewing the suite.
Citation convention: `File.sol:line` paths are relative to the checksummed
`contracts/contracts/` directory. `contracts/SHA256SUMS.txt` identifies
the exact production source described here.

---

## 1. Overview & scope

**Status:** local E2E green (**493/493 assertions**, `test/local-e2e.mjs`) with
Sepolia lifecycle evidence. The suite has **not** received a formal professional
third-party audit.

D17 is a five-round fair-launch protocol on a Uniswap-V2-style AMM. Users commit ETH
(wrapped to WETH) through personal escrow contracts ("lockers"); round 0 discovers an
anchor price; refund windows follow rounds 0–3; after finalization each locker settles —
sale tokens to the buyer, a treasury fee, and the remainder into a permanently locked
official liquidity pool. Pool creation is permissionless and never blocked by unsettled
users: the initial pool pairs settled WETH with a *proportional* share of the LP token
allocation at the canonical launch ratio, and late settlers top the pool up with their
LP-share WETH plus their reserved token share, forever. All admin authority is destroyed
during deployment (one-shot pins, mint close, ownership renounce).

## 2. Topology

```text
                         ┌──────────────────────────────────────────────────┐
                         │ D17Factory  (entry point, config validation,     │
                         │  canonical launch registry, locker registry)     │
                         └───┬──────────────────────────────────┬───────────┘
       createLaunch(config)  │ onlyD17Factory                   │ registerLockerFor
                             ▼                                  │ (only pinned lockerFactory)
                  ┌──────────────────┐               ┌──────────┴────────┐
                  │ D17LaunchFactory │               │ D17LockerFactory  │
                  └───┬────┬────┬────┘               └──────────┬────────┘
    deployToken       │    │    │  deployVault                  │ createLockerFor
 (only pinned         │    │    │  (only pinned                 │ (msg.sender == owner)
  launchFactory)      ▼    │    ▼   launchFactory)              ▼
        ┌──────────────┐   │  ┌──────────────────┐      ┌────────────┐  personal locker;
        │D17TokenFactory│  │  │D17LiquidityVault- │      │ D17Locker  │  holds the user's
        └──────┬───────┘   │  │Factory            │      └─────┬──────┘  positions across
               ▼           ▼  └────────┬─────────┘             │         launches
        ┌───────────┐ ┌───────────┐    ▼                       │
        │ D17Token  │ │ D17Launch │ ┌──────────────────┐       │
        └───────────┘ └───────────┘ │ D17LiquidityVault │      │
              ▲             ▲       └──────────────────┘       │
              │ trading/burn│ onlyLocker (factory registry)    │
              │ gate reads  └──────────────────────────────────┘
              │ launch.tradingOpen()      onlyVault: claimVaultLiquidityTokens,
              └────────────────────────── markLiquidityPoolCreated
```

Authority edges (all others are permissionless or view):

| Caller → callee | Functions | Guard | Cite |
|---|---|---|---|
| D17Factory → D17LaunchFactory | `deployLaunch` | `onlyD17Factory` | D17LaunchFactory.sol:54,71 |
| D17LaunchFactory → D17TokenFactory / D17LiquidityVaultFactory | `deployToken` / `deployVault` | pinned `launchFactory` only | D17TokenFactory.sol:47, D17LiquidityVaultFactory.sol:47 |
| D17LaunchFactory → D17Launch | `configureLiquidityVault` | `msg.sender == vaultConfigurator` (one-shot) | D17Launch.sol:245-252 |
| D17LaunchFactory → D17Token | `configureTradingGate`, `configureMetadata`, `mint`, `closeMinting`, `renounceOwnership` | `onlyOwner` (owner = launch factory until renounce) | D17Token.sol:86,118,196,205,211 |
| D17Locker → D17Launch | `recordRoundCommitment`, `releaseRoundRefund`, `releaseFailedRefund`, `claimVaultSettlement`, `claimLateSettlement` | `onlyLocker` via `ID17FactoryView(factory).isLocker` | D17Launch.sol:137-140 |
| D17LiquidityVault → D17Launch | `claimVaultLiquidityTokens`, `markLiquidityPoolCreated` | `onlyVault` | D17Launch.sol:142-145 |
| D17Locker → D17LiquidityVault | `mintLateLiquidity` | registered locker via `launch.factory()` → `isLocker` | D17LiquidityVault.sol:149-153 |
| D17LockerFactory → D17Factory | `registerLockerFor` | pinned `lockerFactory` only | D17Factory.sol:93-102 |

Canonical registry: `D17Factory.launches[launch] = LaunchRecord{canonical, creator, token,
liquidityVault, rulesHash}` written once at creation (D17Factory.sol:149-155);
`isCanonicalLaunch(launch, rulesHash)` requires **both** the address and the pinned rules
hash to match (D17Factory.sol:171-174). Lockers never trust an address alone.

## 3. Deployment & wiring

Suite deployment (per `scripts/deploy-factory.mjs`): deploy `D17Factory(owner, weth,
router)`, `D17TokenFactory(owner)`, `D17LiquidityVaultFactory(owner)`,
`D17LaunchFactory(d17Factory, tokenFactory, vaultFactory)`, `D17LockerFactory(d17Factory)`;
pin launch factory into token/vault factories and D17Factory, pin locker factory into
D17Factory; optionally renounce all ownership. Every pin is one-shot
(D17Factory.sol:104-120; D17TokenFactory.sol:28-35; D17LiquidityVaultFactory.sol:28-35).
`renounceOwnership` on D17Factory requires both pins first (D17Factory.sol:128-133); after
renounce no privileged function exists anywhere in the suite.

Launch creation is **one transaction**, `D17Factory.createLaunch(config)`
(D17Factory.sol:139-169) → `D17LaunchFactory.deployLaunch(config, msg.sender)`:

| # | Step | Cite |
|---|------|------|
| 0 | Require both factories pinned; `_validateConfig` (full table §5.1) | D17Factory.sol:141-145 |
| 1 | `require(creator != address(0))`; deploy `D17Token` (owner = launch factory) | D17LaunchFactory.sol:76-77 |
| 2 | Deploy `D17Launch` (23 constructor args incl. manual allocation + creator recipient) | D17LaunchFactory.sol:84-109 |
| 3 | Deploy `D17LiquidityVault(launch, token, weth, router, treasury)` | D17LaunchFactory.sol:115 |
| 4 | `launch.configureLiquidityVault(vault)` (one-shot) | D17LaunchFactory.sol:117 |
| 5 | `token.configureTradingGate(launch, d17Factory, weth, routerFactory, vault, tradingOpenAt)` | D17LaunchFactory.sol:118-125 |
| 6 | `token.configureMetadata(description, logoSvgUri, links)` | D17LaunchFactory.sol:126 |
| 7 | Mint `saleTokens + lpTokens` → launch | D17LaunchFactory.sol:128 |
| 8 | Mint `manualDistributionTokens` → creator (if > 0) | D17LaunchFactory.sol:129 |
| 9 | Mint `deadTokens` → `0x…dEaD` (if > 0) | D17LaunchFactory.sol:130 |
| 10 | `closeMinting()`; `renounceOwnership()` — **no mint authority survives** | D17LaunchFactory.sol:131-132 |
| 11 | Factory records canonical entry, emits `LaunchCreated`, `ManualDistributionConfigured`, `LaunchMetadataPublished` | D17Factory.sol:147-168 |

`rulesHash()` is read *after* vault configuration (it includes `liquidityVault`), so the
registered hash is final (D17Factory.sol:148; D17Launch.sol:254-282).

## 4. Lifecycle state machine

Contract rounds 0–4 = display rounds 1–5. Timing anchors: `startTime` (immutable),
`roundStart/roundEnd` (derived walk over `roundSeconds[5]` + `refundSeconds` after rounds
0–3, D17Launch.sol:303-315), `tradingOpenAt = roundEnd(4) + settlementSeconds` (immutable,
D17Launch.sol:222), `finalizedAt` (set at finalization, D17Launch.sol:751),
`poolCreationOpensAt() = finalized ? max(finalizedAt + settlementSeconds, tradingOpenAt) :
tradingOpenAt` (D17Launch.sol:404-408). `tradingOpen() == liquidityPoolCreated`
(D17Launch.sol:410-412).

`launchPhase()` (D17Launch.sol:495-527) reports one of 8 phases:

| Phase (const, D17Launch.sol:18-25) | Predicate | State-changing calls allowed (launch-side) |
|---|---|---|
| 0 `PHASE_NOT_STARTED` | `now < startTime` | — |
| 1 `PHASE_ROUND_OPEN` (idx = round) | `activeRound() != NO_ROUND` (rounds 1+ additionally require `anchorReady()`, :288) | `recordRoundCommitment(round,…)` |
| 2 `PHASE_REFUND_OPEN` (idx = round) | `activeRefundWindow() != NO_ROUND` (windows follow rounds 0–3 only, :295-301) | `releaseRoundRefund()` |
| 7 `PHASE_FAILED` | `launchFailed()`: not finalized ∧ `now ≥ roundEnd(0)+refundSeconds` ∧ `!anchorReady()` (:347-349) | `releaseFailedRefund()` (forever) |
| 3 `PHASE_READY_TO_FINALIZE` | `now ≥ roundEnd(4)`, not finalized | `finalizeLaunch()` (permissionless); settlement calls auto-finalize (:638) |
| 4 `PHASE_SETTLEMENT_OPEN` | finalized ∧ `now < poolCreationOpensAt()` | `claimVaultSettlement()` (via locker owner) |
| 5 `PHASE_POOL_READY` | finalized ∧ `now ≥ poolCreationOpensAt()` ∧ pool not created | `claimVaultSettlement()`; `settleAfterGrace` now permissionless (locker-side); `createOfficialPool` (vault, permissionless) |
| 6 `PHASE_TRADING_OPEN` | `liquidityPoolCreated` | `claimLateSettlement()` (forever); locker `withdrawUnlockedTokens`; token transfers/burns ungated |

Failure is terminal-by-predicate (only reachable pre-finalization); finalization is
one-shot (`FINALIZED`, D17Launch.sol:746) and requires nonzero committed WETH (:757).
Pool creation is one-shot (`POOL_CREATED` + `VAULT_LIQUIDITY_CLAIMED`,
D17Launch.sol:692-693; vault `poolCreated`, D17LiquidityVault.sol:93).

## 5. Per-contract reference

Notation: **AC** = access control. All state-changing functions in D17Launch, D17Locker,
D17LiquidityVault are `nonReentrant` (storage-flag pattern, e.g. D17Launch.sol:147-152);
not repeated per row. `receive()`/`fallback()` revert on D17Launch (:237-243), D17Locker
(:86-92), D17LiquidityVault (:80-86).

### 5.1 D17Factory (D17Factory.sol, 299 lines)

Purpose: entry point, config validation, canonical launch + locker registries.
Constants: `D17_FACTORY_ID` (:12), `BPS = 10_000` (:13), `MAX_TREASURY_BPS = 2_000` (:14),
`MAX_MANUAL_DISTRIBUTION_BPS = 1_000` (:15), `MAX_REFUND_PENALTY_BPS = 5_000` (:16),
`ROUND_COUNT = 5` (:17), metadata bounds (:18-23), `MIN_COMMIT_WETH = 1e15` (:24),
`MIN_LP_TOKENS = 1e18` (:25), `MIN_ROUND_ALLOCATION_TOKENS = 1e18` (:26),
`MIN_ANCHOR_PRICE_WAD = 1e6` (:27), round-seconds bounds 60s–90d (:28-29),
refund/settlement ≤ 30d (:30-31), `MAX_START_DELAY = 365 days` (:32).
Key storage: `owner`, immutable `weth`/`router` (:35-36), `launchFactory`/`lockerFactory` +
pinned flags, `launches` mapping, `isLocker`, `lockersByOwner`.

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `createLaunch(ID17LaunchFactory.LaunchConfig calldata config) external returns (address token, address launch, address liquidityVault)` (:139) | Validates config, delegates deployment, registers canonical record, emits 3 events | any | pins missing; any validation failure below |
| `registerLockerFor(address lockerOwner, address locker) external` (:93) | Registers a locker | pinned lockerFactory only | `NOT_LOCKER_FACTORY`, zero/no-code/duplicate |
| `pinLaunchFactory(address) / pinLockerFactory(address) external` (:113/:104) | One-shot wiring | `onlyOwner` | `*_PINNED`, zero, no code |
| `transferOwnership(address) / renounceOwnership() external` (:122/:128) | Ownership; renounce requires both pins | `onlyOwner` | `OWNER_ZERO`; `*_UNLOCKED` |
| `isCanonicalLaunch(address launch, bytes32 rulesHash) external view returns (bool)` (:171) | Registry check: address **and** hash | view | — |
| `lockersOfOwner(address) external view returns (address[] memory)` (:135) | Locker enumeration per owner | view | — |

`_validateConfig` (:176-220) enforces: name/symbol length + JSON-safety; metadata bounds
(description ≤ 512B, ≤ 8 links, link type `[a-z0-9-]` ≤ 32B, link URL https + ≤ 128B +
JSON-safe, logo ≤ 8192B base64-SVG data URI, :222-267); `tokenSupply > 0`;
`saleTokens > 0`; `lpTokens ≥ 1e18`; **`saleTokens + lpTokens + manualDistributionTokens +
deadTokens == tokenSupply`** (`SUPPLY_SPLIT`, :185-189); **`manualDistributionTokens * BPS
≤ tokenSupply * 1000`** (`MANUAL_ABOVE_CAP`, :190-193); dead recipient must be the
canonical dead address when `deadTokens > 0` (:194-196); treasury nonzero; start within
[now, now+365d]; refund/settlement seconds in (0, 30d]; `minCommitWeth ≥ 1e15`;
`minPhase1Weth ≥ minCommitWeth`; `minAnchorPriceWad ≥ 1e6`; `treasuryBps ≤ 2000`;
`refundPenaltyBps ≤ 5000`; 5 round shares each > 0, each allocation ≥ 1e18 tokens, summing
to exactly 10 000 bps (:207-219). The manual-allocation **recipient is not a config
field** — it is always `msg.sender` of `createLaunch` (:147).

Events: `LaunchCreated(creator idx, launch idx, token idx, liquidityVault, rulesHash)`
(:55-61), `ManualDistributionConfigured(launch idx, recipient idx, amount)` (:70, emitted
for every launch incl. amount 0, :160), `LaunchMetadataPublished(launch idx, metadataHash
idx, description, logoSvgUri, linkTypes[], linkUrls[])` (:62-69),
`LockerRegistered(owner idx, locker idx, manager idx)` (:71), pin/ownership events (:54,72-73).

### 5.2 D17LaunchFactory (D17LaunchFactory.sol, 146 lines)

Purpose: atomic deployer of the token/launch/vault trio (§3 sequence). Immutables:
`d17Factory`, `tokenFactory`, `liquidityVaultFactory` (:50-52); constant
`CANONICAL_DEAD_RECIPIENT` (:48).

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `deployLaunch(LaunchConfig calldata config, address creator) external returns (address token, address launch, address liquidityVault)` (:71) | §3 steps 1–10 | `onlyD17Factory` (:54-57) | `CREATOR_ZERO` (:76); bubble-ups from satellites |

`_metadataHash(config)` = `keccak256(abi.encode(tokenName, tokenSymbol, description,
logoSvgUri, links))` (:135-144) — passed into the launch as immutable `metadataHash`.
**Code size note:** this contract embeds `D17Launch` creation code; deployed size is
24,469 bytes — 107 bytes under the Spurious Dragon limit (proven deployable on Sepolia).

### 5.3 D17Launch (D17Launch.sol, 818 lines) — the engine

Constants: `D17_LAUNCH_ID` (:10), `ROUND_COUNT = 5`/`FINAL_ROUND = 4`/
`REFUND_STAGE_COUNT = 4` (:11-13), `FREE_REFUND_ROUNDS = 2` (**private**, :14-16), phase
constants (:17-25), `BPS = 10_000` (:26), mins (:27-30), `WAD = 1e18` (private, :31),
dead address (:32). Immutables (:34-56): factory, vaultConfigurator, token, weth,
treasury, startTime, refundSeconds, settlementSeconds, tradingOpenAt, minCommitWeth,
minPhase1Weth, minAnchorPriceWad, treasuryBps, refundPenaltyBps, saleTokens, lpTokens,
deadTokens, deadRecipient, manualDistributionTokens, manualDistributionRecipient,
burnUnsoldSaleTokens, metadataHash.

Key storage (:58-88): `liquidityVault` (one-shot), `liquidityPoolCreated`,
`vaultLiquidityClaimed`, `officialPair`, `settledLiquidityWeth` (pre-pool vault deliveries),
`finalCommittedWeth` (finalization snapshot), `settledCommittedWeth` (gross settled, incl.
late), `poolSettledLiquidityWeth`/`poolSettledCommittedWeth` (pool-creation snapshots),
`lateSettledCommittedWeth`/`lateSettledLiquidityWeth`/`lateLpTokensReleased` (late
counters), `vaultLiquidityTokensClaimed`, `officialTokenUsedForLp`/`officialWethUsedForLp`/
`officialLpMinted`/`poolCreatedAt` (write-once pool records), `roundSeconds[5]`/
`roundSharesBps[5]`/`roundRaised[5]`, penalty/treasury counters (:80-82),
`unsoldSaleTokensSettled`/`finalRoundTokenPool`/`unsoldSaleTokensBurned`/`finalizedAt`/
`finalized`. Per-locker `Position{finalSaleTokensClaimed, liquidityClaimed, refundWeth,
penaltyWeth, paid[5], refunded[5]}` (private mapping, :90-99).

State-changing ABI:

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `configureLiquidityVault(address liquidityVault_) external` (:245) | One-shot vault wiring | `vaultConfigurator` only | `VAULT_CONFIGURED`, zero, no code |
| `recordRoundCommitment(uint8 round, uint256 amount) external` (:529) | Books a commit into the active round | `onlyLocker` | `ROUND`, `COMMIT_TOO_SMALL`, `ROUND_CLOSED`, `ANCHOR_NOT_READY` (rounds 1–4, :533-537), position-claimed/refunded guards (:540-542) |
| `releaseRoundRefund() external returns (uint8 round, uint256 refundWeth, uint256 penaltyWeth)` (:549) | Refund of caller's full stake in the currently-open window; **penalty = `round < 2 ? 0 : gross * refundPenaltyBps / BPS`** (:574) | `onlyLocker` | `NO_REFUND_STAGE`, `ROUND_REFUNDED`, claimed guards, `NO_ROUND_POSITION` |
| `releaseFailedRefund() external returns (uint256 refundWeth)` (:585) | Full, penalty-free refund of all rounds after launch failure | `onlyLocker` | `LAUNCH_NOT_FAILED`, claimed guards, `NO_POSITION` |
| `claimVaultSettlement() external returns (uint256 saleTokenAmount, uint256 wethForVault, uint256 treasuryWeth)` (:606) | On-time settlement (pre-pool): `_settlePosition(false)` | `onlyLocker` | `POOL_CREATED` (:612) + `_settlePosition` guards |
| `claimLateSettlement() external returns (uint256 saleTokenAmount, uint256 wethForVault, uint256 treasuryWeth, uint256 lateLpTokens)` (:623) | Late settlement (post-pool, forever): `_settlePosition(true)`; releases reserved LP-token share to the vault | `onlyLocker` | `POOL_NOT_CREATED` (:629), `LP_RESERVE_EXCEEDED` (:657-660) |
| `finalizeLaunch() external` (:681) | One-shot finalization (§6.4) | **permissionless** | `FINALIZED`, `LAUNCH_FAILED`, `NOT_OVER`, `NO_FINAL_COMMITMENTS` |
| `claimVaultLiquidityTokens() external returns (uint256 liquidityTokens, uint256 wethForPool)` (:685) | Pool funding claim: `wethForPool = settledLiquidityWeth`; `liquidityTokens = lpTokens * settledLiquidityWeth / totalLiquidityWeth()` (:702-703); snapshots pool inputs (:708-709) | `onlyVault` | `POOL_CREATED`, `VAULT_LIQUIDITY_CLAIMED`, `POOL_CREATION_NOT_OPEN`, `NO_SETTLED_LIQUIDITY`, `NO_LIQUIDITY_TOKENS` |
| `markLiquidityPoolCreated(address pair, uint256 tokenUsed, uint256 wethUsed, uint256 lpMinted) external` (:715) | Writes the once-only pool records; requires `tokenUsed == vaultLiquidityTokensClaimed` and `wethUsed == poolSettledLiquidityWeth` (:723-724) | `onlyVault` | `POOL_CREATED`, `VAULT_LIQUIDITY_NOT_CLAIMED`, `PAIR_ZERO`, `*_MISMATCH`, `LP_ZERO` |
| `sweepUnexpectedEthToTreasury() external returns (uint256 amount)` (:737) | Sweeps force-sent ETH (receive reverts; only selfdestruct ETH possible) | permissionless | `NO_ETH_BALANCE`, `ETH_SWEEP_FAILED` |

`_settlePosition(bool late)` (:633-679): requires vault configured, lazily finalizes
(:637-638); requires position unclaimed; computes sale tokens via
`previewFinalSaleTokens(msg.sender)` and the WETH split via `_vaultSettlementAmounts`
(:643-645); requires gross > 0; sets both claim flags **before** transfers (:648-649);
on-time: `settledLiquidityWeth += wethForVault`, emits `VaultSettlementClaimed`
(:673-675); late: `lateLpTokens = lpTokens * wethForVault / totalLiquidityWeth()` (:656),
reserve-bound check (:657-660), late counters, transfers `lateLpTokens` to the vault
(:664), emits `LateVaultSettlementClaimed` (:665-672); finally transfers sale tokens to
the calling locker (:678). The **WETH itself never passes through the launch** — the
locker transfers it (see §5.4).

View ABI (selected; full signatures at cited lines): `rulesHash() → bytes32` (:254 —
abi.encode of the 25 fields listed there, first field `D17_LAUNCH_ID`);
`activeRound() → uint8` (:284); `activeRefundWindow() → uint8` (:295);
`roundStart/roundEnd/roundClaimTime(uint8) → uint256` (:303/:313/:331);
`roundBaseTokenAllocation/roundTokenAllocation/roundSoldTokens(uint8) → uint256`
(:317/:322/:367); `anchorPriceWad() → uint256` (:337); `anchorReady() → bool` (:343);
`launchFailed() → bool` (:347); `roundAnchorTargetWeth/roundAnchorUnderfillRemainingWeth
(uint8) → uint256` (:351/:359); `rolloverToFinalRound() → uint256` (:381);
`roundDiscoveredPriceWad(uint8) → uint256` (:389); `isRoundClaimable(uint8) → bool`
(:396); `settlementStartsAt() → uint256` (:400); `poolCreationOpensAt() → uint256` (:404);
`tradingOpen() → bool` (:410); `totalCommittedWeth() → uint256` (:414);
`totalLiquidityWeth() → uint256` (:418); `allFinalCommitmentsSettled() → bool` (:426 —
**metric only**, never gates, :423-425); `contributedBy(address,uint8) → uint256` (:435);
`lockerPositionState(address) → (bool,bool,uint256,uint256,bool[5])` (:440);
`previewRoundTokens(address,uint8)` (:461); `previewFinalSaleTokens(address)` (:470);
`previewVaultSettlement(address) → (saleTokens, gross, wethForVault, treasuryWeth)`
(:476); `previewSettlement` alias (:487); `launchPhase() → (uint8,uint8,uint256,uint256)`
(:495). Derivable metrics deliberately have **no getters** (code size): unsettled gross =
`finalCommittedWeth - settledCommittedWeth`; reserved LP =
`lpTokens - vaultLiquidityTokensClaimed - lateLpTokensReleased` (:430-433).

Events: `LiquidityVaultConfigured` (:101), `RoundCommitted(locker idx, round idx, amount)`
(:102), `RoundRefunded(locker idx, refundRound idx, refundWeth, penaltyWeth)` (:103),
`LaunchFailedRefunded(locker idx, refundWeth)` (:104), `VaultSettlementClaimed(locker idx,
saleTokens, wethForVault, treasuryWeth, grossCommittedWeth)` (:105-111),
`LateVaultSettlementClaimed(locker idx, saleTokens, wethForVault, treasuryWeth,
lateLpTokens, grossCommittedWeth)` (:112-119), `Finalized(finalizedAt)` (:120),
`VaultLiquidityTokensClaimed(liquidityVault idx, liquidityTokens, wethForPool)` (:121-125),
`LiquidityPoolCreated(liquidityVault idx, pair idx, tokenUsed, wethUsed, lpMinted)`
(:126-132), `UnsoldSaleTokensPaid(recipient idx, amount)` (:133),
`UnsoldSaleTokensBurned(amount)` (:134), `UnexpectedEthSwept` (:135).

### 5.4 D17Locker (D17Locker.sol, 323 lines) — per-user escrow

One locker per (user, deployment); registered in D17Factory; holds the user's WETH until
refund/settlement and claimed sale tokens until withdrawal. `EXPECTED_LAUNCH_ID` (:10)
pins the accepted launch version. Immutables: `owner`, `factory`, `weth` (:13-15). Global
ledgers: `withdrawableWeth` (owner-withdrawable across launches), `accountedWeth`
(locker-owned WETH; excess above it is recoverable donation) (:17-18). Per-launch
`LockerPosition` struct (:21-42) mirrors the launch's accounting plus token bookkeeping
(`wethSentToVault`, `wethForLp`, `treasuryWeth`, `withdrawableTokens`, `residualWeth`,
`roundWeth[5]`, `roundSaleTokens[5]`, flags).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `verifyLaunch(address launch, bytes32 expectedRulesHash) public view returns (bool)` (:94) | Authenticity gate: code exists, `D17_LAUNCH_ID == EXPECTED_LAUNCH_ID`, same WETH, `rulesHash` matches, canonical in factory | view | `NO_CODE`, `BAD_LAUNCH_ID`, `BAD_WETH`, `BAD_RULES`, `NOT_CANONICAL` |
| `commitToRound(address launch, uint8 round, bytes32 expectedRulesHash) public payable` (:123) | Wraps `msg.value` ETH→WETH (held **in the locker**, :136-137), books position, calls `recordRoundCommitment` | `onlyOwner` | `NO_ETH`, `ROUND`, verify failures, `LIQUIDITY_SETTLED` |
| `refundCurrentRound(address launch) public` (:150) | Calls `releaseRoundRefund`; pays penalty WETH to treasury from locker (:170); refund stays in locker as `residualWeth`/`withdrawableWeth` | `onlyOwner` | `UNKNOWN_LAUNCH`, `LIQUIDITY_SETTLED`, `NO_REFUND`, ledger-balance guards (:158-159) |
| `refundFailedLaunch(address launch, bytes32 expectedRulesHash) public` (:186) | Full failed-launch refund; cross-checks launch amount vs local ledger (`FAILED_REFUND_MISMATCH`, :196) | `onlyOwner` | verify failures, guards |
| `settleAndClaim(address launch, bytes32 expectedRulesHash) public returns (uint256 claimedSaleTokens)` (:213) | Owner settlement any time post-final-round (lazy finalize) | `onlyOwner` | verify + `_settleVaultPosition` guards |
| `settleAfterGrace(address launch) public returns (uint256 claimedSaleTokens)` (:218) | **Permissionless** settlement-for from `poolCreationOpensAt`; re-verifies with the **stored** rules hash (:221) | any | `UNKNOWN_LAUNCH`, `NOT_FINALIZED`, `GRACE_OPEN` |
| `withdrawUnlockedWeth(address launch, uint256 amount) public` (:174) | Withdraws refund residuals to owner | `onlyOwner` | position/global ledger guards |
| `withdrawUnlockedTokens(address launch, uint256 amount) public` (:293) | Withdraws claimed sale tokens; **gated on `launch.tradingOpen()`** (:297) | `onlyOwner` | `TOKEN_MISSING`, `TOKEN_WITHDRAW_LOCKED`, `TOKEN_BALANCE` |
| `recoverNativeEth(address recipient, uint256 amount) external` (:304) | Force-sent ETH recovery | `onlyOwner` | zero/balance guards |
| `recoverExcessWeth(address recipient, uint256 amount) public` (:313) | Recovers WETH above `accountedWeth` only (:317-318) | `onlyOwner` | `NO_EXCESS_WETH`, `EXCESS_WETH_BALANCE` |
| `lockedWeth(address) external view returns (uint256)` (:104); `roundPosition(address,uint8) external view returns (uint256,uint256,bool,bool)` (:108); `positions(address)` public mapping getter (:44) | Views | view | — |

`_settleVaultPosition` (:227-291): recomputes per-round previews locally and requires
launch-returned sale tokens equal the sum (`FINAL_CLAIM_MISMATCH`, :254) — the locker's
defense against a divergent launch; branches on `launch.liquidityPoolCreated()` (:245):
on-time → `claimVaultSettlement`, late → `claimLateSettlement` (:249-253); transfers
`wethForVault` to the vault and `treasuryWeth` to the treasury **from the locker**
(:268-269); in the late branch then calls
`ID17VaultLateLiquidity(vault).mintLateLiquidity(lateLpTokens, wethForVault)` (:272-274)
— settlement, WETH delivery, and pair top-up are **atomic in one transaction**; any
leftover `wethCommitted` becomes withdrawable residual (:276-278). Emits
`VaultSettlementCompleted` for both paths (:280-290); late-ness is distinguished by the
launch/vault events in the same receipt.

### 5.5 D17LiquidityVault (D17LiquidityVault.sol, 207 lines)

Purpose: creates and permanently holds the official LP position. Immutables: `launch`,
`token`, `weth`, `router`, `routerFactory` (resolved from router at construction,
:68-70), `treasury` (:12-17). **No function transfers or burns vault-held LP — LP is
locked forever** (recovery excludes it, :183).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `createOfficialPool(uint256 minLpMinted, uint256 deadline) external returns (address pair, uint256 liquidityTokens, uint256 wethForPool, uint256 liquidity)` (:88) | Gets-or-creates the pair (:100-103); requires virgin pair (`totalSupply == 0`, :105) with zero token balance (`PAIR_PRESEEDED_TOKEN`, :111; donated WETH tolerated and recorded, :107-110); claims tokens+WETH figures from launch (:113); transfers both to pair, mints LP to itself (:121-123); slippage floor (:124); writes vault records; callback `markLiquidityPoolCreated` (:134) | **permissionless** (time-gated by launch, :98) | `POOL_CREATED`, `DEADLINE`, `POOL_CREATION_NOT_OPEN`, `PAIR_ALREADY_LIVE`, `PAIR_PRESEEDED_TOKEN`, `VAULT_TOKEN_BALANCE`, `NO_TOKEN_BALANCE`, `NO_WETH_FOR_POOL`, `VAULT_WETH_BALANCE`, `LP_SLIPPAGE` |
| `mintLateLiquidity(uint256 tokenAmount, uint256 wethAmount) external returns (uint256 liquidity)` (:144) | Deposits a late settler's exact amounts into the official pair, mints LP to the vault; counters `lateTokenUsedForLp`/`lateWethUsedForLp`/`lateLpMinted` (:163-165) | registered lockers only (`launch.factory()` → `isLocker`, :149-153) | `POOL_NOT_CREATED`, `NOT_D17_LOCKER`, `LATE_AMOUNTS_ZERO`, `VAULT_TOKEN_BALANCE`, `VAULT_WETH_BALANCE`, `LATE_LP_ZERO` |
| `sweepExcessWethToTreasury() external returns (uint256)` (:170) | Post-pool donation sweep (all legitimate WETH is consumed atomically; see §5.4) | permissionless | `POOL_NOT_CREATED`, `NO_EXCESS_WETH` |
| `recoverUnsupportedTokenToTreasury(address tokenAddress, uint256 amount) external` (:178) | Foreign-token recovery; excludes `token`, `weth`, `officialPair` (:181-183) | permissionless | `AMOUNT_ZERO`, `TOKEN_ZERO`, `*_PROTECTED` |
| `sweepUnexpectedEthToTreasury() external returns (uint256)` (:188) | Force-sent ETH sweep | permissionless | `NO_ETH_BALANCE` |

Vault records: `poolCreated`, `officialPair`, `tokenUsedForPool`, `wethUsedForPool`,
`lpMinted` (write-once, :126-130), `preseededTokenReserve`/`preseededWethReserve`
(:131-132), late counters (:24-26). Events: `OfficialPoolCreated(pair idx, tokenUsed,
wethUsed, lpMinted, preseededTokenReserve, preseededWethReserve)` (:31-38),
`LateLiquidityAdded(locker idx, pair idx, tokenUsed, wethUsed, lpMinted)` (:39-45),
sweep/recovery events (:46-48).

### 5.6 D17Token (D17Token.sol, 295 lines)

Minimal ERC-20 (18 decimals, :19) with launch-coupled transfer/burn gates and on-chain
metadata (`contractURI`). Owner = launch factory only during deployment; renounced in the
same transaction (§3 step 10).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `transfer(address,uint256) / transferFrom(address,address,uint256) external returns (bool)` (:159/:170) | ERC-20 with pre-open gate via `_transfer` (:216-229) | any | `TRADING_CLOSED`, `BALANCE`, `ALLOWANCE`, `TO_ZERO` |
| `approve(address,uint256) external returns (bool)` (:164) | Standard; infinite-allowance shortcut in transferFrom (:172) | any | — |
| `burn(uint256 amount) external` (:182) | **Pre-open: launch only** (`msg.sender == launch \|\| tradingOpen`, `BURN_BEFORE_OPEN`, :187); post-open: any holder | gated | `BURN_BEFORE_OPEN`, `BALANCE` |
| `mint(address,uint256) external` (:196) | Capped mint; only during deployment window | `onlyOwner` | `MINTING_CLOSED`, `CAP`, `TO_ZERO` |
| `closeMinting() / renounceOwnership() external` (:205/:211) | One-shot close; owner destruction | `onlyOwner` | `MINTING_CLOSED` |
| `configureTradingGate(address launch_, address d17Factory_, address weth_, address routerFactory_, address liquidityVault_, uint256 tradingOpenAt_) external` (:86) | One-shot gate wiring (validates code at all five addresses, `tradingOpenAt_ > now`) | `onlyOwner` | `TRADING_GATE_CONFIGURED`, zero/no-code, `TRADING_OPEN_NOW` |
| `configureMetadata(string calldata, string calldata, ID17LaunchFactory.Link[] calldata) external` (:118) | One-shot metadata + `metadataHash` | `onlyOwner` | `METADATA_CONFIGURED` |
| Views: `tradingOpen()` (:136), `canonicalPair()` (:154), `contractURI()` (:150), `linkCount()`/`links(uint256)` (:140/:144) | Gate/metadata reads | view | `LINK_INDEX` |

Gate logic `_transferAllowedBeforeOpen(from, to)` (:231-241): before configuration →
false; `from == launch` → true (settlement/unsold flows); `from == liquidityVault && to ==
canonicalPair()` → true (pool creation + late top-ups); otherwise requires
`_launchTradingOpen()` — a try/catch read of `launch.tradingOpen()` that **fails closed**
(:243-249). Zero-amount transfers still pass the gate check (:218-223). `unchecked`
arithmetic in `transferFrom`/`burn`/`_transfer` is guarded by preceding requires
(:174-177, :189-192, :224-227).

### 5.7 D17TokenFactory / D17LiquidityVaultFactory (51 lines each)

Identical pattern: owner pins `launchFactory` once (:28-35), `renounceOwnership` requires
the pin (:37-41), `deployToken` (D17TokenFactory.sol:43-50) / `deployVault`
(D17LiquidityVaultFactory.sol:43-50) callable only by the pinned launch factory. IDs at
:7. Events at :13-15.

### 5.8 D17LockerFactory (D17LockerFactory.sol, 30 lines)

`createLockerFor(address lockerOwner) external returns (address locker)` (:22-29):
**requires `msg.sender == lockerOwner`** (`ONLY_SELF`, :24) — no third party can create a
locker for someone else; deploys `D17Locker(lockerOwner, d17Factory, registry.weth())` and
registers it via `registerLockerFor`. Multiple lockers per owner are allowed (append-only
`lockersByOwner`).

### 5.9 lib/D17SafeTransfer (29 lines)

`safeTransfer` (:10), `safeTransferFrom` (:15), `safeApprove` (:20), `safeBurn` (:25):
raw-call wrappers tolerating missing return values, reverting on `false`/failure with
typed errors (:4-8). **Not** fee-on-transfer-safe — acceptable because the only tokens
touched are D17Token, canonical WETH, and the V2 pair.

## 6. The math

Units: WETH/token amounts in wei (18 decimals); prices in **WAD** (1e18) as WETH-per-token;
shares/fees in **BPS** (1e4). All divisions floor; every floor rounds **against the
claimant** (dust accrues to the launch or pool, never to a user).

**6.1 Anchor discovery (round 0).**
`anchorPriceWad = roundRaised[0] * 1e18 / roundBaseTokenAllocation(0)` (D17Launch.sol:337-341);
`anchorReady = roundRaised[0] ≥ minPhase1Weth ∧ anchorPriceWad ≥ minAnchorPriceWad` (:343-345).
Failure: if the window after round 0 closes without `anchorReady`, `launchFailed()`
becomes true permanently (:347-349) and only `releaseFailedRefund` remains.

**6.2 Round targets, sales, rollover.**
`roundBaseTokenAllocation(r) = saleTokens * roundSharesBps[r] / BPS` (:317-320).
Rounds 1–3: `roundAnchorTargetWeth(r) = allocation(r) * anchorPriceWad / WAD` (:351-357);
`roundSoldTokens(r) = raised ≥ target ? allocation : allocation * raised / target`
(:367-379) — overfill above target is allowed and worsens the round's discovered price;
underfill rolls the unsold remainder into the final round:
`rolloverToFinalRound = Σ_{r=1..3} max(allocation(r) − sold(r), 0)` (:381-387).
Round 4 sells its entire pool (`finalRoundTokenPool = base(4) + rollover`, snapshotted at
finalization, :752) pro-rata to raised WETH. Buyer share:
`_roundTokensForBuyer(r, paid) = sold(r) * paid / roundRaised[r]` (round 0 uses the base
allocation) (:788-799).

**6.3 Refunds.** In window `r` (windows exist for rounds 0–3 only, :295-301):
`penalty = r < FREE_REFUND_ROUNDS(=2) ? 0 : gross * refundPenaltyBps / BPS`;
`refund = gross − penalty` (:574-575). Refund decrements `roundRaised[r]` (:566) — all
downstream math (anchor, targets, rollover, finalization snapshot) uses post-refund
values. Failed-launch refunds are always penalty-free (:585-604).

**6.4 Finalization** (:745-774): one-shot; snapshots `finalCommittedWeth =
totalCommittedWeth()` (must be > 0) and `finalRoundTokenPool`; computes
`unsoldSaleTokensSettled = saleTokens − Σ roundSoldTokens` (capped, :801-804) and either
burns it (`safeBurn`, `burnUnsoldSaleTokens == true`) or transfers to treasury (:762-771).

**6.5 Settlement split** (both paths, :776-786):
`gross = Σ position.paid[r]`; `wethForVault = gross * (BPS − treasuryBps) / BPS`;
`treasuryWeth = gross − wethForVault` (fee ceiling by subtraction). Sale tokens =
`previewFinalSaleTokens` (§6.2 per-round sum). **Late equivalence:** `claimLateSettlement`
uses the identical `_settlePosition` amounts — same tokens, same gross, same fee; the only
difference is the destination of `wethForVault` (pair top-up instead of pre-pool vault
balance) and the extra reserved-token release (§6.6).

**6.6 Pool funding and late top-up.** Let `L = lpTokens`,
`T = totalLiquidityWeth() = finalCommittedWeth * (BPS − treasuryBps) / BPS` (:418-421,
fixed after finalization). Initial pool: `tokens = L * settledLiquidityWeth / T`,
`weth = settledLiquidityWeth` (:702-703) — reserve ratio `≈ L/T`, the **canonical launch
ratio**, independent of how many settled. Late top-up per position:
`lateLpTokens = L * wethForVault / T` (:656) paired with `wethForVault` — the same ratio.
Reserve-bound proof: every term floors against the common fixed denominator `T`, and
Σ `wethForVault_i` ≤ T, hence `initial + Σ late ≤ L`; enforced defensively at :657-660.
Residual LP-token dust (a few wei) remains in the launch permanently. Uniswap V2 `mint`
credits `min(tokenIn/tokenReserve, wethIn/wethReserve) × supply`; when the pair price has
drifted from the launch ratio, the excess leg is donated to K (accrues pro-rata to LP
holders — dominantly the locked vault position); bounded arbitrage extraction from locked
pool book value is an accepted economic risk. It does not alter a participant's
token entitlement or refund amount.

**6.7 Dust & recovery paths.** Launch: force-sent ETH → `sweepUnexpectedEthToTreasury`
(:737-743); LP/sale-token dust stays (no recovery function — intentional). Locker: ETH →
`recoverNativeEth`; WETH above `accountedWeth` → `recoverExcessWeth` (:313-321). Vault:
post-pool WETH donations → `sweepExcessWethToTreasury`; foreign tokens →
`recoverUnsupportedTokenToTreasury` (D17-token donations post-open are unrecoverable by
design — the exclusion protects reserved/late flows).

## 7. Access control & authenticity

Compatibility constants (all `keccak256` values fixed in deployed bytecode):
`D17_FACTORY_ID` (D17Factory.sol:12), `D17_LAUNCH_ID` (D17Launch.sol:10), `D17_TOKEN_ID`
(D17Token.sol:15), `D17_TOKEN_FACTORY_ID` (D17TokenFactory.sol:7),
`D17_LIQUIDITY_VAULT_ID` (D17LiquidityVault.sol:10), `D17_LIQUIDITY_VAULT_FACTORY_ID`
(D17LiquidityVaultFactory.sol:7), and `D17Locker.EXPECTED_LAUNCH_ID` (D17Locker.sol:10)
which **must equal** the launch ID — lockers reject incompatible launches with `BAD_LAUNCH_ID`
in `verifyLaunch` (D17Locker.sol:97). `rulesHash()` covers every economic parameter with
the launch ID as its first field (D17Launch.sol:254-282), so all hashes are
contract-family-separated; lockers pin the hash at first commit (D17Locker.sol:140) and
`settleAfterGrace` re-verifies against the **stored** hash (D17Locker.sol:221), so a third
party can never settle a user against different terms.

Self-registration: `createLockerFor` requires `msg.sender == lockerOwner`
(D17LockerFactory.sol:24); registration is restricted to the pinned locker factory
(D17Factory.sol:93-102) — the `isLocker` registry therefore contains only canonical locker
bytecode, which is the basis for `onlyLocker` on the launch and the
`mintLateLiquidity` auth on the vault (D17LiquidityVault.sol:149-153).

Deliberately permissionless entry points and why they are safe:

| Entry point | Why safe |
|---|---|
| `finalizeLaunch()` (D17Launch.sol:681) | Pure state transition from immutable timing + committed totals; one-shot; no caller-dependent outcome |
| `settleAfterGrace(launch)` (D17Locker.sol:218) | Only after the fixed grace boundary; outcome identical to owner settlement (tokens credit the locker; only the owner can withdraw); stored-rules-hash verification |
| `createOfficialPool(minLp, deadline)` (D17LiquidityVault.sol:88) | Time-gated by launch; virgin-pair + preseed checks; amounts come from launch accounting, not caller; caller supplies only slippage/deadline protections for themselves |
| Sweeps/recovery (launch :737, vault :170,178,188) | Can only move donations/force-sent value to the fixed treasury; accounted funds are unreachable by construction |

## 8. Invariants (enforcement map)

| # | Invariant | Enforcing check(s) |
|---|---|---|
| 1 | Supply conservation: `sale + lp + manual + dead == tokenSupply`; mint one-shot; no post-deploy authority | D17Factory.sol:185-193; D17LaunchFactory.sol:128-132; D17Token.sol:196-203 (`CAP`, `MINTING_CLOSED`), :211-214 |
| 2 | Timing-invariant buyer outcome (no cheap-token, no overcharge) | single `_settlePosition` + `_vaultSettlementAmounts` for both paths (D17Launch.sol:633-679, 776-786); locker cross-check `FINAL_CLAIM_MISMATCH` (D17Locker.sol:254) |
| 3 | Treasury income = penalties + `treasuryBps` fee only | D17Launch.sol:574-580, 784-785; all other treasury transfers are donation sweeps (§7 table) |
| 4 | Sale-token conservation; single claim per position | claim flags (D17Launch.sol:641-642, 648-649); `_soldSaleTokenAmount` cap (:801-804); floors §6 |
| 5 | Custody isolation: user WETH lives in the user's locker until refund/settlement | D17Locker.sol:136-137 (wrap-and-hold); launch never receives WETH (no WETH inflow path in D17Launch) |
| 6 | No hostage mechanisms: no per-user gate on finalize/pool/trading; no unbounded user loops | absence of any all-settled require (`allFinalCommitmentsSettled` is view-only, D17Launch.sol:423-428); permissionless recovery (§7) |
| 7 | Claims never expire | no deadline on `claimVaultSettlement`/`claimLateSettlement`/`settleAfterGrace` beyond the grace *opening* (D17Locker.sol:223) |
| 8 | Fixed grace boundary | `poolCreationOpensAt` pure function of finalization-time values (D17Launch.sol:404-408) |
| 9 | One-time pool creation; write-once pool records | `POOL_CREATED`/`VAULT_LIQUIDITY_CLAIMED` guards (D17Launch.sol:692-693, 720-721); vault `poolCreated` (D17LiquidityVault.sol:93); snapshot equality checks (D17Launch.sol:723-724) |
| 10 | LP reserve bound: `initial + Σ late ≤ lpTokens` | common-denominator floor math (§6.6); `LP_RESERVE_EXCEEDED` (D17Launch.sol:657-660) |
| 11 | LP permanence: vault LP is unwithdrawable | no LP-moving function exists; recovery excludes `officialPair` (D17LiquidityVault.sol:183) |
| 12 | No transfer/burn before trading open (except launch & vault→pair) | `_transferAllowedBeforeOpen` (D17Token.sol:231-241); burn gate (:187) |
| 13 | Incompatible-contract rejection | `EXPECTED_LAUNCH_ID` check (D17Locker.sol:97); `rulesHash` domain separation (D17Launch.sol:256) |
| 14 | Refund non-negativity & ledger balance | `refund = gross − penalty` with `penalty ≤ gross` (`refundPenaltyBps ≤ BPS`, D17Launch.sol:191, 574-575); locker ledger guards (D17Locker.sol:158-159, 246-255) |

## 9. Event catalogue (indexer/UI contract)

| Stage | Event (indexed → `idx`) | Emitter | Cite |
|---|---|---|---|
| Suite deploy | `OwnershipTransferred(prev idx, new idx)`; `LaunchFactoryPinned(addr idx)`; `LockerFactoryPinned(addr idx)`; `TokenCreated(token idx, name, symbol, maxSupply)`; `LiquidityVaultCreated(launch idx, token idx, vault idx)` | factories | D17Factory.sol:54,72-73; D17TokenFactory.sol:13-15; D17LiquidityVaultFactory.sol:13-15 |
| Launch creation | `LaunchCreated(creator idx, launch idx, token idx, liquidityVault, rulesHash)`; `ManualDistributionConfigured(launch idx, recipient idx, amount)`; `LaunchMetadataPublished(launch idx, metadataHash idx, description, logoSvgUri, linkTypes[], linkUrls[])`; `LiquidityVaultConfigured(vault idx)`; `TradingGateConfigured(launch idx, d17Factory idx, weth idx, routerFactory, vault, tradingOpenAt)`; `TokenMetadataConfigured(metadataHash idx, …)`; `ContractURIUpdated()`; `MintingClosed()` | factory / launch / token | D17Factory.sol:55-70; D17Launch.sol:101; D17Token.sol:49-65 |
| Locker setup | `LockerCreated(owner idx, locker idx)`; `LockerRegistered(owner idx, locker idx, manager idx)` | lockerFactory / factory | D17LockerFactory.sol:14; D17Factory.sol:71 |
| Rounds | `RoundCommitted(locker idx, round idx, amount)` (launch) and `RoundCommitted(launch idx, round idx, amount)` (locker) | both | D17Launch.sol:102; D17Locker.sol:46 |
| Refunds | `RoundRefunded(locker idx, refundRound idx, refundWeth, penaltyWeth)` (launch) / `(launch idx, round idx, …)` (locker); `LaunchFailedRefunded` / `FailedLaunchRefunded`; `WethWithdrawn(launch idx, amount)` | both | D17Launch.sol:103-104; D17Locker.sol:47-48,61 |
| Finalization | `Finalized(finalizedAt)`; `UnsoldSaleTokensBurned(amount)` or `UnsoldSaleTokensPaid(recipient idx, amount)` | launch | D17Launch.sol:120,133-134 |
| Settlement (on-time) | `VaultSettlementClaimed(locker idx, saleTokens, wethForVault, treasuryWeth, gross)` (launch); `VaultSettlementCompleted(launch idx, vault idx, settler idx, owner, saleTokens, wethSentToVault, treasuryWeth, gross, residualWeth)` (locker, both paths) | launch + locker | D17Launch.sol:105-111; D17Locker.sol:49-59 |
| Pool creation | `VaultLiquidityTokensClaimed(vault idx, liquidityTokens, wethForPool)`; `LiquidityPoolCreated(vault idx, pair idx, tokenUsed, wethUsed, lpMinted)`; `OfficialPoolCreated(pair idx, tokenUsed, wethUsed, lpMinted, preseededTokenReserve, preseededWethReserve)` | launch / vault | D17Launch.sol:121-132; D17LiquidityVault.sol:31-38 |
| Late settlement | `LateVaultSettlementClaimed(locker idx, saleTokens, wethForVault, treasuryWeth, lateLpTokens, gross)`; `LateLiquidityAdded(locker idx, pair idx, tokenUsed, wethUsed, lpMinted)`; plus the locker's `VaultSettlementCompleted` | launch / vault / locker | D17Launch.sol:112-119; D17LiquidityVault.sol:39-45 |
| Withdrawals & housekeeping | `ClaimedTokensWithdrawn(launch idx, amount)`; `ExcessWethRecovered`/`NativeEthRecovered` (locker); `ExcessWethSwept`/`UnsupportedTokenRecovered`/`UnexpectedEthSwept` (vault/launch) | locker / vault / launch | D17Locker.sol:60-63; D17LiquidityVault.sol:46-48; D17Launch.sol:135 |

Indexing rule (product-level): D17 pipelines ingest only the events above — never ERC-20
`Transfer`/`Approval` or pair `Swap`/`Sync`.

## 10. Testing

- **Local E2E** (`contracts/test/local-e2e.mjs`, fixture
  `test/fixtures/local-launch.json`, 25/10/10/55 split): one scripted lifecycle on an
  ephemeral Hardhat node — factory wiring, metadata/config adversarial reverts, a failed
  weak-anchor launch, an 18-locker 5-round main launch with refunds in every window
  (schedule asserted with exact-bps checks), partial settlement, pool creation with three
  deliberately late lockers, a price-moving trade, late top-ups at and after divergence
  (exact reserve-delta assertions), double-claim/foreign-caller reverts, burn-gate cases,
  supply-conservation sweeps, and a zero-late control launch. **493 named assertions, 0
  failures.** Run: `npm ci && npm test`.
- **Sepolia**: the public factory deployment and launch lifecycle provide live
  network evidence for factory wiring, launch creation, refund policy,
  settlement, official pool creation and late liquidity top-ups.
- **Coverage gaps worth noting**: no property-based/fuzz suite (scenario E2E only); no
  differential testing against a second AMM implementation; mainnet-fork tests not run
  (real-WETH/router behavior reasoned + Sepolia-verified against real V2 instead);
  `LATE_AMOUNTS_ZERO`/`LP_RESERVE_EXCEEDED` guards are unreachable under config bounds and
  therefore untested end-to-end.

## 11. Known limitations & review status

1. **Not independently audited.** Treat all use, especially mainnet use, as
   experimental and review the source and deployment yourself.
2. **Hardcoded refund schedule** — `FREE_REFUND_ROUNDS` is a private constant with no
   getter (D17Launch.sol:14-16); integrators must use the bundled contract identity and ABI.
3. **Code-size ceiling**: `D17LaunchFactory` deployed bytecode 24,469/24,576 bytes.
   Any contract growth risks undeployability; verify code size after every source change.
4. **AMM assumption**: honest Uniswap-V2 semantics (`min`-leg mint, reserves mutate only
   via mint/burn/swap/sync/skim). Late top-ups at the launch ratio under price divergence
   donate the excess leg to K — bounded extraction from locked pool book value by
   arbitrageurs/third-party LPs is accepted (never touches user entitlements). A future
   `feeTo` enablement dilutes LP growth but breaks no check (return-value accounting).
5. **WETH assumption**: canonical WETH9 — no fee-on-transfer, no hooks.
   `D17SafeTransfer` does not defend against fee-on-transfer tokens.
6. **`unchecked` blocks**: D17Token.sol:174-177, 189-192, 224-227 — each guarded by an
   immediately-preceding require; no other unchecked arithmetic in the suite. Cap-style
   multiplications (e.g. `manualDistributionTokens * BPS`, D17Factory.sol:190-193) can
   panic rather than revert-with-reason on absurd inputs (house style).
7. **Config economics unvalidated**: `treasuryBps ≤ 20%`, `refundPenaltyBps ≤ 50%` are
   caps, not recommendations; the factory validates structure, not economics. Per-launch
   config review is an off-chain/deploy-page responsibility.
8. **Donation edge cases**: post-open D17-token donations to the vault are permanently
   stuck (recovery excludes `token`); WETH donated to a failed launch's pair or to lockers
   is recoverable only via the documented paths; LP/sale dust in the launch is permanent.
9. **`createLaunch` gas**: deploys three contracts in one transaction (~13–15M gas on
   mainnet) — near half a block; front-ends must set limits accordingly.
10. **No admin recovery**: with ownership renounced and pins one-shot, the only recovery
    from a bad suite deployment is redeploying a new suite; launches are immutable once
    created.

---

**Reference source:** `contracts/contracts/` and `contracts/SHA256SUMS.txt`.
