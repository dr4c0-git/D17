# D17 Contract Suite - Technical Reference (V15.1)

Audience: Solidity/EVM engineers integrating with, extending, or reviewing the suite.
Citation convention: `File.sol:line` paths are relative to the
`contracts/contracts/` directory and point to the V15.1 source in this repository. The
rule-level changes from the upstream V14 suite, and the V15.1 fixes, are summarised in
[V15_HARDENING.md](./V15_HARDENING.md).

---

## 1. Overview & scope

**Status:** `npm run test:contracts` green - **517/517** assertions in `test/local-e2e.mjs`,
**51/51** in `test/hardening-e2e.mjs`, **36/36** in `test/mainnet-floors-e2e.mjs`, **25/25**
in `test/fee-splitter-e2e.mjs`, **17/17** in `test/v15-1-regressions-e2e.mjs`, and the four
V15.1 review suites (`failed-refund-remediation` 80 checks, `adversarial-callbacks` 32,
`minimum-liquidity` 4, `rounding-reference-model` 84,000), see §10. Stateful fuzz `test/fuzz-invariants.mjs` passes on
V15.1. Slither 0.11.6 reports no exploitable finding. V15.1 is **not deployed on mainnet**
(it is deployed on Sepolia, factory `0xF93a425c0a2DDd4b57b57C6304AEB09ED2Dcb7cB`) and has **not** received a
formal professional third-party audit.

D17 is a five-round fair-launch protocol on a Uniswap-V2-style AMM. Users commit ETH
(wrapped to WETH) through personal escrow contracts ("lockers"); round 0 discovers an
anchor price and every later round sells at or above it; refund windows follow rounds
0–3 and every refund pays a penalty into the liquidity vault; after finalization each
locker settles - sale tokens to the buyer, a treasury fee, a protocol fee, and the
remainder into the liquidity vault. Pool creation is permissionless once every final
commitment is settled; anyone can settle absent users after the grace period, one locker
at a time or up to 4 per call through `D17LockerFactory.settleAfterGraceBatch`, so nobody
can block it. The pool pairs the exact sum of every locker's pool share plus all refund
penalties with the whole (sale-scaled) LP token allocation, in one deposit; no liquidity
is ever added after trading opens. If round 0 misses its minimum the launch fails and
every buyer gets back all of their WETH, including the penalties paid in round 0's refund
window. All admin authority in the creation path is destroyed before the first launch can
exist (one-shot pins, mint close, ownership renounce, enforced on-chain). The only owner
that may survive is `D17FeeConfig`'s, which can only set the protocol fee (≤ 2%) for
future launches; on Ethereum mainnet the factory refuses to create a launch until that
owner is renounced too.

## 2. Topology

```text
   ┌────────────────┐ currentFee()  ┌──────────────────────────────────────────────────┐
   │ D17FeeConfig   │◄──────────────│ D17Factory  (entry point, config validation,     │
   │ (fee ≤ 2%,     │  owner() on   │  fee snapshot, launch + locker registries)       │
   │  renounced on  │  mainnet      └───┬──────────────────────────────────┬───────────┘
   │  mainnet)      │                   │ onlyD17Factory                   │ registerLockerFor
   └────────────────┘ createLaunch(cfg) │                                  │ (pinned lockerFactory)
                                        ▼                                  │
                             ┌──────────────────┐               ┌──────────┴────────┐
                             │ D17LaunchFactory │               │ D17LockerFactory  │ settleAfterGraceBatch
                             └─┬──────┬───────┬─┘               └──────────┬────────┘ (≤ 8 lockers)
               deployToken     │      │       │ deployVault                │ createLockerFor
                               ▼      │       ▼                            ▼ (msg.sender == owner)
                 ┌───────────────┐    │   ┌─────────────────────────┐ ┌────────────┐
                 │D17TokenFactory│    │   │D17LiquidityVaultFactory │ │ D17Locker  │ personal escrow,
                 └──────┬────────┘    │   └───────────┬─────────────┘ └─────┬──────┘ positions across
                        ▼             ▼ deployLaunch  ▼                     │        launches
                 ┌───────────┐ ┌───────────────────┐ ┌───────────────────┐  │
                 │ D17Token  │ │ D17LaunchDeployer │ │ D17LiquidityVault │◄─┤ penalties,
                 └───────────┘ └─────────┬─────────┘ │ (LP locked,       │  │ pool-share WETH
                       ▲                 ▼           │  creator vesting, │  │
                       │           ┌───────────┐     │  failed-penalty   │  │
                       │ gate reads│ D17Launch │◄───►│  return)          │  │
                       │ tradingOpen└──────────┘◄──┐ └───────────────────┘  │
                       └────────────────┘          └─────────────────────────┘ onlyLocker
          vault → launch (onlyVault): claimVaultLiquidityTokens, markLiquidityPoolCreated
          launch → vault (launch only): returnFailedPenalty
```

Authority edges (all others are permissionless or view):

| Caller → callee | Functions | Guard | Cite |
|---|---|---|---|
| D17Factory → D17FeeConfig | `currentFee`, `owner`, `pendingOwner` (views; the last two on mainnet only) | - | D17Factory.sol:170-179 |
| D17Factory → D17LaunchFactory | `deployLaunch` | `onlyD17Factory` | D17LaunchFactory.sol:63-66,83-91 |
| D17LaunchFactory → D17LaunchDeployer | `deployLaunch(bytes)` | pinned `launchFactory` only; encoded `vaultConfigurator == msg.sender` | D17LaunchDeployer.sol:51-61 |
| D17LaunchFactory → D17TokenFactory / D17LiquidityVaultFactory | `deployToken` / `deployVault` | pinned `launchFactory` only | D17TokenFactory.sol:43-50, D17LiquidityVaultFactory.sol:43-50 |
| D17LaunchFactory → D17Launch | `configureLiquidityVault` | `msg.sender == vaultConfigurator` (one-shot) | D17Launch.sol:266-273 |
| D17LaunchFactory → D17Token | `configureTradingGate`, `configureMetadata`, `mint`, `closeMinting`, `renounceOwnership` | `onlyOwner` (owner = launch factory until renounce) | D17Token.sol:86,118,196,205,211 |
| D17Locker → D17Launch | `recordRoundCommitment`, `releaseRoundRefund`, `releaseFailedRefund`, `claimVaultSettlement` (`claimLateSettlement` keeps the guard but always reverts) | `onlyLocker` via `ID17FactoryView(factory).isLocker` | D17Launch.sol:182-185 |
| D17LiquidityVault → D17Launch | `claimVaultLiquidityTokens`, `markLiquidityPoolCreated` | `onlyVault` | D17Launch.sol:187-190 |
| D17Launch → D17LiquidityVault | `returnFailedPenalty(locker, amount)` | `msg.sender == launch`; launch failed; pool not created; `locker` registered | D17LiquidityVault.sol:195-204 |
| D17LockerFactory → D17Factory | `registerLockerFor` | pinned `lockerFactory` only | D17Factory.sol:114-123 |
| D17FeeConfig owner → D17FeeConfig | `setProtocolFee`, `transferOwnership`, `renounceOwnership` | `onlyOwner`; `acceptOwnership` by `pendingOwner` | D17FeeConfig.sol:41-65 |

`D17LockerFactory.settleAfterGraceBatch` calls `D17Locker.settleAfterGrace`, which is
permissionless anyway: the batch holds no authority of its own (§5.9). The vault's
`mintLateLiquidity` keeps a registered-locker check but always reverts
(D17LiquidityVault.sol:172-175).

Canonical registry: `D17Factory.launches[launch] = LaunchRecord{canonical, creator, token,
liquidityVault, rulesHash}` written once at creation (D17Factory.sol:184-190);
`isCanonicalLaunch(launch, rulesHash)` requires **both** the address and the pinned rules
hash to match (D17Factory.sol:206-209). Lockers never trust an address alone.

## 3. Deployment & wiring

Suite deployment (per `scripts/deploy-factory.mjs`): deploy
`D17FeeConfig(feeOwner, feeRecipient, feeBps)` (optionally preceded by an ownerless
`D17FeeSplitter` used as `feeRecipient`), `D17Factory(owner, weth, router, feeConfig)`,
`D17TokenFactory(owner)`, `D17LiquidityVaultFactory(owner)`, `D17LaunchDeployer(owner)`,
`D17LaunchFactory(d17Factory, tokenFactory, vaultFactory, launchDeployer)`,
`D17LockerFactory(d17Factory)`; pin the launch factory into the token factory, vault
factory, launch deployer and D17Factory, pin the locker factory into D17Factory; renounce
every owner, and the fee config's too when `RENOUNCE_FEE_CONFIG_OWNER=1`. Every pin is
one-shot (D17Factory.sol:125-141; D17TokenFactory.sol:28-35;
D17LiquidityVaultFactory.sol:28-35; D17LaunchDeployer.sol:32-39). `renounceOwnership`
requires the pins first (D17Factory.sol:149-154; D17LaunchDeployer.sol:41-45).

Renunciation is **enforced, not advisory**: `createLaunch` reverts with
`FACTORY_NOT_RENOUNCED` while D17Factory has an owner (D17Factory.sol:167) and
`deployLaunch` reverts with `FACTORIES_NOT_RENOUNCED` while the token factory, vault
factory or launch deployer has one (D17LaunchFactory.sol:95-100). On Ethereum mainnet
(`block.chainid == 1`) `createLaunch` also reverts with `MAINNET_FEE_NOT_FROZEN` while the
fee config has an owner or a pending owner (D17Factory.sol:173-179), so the fee rate and
recipient are final for the whole mainnet suite. The deploy script refuses to run without
`RENOUNCE_D17_FACTORY_OWNER=1` and, on mainnet, without `RENOUNCE_FEE_CONFIG_OWNER=1`;
`verify:factory` checks every owner is zero.

Launch creation is **one transaction**, `D17Factory.createLaunch(config)`
(D17Factory.sol:160-204) → `D17LaunchFactory.deployLaunch(config, msg.sender,
feeRecipient, feeBps)`:

| # | Step | Cite |
|---|------|------|
| 0 | Require both pins and `owner == 0`; `_validateConfig` (full table §5.1) | D17Factory.sol:164-168 |
| 1 | Read `(feeRecipient, feeBps)` from D17FeeConfig; on mainnet require fee config `owner == 0` and `pendingOwner == 0` (`MAINNET_FEE_NOT_FROZEN`); require `feeBps ≤ config.maxProtocolFeeBps` (`PROTOCOL_FEE_ABOVE_MAX`) | D17Factory.sol:170-180 |
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
| 12 | `closeMinting()`; `renounceOwnership()` - **no mint authority survives** | D17LaunchFactory.sol:162-163 |
| 13 | Factory records canonical entry, emits `LaunchCreated`, `ManualDistributionConfigured`, `LaunchMetadataPublished` | D17Factory.sol:183-203 |

`rulesHash()` is read *after* vault configuration (it includes `liquidityVault`), so the
registered hash is final (D17Factory.sol:183; D17Launch.sol:275-305).

## 4. Lifecycle state machine

Contract rounds 0–4 = display rounds 1–5. Timing anchors: `startTime` (immutable),
`roundStart/roundEnd` (derived walk over `roundSeconds[5]` + `refundSeconds` after rounds
0–3, D17Launch.sol:326-338), `tradingOpenAt = roundEnd(4) + settlementSeconds`
(immutable, D17Launch.sol:243), `finalizedAt` (set at finalization),
`poolCreationOpensAt() = finalized ? max(finalizedAt + settlementSeconds, tradingOpenAt) :
tradingOpenAt` (D17Launch.sol:423-427). `tradingOpen() == liquidityPoolCreated`
(D17Launch.sol:429-431). On Ethereum mainnet (`block.chainid == 1`) the factory requires
`startTime ≥ now + 1 day` and every round/refund/settlement window ≥ 1 hour
(D17Factory.sol:234-243, 255).

`launchPhase()` (D17Launch.sol:522-554) reports one of 8 phases:

| Phase (const, D17Launch.sol:23-30) | Predicate | State-changing calls allowed (launch-side) |
|---|---|---|
| 0 `PHASE_NOT_STARTED` | `now < startTime` | - |
| 1 `PHASE_ROUND_OPEN` (idx = round) | `activeRound() != NO_ROUND` (rounds 1+ additionally require `anchorReady()`, :311) | `recordRoundCommitment(round,…)` |
| 2 `PHASE_REFUND_OPEN` (idx = round) | `activeRefundWindow() != NO_ROUND` (windows follow rounds 0–3 only, :318-324) | `releaseRoundRefund()` |
| 7 `PHASE_FAILED` | `launchFailed()`: not finalized ∧ `now ≥ roundEnd(0)+refundSeconds` ∧ `!anchorReady()` (:369-371) | `releaseFailedRefund()` (forever): principal plus the locker's round-0 refund penalties, the latter returned by the vault (`returnFailedPenalty`) |
| 3 `PHASE_READY_TO_FINALIZE` | `now ≥ roundEnd(4)`, not finalized | `finalizeLaunch()` (permissionless); settlement calls auto-finalize (:669) |
| 4 `PHASE_SETTLEMENT_OPEN` | finalized ∧ `now < poolCreationOpensAt()` | `claimVaultSettlement()` (via locker owner) |
| 5 `PHASE_POOL_READY` | finalized ∧ `now ≥ poolCreationOpensAt()` ∧ pool not created | `claimVaultSettlement()` (owner, or anyone through `settleAfterGrace` / `settleAfterGraceBatch` on the locker side); `createOfficialPool` (vault, permissionless) once `allFinalCommitmentsSettled()`, otherwise it reverts `UNSETTLED_COMMITMENTS` |
| 6 `PHASE_TRADING_OPEN` | `liquidityPoolCreated` | locker `withdrawUnlockedTokens`; token transfers/burns ungated; vault `releaseCreatorTokens`; launch `burnResidualTokens`. No settlement remains: every final commitment settled before the pool existed |

Failure is terminal-by-predicate (only reachable pre-finalization); finalization is
one-shot (`FINALIZED`, D17Launch.sol:769) and requires nonzero committed WETH (:779).
Pool creation is one-shot (`POOL_CREATED` + `VAULT_LIQUIDITY_CLAIMED`,
D17Launch.sol:704-705; vault `poolCreated`, D17LiquidityVault.sol:124) and requires every
final commitment to be settled (`UNSETTLED_COMMITMENTS`, D17Launch.sol:707). The V15 late
path is gone: `claimLateSettlement` reverts `LATE_SETTLEMENT_DISABLED` (D17Launch.sol:655-657)
and so does the vault's `mintLateLiquidity` (D17LiquidityVault.sol:172-175).

## 5. Per-contract reference

Notation: **AC** = access control. All state-changing functions in D17Launch, D17Locker,
D17LiquidityVault are `nonReentrant` (storage-flag pattern, e.g. D17Launch.sol:192-197);
not repeated per row. `receive()`/`fallback()` revert on D17Launch (:258-264), D17Locker
(:89-95), D17LiquidityVault (:98-104).

### 5.1 D17Factory (D17Factory.sol, 344 lines)

Purpose: entry point, config validation, fee snapshot, canonical launch + locker registries.
Constants: `D17_FACTORY_ID` (:18), `BPS = 10_000` (:19), `MAX_TREASURY_BPS = 1_000`
(:22), `MAX_MANUAL_DISTRIBUTION_BPS = 1_000` (:23), `MIN_REFUND_PENALTY_BPS = 100` /
`MAX_REFUND_PENALTY_BPS = 2_500` (:26-27), `ROUND_COUNT = 5` (:28), metadata bounds
(:29-34), `MIN_COMMIT_WETH = 1e15` (:35), `MIN_LP_TOKENS = 1e18` (:36),
`MIN_ROUND_ALLOCATION_TOKENS = 1e18` (:37), **`MAX_TOKEN_SUPPLY = type(uint112).max`**
(:39, Uniswap V2 reserve limit), `MIN_ANCHOR_PRICE_WAD = 1e6` (:40), round-seconds bounds
60s–90d (:41-42), refund/settlement ≤ 30d (:43-44), `MAX_START_DELAY = 365 days` (:45),
mainnet floors `MAINNET_MIN_WINDOW_SECONDS = 1 hours` / `MAINNET_MIN_START_DELAY = 1 days`
(:49-50).
Key storage: `owner`, immutable `weth`/`router`/`feeConfig` (:52-55),
`launchFactory`/`lockerFactory` + pinned flags (:56-59), `launches`, `isLocker`,
`lockersByOwner` (:69-71).

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `createLaunch(ID17LaunchFactory.LaunchConfig calldata config) external returns (address token, address launch, address liquidityVault)` (:160) | Validates config, snapshots the protocol fee, on mainnet requires a frozen fee config, delegates deployment, registers canonical record, emits 3 events | any | pins missing; `FACTORY_NOT_RENOUNCED`; `MAINNET_FEE_NOT_FROZEN` (chain id 1); `PROTOCOL_FEE_ABOVE_MAX`; any validation failure below |
| `registerLockerFor(address lockerOwner, address locker) external` (:114) | Registers a locker | pinned lockerFactory only | `NOT_LOCKER_FACTORY`, zero/no-code/duplicate |
| `pinLaunchFactory(address) / pinLockerFactory(address) external` (:134/:125) | One-shot wiring | `onlyOwner` | `*_PINNED`, zero, no code |
| `transferOwnership(address) / renounceOwnership() external` (:143/:149) | Ownership; renounce requires both pins | `onlyOwner` | `OWNER_ZERO`; `*_UNLOCKED` |
| `isCanonicalLaunch(address launch, bytes32 rulesHash) external view returns (bool)` (:206) | Registry check: address **and** hash | view | - |
| `lockersOfOwner(address) external view returns (address[] memory)` (:156) | Locker enumeration per owner | view | - |

`_validateConfig` (:211-265) enforces: name/symbol length + JSON-safety; metadata bounds
(description ≤ 512B, ≤ 8 links, link type `[a-z0-9-]` ≤ 32B, link URL https + ≤ 128B +
JSON-safe, logo ≤ 8192B base64-SVG data URI, :267-304; the web app stops at 4096B so the creation fits the 16,777,216 gas cap per transaction); `tokenSupply > 0`;
**`tokenSupply ≤ MAX_TOKEN_SUPPLY`** (`SUPPLY_ABOVE_V2_RESERVE`, :218); `saleTokens > 0`;
`lpTokens ≥ 1e18`; **`saleTokens + lpTokens + manualDistributionTokens + deadTokens ==
tokenSupply`** (`SUPPLY_SPLIT`, :221-225); **`manualDistributionTokens * BPS ≤ tokenSupply *
1000`** (`MANUAL_ABOVE_CAP`, :226-229); canonical dead recipient when `deadTokens > 0`
(:230-232); treasury nonzero (:233); `startTime` in [now (+1 day on mainnet), now + 365d]
(`START_TOO_SOON`/`START_TOO_FAR`, :237-238); refund/settlement seconds in [1 (1h on
mainnet), 30d] (:239-243); `minCommitWeth ≥ 1e15`; `minPhase1Weth ≥ minCommitWeth`;
`minAnchorPriceWad ≥ 1e6` (:244-246); **`treasuryBps ≤ 1000`** (:247); **`100 ≤
refundPenaltyBps ≤ 2500`** (:248-251); 5 rounds, each 60s (1h on mainnet)–90d, each share
> 0 with allocation ≥ 1e18 tokens, shares summing to exactly 10 000 bps (:253-264). The
manual-allocation **recipient is not a config field** - it is always `msg.sender` of
`createLaunch`, passed as `creator` (:182). The config field `maxProtocolFeeBps` is the
creator's consent bound (ID17LaunchFactory.sol).

Events: `LaunchCreated(creator idx, launch idx, token idx, liquidityVault, rulesHash)`
(:74-80), `ManualDistributionConfigured(launch idx, recipient idx, amount)` (:89, emitted
for every launch incl. amount 0), `LaunchMetadataPublished(launch idx, metadataHash idx,
description, logoSvgUri, linkTypes[], linkUrls[])` (:81-88),
`LockerRegistered(owner idx, locker idx, manager idx)` (:90), pin/ownership events
(:73, :91-92).

### 5.2 D17FeeConfig (D17FeeConfig.sol, 74 lines)

Purpose: protocol fee settings for **future** launches. Constants: `D17_FEE_CONFIG_ID`
(:17), `MAX_PROTOCOL_FEE_BPS = 200` (:18). Storage: `owner`, `pendingOwner`,
`feeRecipient`, `protocolFeeBps` (:20-23).

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `constructor(address owner_, address feeRecipient_, uint16 protocolFeeBps_)` (:34) | Initial settings through `_setFee` | - | `OWNER_ZERO`, `FEE_ABOVE_CAP`, `FEE_RECIPIENT_ZERO` |
| `setProtocolFee(address feeRecipient_, uint16 protocolFeeBps_) external` (:41) | Replace settings; `bps ≤ 200`, recipient required when `bps > 0` (:67-73) | `onlyOwner` | `NOT_OWNER`, `FEE_ABOVE_CAP`, `FEE_RECIPIENT_ZERO` |
| `currentFee() external view returns (address recipient, uint16 bps)` (:45) | Read by `createLaunch` | view | - |
| `transferOwnership(address) / acceptOwnership() / renounceOwnership()` (:49/:54/:61) | Two-step handover; renouncing clears `pendingOwner` and freezes the settings forever | owner / pending owner | `NOT_OWNER`, `NOT_PENDING_OWNER` |

The fee config holds no funds and is never called by a launch: changing it cannot affect
any existing launch (§7). On mainnet `D17Factory.createLaunch` also reads its `owner()` and
`pendingOwner()` and requires both to be zero (D17Factory.sol:173-179), so a mainnet suite
only ever runs with renounced, final fee settings. Events: `ProtocolFeeUpdated(feeRecipient
idx, protocolFeeBps)`, `OwnershipTransferStarted`, `OwnershipTransferred`
(D17FeeConfig.sol:25-27).

### 5.2b D17FeeSplitter (D17FeeSplitter.sol, 94 lines)

Purpose: optional `feeRecipient` that splits the protocol fee between fixed recipients.
No owner, no setter. Constants: `D17_FEE_SPLITTER_ID` (:19), `BPS = 10_000` (:20),
`MAX_RECIPIENTS = 5` (:21). Storage: `weth` (immutable), recipients and shares (set once),
a reentrancy flag (:23-26).

| Signature | Semantics | AC | Reverts |
|---|---|---|---|
| `constructor(address weth_, address[] recipients_, uint16[] sharesBps_)` (:37) | 1 to 5 distinct non-zero recipients, non-zero shares adding up to 10 000 | - | `WETH_ZERO`, `WETH_NO_CODE`, `RECIPIENT_COUNT`, `LENGTH_MISMATCH`, `RECIPIENT_ZERO`, `SHARE_ZERO`, `RECIPIENT_DUPLICATE`, `SHARES_NOT_100_PERCENT` |
| `recipients() external view` (:57) | Recipients and shares | view | - |
| `distribute(address token) public returns (uint256 total)` (:63) | Sends the whole balance of `token`: `balance × share / 10 000` each, the last recipient gets the remainder (:67-80) | anyone, `nonReentrant` | `REENTRANT`, `BALANCE_READ`, `TransferFailed` |
| `distributeEth() external returns (uint256 total)` (:83) | Wraps the ETH balance into WETH, then distributes the WETH balance; shares the same guard as `distribute` (V15.1) | anyone, `nonReentrant` | as above |

Fees arrive as plain WETH transfers (`D17Locker` pays the launch's `protocolFeeRecipient`),
so a splitter never runs code on receipt and can never block a settlement. Event:
`Distributed(token idx, recipient idx, amount)` (:28). Covered by
`test/fee-splitter-e2e.mjs` (a real launch's 1% fee split 50/25/25) and by the callback
probes of `test/adversarial-callbacks.mjs`.

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
the other factories (:32-45). **Code size (V15.1, `release/protocol-build.json`):** D17LaunchDeployer
22,910 bytes (limit 24,576), so `D17Launch` creation code can grow by ~1.6 KB at most;
D17Launch 17,722 bytes; D17Factory 11,538 bytes; D17LaunchFactory 5,129 bytes.

### 5.4 D17Launch (D17Launch.sol, 847 lines) - the engine

Constants: `D17_LAUNCH_ID` (:10), **`FAILED_REFUND_POLICY =
keccak256("D17_FAILED_R1_FULL_REFUND_V1")`** (:11), `ROUND_COUNT = 5`/`FINAL_ROUND = 4`/
`REFUND_STAGE_COUNT = 4` (:12-14), `EARLY_REFUND_ROUNDS = 2` (:17),
`EARLY_REFUND_PENALTY_BPS = 100` (:21), `NO_ROUND` (:22), phase constants (:23-30),
`BPS = 10_000` (:31), mins (:32-35), `WAD = 1e18` (private, :36), dead address (:37).
Immutables (:39-62): factory, vaultConfigurator, token, weth, treasury,
**protocolFeeRecipient**, startTime, refundSeconds, settlementSeconds, tradingOpenAt,
minCommitWeth, minPhase1Weth, minAnchorPriceWad, treasuryBps, **protocolFeeBps**,
refundPenaltyBps, saleTokens, lpTokens, deadTokens, deadRecipient,
manualDistributionTokens, manualDistributionRecipient, metadataHash. Constructor takes one
`LaunchParams` struct (:113-138, :202-256); it keeps structural checks (incl.
`treasuryBps + protocolFeeBps < BPS` and a fee recipient when the fee is nonzero,
:208-209) while economic caps live in D17Factory.

Key storage (:64-102): `liquidityVault` (one-shot), `liquidityPoolCreated`,
`vaultLiquidityClaimed`, `officialPair`, **`exactCommittedLiquidityWeth`** (:70, the exact
sum of every locker's current pool share, maintained on each commitment and refund),
`settledLiquidityWeth` (vault deliveries at settlement), `finalCommittedWeth`
(finalization snapshot), `settledCommittedWeth` (gross settled),
`poolSettledLiquidityWeth`/`poolSettledCommittedWeth` (pool-creation snapshots),
`lateSettledCommittedWeth`/`lateSettledLiquidityWeth`/`lateLpTokensReleased` (:76-78, V15
fields kept for ABI compatibility; always zero in V15.1), `vaultLiquidityTokensClaimed`,
write-once pool records (:80-83), `roundSeconds[5]`/`roundSharesBps[5]`/`roundRaised[5]`
(:85-87), `retainedPenaltyWeth`/`penaltyWethPaid`/**`penaltyWethRefunded`**/
**`failedPenaltyWethRefunded[locker]`**/`treasuryWethPaid`/`protocolFeeWethPaid` (:89-94),
`unsoldSaleTokensSettled`/`unusedLpTokensBurned`/`effectiveLpTokens`/
`finalRoundTokenPool`/`unsoldSaleTokensBurned` (:95-99), `finalizedAt`, `finalized`
(:100-101). Per-locker `Position{finalSaleTokensClaimed, liquidityClaimed, refundWeth,
penaltyWeth, paid[5], refunded[5]}` (private mapping, :104-111, :140).

State-changing ABI:

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `configureLiquidityVault(address liquidityVault_) external` (:266) | One-shot vault wiring | `vaultConfigurator` only | `VAULT_CONFIGURED`, zero, no code |
| `recordRoundCommitment(uint8 round, uint256 amount) external` (:556) | Books a commit into the active round; adds the change of the locker's pool share to `exactCommittedLiquidityWeth` (:567-571) | `onlyLocker` | `ROUND`, `COMMIT_TOO_SMALL`, `ROUND_CLOSED`, `ANCHOR_NOT_READY` (rounds 1–4, :560), claimed/refunded guards (:563-565) |
| `releaseRoundRefund() external returns (uint8 round, uint256 refundWeth, uint256 penaltyWeth)` (:575) | Refund of the caller's full stake in the open window; removes the change of its pool share from `exactCommittedLiquidityWeth` (:591, :596); **penalty = `gross * (round < 2 ? 100 : refundPenaltyBps) / BPS`**, accumulated in `retainedPenaltyWeth` and the position's `penaltyWeth` (:601-606) | `onlyLocker` | `NO_REFUND_STAGE`, `ROUND_REFUNDED`, claimed guards, `NO_ROUND_POSITION` |
| `releaseFailedRefund() external returns (uint256 refundWeth)` (:611) | After launch failure: every remaining round's principal, **plus** the locker's unreturned refund penalties (`position.penaltyWeth − failedPenaltyWethRefunded[locker]`, :628), which the vault sends back to the locker through `returnFailedPenalty` (:637-640); `retainedPenaltyWeth` decreases by the returned amount (:634). No penalty is charged on this path | `onlyLocker` | `LAUNCH_NOT_FAILED`, claimed guards, `NO_POSITION` (nothing left to return, :629) |
| `claimVaultSettlement() external returns (uint256 saleTokenAmount, uint256 wethForVault, uint256 treasuryWeth, uint256 protocolFeeWeth)` (:644) | Settlement (only before the pool exists): `_settlePosition()` | `onlyLocker` | `POOL_CREATED` (:650) + `_settlePosition` guards |
| `claimLateSettlement() external view` (:655) | V15 ABI kept for clients; **always reverts** | `onlyLocker` | `LATE_SETTLEMENT_DISABLED` (:656) |
| `finalizeLaunch() external` (:693) | One-shot finalization (§6.4) | **permissionless** | `FINALIZED`, `LAUNCH_FAILED`, `NOT_OVER`, `NO_FINAL_COMMITMENTS` |
| `claimVaultLiquidityTokens() external returns (uint256 liquidityTokens, uint256 wethForPool)` (:697) | Pool funding claim, once every final commitment is settled (:707) and the settled pool shares equal the exact ledger (:708): `wethForPool = totalLiquidityWeth()`, `liquidityTokens = effectiveLpTokens` (:713-714); snapshots pool inputs and transfers the LP tokens to the vault (:717-721) | `onlyVault` | `POOL_CREATED`, `VAULT_LIQUIDITY_CLAIMED`, `POOL_CREATION_NOT_OPEN`, `UNSETTLED_COMMITMENTS`, `LIQUIDITY_ACCOUNTING`, `NO_SETTLED_LIQUIDITY`, `NO_LIQUIDITY_TOKENS` |
| `markLiquidityPoolCreated(address pair, uint256 tokenUsed, uint256 wethUsed, uint256 lpMinted) external` (:726) | Writes the once-only pool records; requires `tokenUsed == vaultLiquidityTokensClaimed` and `wethUsed == poolSettledLiquidityWeth + retainedPenaltyWeth` (:734-735) | `onlyVault` | `POOL_CREATED`, `VAULT_LIQUIDITY_NOT_CLAIMED`, `PAIR_ZERO`, `*_MISMATCH`, `LP_ZERO` |
| `burnResidualTokens() external returns (uint256 amount)` (:750) | Burns the launch's whole token balance (per-position sale-token rounding dust) once the pool exists and every final commitment has settled | **permissionless** | `SETTLEMENT_OPEN`, `NO_RESIDUAL` |
| `sweepUnexpectedEthToTreasury() external returns (uint256 amount)` (:760) | Force-sent ETH is wrapped and sent to the treasury **as WETH** (cannot be blocked by a treasury that rejects ETH) | permissionless | `NO_ETH_BALANCE` |

`_settlePosition()` (:659-691): requires vault configured, lazily finalizes (:668-669);
requires position unclaimed (:672-673); computes sale tokens via
`previewFinalSaleTokens(msg.sender)` and the WETH split via `_vaultSettlementAmounts`;
requires gross > 0 (:677); sets both claim flags **before** transfers (:679-680); updates
`settledCommittedWeth`, `treasuryWethPaid`, `protocolFeeWethPaid` and
`settledLiquidityWeth += wethForVault` (:681-685); emits `VaultSettlementClaimed`
(:686-688); finally transfers sale tokens to the calling locker (:690). The **WETH itself
never passes through the launch** - the locker transfers it (see §5.5).

View ABI (selected; full signatures at cited lines): `rulesHash() → bytes32` (:275 -
abi.encode of the 27 fields at :277-303, first field `D17_LAUNCH_ID`, includes
`protocolFeeRecipient` and `protocolFeeBps`, last field `FAILED_REFUND_POLICY`);
`activeRound() → uint8` (:307); `activeRefundWindow() → uint8` (:318);
`roundStart/roundEnd/roundClaimTime(uint8)` (:326/:336/:353);
`roundBaseTokenAllocation/roundTokenAllocation/roundSoldTokens(uint8)` (:340/:345/:388);
`anchorPriceWad()` (:359); `anchorReady()` (:365); `launchFailed()` (:369);
`roundAnchorTargetWeth/roundAnchorUnderfillRemainingWeth(uint8)` (:376/:382 - defined for
the final round too); `rolloverToFinalRound()` (:401); `roundDiscoveredPriceWad(uint8)`
(:409); `isRoundClaimable(uint8)` (:415); `settlementStartsAt()` (:419);
`poolCreationOpensAt()` (:423); `tradingOpen()` (:429); `totalCommittedWeth()` (:433);
**`liquidityBps()`** (:438, informational: the pool no longer uses it);
**`totalLiquidityWeth()`** (:445, `exactCommittedLiquidityWeth + retainedPenaltyWeth`);
**`poolTokenAllocation()`** (:453); `allFinalCommitmentsSettled()` (:460 - gates pool
creation and `burnResidualTokens`); `contributedBy(address,uint8)` (:464);
`lockerPositionState(address)` (:469); `previewRoundTokens(address,uint8)` (:490);
`previewFinalSaleTokens(address)` (:499); `previewVaultSettlement(address) → (saleTokens,
gross, wethForVault, treasuryWeth, protocolFeeWeth)` (:505); `launchPhase()` (:522); public
getters `exactCommittedLiquidityWeth`, `penaltyWethRefunded`,
`failedPenaltyWethRefunded(address)`. The V14 `previewSettlement` alias was removed.

Events (:142-180): `LiquidityVaultConfigured`, `RoundCommitted(locker idx, round idx,
amount)`, `RoundRefunded(locker idx, refundRound idx, refundWeth, penaltyWeth)`,
`LaunchFailedRefunded(locker idx, refundWeth)` (refundWeth includes returned penalties),
**`FailedPenaltyRefunded(locker idx, penaltyWeth)`**, `VaultSettlementClaimed(locker idx,
saleTokens, wethForVault, treasuryWeth, protocolFeeWeth, grossCommittedWeth)`,
`Finalized(finalizedAt)`, `VaultLiquidityTokensClaimed(liquidityVault idx,
liquidityTokens, wethForPool)`, `LiquidityPoolCreated(liquidityVault idx, pair idx,
tokenUsed, wethUsed, lpMinted)`, `UnsoldSaleTokensBurned(amount)`,
`UnusedLpTokensBurned(amount)`, `ResidualTokensBurned(amount)`,
`UnexpectedEthSwept(recipient idx, amount)`. `LateVaultSettlementClaimed` (:155-163) is
still declared for ABI compatibility but is never emitted in V15.1. V14's
`UnsoldSaleTokensPaid` no longer exists.

### 5.5 D17Locker (D17Locker.sol, 337 lines) - per-user escrow

One locker per (user, deployment); registered in D17Factory; holds the user's WETH until
refund/settlement and claimed sale tokens until withdrawal. `EXPECTED_LAUNCH_ID` (:10)
pins the accepted launch version (`D17_LAUNCH_V15_1`). Immutables: `owner`,
`factory`, `weth` (:13-15). Global ledgers: `withdrawableWeth`, `accountedWeth` (:17-18).
Per-launch `LockerPosition` struct (:21-43); V15 inserted **`protocolFeeWeth` after
`treasuryWeth`** (:34-35), shifting every later field of the public `positions` getter
(:45) - decode it by field name. V15.1 adds `failedPenaltyWethRefunded[launch]` (:46).
Every value-moving function updates the locker's ledgers **before** its external calls
(checks-effects-interactions, V15.1).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `verifyLaunch(address launch, bytes32 expectedRulesHash) public view returns (bool)` (:97) | Authenticity gate: code exists, `D17_LAUNCH_ID == EXPECTED_LAUNCH_ID`, same WETH, `rulesHash` matches, canonical in factory | view | `NO_CODE`, `BAD_LAUNCH_ID`, `BAD_WETH`, `BAD_RULES`, `NOT_CANONICAL` |
| `commitToRound(address launch, uint8 round, bytes32 expectedRulesHash) public payable` (:133) | Updates the ledgers and pins the rules hash (:146-155), calls `recordRoundCommitment` (:157), then wraps `msg.value` ETH→WETH, held **in the locker** (:158) | `onlyOwner` | `NO_ETH`, `ROUND`, verify failures, `LIQUIDITY_SETTLED` |
| `refundCurrentRound(address launch) public` (:162) | Calls `releaseRoundRefund`; updates the ledgers (:170-180), then pays the penalty WETH to the **liquidity vault** (:183); refund stays in the locker as `residualWeth`/`withdrawableWeth` | `onlyOwner` | `UNKNOWN_LAUNCH`, `LIQUIDITY_SETTLED`, `NO_REFUND`, ledger guards (:170-171) |
| `refundFailedLaunch(address launch, bytes32 expectedRulesHash) public` (:199) | Full failed-launch refund: remaining principal plus unreturned penalties (:208-209); ledgers first (:219-226), then `releaseFailedRefund`, whose amount must match (`FAILED_REFUND_MISMATCH`, :228). Works even when every round was already refunded, as long as a penalty is owed | `onlyOwner` | verify failures, `UNKNOWN_LAUNCH`, `LIQUIDITY_SETTLED`, `LOCKED_WETH_BALANCE`, launch reverts |
| `failedRefundDue(address launch) external view returns (uint256)` (:111) | What `refundFailedLaunch` would return now (0 unless the launch failed) | view | - |
| `settleAndClaim(address launch, bytes32 expectedRulesHash) public returns (uint256)` (:232) | Owner settlement any time after the final round (lazy finalize) and before the pool exists | `onlyOwner` | verify + `_settleVaultPosition` guards |
| `settleAfterGrace(address launch) public returns (uint256)` (:237) | **Permissionless** settlement-for from `poolCreationOpensAt`; re-verifies with the **stored** rules hash (:240); tokens stay in this locker for its owner | any | `UNKNOWN_LAUNCH`, `NOT_FINALIZED`, `GRACE_OPEN` |
| `withdrawUnlockedWeth(address launch, uint256 amount) public` (:187) | Withdraws refund residuals to owner | `onlyOwner` | ledger guards |
| `withdrawUnlockedTokens(address launch, uint256 amount) public` (:307) | Withdraws claimed sale tokens; **gated on `launch.tradingOpen()`** (:311) | `onlyOwner` | `TOKEN_MISSING`, `TOKEN_WITHDRAW_LOCKED`, `TOKEN_BALANCE` |
| `recoverNativeEth(address, uint256) external` (:318) / `recoverExcessWeth(address, uint256) public` (:327) | Force-sent ETH / WETH above `accountedWeth` | `onlyOwner` | balance guards |
| `lockedWeth(address)` (:107); `roundPosition(address,uint8)` (:118); `positions(address)` (:45) | Views | view | - |

`_settleVaultPosition` (:246-305): recomputes per-round previews locally (:251-259) and
requires the launch-returned sale tokens to equal their sum (`FINAL_CLAIM_MISMATCH`,
:267); calls `claimVaultSettlement` (:266), which reverts once the pool exists; requires
`wethCommitted ≥ wethForVault + treasuryWeth + protocolFeeWeth` (:268-269); records the
settlement and moves the leftover `wethCommitted` to the withdrawable residual (:271-287);
then transfers `wethForVault` to the vault, `treasuryWeth` to the treasury and
`protocolFeeWeth` to `launch.protocolFeeRecipient()` **from the locker** (:289-291). Emits
`VaultSettlementCompleted` (:293-304).

### 5.6 D17LiquidityVault (D17LiquidityVault.sol, 246 lines)

Purpose: creates and permanently holds the official LP position in one deposit, vests the
creator allocation, returns failed-launch penalties. Constants: `D17_LIQUIDITY_VAULT_ID`
(:13), `CREATOR_VESTING_SECONDS = 180 days` (:16), `BURN_ADDRESS = 0x…dEaD` (:17).
Immutables: `launch`, `token`, `weth`, `router`, `routerFactory`, `treasury` (:19-24).
Storage (:26-42): pool records, `poolCreatedAt`, `creatorTokensReleased`, pre-seed
records, **`failedLaunchPenaltyWethRefunded`** (:38); the V15 fields `lateTokenUsedForLp`,
`lateWethUsedForLp`, `lateLpMinted`, `lateTokensBurned`, `lateWethBurned` and
`failedLaunchPenaltyWethBurned` (:32-37) stay in the ABI and are always zero. **No function
transfers or burns vault-held LP - LP is locked forever** (recovery excludes it, :221).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `createOfficialPool(uint256 minLpMinted, uint256 deadline) external returns (address pair, uint256 liquidityTokens, uint256 wethForPool, uint256 liquidity)` (:119) | Gets-or-creates the pair; requires a virgin pair (`totalSupply == 0`, :133) with zero token balance (`PAIR_PRESEEDED_TOKEN`, :142; donated WETH tolerated and recorded, :138-141); claims amounts from the launch (:144), which requires every final commitment settled; requires token balance ≥ claimed + still-locked creator tokens (:145-148); transfers both legs, mints LP to itself (:153-155); slippage floor (:156); records `poolCreatedAt` (:160); callback `markLiquidityPoolCreated` (:167) | **permissionless** (time-gated by launch, :126) | `POOL_CREATED`, `DEADLINE`, `POOL_CREATION_NOT_OPEN`, `PAIR_NO_CODE`, `PAIR_ALREADY_LIVE`, `PAIR_PRESEEDED_TOKEN`, `UNSETTLED_COMMITMENTS`, `LIQUIDITY_ACCOUNTING`, `NO_SETTLED_LIQUIDITY`, `VAULT_TOKEN_BALANCE`, `NO_TOKEN_BALANCE`, `NO_WETH_FOR_POOL`, `VAULT_WETH_BALANCE`, `LP_SLIPPAGE` |
| `mintLateLiquidity(uint256, uint256) external view returns (uint256)` (:172) | V15 ABI kept for clients; **always reverts** | registered lockers reach the revert (:173) | `NOT_D17_LOCKER`, `LATE_SETTLEMENT_DISABLED` |
| `releaseCreatorTokens() external returns (uint256 amount)` (:179) | Pays `vestedCreatorTokens() − creatorTokensReleased` to `launch.manualDistributionRecipient()` | **permissionless** | `NOTHING_VESTED` |
| `burnFailedLaunchPenalties() external pure returns (uint256)` (:189) | V15 ABI kept for clients; **always reverts**: failed-launch WETH is never sent to the burn address | - | `FAILED_PENALTIES_REFUND_ONLY` |
| `returnFailedPenalty(address locker, uint256 amount) external` (:195) | Sends `amount` WETH back to `locker`, the payer of that penalty; the amount is the launch's per-locker record, so donations to the vault never increase a claim | `msg.sender == launch` | `NOT_LAUNCH`, `LAUNCH_NOT_FAILED`, `POOL_CREATED`, `NOT_D17_LOCKER`, `AMOUNT_ZERO` |
| `sweepExcessWethToTreasury() external returns (uint256)` (:208) | Post-pool WETH donation sweep (every legitimate WETH flow ended at pool creation) | permissionless | `POOL_NOT_CREATED`, `NO_EXCESS_WETH` |
| `recoverUnsupportedTokenToTreasury(address, uint256) external` (:216) | Foreign-token recovery; excludes `token`, `weth`, `officialPair` (:219-221) | permissionless | `AMOUNT_ZERO`, `TOKEN_ZERO`, `*_PROTECTED` |
| `sweepUnexpectedEthToTreasury() external returns (uint256)` (:227) | Force-sent ETH wrapped and sent as WETH (:230-231) | permissionless | `NO_ETH_BALANCE` |
| `lockedCreatorTokens()` (:107) / `vestedCreatorTokens()` (:111) | Vesting views | view | - |

Events (:44-66): `OfficialPoolCreated(pair idx, tokenUsed, wethUsed, lpMinted,
preseededTokenReserve, preseededWethReserve)`, **`FailedLaunchPenaltyReturned(locker idx,
amount)`**, `CreatorTokensReleased(recipient idx, amount)`, sweep/recovery events.
`LateLiquidityAdded` and `FailedLaunchPenaltiesBurned` are still declared but never
emitted in V15.1.

### 5.7 D17Token (D17Token.sol, 295 lines)

Unchanged from V14 except its identity string. Minimal ERC-20 (18 decimals, :19) with
launch-coupled transfer/burn gates and on-chain metadata (`contractURI`). Owner = launch
factory only during deployment; renounced in the same transaction (§3 step 12).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `transfer / transferFrom` (:159/:170) | ERC-20 with pre-open gate via `_transfer` (:216-229) | any | `TRADING_CLOSED`, `BALANCE`, `ALLOWANCE`, `TO_ZERO` |
| `approve(address,uint256)` (:164) | Standard; infinite-allowance shortcut in transferFrom (:172) | any | - |
| `burn(uint256 amount)` (:182) | **Pre-open: launch only** (`BURN_BEFORE_OPEN`, :187); post-open: any holder | gated | `BURN_BEFORE_OPEN`, `BALANCE` |
| `mint(address,uint256)` (:196) | Capped mint; deployment window only | `onlyOwner` | `MINTING_CLOSED`, `CAP`, `TO_ZERO` |
| `closeMinting() / renounceOwnership()` (:205/:211) | One-shot close; owner destruction | `onlyOwner` | `MINTING_CLOSED` |
| `configureTradingGate(...)` (:86) / `configureMetadata(...)` (:118) | One-shot wiring | `onlyOwner` | `TRADING_GATE_CONFIGURED`, `METADATA_CONFIGURED`, zero/no-code, `TRADING_OPEN_NOW` |
| Views: `tradingOpen()` (:136), `canonicalPair()` (:154), `contractURI()` (:150), `linkCount()`/`links(uint256)` (:140/:144) | Gate/metadata reads | view | `LINK_INDEX` |

Gate logic `_transferAllowedBeforeOpen(from, to)` (:231-241): before configuration →
false; `from == launch` → true; `from == liquidityVault && to == canonicalPair()` → true;
otherwise requires `_launchTradingOpen()` - a try/catch read of `launch.tradingOpen()`
that **fails closed** (:243-249). The creator allocation sits in the vault, so it can only
leave through vesting once the pool exists. `unchecked` arithmetic in
`transferFrom`/`burn`/`_transfer` is guarded by preceding requires (:174-177, :189-192,
:224-227).

### 5.8 D17TokenFactory / D17LiquidityVaultFactory (51 lines each)

Identical pattern: owner pins `launchFactory` once (:28-35), `renounceOwnership` requires
the pin (:37-41), `deployToken` (D17TokenFactory.sol:43-50) / `deployVault`
(D17LiquidityVaultFactory.sol:43-50) callable only by the pinned launch factory. IDs at
:7. Events at :13-15. Their owners must be zero before any launch (§3).

### 5.9 D17LockerFactory (D17LockerFactory.sol, 62 lines)

Immutable `d17Factory` (:13); constants `MAX_SETTLEMENT_BATCH = 4` (:17) and
`SETTLEMENT_CALL_GAS = 3_000_000` (:18). Events `LockerCreated(owner idx, locker idx)` and
`BatchSettlementResult(launch idx, locker idx, success)` (:20-21).

| Signature | Semantics | AC | Key reverts |
|---|---|---|---|
| `createLockerFor(address lockerOwner) external returns (address locker)` (:29) | Deploys `D17Locker(lockerOwner, d17Factory, registry.weth())` and registers it; multiple lockers per owner are allowed | **`msg.sender == lockerOwner`** (`ONLY_SELF`, :31) | `OWNER_ZERO`, `ONLY_SELF` |
| `settleAfterGraceBatch(address launch, address[] calldata lockers) external returns (uint256 completed)` (:42) | Calls `settleAfterGrace(launch)` on up to 4 lockers, each with a fixed 3,000,000 gas stipend in a `try` (:50-60); entries that are not registered lockers, duplicates, already-settled or failing positions are skipped and reported in `BatchSettlementResult` instead of reverting the batch; returns the number settled | **permissionless** | `BATCH_SIZE` (0 or more than 8, :44), `BATCH_GAS` (not enough gas forwarded for every item, :46) |

The batch adds no authority: each locker re-runs its own checks (stored rules hash,
finalization, grace boundary) and the sale tokens stay in that locker for its owner.
`D17Locker.settleAfterGrace` remains callable directly if a settlement ever needs more gas
than the stipend.

### 5.10 lib/D17SafeTransfer (29 lines)

`safeTransfer` (:10), `safeTransferFrom` (:15), `safeApprove` (:20), `safeBurn` (:25):
raw-call wrappers tolerating missing return values, reverting with typed errors (:5-8).
**Not** fee-on-transfer-safe - acceptable because the only tokens touched are D17Token,
canonical WETH, and the V2 pair.

## 6. The math

Units: WETH/token amounts in wei (18 decimals); prices in **WAD** (1e18) as WETH-per-token;
shares/fees in **BPS** (1e4). All divisions floor; fee floors round in favour of the pool,
token floors round against the claimant.

**6.1 Anchor discovery (round 0).**
`anchorPriceWad = roundRaised[0] * 1e18 / roundBaseTokenAllocation(0)` (D17Launch.sol:359-363);
`anchorReady = roundRaised[0] ≥ minPhase1Weth ∧ anchorPriceWad ≥ minAnchorPriceWad` (:365-367).
If the window after round 0 closes without `anchorReady`, `launchFailed()` becomes true
permanently (:369-371).

**6.2 Round targets, sales, rollover.**
`roundBaseTokenAllocation(r) = saleTokens * roundSharesBps[r] / BPS` (:340-343).
For **every** round `r ≥ 1` (V14: rounds 1–3 only):
`roundAnchorTargetWeth(r) = roundTokenAllocation(r) * anchorPriceWad / WAD` (:376-380);
`roundSoldTokens(r) = raised ≥ target ? allocation : allocation * raised / target`
(:388-399). Overfill above target is allowed and raises the round's price; underfill in
rounds 1–3 rolls into the final round,
`rolloverToFinalRound = Σ_{r=1..3} max(base(r) − sold(r), 0)` (:401-407). The final round's
allocation is `base(4) + rollover` (snapshotted as `finalRoundTokenPool` at finalization,
:775) and it sells at most `allocation * raised / target`: **no round sells below the
anchor price**; what the final round cannot sell is burned (§6.4). Buyer share:
`_roundTokensForBuyer(r, paid) = sold(r) * paid / roundRaised[r]` (round 0 uses the base
allocation) (:817-828).

**6.3 Refunds.** In window `r` (windows follow rounds 0–3 only, :318-324):
`penalty = gross * (r < 2 ? EARLY_REFUND_PENALTY_BPS(=100) : refundPenaltyBps) / BPS`,
`refund = gross − penalty` (:601-602). `roundRaised[r]` is decremented by the gross
amount; `retainedPenaltyWeth += penalty` (:603). The locker sends the penalty WETH to the
**liquidity vault** (D17Locker.sol:183). If the launch then succeeds, every penalty is
paired into the initial pool (§6.6). If it fails (only round-0 penalties can exist at that
point), each locker's `refundFailedLaunch` returns its remaining principal **and** the
penalties it paid: the launch tracks them per locker (`position.penaltyWeth`,
`failedPenaltyWethRefunded`, D17Launch.sol:628-635) and the vault pays them back with
`returnFailedPenalty` (D17LiquidityVault.sol:195-204). Nothing is burned and no fee is
charged. This policy is pinned in every launch's `rulesHash` as `FAILED_REFUND_POLICY`
(D17Launch.sol:11, :303).

**6.4 Finalization** (:768-798): one-shot; snapshots `finalRoundTokenPool` and
`finalCommittedWeth` (> 0, :775-779); `sold = Σ roundSoldTokens` (capped at `saleTokens`,
:830-833); `unsoldSaleTokensSettled = saleTokens − sold`;
**`effectiveLpTokens = lpTokens * sold / saleTokens`**,
`unusedLpTokensBurned = lpTokens − effectiveLpTokens` (:781-784); both remainders are
burned in one `safeBurn` (:788-790). No unsold token is ever transferred to anyone.

**6.5 Settlement split** (:804-815):
`gross = Σ position.paid[r]`; `treasuryWeth = gross * treasuryBps / BPS`;
`protocolFeeWeth = gross * protocolFeeBps / BPS`;
`wethForVault = gross − treasuryWeth − protocolFeeWeth` (both fees floor per position;
the pool takes the remainder). Sale tokens = `previewFinalSaleTokens` (§6.2). The same
function, `_positionLiquidityWeth` (:800-802), maintains the exact ledger: on every
commitment and refund the launch adds or removes the **change** of the locker's
`wethForVault` (:567-571, :591-596), so at any time `exactCommittedLiquidityWeth =
Σ_lockers wethForVault(locker)`. Who settles and when (owner, third party, batch) never
changes the amounts.

**6.6 Pool funding.** Let `L = effectiveLpTokens`, `P = retainedPenaltyWeth` and
`E = exactCommittedLiquidityWeth = Σ_i (g_i − ⌊g_i·treasuryBps/BPS⌋ −
⌊g_i·protocolFeeBps/BPS⌋)` over every locker `i` with final gross `g_i`; all three are
fixed after finalization. `totalLiquidityWeth() = E + P` (D17Launch.sol:445-447). The pool
opens only when every final commitment has settled (`settledCommittedWeth ==
finalCommittedWeth`, :460-462, required at :707), at which point the vault holds exactly
`settledLiquidityWeth + P` WETH and the launch checks `settledLiquidityWeth == E`
(`LIQUIDITY_ACCOUNTING`, :708). The single initial deposit is `weth = E + P` paired with
`tokens = L` (:713-714): every reserved LP token and every wei of pool share, in one
`mint`, at the **canonical launch ratio** `(E + P) / L`. Because `L` scales with the share
sold and `E` with what was paid, the opening price tracks the average sale price whatever
the fill: `E ≈ finalCommittedWeth × liquidityBps / BPS` (the per-locker fee floors put it
at or above that aggregate, by less than two wei per locker), so the price is about
`avgSalePrice × (liquidityBps / BPS) × (saleTokens / lpTokens)` plus the penalty
contribution, and equals the average price net of fees when the creator sets
`lpTokens == saleTokens` (ignoring penalties). The `saleTokens / lpTokens` factor is fixed
in the published rules.

V15 computed the pool total once on the aggregate (`T = finalCommittedWeth × liquidityBps /
BPS + P`) and the tokens as `L × weth / T`; per-position fee floors could make the settled
WETH exceed that aggregate by a few wei, so a pool funded by fully settled positions asked for
more than `L` tokens and reverted forever. V15.1 removes the ratio entirely: the WETH is
the exact ledger and the tokens are exactly `L`. There is no late top-up, no live-ratio
deposit and no burn of unpairable value: nobody can settle after trading opens, so no
contribution ever meets a moved market price.

**6.7 Dust & recovery paths.** Launch: per-position sale-token dust →
`burnResidualTokens()` once the pool exists (every commitment is settled by then,
:750-756); force-sent ETH → `sweepUnexpectedEthToTreasury` as WETH (:760-766). Locker:
ETH → `recoverNativeEth`; WETH above `accountedWeth` → `recoverExcessWeth`. Vault:
post-pool WETH donations → `sweepExcessWethToTreasury`; foreign tokens →
`recoverUnsupportedTokenToTreasury` (D17-token donations to the vault are unrecoverable by
design, and so is WETH donated to the vault of a failed launch: `returnFailedPenalty` only
pays recorded penalties and the sweep needs a pool).

**6.8 Creator vesting.** `vestedCreatorTokens() = manualDistributionTokens *
min(now − poolCreatedAt, 180 days) / 180 days` (0 before the pool exists,
D17LiquidityVault.sol:111-117); `releaseCreatorTokens` pays the difference with
`creatorTokensReleased` to the fixed recipient (:179-186). `lockedCreatorTokens()` (:107)
is excluded from the vault's token-balance check at pool creation (:145-148), so creator
tokens can never be paired into the pool or burned. If the launch fails the pool never
exists and the allocation stays in the vault forever.

## 7. Access control & authenticity

Compatibility constants (all `keccak256` values fixed in deployed bytecode, all ending in
`V15_1`; the first V15 suites used `V15_HARDENED`, which the web app still recognises when
the published manifest says so): `D17_FACTORY_ID` (D17Factory.sol:18), `D17_FEE_CONFIG_ID`
(D17FeeConfig.sol:17), `D17_LAUNCH_DEPLOYER_ID` (D17LaunchDeployer.sol:11),
`D17_LAUNCH_ID` (D17Launch.sol:10), `D17_TOKEN_ID` (D17Token.sol:15),
`D17_TOKEN_FACTORY_ID` (D17TokenFactory.sol:7), `D17_LIQUIDITY_VAULT_ID`
(D17LiquidityVault.sol:13), `D17_LIQUIDITY_VAULT_FACTORY_ID`
(D17LiquidityVaultFactory.sol:7), and `D17Locker.EXPECTED_LAUNCH_ID` (D17Locker.sol:10),
which **must equal** the launch ID - lockers reject V14 and other incompatible launches
with `BAD_LAUNCH_ID` in `verifyLaunch`. `D17_FEE_SPLITTER_ID` (D17FeeSplitter.sol:19) is
`D17_FEE_SPLITTER_V1`. `rulesHash()` covers every economic parameter, including the
protocol fee rate and recipient and the failed-refund policy, with the launch ID as its
first field (D17Launch.sol:275-305); lockers pin the hash at commit (D17Locker.sol:150)
and `settleAfterGrace` re-verifies against the **stored** hash (D17Locker.sol:240).

**Protocol fee isolation.** The fee is read once, at creation, from `D17FeeConfig`
(D17Factory.sol:170), checked against the creator's `maxProtocolFeeBps` (:180) and stored
in launch immutables that are part of `rulesHash`. No launch, locker or vault ever calls
the fee config again; the fee owner has no path to an existing launch or to any funds. On
mainnet there is no fee owner at all: `createLaunch` requires the fee config's `owner` and
`pendingOwner` to be zero (:173-179).

Self-registration: `createLockerFor` requires `msg.sender == lockerOwner`
(D17LockerFactory.sol:31); registration is restricted to the pinned locker factory
(D17Factory.sol:114-123) - `isLocker` contains only canonical locker bytecode, which is
the basis for `onlyLocker` on the launch and the `NOT_D17_LOCKER` check of
`returnFailedPenalty` on the vault. The vault pays a failed-launch penalty only when its
own launch calls it with an amount taken from that launch's per-locker record.

Deliberately permissionless entry points and why they are safe:

| Entry point | Why safe |
|---|---|
| `finalizeLaunch()` (D17Launch.sol:693) | Pure state transition from immutable timing + committed totals; one-shot |
| `settleAfterGrace(launch)` (D17Locker.sol:237) | Only after the fixed grace boundary; outcome identical to owner settlement; tokens stay in the owner's locker; stored-rules-hash verification |
| `settleAfterGraceBatch(launch, lockers)` (D17LockerFactory.sol:42) | Only calls `settleAfterGrace` on registered lockers; bounded to 4 items with a fixed gas stipend; failures are skipped, never forwarded |
| `createOfficialPool(minLp, deadline)` (D17LiquidityVault.sol:119) | Time-gated; requires every commitment settled; virgin-pair + preseed checks; amounts come from launch accounting |
| `releaseCreatorTokens()` (D17LiquidityVault.sol:179) | Amount from a deterministic schedule; recipient fixed in the rules |
| `burnResidualTokens()` (D17Launch.sol:750) | Only burns the launch's own token balance; only once the pool exists and every commitment settled |
| Sweeps/recovery (launch :760, vault :208, :216, :227) | Only move donations/force-sent value to the fixed treasury |

## 8. Invariants (enforcement map)

| # | Invariant | Enforcing check(s) |
|---|---|---|
| 1 | Supply conservation: `sale + lp + manual + dead == tokenSupply ≤ 2^112 − 1`; mint one-shot; no post-deploy authority | D17Factory.sol:217-225; D17LaunchFactory.sol:155-163; D17Token.sol:196-214 |
| 2 | Timing-invariant buyer outcome: owner, third-party and batch settlement give the same amounts | single `_settlePosition` + `_vaultSettlementAmounts` (D17Launch.sol:659-691, 804-815); `FINAL_CLAIM_MISMATCH` (D17Locker.sol:267) |
| 3 | `gross = wethForVault + treasuryWeth + protocolFeeWeth`; pool share ≥ 88% | D17Launch.sol:812-814; caps D17Factory.sol:247, D17FeeConfig.sol:18 |
| 4 | Creator income = `treasuryBps` share + vested allocation only (no penalties, no unsold tokens) | penalties → vault (D17Locker.sol:183); burns (D17Launch.sol:788-790); vesting (D17LiquidityVault.sol:179-186) |
| 5 | Fee immutability per launch; mainnet fee frozen for the suite | immutables + `rulesHash` (D17Launch.sol:44,53,283,294); fee config never read after creation; `MAINNET_FEE_NOT_FROZEN` (D17Factory.sol:173-179) |
| 6 | No launch while an admin key exists in the creation path | D17Factory.sol:167; D17LaunchFactory.sol:95-100 |
| 7 | No round sells below the anchor | `roundAnchorTargetWeth`/`roundSoldTokens` for r ≥ 1 (D17Launch.sol:376-399) |
| 8 | Sale-token conservation; single claim per position | claim flags (D17Launch.sol:672-673, 679-680); `_soldSaleTokenAmount` cap (:830-833) |
| 9 | Custody isolation: user WETH lives in the user's locker until refund/settlement | D17Locker.sol:158 (wrap-and-hold); no WETH inflow path in D17Launch |
| 10 | Exact pool ledger: `exactCommittedLiquidityWeth == Σ_lockers wethForVault` at all times | delta updates (D17Launch.sol:567-571, 591-596, 630); `LIQUIDITY_ACCOUNTING` at pool creation (:708) |
| 11 | Complete funding before trading: the pool opens only once every final commitment is settled; no liquidity is added afterwards | `UNSETTLED_COMMITMENTS` (D17Launch.sol:707); `claimVaultSettlement` reverts after the pool (:650); `claimLateSettlement` / `mintLateLiquidity` revert (D17Launch.sol:655-657; D17LiquidityVault.sol:172-175) |
| 12 | No hostage: absent buyers cannot block the pool; claims never expire before it | permissionless `settleAfterGrace` (D17Locker.sol:237-244) and `settleAfterGraceBatch` (D17LockerFactory.sol:42-61); no deadline on settlement |
| 13 | One-time pool creation; write-once pool records; pool takes exactly `L` tokens and `E + P` WETH | D17Launch.sol:704-705, 713-714, 734-743; D17LiquidityVault.sol:124 |
| 14 | Failed launch returns everything: principal plus recorded penalties to their payer; nothing burned | D17Launch.sol:611-642; D17Locker.sol:199-230; D17LiquidityVault.sol:189-204 |
| 15 | LP permanence | no LP-moving function; recovery excludes `officialPair` (D17LiquidityVault.sol:221) |
| 16 | Creator tokens unusable for liquidity and locked until vested | `lockedCreatorTokens()` balance check (D17LiquidityVault.sol:145-148) |
| 17 | No transfer/burn before trading open (except launch & vault→pair) | D17Token.sol:187, 231-241 |
| 18 | Incompatible-contract rejection | `EXPECTED_LAUNCH_ID` (D17Locker.sol:10); `rulesHash` domain separation |

## 9. Event catalogue (indexer/UI contract)

| Stage | Event (indexed → `idx`) | Emitter |
|---|---|---|
| Suite deploy | `OwnershipTransferred`; `OwnershipTransferStarted`; `ProtocolFeeUpdated(feeRecipient idx, bps)`; `LaunchFactoryPinned`; `LockerFactoryPinned`; `TokenCreated`; `LiquidityVaultCreated`; `LaunchDeployed(launch idx)` | factories, fee config, deployer |
| Launch creation | `LaunchCreated`; `ManualDistributionConfigured`; `LaunchMetadataPublished`; `LiquidityVaultConfigured`; `TradingGateConfigured`; `TokenMetadataConfigured`; `ContractURIUpdated`; `MintingClosed` | factory / launch / token |
| Locker setup | `LockerCreated(owner idx, locker idx)`; `LockerRegistered(owner idx, locker idx, manager idx)` | lockerFactory / factory |
| Rounds | `RoundCommitted` (launch and locker variants) | both |
| Refunds | `RoundRefunded(…, refundWeth, penaltyWeth)`; `WethWithdrawn` | launch / locker |
| Failed launch | `LaunchFailedRefunded(locker idx, refundWeth)`; `FailedPenaltyRefunded(locker idx, penaltyWeth)`; `FailedLaunchPenaltyReturned(locker idx, amount)`; `FailedLaunchRefunded(launch idx, refundWeth)` | launch / vault / locker |
| Finalization | `Finalized`; `UnsoldSaleTokensBurned(amount)`; `UnusedLpTokensBurned(amount)` | launch |
| Settlement | `VaultSettlementClaimed(locker idx, saleTokens, wethForVault, treasuryWeth, protocolFeeWeth, gross)`; `VaultSettlementCompleted(launch idx, vault idx, settler idx, owner, saleTokens, wethSentToVault, treasuryWeth, protocolFeeWeth, gross, residualWeth)`; `BatchSettlementResult(launch idx, locker idx, success)` (batch only) | launch + locker / lockerFactory |
| Pool creation | `VaultLiquidityTokensClaimed`; `LiquidityPoolCreated`; `OfficialPoolCreated` | launch / vault |
| After trading opens | `CreatorTokensReleased(recipient idx, amount)`; `ResidualTokensBurned(amount)`; `ClaimedTokensWithdrawn`; sweep/recovery events | vault / launch / locker |

V15 events kept in the ABI but never emitted by V15.1: `LateVaultSettlementClaimed`
(launch), `LateLiquidityAdded` and `FailedLaunchPenaltiesBurned` (vault). Indexers may
keep their decoders; they will see no such logs from a V15.1 suite.

Indexing rule (product-level): D17 pipelines ingest only the events above - never ERC-20
`Transfer`/`Approval` or pair `Swap`/`Sync`.

## 10. Testing

`npm run test:contracts` runs every suite below except the fuzz.

- **Local E2E** (`contracts/test/local-e2e.mjs`, fixture `test/fixtures/local-launch.json`,
  25/10/10/55 split): enforced renounce before any launch; a failed weak-anchor launch
  with a last-second 20 ETH round-0 refund (1% penalty into the vault), then the failed
  refund returning that penalty to its payer, `burnFailedLaunchPenalties` reverting and
  nothing sent to the burn address; metadata/config adversarial reverts; an 18-locker
  5-round main launch with refunds in every window (exact penalty amounts, penalties land
  in the vault, treasury untouched); exact protocol-fee and treasury-fee accounting per
  locker; finalization burns (unsold + unused LP); pool creation refused with
  `UNSETTLED_COMMITMENTS` while lockers are absent, third-party settlement of the absent
  lockers with exact amounts, then pool creation with penalties paired in and no LP
  reserve left; residual-dust burn; creator vesting at 50% and 100%; a control launch with
  an under-filled final round. **517 assertions, 0 failures.**
- **Hardening suite** (`contracts/test/hardening-e2e.mjs`): fee config cap/recipient/
  owner/two-step handover; factory caps (treasury, penalty bounds, consent bound); fee
  snapshot unchanged after a fee change; zero-fee launch; final round priced at the anchor
  with the remainder burned; effective LP and canonical opening ratio; pool refused until a
  third party settles the absent locker; after a price drop, no repeated settlement and no
  WETH or token burned; residual burn gating; forced-ETH sweep as WETH.
  **51 assertions, 0 failures.**
- **Mainnet minimums** (`contracts/test/mainnet-floors-e2e.mjs`, local simulation with
  chain id 1, Hardhat network `mainnetSim`): start 1 second short of 24 hours rejected and
  exactly 24 hours accepted; each of the five rounds, the refund window and the settlement
  window rejected at 59m59s; testnet-valid short durations rejected; launches refused while
  the fee config is not frozen; then a full launch at exactly the minimums (1-hour rounds
  and windows): no commitment during the notice, a refund in the last seconds of the
  window, finalization, settlement and pool creation one hour after finalization.
  **36 assertions, 0 failures.**
- **Fee splitter** (`contracts/test/fee-splitter-e2e.mjs`): constructor bounds and a real
  launch's 1% fee split 50/25/25, odd amounts, plain ETH and other tokens. **25 assertions,
  0 failures.**
- **V15.1 regressions** (`contracts/test/v15-1-regressions-e2e.mjs`), each reproduced on
  V15 before its fix: odd-wei commitments and a refund, every position settled (owner and
  `settleAfterGraceBatch` with junk entries), then the pool opens with exactly the reserved
  LP tokens and the exact WETH ledger; a supply of exactly `2^112 − 1` opens its pool and
  one more wei is rejected (`SUPPLY_ABOVE_V2_RESERVE`). **17 assertions, 0 failures.**
- **Failed-refund remediation** (`contracts/test/failed-refund-remediation.mjs`): a failed
  round 0 returns principal plus penalties to each payer (including lockers that had
  already taken everything back), a donation to the vault does not increase any claim, a
  control without penalties, a successful launch where penalties still reach the pool, and
  hostile-callback probes on the refund path; gas per refund recorded. **80 checks, 0
  failures.**
- **Adversarial callbacks** (`contracts/test/adversarial-callbacks.mjs`, hostile WETH
  fixture `test/CallbackWETH.sol`): reentry into the locker during deposit and settlement
  transfers, cross-function reentry, the splitter's `distribute` and `distributeEth`; all
  denied by the guards, with exact accounting after each attempt; pool creation with an
  unsynced and a synced WETH donation to a real pair. **32 checks, 0 failures.**
- **Minimum liquidity** (`contracts/test/minimum-liquidity.mjs`): the smallest LP
  allocation (1 token) with the smallest round-0 share and commitment opens a real
  Uniswap V2 pool; one wei less is rejected (`LP_TOO_LOW`). **4 checks, 0 failures.**
- **Rounding reference model** (`contracts/test/rounding-reference-model.mjs`): a
  wei-exact BigInt model (no EVM) of random commitments, refunds and failed-launch refunds,
  checking that the incrementally maintained ledger always equals every locker's pool
  share recomputed from scratch (200 campaigns × 100 lockers, 24,620 operations, 84,000
  checks; the V15 aggregate formula differs from the exact ledger at 29,220 of the 32,000
  steps).
- The four V15.1 review suites use the real Uniswap V2 bytecode from `@uniswap/v2-core`
  (`test/release-fixture.mjs`); the older suites use the mock router/pair in
  `contracts/test/`.
- **Stateful fuzz** (`contracts/test/fuzz-invariants.mjs`, `npm run test:fuzz -w
  @d17/contracts`, `FUZZ_SEED` / `FUZZ_CAMPAIGNS`): each campaign draws a random launch
  configuration within the factory bounds and plays a random lifecycle (mixed, dust and
  whale commits; refunds in every window; failed launches with full refunds; explicit or
  lazy finalization; owner and third-party settlements; pool creation refused while any
  position is unsettled; WETH donations and post-open price moves; residual burn; creator
  vesting). After every action it checks WETH conservation per position and through the
  vault, the launch token ledger, exact fees and penalties, the return of every
  failed-launch penalty, the anchor floor (to 1 WAD unit), no post-open liquidity loss and
  vesting bounds; any revert of a valid action is a liveness failure, and adversarial calls
  are probed for their expected reverts. V15.1 campaigns pass; the last full V15 run was
  4 seeds × 8 campaigns, 82,030 invariant checks, 381 adversarial probes, 0 failures. Not
  part of `npm test` (≈15 min per 8 campaigns).
- **Deployment dry run** on a local node: `deploy:factory` → `verify:factory` →
  `create:launch`. The terminal's creator-vesting release button was exercised in a
  browser against a local node with Sepolia's chain id.
- Run everything with `npm ci && npm test`.
- **Coverage gaps worth noting**: the fuzz suite is seeded and not run in CI; no
  mainnet-fork tests (the mainnet minimums run on a local chain-id-1 simulation, with mock
  WETH and router); the V15.1 Sepolia suite (2026-11-10) has no complete
  success and failure launch evidence yet.

## 11. Known limitations & review status

1. **Not independently audited.** Slither 0.11.6 reports only benign findings (reentrancy
   into own token/WETH/pair behind `nonReentrant`, intended timestamp comparisons, the
   intended pre-seed strict equality, default-zero locals, a missing zero check on the
   fee config's two-step handover where zero cancels a pending transfer).
2. **Code-size ceiling**: D17LaunchDeployer is 22,910/24,576 bytes; any growth of
   `D17Launch` consumes that margin. Check sizes after every source change.
3. **AMM assumption**: honest Uniswap-V2 semantics. The pool receives one balanced
   deposit before any trading, and no liquidity is added afterwards, so there is no late
   deposit to sandwich.
4. **WETH assumption**: canonical WETH9 - no fee-on-transfer, no hooks.
5. **`unchecked` blocks**: only in D17Token (:174-177, :189-192, :224-227), each guarded.
6. **Config economics**: the factory validates hard caps (treasury ≤ 10%, protocol fee
   ≤ 2%, rounds 3–4 penalty 1–25%, supply ≤ `2^112 − 1`), not whether a launch is
   attractive. The contract accepts any LP allocation from 1 token, so a creator can set
   an opening price far above the average price paid.
7. **Settlement gas before trading**: every buyer must be settled before the pool can
   open. Someone (usually the creator) pays the gas to settle absent buyers, up to 4 per
   `settleAfterGraceBatch`; each position needs at least the launch's minimum commitment,
   which bounds the count.
8. **Donation edge cases**: post-open D17-token donations to the vault are stuck; WETH
   donated to the vault of a failed launch is stuck; the creator allocation of a failed
   launch is locked forever.
9. **`createLaunch` gas**: deploys three contracts in one transaction (~13–15M gas).
10. **No admin recovery**: launches are immutable once created; the only remedy for a bad
    suite is a new suite. A fee config owner (test networks only) can only change future
    fees.
11. **Block timestamps**: windows use `block.timestamp`; mainnet floors keep every window
    ≥ 1 hour so a few seconds of validator drift are immaterial.

---

**Reference source:** `contracts/contracts/` and `contracts/SHA256SUMS.txt`.
