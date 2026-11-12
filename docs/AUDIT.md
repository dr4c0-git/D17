# Audit package - D17 V15.1

Everything a reviewer needs to audit the D17 V15.1 contracts: what is in scope, how to
build and test it, how the system is meant to work, what is deliberate, what is already
known, and where we would most like a second pair of eyes.

Status: V15.1 was reviewed by the project lead's Solidity reviewer (no blocking issue)
and deployed on Ethereum mainnet on 2026-11-12 (factory `0xB46eb48f982b63B879E00592880D12d1741fDB02`, 2% fee). A formal
professional audit is still welcome; findings go into V16.

## 1. Scope

The production source is `contracts/contracts/` (12 contracts, 2 interface files and one
library). Its exact bytes are fixed by `contracts/SHA256SUMS.txt`; please quote the commit
you reviewed in the report.

| File | nSLOC | Role |
|---|---:|---|
| `D17Launch.sol` | 708 | The sale engine: rounds, refunds, finalization, settlement accounting, pool funding |
| `D17Factory.sol` | 299 | Registry and validation of every launch configuration; mainnet guards |
| `D17Locker.sol` | 284 | Per-participant escrow: WETH in, refunds, settlement, withdrawals |
| `D17Token.sol` | 250 | The launch token (ERC-20), transfer gate until trading opens |
| `D17LiquidityVault.sol` | 198 | Creates the official Uniswap V2 pair, holds the LP forever, creator vesting |
| `D17LaunchFactory.sol` | 155 | Deploys token, launch and vault for one launch |
| `interfaces/ID17.sol` | 113 | Shared interfaces |
| `D17FeeSplitter.sol` | 68 | Ownerless fee recipient with fixed shares |
| `D17FeeConfig.sol` | 50 | Protocol fee rate and recipient for future launches (renounced at deployment) |
| `D17LockerFactory.sol` | 46 | Creates lockers; batch settlement of absent lockers |
| `D17LaunchDeployer.sol` | 43 | Deploys `D17Launch` (keeps `D17LaunchFactory` under the size limit) |
| `D17TokenFactory.sol` | 41 | Deploys `D17Token` |
| `D17LiquidityVaultFactory.sol` | 41 | Deploys `D17LiquidityVault` |
| `interfaces/ID17LaunchFactory.sol` | 40 | Launch factory interface |
| `lib/D17SafeTransfer.sol` | 23 | Safe ERC-20 transfers |
| **Total** | **about 2,360** | |

**Out of scope:** the test contracts in `contracts/contracts/test/`, the deployment and
tooling scripts in `contracts/scripts/`, the web app (`apps/web`) and the API (`apps/api`).
External dependencies are assumed honest: canonical WETH9 and the Uniswap V2 factory,
router and pair.

**Compiler:** solc 0.8.24, `viaIR: true`, optimizer enabled with `runs: 1`, EVM version
`shanghai`, `bytecodeHash: "none"` (`contracts/hardhat.config.js`). The exact standard
JSON input used for the release is `release/solc-input.json`.

## 2. Build and test

Requirements: Node 22.13+ or 24+, npm. From the repository root:

```bash
npm ci
npm run compile -w @d17/contracts
npm run test:contracts                       # every contract suite below, a few minutes
npm run test:fuzz -w @d17/contracts          # stateful fuzz, about 15 minutes per 8 campaigns
```

| Suite (`contracts/test/`) | What it covers |
|---|---|
| `local-e2e.mjs` | Full lifecycle: wiring, configuration bounds, five rounds, refunds, failed launches, finalization, settlement (owner, third party), pool creation, token conservation, adversarial reverts |
| `hardening-e2e.mjs` | The V15 hardening rules: anchor griefing, the final-round floor, the effective LP allocation, the complete-funding gate |
| `mainnet-floors-e2e.mjs` | Chain id 1 rules: 24 h notice, 1 h windows, frozen fee config required |
| `fee-splitter-e2e.mjs` | Splitter constructor rules and exact distribution |
| `v15-1-regressions-e2e.mjs` | The three V15.1 fixes, the all-settled gate, batch settlement, its gas margin and the per-transaction gas cap |
| `failed-refund-remediation.mjs` | Cancelled launches: principal and take-back penalties returned exactly once |
| `adversarial-callbacks.mjs` | Hostile WETH callbacks and reentrancy around deposits and refunds |
| `minimum-liquidity.mjs` | Smallest pools against the real Uniswap V2 pair |
| `rounding-reference-model.mjs` | Mathematical reference model of the per-locker rounding |
| `fuzz-invariants.mjs` | Seeded stateful fuzzing with invariant checks and adversarial probes |

Several suites run against the real Uniswap V2 bytecode (`@uniswap/v2-core`). In a
sandbox without access to `binaries.soliditylang.org`, see "Cloud sandbox" in
`docs/MAINTAINERS.md` for installing the compiler by hand.

## 3. How the system works

The complete reference, with a citation for every rule, is
[CONTRACTS_TECHNICAL.md](./CONTRACTS_TECHNICAL.md); the plain-language version is
[CONTRACTS.md](./CONTRACTS.md); the changes from the upstream V14 code are in
[V15_HARDENING.md](./V15_HARDENING.md). In short:

1. **Creation.** A creator calls `D17Factory.createLaunch(config)`. The factory validates
   the configuration, snapshots the protocol fee, and has the launch factory deploy the
   token, the launch and the liquidity vault in one transaction. The whole supply is
   minted once; the rules are fixed in immutables and a `rulesHash`.
2. **Sale.** Five rounds. Participants commit ETH through their own `D17Locker`, which
   wraps it to WETH and keeps it. Round 1 sets the anchor price and must meet a minimum
   raise and a minimum price, otherwise the launch is cancelled. No later round sells below
   the anchor; unsold tokens are burned.
3. **Take-backs.** After rounds 1 to 4 a window lets participants take their commitment
   back for a fee (1% after rounds 1-2, the launch's 1-25% after rounds 3-4), paid into the
   vault for the pool. If the launch is cancelled, everything is returned, fees included.
4. **Finalization and settlement.** Anyone finalizes after round 5. Each locker settles:
   sale tokens to the locker, the pool share of its WETH to the vault, the creator's
   treasury share and the protocol fee to their recipients. After the claim window anyone
   can settle an absent locker (`settleAfterGrace`, or `settleAfterGraceBatch` for up to 4).
5. **Pool.** Once every final commitment is settled, anyone creates the official Uniswap
   V2 pair from the vault: all settled WETH plus all take-back fees against the effective
   LP allocation. The LP tokens stay in the vault forever. Token transfers open with the
   pool. The creator's token allocation vests over 180 days.

**Roles and trust.**

| Role | Powers |
|---|---|
| Creator | Chooses the configuration within the factory's bounds; receives the treasury share (at most 10%) and the vested allocation (at most 10% of supply). No function after creation. |
| Participant (locker owner) | Commits, takes back, settles, withdraws; only for their own locker. |
| Anyone | Finalizes, settles absent lockers after the claim window, creates the pool, releases vested creator tokens, burns residual dust, distributes the fee splitter. Gains nothing from it. |
| Fee config owner | Renounced as the last deployment transaction; on chain id 1 the factory refuses to create launches until it is. |
| Deployment keys | Own the factories only until they are pinned and renounced; the factory refuses every launch while any owner key exists. |

## 4. Intended behaviour (please do not report as a bug unless it can be exploited)

- **Permanently locked liquidity.** There is no way to withdraw the vault's LP tokens.
  Once holders have sold, a large share of the pool's WETH stays in the pair forever
  (about half of the pool's WETH if the pool holds as many tokens as the sale sold). This
  is the main topic of the next version (V16); ideas are welcome.
- **The creator chooses the LP allocation**, from 1 token up. A very small one opens the
  pool far above the average price paid. The web app flags such launches as predatory;
  a contract rule is planned for V16.
- **Round 5 is anchored** like rounds 2-4: it never sells below the round-1 price, and
  what it cannot sell is burned.
- **The pool waits for every buyer.** Pool creation reverts while a final commitment is
  unsettled; whoever opens trading pays the gas to settle absent buyers.
- **Fees.** Protocol fee at most 2% (2% on mainnet, 1% on the Sepolia test suite), charged only on
  settlement of a successful commitment, frozen per launch. Each fee is rounded down per
  locker; the pool receives the remainder.
- **Late-settlement entry points** (`D17Launch.claimLateSettlement`,
  `D17LiquidityVault.mintLateLiquidity`) and `burnFailedLaunchPenalties` remain in the ABI
  for compatibility and always revert.
- **Contract identities** end in `V15_1` (`D17_LAUNCH_V15_1`, ...), distinct from V15's
  `V15_HARDENED`. Each suite only accepts lockers and launches it registered itself.

## 5. Known limitations

- Block timestamps bound every window; mainnet requires every window to last at least 1 h.
- A creator can take part through other wallets on the same terms as everyone else.
- Donations: D17 tokens sent to the vault after the pool opens, or WETH sent to the vault
  of a cancelled launch, are stuck. The creator allocation of a cancelled launch is
  locked forever.
- `createLaunch` deploys three contracts in one transaction. With the largest metadata the
  contract accepts (an 8 KB logo) it needs more than the 16,777,216 gas cap per
  transaction (EIP-7825); the web app limits the logo to 4 KB.
- `D17LaunchDeployer` is 22,910 bytes of the 24,576-byte limit: any growth of
  `D17Launch` consumes that margin.
- Static analysis: Slither 0.11.6 reports only benign findings (listed in
  `CONTRACTS_TECHNICAL.md` section 11).
- No professional audit before this one.

## 6. Already found and fixed

| When | Issue | Fix |
|---|---|---|
| V15 | Factory at the contract size limit | `D17LaunchDeployer` |
| V15 | Free last-second refunds could grief the anchor | 1% fee on every round 1-2 take-back |
| V15 | Final round sold off at any price | Anchor floor on round 5, unsold burned |
| V15 | Last late settler blocked by rounding (`LP_RESERVE_EXCEEDED`) | Cap on late LP releases (late settlement removed in V15.1) |
| V15.1 | Pool creation reverted forever when every locker settled first: per-locker fee rounding put the settled WETH above the aggregate formula, so the pool asked for more LP tokens than reserved; anyone could trigger it with odd wei amounts | Exact per-locker ledger `exactCommittedLiquidityWeth` |
| V15.1 | Supplies above Uniswap V2's `uint112` reserve accepted | `MAX_TOKEN_SUPPLY`, `SUPPLY_ABOVE_V2_RESERVE` |
| V15.1 | Late settlement added liquidity at a moved price and burned the unmatched part | Pool only once every commitment is settled |
| V15.1 | Take-back fees of a cancelled launch were burned | Returned to their payers |
| V15.1 (Sepolia test) | Batch settlement forwarded 1M gas per locker; a settlement costs about 1M on Sepolia, so the batch skipped every buyer | 3M per locker, at most 4 per batch (12.2M, under the EIP-7825 cap) |

## 7. Where we would most like your attention

1. **Accounting exactness.** `exactCommittedLiquidityWeth` against every path that changes
   a position (commit, round refund, failed refund, settlement), and the equality checked
   at pool creation (`LIQUIDITY_ACCOUNTING`). Any rounding path that could make the pool
   creation revert again, or leave WETH or tokens behind.
2. **Liveness.** Any way to make a successful launch impossible to open (a position that
   can never settle, a locker that blocks the batch, gas griefing with many small
   positions), or a cancelled launch impossible to refund.
3. **Failed-launch refunds.** Principal and penalties returned exactly once, including
   partial withdrawals before the failure; no way to claim another locker's penalty.
4. **Reentrancy and ordering** across the locker, the launch, the vault, WETH and the token
   (the token transfer gate and the vault-to-pair exception).
5. **Pool creation.** Pre-seeding or donating to the pair before it is created, the
   vault's checks on reserves, and the `minLpMinted` and deadline arguments.
6. **Deployment and identity.** The pin and renounce flow, the mainnet guards in
   `D17Factory`, and the identity checks between lockers, launches and factories.
7. **Fee splitter.** Rounding, any token or ETH left behind, and behaviour with
   non-standard tokens sent to it.

## 8. Public test deployment

The exact source of this package (with a 1% fee, a 75 / 25 fee split,
fee config renounced; mainnet will use 2%, the only difference) is deployed on **Sepolia**, start block 12112991, with every contract
verified on Etherscan. Addresses and transactions: `release/deployments/sepolia.json`.

| Contract | Address |
|---|---|
| D17Factory | `0x260cbEA5Af1669446353d2B80D75a145016C1228` |
| D17FeeConfig | `0xcB917eaAd0DaDB3E483212e4a9452dD1b73d270c` |
| D17FeeSplitter | `0x6E6F46d2DdA1E0c70A467148bB43B7b76e59FeF7` |
| D17LaunchFactory | `0xd1730399468d40ef9Dff8f91653D4f83E889Ef4E` |
| D17LaunchDeployer | `0xB4bcE65b6C5ecFd0ADeB7DaE32a2B9036B96d556` |
| D17TokenFactory | `0x778e49CB1e24fE4ae31111Ba4283cd5061B57b6f` |
| D17LiquidityVaultFactory | `0x9C663fCE0049423b9c53f55993E41b7b41D2CcE1` |
| D17LockerFactory | `0x613F3B7406Eb59385502b123026229B57c2E9D75` |

This suite (2026-11-11) differs from the previous Sepolia suite only by its identity
constants (`*_V15_1`). The test launches ran on that previous suite: a successful launch
with one buyer left absent and settled by a third party through the batch (the pool then
opened and the 1% fee was split 75 / 25 to the wei), two launches cancelled by their
round-1 floors, and, one suite earlier, a cancelled launch that returned a take-back fee
in full. A cancelled launch
with a take-back fee returned in full ran on the previous V15.1 suite.

## 9. Reviews of later versions

Every contract change makes a new version with new identity constants, and each version
gets its own review before mainnet: V16 (planned changes to the pool liquidity, see
`docs/V16_POOL_LIQUIDITY.md`) will need one too. A review of a later version can focus on
the diff from the last reviewed commit, plus the invariants it touches.

## 10. Reporting

Please share findings privately with the maintainers before any publication (see
`SECURITY.md`), with the affected contract, the invariant, the call sequence and a minimal
reproduction where possible.
