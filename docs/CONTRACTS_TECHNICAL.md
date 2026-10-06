# D17 Contract Suite - Technical Reference (V15)

Audience: Solidity/EVM engineers integrating with, extending, or reviewing the suite.
Citation convention: `File.sol:line` paths are relative to the checksummed
`contracts/contracts/` directory. `contracts/SHA256SUMS.txt` identifies
the exact production source described here. The rule-level changes from the upstream V14
suite are summarised in [V15_HARDENING.md](./V15_HARDENING.md).

---

## 1. Overview & scope

**Status:** local E2E green — **567/567** assertions in `test/local-e2e.mjs` and **52/52**
in `test/hardening-e2e.mjs`. Slither 0.11.6 reports no exploitable finding. V15 is **not
deployed** on any network yet and has **not** received a formal professional third-party
audit.

D17 is a five-round fair-launch protocol on a Uniswap-V2-style AMM. Users commit ETH
(wrapped to WETH) through personal escrow contracts ("lockers"); round 0 discovers an
anchor price and every later round sells at or above it; refund windows follow rounds
0–3 and every refund pays a penalty into the official pool; after finalization each
locker settles — sale tokens to the buyer, a treasury fee, a protocol fee, and the
remainder into a permanently locked official liquidity pool. Pool creation is
permissionless and never blocked by unsettled users: the initial pool pairs settled WETH
plus all refund penalties with a *proportional* share of the (sale-scaled) LP token
allocation at the canonical launch ratio; late settlers add their share at the pair's
live ratio, forever. All admin authority in the creation path is destroyed before the
first launch can exist (one-shot pins, mint close, ownership renounce, enforced on-chain).
The only surviving owner is `D17FeeConfig`'s, which can only set the protocol fee
(≤ 2%) for future launches.

## 2. Topology

```text
   ┌────────────────┐ currentFee()  ┌──────────────────────────────────────────────────┐
   │ D17FeeConfig   │◄──────────────│ D17Factory  (entry point, config validation,     │
   │ (fee ≤ 2%,     │  read at      │  fee snapshot, launch + locker registries)       │
   │  multisig own.)│  createLaunch └───┬──────────────────────────────────┬───────────┘
   └────────────────┘ createLaunch(cfg) │ onlyD17Factory                   │ registerLockerFor
                                        ▼                                  │ (pinned lockerFactory)
                             ┌──────────────────┐               ┌──────────┴────────┐
                             │ D17LaunchFactory │               │ D17LockerFactory  │
                             └─┬──────┬───────┬─┘               └──────────┬────────┘
               deployToken     │      │       │ deployVault                │ createLockerFor
                               ▼      │       ▼                            ▼ (msg.sender == owner)
                 ┌───────────────┐    │   ┌─────────────────────────┐ ┌────────────┐
                 │D17TokenFactory│    │   │D17LiquidityVaultFactory │ │ D17Locker  │ personal escrow,
                 └──────┬────────┘    │   └───────────┬─────────────┘ └─────┬──────┘ positions across
                        ▼             ▼ deployLaunch  ▼                     │        launches
                 ┌───────────┐ ┌───────────────────┐ ┌───────────────────┐  │
                 │ D17Token  │ │ D17LaunchDeployer │ │ D17LiquidityVault │◄─┤ penalties, LP-share
                 └───────────┘ └─────────┬─────────┘ │ (LP locked, late  │  │ WETH, mintLateLiquidity
                       ▲                 ▼           │  liquidity, creator│  │
                       │           ┌───────────┐     │  vesting)          │  │
                       │ gate reads│ D17Launch │◄────└───────────────────┘  │ onlyLocker
                       │ tradingOpen└──────────┘◄───────────────────────────┘
                       └────────────────┘   onlyVault: claimVaultLiquidityTokens,
                                                       markLiquidityPoolCreated
```

Authority edges (all others are permissionless or view):

| Caller → callee | Functions | Guard | Cite |
|---|---|---|---|
| D17Factory → D17FeeConfig | `currentFee` (view) | — | D17Factory.sol:166 |
| D17Factory → D17LaunchFactory | `deployLaunch` | `onlyD17Factory` | D17LaunchFactory.sol:63-66,83-91 |
| D17LaunchFactory → D17LaunchDeployer | `deployLaunch(bytes)` | pinned `launchFactory` only; encoded `vaultConfigurator == msg.sender` | D17LaunchDeployer.sol:51-61 |
| D17LaunchFactory → D17TokenFactory / D17LiquidityVaultFactory | `deployToken` / `deployVault` | pinned `launchFactory` only | D17TokenFactory.sol:43-50, D17LiquidityVaultFactory.sol:43-50 |
| D17LaunchFactory → D17Launch | `configureLiquidityVault` | `msg.sender == vaultConfigurator` (one-shot) | D17Launch.sol:259-266 |
| D17LaunchFactory → D17Token | `configureTradingGate`, `configureMetadata`, `mint`, `closeMinting`, `renounceOwnership` | `onlyOwner` (owner = launch factory until renounce) | D17Token.sol:86,118,196,205,211 |
| D17Locker → D17Launch | `recordRoundCommitment`, `releaseRoundRefund`, `releaseFailedRefund`, `claimVaultSettlement`, `claimLateSettlement` | `onlyLocker` via `ID17FactoryView(factory).isLocker` | D17Launch.sol:175-178 |
| D17LiquidityVault → D17Launch | `claimVaultLiquidityTokens`, `markLiquidityPoolCreated` | `onlyVault` | D17Launch.sol:180-183 |
| D17Locker → D17LiquidityVault | `mintLateLiquidity` | registered locker via `launch.factory()` → `isLocker` | D17LiquidityVault.sol:183-186 |
| D17LockerFactory → D17Factory | `registerLockerFor` | pinned `lockerFactory` only | D17Factory.sol:110-119 |
| D17FeeConfig owner → D17FeeConfig | `setProtocolFee`, `transferOwnership`, `renounceOwnership` | `onlyOwner`; `acceptOwnership` by `pendingOwner` | D17FeeConfig.sol:41-65 |

Canonical registry: `D17Factory.launches[launch] = LaunchRecord{canonical, creator, token,
liquidityVault, rulesHash}` written once at creation (D17Factory.sol:170-177);
`isCanonicalLaunch(launch, rulesHash)` requires **both** the address and the pinned rules
hash to match (D17Factory.sol:193-196). Lockers never trust an address alone.

## 3. Deployment & wiring

Suite deployment (per `scripts/deploy-factory.mjs`): deploy
`D17FeeConfig(feeOwner, feeRecipient, feeBps)`, `D17Factory(owner, weth, router,
feeConfig)`, `D17TokenFactory(owner)`, `D17LiquidityVaultFactory(owner)`,
`D17LaunchDeployer(owner)`, `D17LaunchFactory(d17Factory, tokenFactory, vaultFactory,
launchDeployer)`, `D17LockerFactory(d17Factory)`; pin the launch factory into the token
factory, vault factory, launch deployer and D17Factory, pin the locker factory into
D17Factory; renounce every owner except the fee config's. Every pin is one-shot
(D17Factory.sol:121-137; D17TokenFactory.sol:28-35; D17LiquidityVaultFactory.sol:28-35;
D17LaunchDeployer.sol:32-39). `renounceOwnership` requires the pins first
(D17Factory.sol:145-150; D17LaunchDeployer.sol:41-45).

Renunciation is **enforced, not advisory**: `createLaunch` reverts with
`FACTORY_NOT_RENOUNCED` while D17Factory has an owner (D17Factory.sol:163) and
`deployLaunch` reverts with `FACTORIES_NOT_RENOUNCED` while the token factory, vault
factory or launch deployer has one (D17LaunchFactory.sol:95-100). The deploy script
refuses to run without `RENOUNCE_D17_FACTORY_OWNER=1` and, on mainnet, refuses an EOA as
fee owner; `verify:factory` checks every owner is zero.

Launch creation is **one transaction**, `D17Factory.createLaunch(config)`
(D17Factory.sol:156-191) → `D17LaunchFactory.deployLaunch(config, msg.sender,
feeRecipient, feeBps)`:

| # | Step | Cite |
|---|------|------|
| 0 | Require both pins and `owner == 0`; `_validateConfig` (full table §5.1) | D17Factory.sol:160-164 |
| 1 | Read `(feeRecipient, feeBps)` from D17FeeConfig; require `feeBps ≤ config.maxProtocolFeeBps` (`PROTOCOL_FEE_ABOVE_MAX`) | D17Factory.sol:166-167 |
| 2 | `require(creator != 0)`; require token factory, vault factory and launch deployer owners are zero | D17LaunchFactory.sol:93-100 |
| 3 | Deploy `D17Token` (owner = launch factory) | D17LaunchFactory.sol:101-106 |
| 4 | Deploy `D17Launch` through `D17LaunchDeployer.deployLaunch(abi.encode(LaunchParams))` (fee recipient/rate, manual allocation + creator recipient included) | D17LaunchFactory.sol:108-137 |
| 5 | Deploy `D17LiquidityVault(launch, token, weth, router, treasury)` | D17LaunchFactory.sol:139-142 |
| 6 | `launch.configureLiquidityVault(vault)` (one-shot) | D17LaunchFactory.sol:144 |
| 7 | `token.configureTradingGate(launch, d17Factory, weth, routerFactory, vault, tradingOpenAt)` | D17LaunchFactory.sol:145-152 |
| 8 | `token.configureMetadata(description, logoSvgUri, links)` | D17LaunchFactory.sol:153 |
| 9 | Mint `saleTokens + lpTokens` → launch | D17LaunchFactory.sol:155 |
| 10 | Mint `manualDistributionTokens` → **liquidity vault** (vested to the creator, §6.8) | D17LaunchFactory.sol:156-160 |
| 11 | Mint `deadTokens` → `0x…dEaD` (if > 0) | D17LaunchFactory.sol:161 |
| 12 | `closeMinting()`; `renounceOwnership()` — **no mint authority survives** | D17LaunchFactory.sol:162-163 |
| 13 | Factory records canonical entry, emits `LaunchCreated`, `ManualDistributionConfigured`, `LaunchMetadataPublished` | D17Factory.sol:170-190 |

`rulesHash()` is read *after* vault configuration (it includes `liquidityVault`), so the
registered hash is final (D17Factory.sol:170; D17Launch.sol:268-297).

## 4. Lifecycle state machine

Contract rounds 0–4 = display rounds 1–5. Timing anchors: `startTime` (immutable),
`roundStart/roundEnd` (derived walk over `roundSeconds[5]` + `refundSeconds` after rounds
0–3, D17Launch.sol:318-330), `tradingOpenAt = roundEnd(4) + settlementSeconds`
(immutable, D17Launch.sol:236), `finalizedAt` (set at finalization),
`poolCreationOpensAt() = finalized ? max(finalizedAt + settlementSeconds, tradingOpenAt) :
tradingOpenAt` (D17Launch.sol:415-419). `tradingOpen() == liquidityPoolCreated`
(D17Launch.sol:421-423). On Ethereum mainnet (`block.chainid == 1`) the factory requires
`startTime ≥ now + 1 day` and every round/refund/settlement window ≥ 1 hour
(D17Factory.sol:220-229, 241).

`launchPhase()` (D17Launch.sol:512-544) reports one of 8 phases:

| Phase (const, D17Launch.sol:22-29) | Predicate | State-changing calls allowed (launch-side) |
|---|---|---|
| 0 `PHASE_NOT_STARTED` | `now < startTime` | — |
| 1 `PHASE_ROUND_OPEN` (idx = round) | `activeRound() != NO_ROUND` (rounds 1+ additionally require `anchorReady()`, :303) | `recordRoundCommitment(round,…)` |
| 2 `PHASE_REFUND_OPEN` (idx = round) | `activeRefundWindow() != NO_ROUND` (windows follow rounds 0–3 only, :310-316) | `releaseRoundRefund()` |
| 7 `PHASE_FAILED` | `launchFailed()`: not finalized ∧ `now ≥ roundEnd(0)+refundSeconds` ∧ `!anchorReady()` (:361-363) | `releaseFailedRefund()` (forever); vault `burnFailedLaunchPenalties()` |
| 3 `PHASE_READY_TO_FINALIZE` | `now ≥ roundEnd(4)`, not finalized | `finalizeLaunch()` (permissionless); settlement calls auto-finalize (:658) |
| 4 `PHASE_SETTLEMENT_OPEN` | finalized ∧ `now < poolCreationOpensAt()` | `claimVaultSettlement()` (via locker owner) |
| 5 `PHASE_POOL_READY` | finalized ∧ `now ≥ poolCreationOpensAt()` ∧ pool not created | `claimVaultSettlement()`; `settleAfterGrace` permissionless (locker-side); `createOfficialPool` (vault, permissionless) |
| 6 `PHASE_TRADING_OPEN` | `liquidityPoolCreated` | `claimLateSettlement()` (forever); locker `withdrawUnlockedTokens`; token transfers/burns ungated; vault `releaseCreatorTokens`; launch `burnResidualTokens` once all settled |

Failure is terminal-by-predicate (only reachable pre-finalization); finalization is
one-shot (`FINALIZED`, D17Launch.sol:779) and requires nonzero committed WETH (:789).
Pool creation is one-shot (`POOL_CREATED` + `VAULT_LIQUIDITY_CLAIMED`,
D17Launch.sol:715-716; vault `poolCreated`, D17LiquidityVault.sol:122).

## 5. Per-contract reference

Notation: **AC** = access control. All state-changing functions in D17Launch, D17Locker,
D17LiquidityVault are `nonReentrant` (storage-flag pattern, e.g. D17Launch.sol:185-190);
not repeated per row. `receive()`/`fallback()` revert on D17Launch (:251-257), D17Locker
(:88-94), D17LiquidityVault (:96-102).

### 5.1 D17Factory (D17Factory.sol, 330 lines)

Purpose: entry point, config validation, fee snapshot, canonical launch + locker registries.
Constants: `D17_FACTORY_ID` (:16), `BPS = 10_000` (:17), `MAX_TREASURY_BPS = 1_000`
(:20), `MAX_MANUAL_DISTRIBUTION_BPS = 1_000` (:21), `MIN_REFUND_PENALTY_BPS = 100` /
`MAX_REFUND_PENALTY_BPS = 2_500` (:24-25), `ROUND_COUNT = 5` (:26), metadata bounds
(:27-32), `MIN_COMMIT_WETH = 1e15` (:33), `MIN_LP_TOKENS = 1e18` (:34),
`MIN_ROUND_ALLOCATION_TOKENS = 1e18` (:35), `MIN_ANCHOR_PRICE_WAD = 1e6` (:36),
round-seconds bounds 60s–90d (:37-38), refund/settlement ≤ 30d (:39-40),
`MAX_START_DELAY = 365 days` (:41), mainnet floors `MAINNET_MIN_WINDOW_SECONDS = 1 hours`
/ `MAINNET_MIN_START_DELAY = 1 days` (:45-46).
Key storage: `owner`, immutable `weth`/`router`/`feeConfig` (:49-51),
`launchFactory`/`lockerFactory` + pinned flags, `launches`, `isLocker`, `lockersByOwner`
(:65-67).

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `createLaunch(ID17LaunchFactory.LaunchConfig calldata config) external returns (address token, address launch, address liquidityVault)` (:156) | Validates config, snapshots the protocol fee, delegates deployment, registers canonical record, emits 3 events | any | pins missing; `FACTORY_NOT_RENOUNCED`; `PROTOCOL_FEE_ABOVE_MAX`; any validation failure below |
| `registerLockerFor(address lockerOwner, address locker) external` (:110) | Registers a locker | pinned lockerFactory only | `NOT_LOCKER_FACTORY`, zero/no-code/duplicate |
| `pinLaunchFactory(address) / pinLockerFactory(address) external` (:130/:121) | One-shot wiring | `onlyOwner` | `*_PINNED`, zero, no code |
| `transferOwnership(address) / renounceOwnership() external` (:139/:145) | Ownership; renounce requires both pins | `onlyOwner` | `OWNER_ZERO`; `*_UNLOCKED` |
| `isCanonicalLaunch(address launch, bytes32 rulesHash) external view returns (bool)` (:193) | Registry check: address **and** hash | view | — |
| `lockersOfOwner(address) external view returns (address[] memory)` (:152) | Locker enumeration per owner | view | — |

`_validateConfig` (:198-251) enforces: name/symbol length + JSON-safety; metadata bounds
(description ≤ 512B, ≤ 8 links, link type `[a-z0-9-]` ≤ 32B, link URL https + ≤ 128B +
JSON-safe, logo ≤ 8192B base64-SVG data URI, :253-298); `tokenSupply > 0`;
`saleTokens > 0`; `lpTokens ≥ 1e18`; **`saleTokens + lpTokens + manualDistributionTokens +
deadTokens == tokenSupply`** (`SUPPLY_SPLIT`, :207-211); **`manualDistributionTokens * BPS
≤ tokenSupply * 1000`** (`MANUAL_ABOVE_CAP`, :212-215); canonical dead recipient when
`deadTokens > 0` (:216-218); treasury nonzero; `startTime` in
[now (+1 day on mainnet), now + 365d] (`START_TOO_SOON`/`START_TOO_FAR`, :223-224);
refund/settlement seconds in [1 (1h on mainnet), 30d] (:225-229); `minCommitWeth ≥ 1e15`;
`minPhase1Weth ≥ minCommitWeth`; `minAnchorPriceWad ≥ 1e6`; **`treasuryBps ≤ 1000`**
(:233); **`100 ≤ refundPenaltyBps ≤ 2500`** (:234-237); 5 rounds, each 60s (1h on
mainnet)–90d, each share > 0 with allocation ≥ 1e18 tokens, shares summing to exactly
10 000 bps (:239-250). The manual-allocation **recipient is not a config field** — it is
always `msg.sender` of `createLaunch` (:169). The config field `maxProtocolFeeBps` is the
creator's consent bound (ID17LaunchFactory.sol).

Events: `LaunchCreated(creator idx, launch idx, token idx, liquidityVault, rulesHash)`
(:70-76), `ManualDistributionConfigured(launch idx, recipient idx, amount)` (:85, emitted
for every launch incl. amount 0), `LaunchMetadataPublished(launch idx, metadataHash idx,
description, logoSvgUri, linkTypes[], linkUrls[])` (:77-84),
`LockerRegistered(owner idx, locker idx, manager idx)` (:86), pin/ownership events
(:69,87-88).

### 5.2 D17FeeConfig (D17FeeConfig.sol, 74 lines)

Purpose: protocol fee settings for **future** launches. Constants: `D17_FEE_CONFIG_ID`
(:17), `MAX_PROTOCOL_FEE_BPS = 200` (:18). Storage: `owner`, `pendingOwner`,
`feeRecipient`, `protocolFeeBps`.

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `constructor(address owner_, address feeRecipient_, uint16 protocolFeeBps_)` (:34) | Initial settings through `_setFee` | — | `OWNER_ZERO`, `FEE_ABOVE_CAP`, `FEE_RECIPIENT_ZERO` |
| `setProtocolFee(address feeRecipient_, uint16 protocolFeeBps_) external` (:41) | Replace settings; `bps ≤ 200`, recipient required when `bps > 0` (:67-73) | `onlyOwner` | `NOT_OWNER`, `FEE_ABOVE_CAP`, `FEE_RECIPIENT_ZERO` |
| `currentFee() external view returns (address recipient, uint16 bps)` (:45) | Read by `createLaunch` | view | — |
| `transferOwnership(address) / acceptOwnership() / renounceOwnership()` (:49/:54/:61) | Two-step handover; renouncing freezes the settings forever | owner / pending owner | `NOT_OWNER`, `NOT_PENDING_OWNER` |

The fee config holds no funds and is never called by a launch: changing it cannot affect
any existing launch (§7). Events: `ProtocolFeeUpdated(feeRecipient idx, protocolFeeBps)`,
`OwnershipTransferStarted`, `OwnershipTransferred` (:25-27).

### 5.3 D17LaunchFactory (D17LaunchFactory.sol, 177 lines) and D17LaunchDeployer (61 lines)

D17LaunchFactory is the atomic deployer of the token/launch/vault trio (§3). Immutables:
`d17Factory`, `tokenFactory`, `liquidityVaultFactory`, `launchDeployer` (:58-61); constant
`CANONICAL_DEAD_RECIPIENT` (:56).

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `deployLaunch(LaunchConfig calldata config, address creator, address protocolFeeRecipient, uint16 protocolFeeBps) external returns (address token, address launch, address liquidityVault)` (:83) | §3 steps 2–12 | `onlyD17Factory` (:63-66) | `CREATOR_ZERO`, `FACTORIES_NOT_RENOUNCED` (:93-100); bubble-ups |

`_metadataHash(config)` = `keccak256(abi.encode(tokenName, tokenSymbol, description,
logoSvgUri, links))` (:166-176).

D17LaunchDeployer exists only for code size: it holds `D17Launch`'s creation code so the
launch factory does not. `deployLaunch(bytes encodedParams)` (D17LaunchDeployer.sol:51-61)
requires the pinned launch factory as caller, checks that the second static word of the
encoded `LaunchParams` (the vault configurator) equals the caller, then `create`s
`D17Launch` with `creationCode ‖ encodedParams`. Same owner → pin → renounce lifecycle as
the other factories (:32-45). **Code size:** D17LaunchDeployer 22,759 bytes (limit
24,576), so `D17Launch` creation code can grow by ~1.8 KB at most; D17LaunchFactory
5,129 bytes.

### 5.4 D17Launch (D17Launch.sol, 853 lines) — the engine

Constants: `D17_LAUNCH_ID` (:10), `ROUND_COUNT = 5`/`FINAL_ROUND = 4`/
`REFUND_STAGE_COUNT = 4` (:11-13), `EARLY_REFUND_ROUNDS = 2` (:16),
`EARLY_REFUND_PENALTY_BPS = 100` (:20), phase constants (:21-29), `BPS = 10_000` (:30),
mins (:31-34), `WAD = 1e18` (private, :35), dead address (:36). Immutables (:38-61):
factory, vaultConfigurator, token, weth, treasury, **protocolFeeRecipient**, startTime,
refundSeconds, settlementSeconds, tradingOpenAt, minCommitWeth, minPhase1Weth,
minAnchorPriceWad, treasuryBps, **protocolFeeBps**, refundPenaltyBps, saleTokens,
lpTokens, deadTokens, deadRecipient, manualDistributionTokens,
manualDistributionRecipient, metadataHash. Constructor takes one `LaunchParams` struct
(:107-132, :195-249); it keeps structural checks (incl. `treasuryBps + protocolFeeBps <
BPS` and a fee recipient when the fee is nonzero, :201-202) while economic caps live in
D17Factory.

Key storage (:63-96): `liquidityVault` (one-shot), `liquidityPoolCreated`,
`vaultLiquidityClaimed`, `officialPair`, `settledLiquidityWeth` (pre-pool vault
deliveries), `finalCommittedWeth` (finalization snapshot), `settledCommittedWeth` (gross
settled, incl. late), `poolSettledLiquidityWeth`/`poolSettledCommittedWeth` (pool-creation
snapshots), `lateSettledCommittedWeth`/`lateSettledLiquidityWeth`/`lateLpTokensReleased`,
`vaultLiquidityTokensClaimed`, write-once pool records, `roundSeconds[5]`/
`roundSharesBps[5]`/`roundRaised[5]`, `retainedPenaltyWeth`/`penaltyWethPaid`/
`treasuryWethPaid`/`protocolFeeWethPaid` (:85-88), `unsoldSaleTokensSettled`/
`unusedLpTokensBurned`/`effectiveLpTokens`/`finalRoundTokenPool`/`unsoldSaleTokensBurned`
(:89-93), `finalizedAt`, `finalized`. Per-locker `Position{finalSaleTokensClaimed,
liquidityClaimed, refundWeth, penaltyWeth, paid[5], refunded[5]}` (private mapping,
:98-105, :134).

State-changing ABI:

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `configureLiquidityVault(address liquidityVault_) external` (:259) | One-shot vault wiring | `vaultConfigurator` only | `VAULT_CONFIGURED`, zero, no code |
| `recordRoundCommitment(uint8 round, uint256 amount) external` (:546) | Books a commit into the active round | `onlyLocker` | `ROUND`, `COMMIT_TOO_SMALL`, `ROUND_CLOSED`, `ANCHOR_NOT_READY` (rounds 1–4, :550), claimed/refunded guards (:553-555) |
| `releaseRoundRefund() external returns (uint8 round, uint256 refundWeth, uint256 penaltyWeth)` (:562) | Refund of the caller's full stake in the open window; **penalty = `gross * (round < 2 ? 100 : refundPenaltyBps) / BPS`**, accumulated in `retainedPenaltyWeth` (:586-588) | `onlyLocker` | `NO_REFUND_STAGE`, `ROUND_REFUNDED`, claimed guards, `NO_ROUND_POSITION` |
| `releaseFailedRefund() external returns (uint256 refundWeth)` (:596) | Full refund of every remaining round after launch failure (no penalty on this path) | `onlyLocker` | `LAUNCH_NOT_FAILED`, claimed guards, `NO_POSITION` |
| `claimVaultSettlement() external returns (uint256 saleTokenAmount, uint256 wethForVault, uint256 treasuryWeth, uint256 protocolFeeWeth)` (:617) | On-time settlement (pre-pool): `_settlePosition(false)` | `onlyLocker` | `POOL_CREATED` (:623) + `_settlePosition` guards |
| `claimLateSettlement() external returns (uint256 saleTokenAmount, uint256 wethForVault, uint256 treasuryWeth, uint256 protocolFeeWeth, uint256 lateLpTokens)` (:631) | Late settlement (post-pool, forever): `_settlePosition(true)`; releases the position's reserved LP-token share to the vault | `onlyLocker` | `POOL_NOT_CREATED` (:643) |
| `finalizeLaunch() external` (:704) | One-shot finalization (§6.4) | **permissionless** | `FINALIZED`, `LAUNCH_FAILED`, `NOT_OVER`, `NO_FINAL_COMMITMENTS` |
| `claimVaultLiquidityTokens() external returns (uint256 liquidityTokens, uint256 wethForPool)` (:708) | Pool funding claim: `wethForPool = settledLiquidityWeth + retainedPenaltyWeth`; `liquidityTokens = effectiveLpTokens * wethForPool / totalLiquidityWeth()` (:723-724); snapshots pool inputs (:727-730) | `onlyVault` | `POOL_CREATED`, `VAULT_LIQUIDITY_CLAIMED`, `POOL_CREATION_NOT_OPEN`, `NO_SETTLED_LIQUIDITY`, `NO_LIQUIDITY_TOKENS` |
| `markLiquidityPoolCreated(address pair, uint256 tokenUsed, uint256 wethUsed, uint256 lpMinted) external` (:736) | Writes the once-only pool records; requires `tokenUsed == vaultLiquidityTokensClaimed` and `wethUsed == poolSettledLiquidityWeth + retainedPenaltyWeth` (:744-745) | `onlyVault` | `POOL_CREATED`, `VAULT_LIQUIDITY_NOT_CLAIMED`, `PAIR_ZERO`, `*_MISMATCH`, `LP_ZERO` |
| `burnResidualTokens() external returns (uint256 amount)` (:760) | Burns the launch's whole token balance (per-position rounding dust) once the pool exists and every final commitment has settled | **permissionless** | `SETTLEMENT_OPEN`, `NO_RESIDUAL` |
| `sweepUnexpectedEthToTreasury() external returns (uint256 amount)` (:770) | Force-sent ETH is wrapped and sent to the treasury **as WETH** (cannot be blocked by a treasury that rejects ETH) | permissionless | `NO_ETH_BALANCE` |

`_settlePosition(bool late)` (:647-702): requires vault configured, lazily finalizes;
requires position unclaimed; computes sale tokens via `previewFinalSaleTokens(msg.sender)`
and the WETH split via `_vaultSettlementAmounts`; requires gross > 0; sets both claim
flags **before** transfers (:668-669); updates `settledCommittedWeth`,
`treasuryWethPaid`, `protocolFeeWethPaid` (:670-672); on-time:
`settledLiquidityWeth += wethForVault`, emits `VaultSettlementClaimed` (:694-699); late:
`lateLpTokens = effectiveLpTokens * wethForVault / totalLiquidityWeth()` **capped at the
remaining reserve** (:678-680), late counters, transfers `lateLpTokens` to the vault,
emits `LateVaultSettlementClaimed` (:681-693); finally transfers sale tokens to the calling
locker (:701). The **WETH itself never passes through the launch** — the locker
transfers it (see §5.5).

View ABI (selected; full signatures at cited lines): `rulesHash() → bytes32` (:268 —
abi.encode of the 26 fields at :270-295, first field `D17_LAUNCH_ID`, includes
`protocolFeeRecipient` and `protocolFeeBps`); `activeRound() → uint8` (:299);
`activeRefundWindow() → uint8` (:310); `roundStart/roundEnd/roundClaimTime(uint8)`
(:318/:328/:345); `roundBaseTokenAllocation/roundTokenAllocation/roundSoldTokens(uint8)`
(:332/:337/:380); `anchorPriceWad()` (:351); `anchorReady()` (:357); `launchFailed()`
(:361); `roundAnchorTargetWeth/roundAnchorUnderfillRemainingWeth(uint8)` (:368/:374 — now
defined for the final round too); `rolloverToFinalRound()` (:393);
`roundDiscoveredPriceWad(uint8)` (:401); `isRoundClaimable(uint8)` (:407);
`settlementStartsAt()` (:411); `poolCreationOpensAt()` (:415); `tradingOpen()` (:421);
`totalCommittedWeth()` (:425); **`liquidityBps()`** (:430); `totalLiquidityWeth()` (:436);
**`poolTokenAllocation()`** (:444); `allFinalCommitmentsSettled()` (:450 — gates only
`burnResidualTokens`, never the lifecycle); `contributedBy(address,uint8)` (:454);
`lockerPositionState(address)` (:459); `previewRoundTokens(address,uint8)` (:480);
`previewFinalSaleTokens(address)` (:489); `previewVaultSettlement(address) → (saleTokens,
gross, wethForVault, treasuryWeth, protocolFeeWeth)` (:495); `launchPhase()` (:512). The
V14 `previewSettlement` alias was removed.

Events (:136-173): `LiquidityVaultConfigured`, `RoundCommitted(locker idx, round idx,
amount)`, `RoundRefunded(locker idx, refundRound idx, refundWeth, penaltyWeth)`,
`LaunchFailedRefunded(locker idx, refundWeth)`, `VaultSettlementClaimed(locker idx,
saleTokens, wethForVault, treasuryWeth, protocolFeeWeth, grossCommittedWeth)`,
`LateVaultSettlementClaimed(locker idx, saleTokens, wethForVault, treasuryWeth,
protocolFeeWeth, lateLpTokens, grossCommittedWeth)`, `Finalized(finalizedAt)`,
`VaultLiquidityTokensClaimed(liquidityVault idx, liquidityTokens, wethForPool)`,
`LiquidityPoolCreated(liquidityVault idx, pair idx, tokenUsed, wethUsed, lpMinted)`,
`UnsoldSaleTokensBurned(amount)`, `UnusedLpTokensBurned(amount)`,
`ResidualTokensBurned(amount)`, `UnexpectedEthSwept(recipient idx, amount)`. V14's
`UnsoldSaleTokensPaid` no longer exists.

### 5.5 D17Locker (D17Locker.sol, 332 lines) — per-user escrow

One locker per (user, deployment); registered in D17Factory; holds the user's WETH until
refund/settlement and claimed sale tokens until withdrawal. `EXPECTED_LAUNCH_ID` (:10)
pins the accepted launch version (`D17_LAUNCH_V15_HARDENED`). Immutables: `owner`,
`factory`, `weth` (:13-15). Global ledgers: `withdrawableWeth`, `accountedWeth` (:17-18).
Per-launch `LockerPosition` struct (:21-44); V15 inserted **`protocolFeeWeth` after
`treasuryWeth`** (:34-35), shifting every later field of the public `positions` getter —
decode it by field name.

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `verifyLaunch(address launch, bytes32 expectedRulesHash) public view returns (bool)` (:96) | Authenticity gate: code exists, `D17_LAUNCH_ID == EXPECTED_LAUNCH_ID`, same WETH, `rulesHash` matches, canonical in factory | view | `NO_CODE`, `BAD_LAUNCH_ID`, `BAD_WETH`, `BAD_RULES`, `NOT_CANONICAL` |
| `commitToRound(address launch, uint8 round, bytes32 expectedRulesHash) public payable` (:125) | Wraps `msg.value` ETH→WETH (held **in the locker**, :138), pins the rules hash (:142), calls `recordRoundCommitment` | `onlyOwner` | `NO_ETH`, `ROUND`, verify failures, `LIQUIDITY_SETTLED` |
| `refundCurrentRound(address launch) public` (:152) | Calls `releaseRoundRefund`; pays the penalty WETH to the **liquidity vault** (:173); refund stays in the locker as `residualWeth`/`withdrawableWeth` | `onlyOwner` | `UNKNOWN_LAUNCH`, `LIQUIDITY_SETTLED`, `NO_REFUND`, ledger guards (:160-161) |
| `refundFailedLaunch(address launch, bytes32 expectedRulesHash) public` (:189) | Full failed-launch refund; cross-checks launch amount vs local ledger (`FAILED_REFUND_MISMATCH`, :199) | `onlyOwner` | verify failures, guards |
| `settleAndClaim(address launch, bytes32 expectedRulesHash) public returns (uint256)` (:216) | Owner settlement any time after the final round (lazy finalize) | `onlyOwner` | verify + `_settleVaultPosition` guards |
| `settleAfterGrace(address launch) public returns (uint256)` (:221) | **Permissionless** settlement-for from `poolCreationOpensAt`; re-verifies with the **stored** rules hash (:224) | any | `UNKNOWN_LAUNCH`, `NOT_FINALIZED`, `GRACE_OPEN` |
| `withdrawUnlockedWeth(address launch, uint256 amount) public` (:177) | Withdraws refund residuals to owner | `onlyOwner` | ledger guards |
| `withdrawUnlockedTokens(address launch, uint256 amount) public` (:302) | Withdraws claimed sale tokens; **gated on `launch.tradingOpen()`** (:306) | `onlyOwner` | `TOKEN_MISSING`, `TOKEN_WITHDRAW_LOCKED`, `TOKEN_BALANCE` |
| `recoverNativeEth(address, uint256) external` (:313) / `recoverExcessWeth(address, uint256) public` (:322) | Force-sent ETH / WETH above `accountedWeth` | `onlyOwner` | balance guards |
| `lockedWeth(address)` (:106); `roundPosition(address,uint8)` (:110); `positions(address)` (:45) | Views | view | — |

`_settleVaultPosition` (:230-300): recomputes per-round previews locally and requires the
launch-returned sale tokens to equal their sum (`FINAL_CLAIM_MISMATCH`, :259); branches
on `launch.liquidityPoolCreated()` (:248-258); requires `wethCommitted ≥ wethForVault +
treasuryWeth + protocolFeeWeth` (:260-261); transfers `wethForVault` to the vault,
`treasuryWeth` to the treasury and `protocolFeeWeth` to `launch.protocolFeeRecipient()`
**from the locker** (:275-277); in the late branch then calls
`mintLateLiquidity(lateLpTokens, wethForVault)` (:280-282) — settlement, WETH delivery
and pair top-up are **atomic**; leftover `wethCommitted` becomes withdrawable residual
(:284-286). Emits `VaultSettlementCompleted` for both paths (:288-299).

### 5.6 D17LiquidityVault (D17LiquidityVault.sol, 301 lines)

Purpose: creates and permanently holds the official LP position, adds late liquidity,
vests the creator allocation. Constants: `D17_LIQUIDITY_VAULT_ID` (:13),
`CREATOR_VESTING_SECONDS = 180 days` (:16), `BURN_ADDRESS = 0x…dEaD` (:17). Immutables:
`launch`, `token`, `weth`, `router`, `routerFactory`, `treasury` (:19-24). Storage
(:26-41) adds `poolCreatedAt`, `lateTokensBurned`, `lateWethBurned`,
`failedLaunchPenaltyWethBurned`, `creatorTokensReleased` to the V14 records. **No function
transfers or burns vault-held LP — LP is locked forever** (recovery excludes it, :276).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `createOfficialPool(uint256 minLpMinted, uint256 deadline) external returns (address pair, uint256 liquidityTokens, uint256 wethForPool, uint256 liquidity)` (:117) | Gets-or-creates the pair; requires a virgin pair (`totalSupply == 0`, :131) with zero token balance (`PAIR_PRESEEDED_TOKEN`, :140; donated WETH tolerated and recorded, :136-139); claims amounts from the launch (:142); requires token balance ≥ claimed + still-locked creator tokens (:143-146); transfers both legs, mints LP to itself (:151-153); slippage floor; records `poolCreatedAt` (:158); callback `markLiquidityPoolCreated` | **permissionless** (time-gated by launch, :124) | `POOL_CREATED`, `DEADLINE`, `POOL_CREATION_NOT_OPEN`, `PAIR_ALREADY_LIVE`, `PAIR_PRESEEDED_TOKEN`, `VAULT_TOKEN_BALANCE`, `NO_TOKEN_BALANCE`, `NO_WETH_FOR_POOL`, `VAULT_WETH_BALANCE`, `LP_SLIPPAGE` |
| `mintLateLiquidity(uint256 tokenAmount, uint256 wethAmount) external returns (uint256 liquidity)` (:177) | Pairs a late settler's amounts **at the pair's live reserve ratio** (:193-214), mints LP to the vault; burns the unpairable remainder (tokens via `burn`, WETH to `BURN_ADDRESS`, :225-234); a position too small to mint one LP wei is burned instead of reverting (:205-213) | registered lockers only (:183-186) | `POOL_NOT_CREATED`, `NOT_D17_LOCKER`, `VAULT_TOKEN_BALANCE`, `VAULT_WETH_BALANCE` |
| `releaseCreatorTokens() external returns (uint256 amount)` (:241) | Pays `vestedCreatorTokens() − creatorTokensReleased` to `launch.manualDistributionRecipient()` | **permissionless** | `NOTHING_VESTED` |
| `burnFailedLaunchPenalties() external returns (uint256 amount)` (:252) | If `launch.launchFailed()`, sends the vault's whole WETH balance (phase-one penalties) to `BURN_ADDRESS` | permissionless | `LAUNCH_NOT_FAILED`, `NO_WETH` |
| `sweepExcessWethToTreasury() external returns (uint256)` (:263) | Post-pool WETH donation sweep (every legitimate WETH flow is atomic) | permissionless | `POOL_NOT_CREATED`, `NO_EXCESS_WETH` |
| `recoverUnsupportedTokenToTreasury(address, uint256) external` (:271) | Foreign-token recovery; excludes `token`, `weth`, `officialPair` (:274-276) | permissionless | `AMOUNT_ZERO`, `TOKEN_ZERO`, `*_PROTECTED` |
| `sweepUnexpectedEthToTreasury() external returns (uint256)` (:282) | Force-sent ETH wrapped and sent as WETH (:285-286) | permissionless | `NO_ETH_BALANCE` |
| `lockedCreatorTokens()` (:105) / `vestedCreatorTokens()` (:109) | Vesting views | view | — |

Events (:43-64): `OfficialPoolCreated(pair idx, tokenUsed, wethUsed, lpMinted,
preseededTokenReserve, preseededWethReserve)`, `LateLiquidityAdded(locker idx, pair idx,
tokenUsed, wethUsed, lpMinted, tokensBurned, wethBurned)`,
`FailedLaunchPenaltiesBurned(amount)`, `CreatorTokensReleased(recipient idx, amount)`,
sweep/recovery events.

### 5.7 D17Token (D17Token.sol, 295 lines)

Unchanged from V14 except its identity string. Minimal ERC-20 (18 decimals, :19) with
launch-coupled transfer/burn gates and on-chain metadata (`contractURI`). Owner = launch
factory only during deployment; renounced in the same transaction (§3 step 12).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `transfer / transferFrom` (:159/:170) | ERC-20 with pre-open gate via `_transfer` (:216-229) | any | `TRADING_CLOSED`, `BALANCE`, `ALLOWANCE`, `TO_ZERO` |
| `approve(address,uint256)` (:164) | Standard; infinite-allowance shortcut in transferFrom (:172) | any | — |
| `burn(uint256 amount)` (:182) | **Pre-open: launch only** (`BURN_BEFORE_OPEN`, :187); post-open: any holder (the vault burns late-liquidity leftovers this way) | gated | `BURN_BEFORE_OPEN`, `BALANCE` |
| `mint(address,uint256)` (:196) | Capped mint; deployment window only | `onlyOwner` | `MINTING_CLOSED`, `CAP`, `TO_ZERO` |
| `closeMinting() / renounceOwnership()` (:205/:211) | One-shot close; owner destruction | `onlyOwner` | `MINTING_CLOSED` |
| `configureTradingGate(...)` (:86) / `configureMetadata(...)` (:118) | One-shot wiring | `onlyOwner` | `TRADING_GATE_CONFIGURED`, `METADATA_CONFIGURED`, zero/no-code, `TRADING_OPEN_NOW` |
| Views: `tradingOpen()` (:136), `canonicalPair()` (:154), `contractURI()` (:150), `linkCount()`/`links(uint256)` (:140/:144) | Gate/metadata reads | view | `LINK_INDEX` |

Gate logic `_transferAllowedBeforeOpen(from, to)` (:231-241): before configuration →
false; `from == launch` → true; `from == liquidityVault && to == canonicalPair()` → true;
otherwise requires `_launchTradingOpen()` — a try/catch read of `launch.tradingOpen()`
that **fails closed** (:243-249). The creator allocation sits in the vault, so it can only
leave through vesting once the pool exists. `unchecked` arithmetic in
`transferFrom`/`burn`/`_transfer` is guarded by preceding requires (:174-177, :189-192,
:224-227).

### 5.8 D17TokenFactory / D17LiquidityVaultFactory (51 lines each)

Identical pattern: owner pins `launchFactory` once (:28-35), `renounceOwnership` requires
the pin (:37-41), `deployToken` (D17TokenFactory.sol:43-50) / `deployVault`
(D17LiquidityVaultFactory.sol:43-50) callable only by the pinned launch factory. IDs at
:7. Events at :13-15. Their owners must be zero before any launch (§3).

### 5.9 D17LockerFactory (D17LockerFactory.sol, 30 lines)

`createLockerFor(address lockerOwner) external returns (address locker)` (:22-29):
**requires `msg.sender == lockerOwner`** (`ONLY_SELF`, :24); deploys
`D17Locker(lockerOwner, d17Factory, registry.weth())` and registers it. Multiple lockers
per owner are allowed.

### 5.10 lib/D17SafeTransfer (29 lines)

`safeTransfer` (:10), `safeTransferFrom` (:15), `safeApprove` (:20), `safeBurn` (:25):
raw-call wrappers tolerating missing return values, reverting with typed errors (:4-8).
**Not** fee-on-transfer-safe — acceptable because the only tokens touched are D17Token,
canonical WETH, and the V2 pair.

## 6. The math

Units: WETH/token amounts in wei (18 decimals); prices in **WAD** (1e18) as WETH-per-token;
shares/fees in **BPS** (1e4). All divisions floor; fee floors round in favour of the pool,
token floors round against the claimant.

**6.1 Anchor discovery (round 0).**
`anchorPriceWad = roundRaised[0] * 1e18 / roundBaseTokenAllocation(0)` (D17Launch.sol:351-355);
`anchorReady = roundRaised[0] ≥ minPhase1Weth ∧ anchorPriceWad ≥ minAnchorPriceWad` (:357-359).
If the window after round 0 closes without `anchorReady`, `launchFailed()` becomes true
permanently (:361-363).

**6.2 Round targets, sales, rollover.**
`roundBaseTokenAllocation(r) = saleTokens * roundSharesBps[r] / BPS` (:332-335).
For **every** round `r ≥ 1` (V14: rounds 1–3 only):
`roundAnchorTargetWeth(r) = roundTokenAllocation(r) * anchorPriceWad / WAD` (:368-372);
`roundSoldTokens(r) = raised ≥ target ? allocation : allocation * raised / target`
(:380-391). Overfill above target is allowed and raises the round's price; underfill in
rounds 1–3 rolls into the final round,
`rolloverToFinalRound = Σ_{r=1..3} max(base(r) − sold(r), 0)` (:393-399). The final round's
allocation is `base(4) + rollover` (snapshotted as `finalRoundTokenPool` at finalization,
:785) and it now sells at most `allocation * raised / target`: **no round sells below the
anchor price**; what the final round cannot sell is burned (§6.4). Buyer share:
`_roundTokensForBuyer(r, paid) = sold(r) * paid / roundRaised[r]` (round 0 uses the base
allocation) (:823-834).

**6.3 Refunds.** In window `r` (windows follow rounds 0–3 only, :310-316):
`penalty = gross * (r < 2 ? EARLY_REFUND_PENALTY_BPS(=100) : refundPenaltyBps) / BPS`,
`refund = gross − penalty` (:586-587). `roundRaised[r]` is decremented by the gross
amount; `retainedPenaltyWeth += penalty` (:588). The locker sends the penalty WETH to the
**liquidity vault** (D17Locker.sol:173). If the launch then succeeds, every penalty is
paired into the initial pool (§6.6); if it fails (only phase-one penalties can exist at
that point), `burnFailedLaunchPenalties` burns them. Failed-launch refunds of the
remaining commitments carry no penalty (:596-615).

**6.4 Finalization** (:778-808): one-shot; snapshots `finalRoundTokenPool` and
`finalCommittedWeth` (> 0); `sold = Σ roundSoldTokens` (capped at `saleTokens`,
:836-839); `unsoldSaleTokensSettled = saleTokens − sold`;
**`effectiveLpTokens = lpTokens * sold / saleTokens`**,
`unusedLpTokensBurned = lpTokens − effectiveLpTokens` (:791-794); both remainders are
burned in one `safeBurn` (:798-800). No unsold token is ever transferred to anyone.

**6.5 Settlement split** (both paths, :810-821):
`gross = Σ position.paid[r]`; `treasuryWeth = gross * treasuryBps / BPS`;
`protocolFeeWeth = gross * protocolFeeBps / BPS`;
`wethForVault = gross − treasuryWeth − protocolFeeWeth` (both fees floor; the pool takes
the remainder). Sale tokens = `previewFinalSaleTokens` (§6.2). **Late equivalence:**
`claimLateSettlement` uses the identical amounts — same tokens, same gross, same fees;
only the destination of `wethForVault` differs (§6.6).

**6.6 Pool funding and late top-up.** Let `L = effectiveLpTokens`,
`P = retainedPenaltyWeth`, `T = totalLiquidityWeth() = finalCommittedWeth *
liquidityBps / BPS + P` (:430-439; `liquidityBps = BPS − treasuryBps − protocolFeeBps`),
all fixed after finalization. Initial pool: `weth = settledLiquidityWeth + P`,
`tokens = L * weth / T` (:723-724) — reserve ratio `≈ L/T`, the **canonical launch
ratio**. Because `L` scales with the share sold and `T` with what was paid, the opening
price is `T / L = avgSalePrice × (liquidityBps / BPS) × (saleTokens / lpTokens)` plus the
penalty contribution: it tracks the average sale price whatever the fill, and equals it
net of fees when the creator sets `lpTokens == saleTokens`. The `saleTokens / lpTokens`
factor is fixed in the published rules.
Late top-up per position: `lateLpTokens = min(L * wethForVault / T, L − claimed −
released)` (:678-680). The cap matters: per-position fee floors make each `wethForVault`
round **up**, so `Σ wethForVault` can exceed `finalCommittedWeth * liquidityBps / BPS` by
a few wei, and without it the last late settler could revert forever (V14's
`LP_RESERVE_EXCEEDED`). The vault then deposits at the pair's **live** ratio
`r = wethReserve / tokenReserve` (D17LiquidityVault.sol:197-204):
`wethUsed = tokenAmount * r`; if that exceeds `wethAmount`, it uses all the WETH and
`tokenUsed = wethAmount / r`. The deposit is balanced, so Uniswap V2 `mint` donates
nothing one-sided; the unpairable remainder — tokens if the price rose since launch, WETH
if it fell — is burned (:225-234). Nobody, including the late settler, profits from
settling late or from moving the price.

**6.7 Dust & recovery paths.** Launch: per-position token dust →
`burnResidualTokens()` once all settled (:760-766); force-sent ETH →
`sweepUnexpectedEthToTreasury` as WETH (:770-776). Locker: ETH → `recoverNativeEth`; WETH
above `accountedWeth` → `recoverExcessWeth`. Vault: post-pool WETH donations →
`sweepExcessWethToTreasury`; foreign tokens → `recoverUnsupportedTokenToTreasury`
(D17-token donations to the vault are unrecoverable by design).

**6.8 Creator vesting.** `vestedCreatorTokens() = manualDistributionTokens *
min(now − poolCreatedAt, 180 days) / 180 days` (0 before the pool exists,
D17LiquidityVault.sol:109-115); `releaseCreatorTokens` pays the difference with
`creatorTokensReleased` to the fixed recipient (:241-248). `lockedCreatorTokens()` is
excluded from every token-balance check in the vault (:143-146, :187-190), so creator
tokens can never be paired into the pool or burned. If the launch fails the pool never
exists and the allocation stays in the vault forever.

## 7. Access control & authenticity

Compatibility constants (all `keccak256` values fixed in deployed bytecode, all ending in
`V15_HARDENED`): `D17_FACTORY_ID` (D17Factory.sol:16), `D17_FEE_CONFIG_ID`
(D17FeeConfig.sol:17), `D17_LAUNCH_DEPLOYER_ID` (D17LaunchDeployer.sol:11),
`D17_LAUNCH_ID` (D17Launch.sol:10), `D17_TOKEN_ID` (D17Token.sol:15),
`D17_TOKEN_FACTORY_ID` (D17TokenFactory.sol:7), `D17_LIQUIDITY_VAULT_ID`
(D17LiquidityVault.sol:13), `D17_LIQUIDITY_VAULT_FACTORY_ID`
(D17LiquidityVaultFactory.sol:7), and `D17Locker.EXPECTED_LAUNCH_ID` (D17Locker.sol:10),
which **must equal** the launch ID — lockers reject V14 and other incompatible launches
with `BAD_LAUNCH_ID` in `verifyLaunch`. `rulesHash()` covers every economic parameter,
including the protocol fee rate and recipient, with the launch ID as its first field
(D17Launch.sol:268-297); lockers pin the hash at first commit (D17Locker.sol:142) and
`settleAfterGrace` re-verifies against the **stored** hash (D17Locker.sol:224).

**Protocol fee isolation.** The fee is read once, at creation, from `D17FeeConfig`
(D17Factory.sol:166), checked against the creator's `maxProtocolFeeBps` (:167) and stored
in launch immutables that are part of `rulesHash`. No launch, locker or vault ever calls
the fee config again; the fee owner has no path to an existing launch or to any funds.

Self-registration: `createLockerFor` requires `msg.sender == lockerOwner`
(D17LockerFactory.sol:24); registration is restricted to the pinned locker factory
(D17Factory.sol:110-119) — `isLocker` contains only canonical locker bytecode, which is
the basis for `onlyLocker` on the launch and the `mintLateLiquidity` auth on the vault.
A registered locker can only call `mintLateLiquidity` from its fixed settlement code with
launch-computed amounts.

Deliberately permissionless entry points and why they are safe:

| Entry point | Why safe |
|---|---|
| `finalizeLaunch()` (D17Launch.sol:704) | Pure state transition from immutable timing + committed totals; one-shot |
| `settleAfterGrace(launch)` (D17Locker.sol:221) | Only after the fixed grace boundary; outcome identical to owner settlement; stored-rules-hash verification |
| `createOfficialPool(minLp, deadline)` (D17LiquidityVault.sol:117) | Time-gated; virgin-pair + preseed checks; amounts come from launch accounting |
| `releaseCreatorTokens()` (D17LiquidityVault.sol:241) | Amount from a deterministic schedule; recipient fixed in the rules |
| `burnResidualTokens()` (D17Launch.sol:760), `burnFailedLaunchPenalties()` (D17LiquidityVault.sol:252) | Only burn; only once every commitment settled / only after failure |
| Sweeps/recovery (launch :770, vault :263,271,282) | Only move donations/force-sent value to the fixed treasury |

## 8. Invariants (enforcement map)

| # | Invariant | Enforcing check(s) |
|---|---|---|
| 1 | Supply conservation: `sale + lp + manual + dead == tokenSupply`; mint one-shot; no post-deploy authority | D17Factory.sol:207-215; D17LaunchFactory.sol:155-163; D17Token.sol:196-214 |
| 2 | Timing-invariant buyer outcome | single `_settlePosition` + `_vaultSettlementAmounts` (D17Launch.sol:647-702, 810-821); `FINAL_CLAIM_MISMATCH` (D17Locker.sol:259) |
| 3 | `gross = wethForVault + treasuryWeth + protocolFeeWeth`; pool share ≥ 88% | D17Launch.sol:818-820; caps D17Factory.sol:233, D17FeeConfig.sol:18 |
| 4 | Creator income = `treasuryBps` share + vested allocation only (no penalties, no unsold tokens) | penalties → vault (D17Locker.sol:173); burns (D17Launch.sol:798-800); vesting (D17LiquidityVault.sol:241-248) |
| 5 | Fee immutability per launch | immutables + `rulesHash` (D17Launch.sol:43,52,276,287); fee config never read after creation |
| 6 | No launch while an admin key exists in the creation path | D17Factory.sol:163; D17LaunchFactory.sol:95-100 |
| 7 | No round sells below the anchor | `roundAnchorTargetWeth`/`roundSoldTokens` for r ≥ 1 (D17Launch.sol:368-391) |
| 8 | Sale-token conservation; single claim per position | claim flags (D17Launch.sol:661-662, 668-669); `_soldSaleTokenAmount` cap (:836-839) |
| 9 | Custody isolation: user WETH lives in the user's locker until refund/settlement | D17Locker.sol:138 (wrap-and-hold); no WETH inflow path in D17Launch |
| 10 | No hostage mechanisms; claims never expire | `allFinalCommitmentsSettled` gates only the residual burn; no deadline on settlement (D17Locker.sol:226) |
| 11 | One-time pool creation; write-once pool records | D17Launch.sol:715-716, 741-746; D17LiquidityVault.sol:122 |
| 12 | LP reserve bound: `initial + Σ late ≤ effectiveLpTokens`, never reverting | cap at D17Launch.sol:678-680 |
| 13 | Late deposits balanced at the live ratio; remainder burned | D17LiquidityVault.sol:193-234 |
| 14 | LP permanence | no LP-moving function; recovery excludes `officialPair` (D17LiquidityVault.sol:276) |
| 15 | Creator tokens unusable for liquidity and locked until vested | `lockedCreatorTokens()` balance checks (D17LiquidityVault.sol:143-146, 187-190) |
| 16 | No transfer/burn before trading open (except launch & vault→pair) | D17Token.sol:187, 231-241 |
| 17 | Incompatible-contract rejection | `EXPECTED_LAUNCH_ID` (D17Locker.sol:10); `rulesHash` domain separation |

## 9. Event catalogue (indexer/UI contract)

| Stage | Event (indexed → `idx`) | Emitter |
|---|---|---|
| Suite deploy | `OwnershipTransferred`; `OwnershipTransferStarted`; `ProtocolFeeUpdated(feeRecipient idx, bps)`; `LaunchFactoryPinned`; `LockerFactoryPinned`; `TokenCreated`; `LiquidityVaultCreated`; `LaunchDeployed(launch idx)` | factories, fee config, deployer |
| Launch creation | `LaunchCreated`; `ManualDistributionConfigured`; `LaunchMetadataPublished`; `LiquidityVaultConfigured`; `TradingGateConfigured`; `TokenMetadataConfigured`; `ContractURIUpdated`; `MintingClosed` | factory / launch / token |
| Locker setup | `LockerCreated(owner idx, locker idx)`; `LockerRegistered(owner idx, locker idx, manager idx)` | lockerFactory / factory |
| Rounds | `RoundCommitted` (launch and locker variants) | both |
| Refunds | `RoundRefunded(…, refundWeth, penaltyWeth)`; `LaunchFailedRefunded` / `FailedLaunchRefunded`; `WethWithdrawn`; `FailedLaunchPenaltiesBurned(amount)` | launch / locker / vault |
| Finalization | `Finalized`; `UnsoldSaleTokensBurned(amount)`; `UnusedLpTokensBurned(amount)` | launch |
| Settlement (on-time) | `VaultSettlementClaimed(locker idx, saleTokens, wethForVault, treasuryWeth, protocolFeeWeth, gross)`; `VaultSettlementCompleted(launch idx, vault idx, settler idx, owner, saleTokens, wethSentToVault, treasuryWeth, protocolFeeWeth, gross, residualWeth)` | launch + locker |
| Pool creation | `VaultLiquidityTokensClaimed`; `LiquidityPoolCreated`; `OfficialPoolCreated` | launch / vault |
| Late settlement | `LateVaultSettlementClaimed(…, protocolFeeWeth, lateLpTokens, gross)`; `LateLiquidityAdded(locker idx, pair idx, tokenUsed, wethUsed, lpMinted, tokensBurned, wethBurned)`; locker `VaultSettlementCompleted` | launch / vault / locker |
| After trading opens | `CreatorTokensReleased(recipient idx, amount)`; `ResidualTokensBurned(amount)`; `ClaimedTokensWithdrawn`; sweep/recovery events | vault / launch / locker |

Indexing rule (product-level): D17 pipelines ingest only the events above — never ERC-20
`Transfer`/`Approval` or pair `Swap`/`Sync`.

## 10. Testing

- **Local E2E** (`contracts/test/local-e2e.mjs`, fixture `test/fixtures/local-launch.json`,
  25/10/10/55 split): enforced renounce before any launch; a failed weak-anchor launch
  with a last-second 20 ETH phase-one refund (1% penalty into the vault, then burned);
  metadata/config adversarial reverts; an 18-locker 5-round main launch with refunds in
  every window (exact penalty amounts, penalties land in the vault, treasury untouched);
  exact protocol-fee and treasury-fee accounting per locker; finalization burns
  (unsold + unused LP); pool creation with penalties paired in and three late lockers;
  late top-ups at the live ratio after a price move (balanced deposits, exact pooled +
  burned amounts); residual-dust burn; creator vesting at 50% and 100%; a zero-late
  control launch with an under-filled final round. **567 assertions, 0 failures.**
- **Hardening suite** (`contracts/test/hardening-e2e.mjs`): fee config cap/recipient/
  owner/two-step handover; factory caps (treasury, penalty bounds, consent bound); fee
  snapshot unchanged after a fee change; zero-fee launch; final round priced at the anchor
  with the remainder burned; effective LP and canonical opening ratio; late settlement after
  a price **drop** (surplus WETH burned, no tokens burned); residual burn gating; forced-ETH
  sweep as WETH. **52 assertions, 0 failures.**
- **Deployment dry run** on a local node: `deploy:factory` → `verify:factory` (40/40) →
  `create:launch`. The terminal's creator-vesting release button was exercised in a
  browser against a local node with Sepolia's chain id.
- Run everything with `npm ci && npm test`.
- **Coverage gaps worth noting**: no property-based/fuzz suite; the mainnet-only minimums
  (`block.chainid == 1`) are not exercised by the local suites; no mainnet-fork tests; no
  Sepolia evidence for V15 yet.

## 11. Known limitations & review status

1. **Not independently audited.** Slither 0.11.6 reports only benign findings (reentrancy
   into own token/WETH/pair behind `nonReentrant`, intended timestamp comparisons, the
   intended pre-seed strict equality, default-zero locals, a missing zero check on the
   fee config's two-step handover where zero cancels a pending transfer).
2. **Code-size ceiling**: D17LaunchDeployer is 22,759/24,576 bytes; any growth of
   `D17Launch` consumes that margin. Check sizes after every source change.
3. **AMM assumption**: honest Uniswap-V2 semantics. Late deposits are balanced at the
   live ratio, so a price manipulator around a late settlement pays swap fees on both legs
   and can at most extract the impermanent loss of that late position.
4. **WETH assumption**: canonical WETH9 — no fee-on-transfer, no hooks.
5. **`unchecked` blocks**: only in D17Token (:174-177, :189-192, :224-227), each guarded.
6. **Config economics**: the factory validates hard caps (treasury ≤ 10%, protocol fee
   ≤ 2%, rounds 3–4 penalty 1–25%), not whether a launch is attractive.
7. **Donation edge cases**: post-open D17-token donations to the vault are stuck; the
   creator allocation of a failed launch is locked forever.
8. **`createLaunch` gas**: deploys three contracts in one transaction (~13–15M gas).
9. **No admin recovery**: launches are immutable once created; the only remedy for a bad
   suite is a new suite. The fee config owner can only change future fees.
10. **Block timestamps**: windows use `block.timestamp`; mainnet floors keep every window
    ≥ 1 hour so a few seconds of validator drift are immaterial.

---

**Reference source:** `contracts/contracts/` and `contracts/SHA256SUMS.txt`.
