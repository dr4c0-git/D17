# Maintainer notes

Fork of `0xlocker/D17` (MIT license), turned into a proprietary "D17 V15" launchpad
with a protocol fee. Repository: `dr4c0-git/D17`. Default branch:
`main` (V15 merged from `v15-hardening`). Upstream docs: https://d17docs.vercel.app/docs
(unreachable from the cloud sandbox; local copies in `docs/`).

## Standing constraints (set by the owner)

- **License**: never modify the `Copyright (c) 2026 D17 contributors` line in `LICENSE`
  or the `SPDX-License-Identifier: MIT` headers. Lines may be *added*.
- **Sepolia before mainnet**: every contract change goes through
  `npm run test:contracts`, then a deployment and a full launch on Sepolia.
- **Never a private key in the repository**: keys live only in `contracts/.env`
  (git-ignored). `*.example` files stay empty. `check:release` rejects key assignments.
- **Product goal**: zero possible scam, everything public, a launch mechanism that
  cannot be circumvented. Guarantees: no discretionary creator access to funds, LP
  locked forever, immutable rules per launch (`rulesHash`), no admin key in the
  creation path.
- **Commit authorship**: every commit is authored and committed as `dr4c0` with the
  GitHub noreply address of `dr4c0-git` (user id 254115178), set via `git config`
  (the address itself is not written here: `check:release` rejects email addresses).
  No AI-assistant attribution (co-author trailers, session links, signatures) in
  commits, PRs or GitHub comments.

## Status (2026-10-06)

- Step 1 (analysis) done. Step 2 (fee + fix for every risk) done and pushed: commits
  `f3442cb` (deployer), `fd9e635` (contracts), `4a3d92e` (tooling), `b8ecb7e` (apps),
  then docs/release, creator-vesting UI (`f5aee23`), V15 docs rewrite (`f944f69`).
- **V15 is not deployed anywhere.** Manifests `deployments/*.json` (4 copies +
  `release/deployments/`) say `"status": "not-deployed"` with zero addresses. The
  upstream V14 addresses are incompatible (different ABIs/IDs).
- Next step on the owner's side: deploy to Sepolia (see "Deployment").

## Commands

```bash
npm ci                                     # Node 22.13+ or 24+
npm test                                   # typecheck + api + contracts + web tests
npm run test:contracts                     # E2E suites (~2 min): 567 + 52 assertions
npm run test:fuzz -w @d17/contracts        # stateful fuzz, ~15 min per 8 campaigns (FUZZ_SEED, FUZZ_CAMPAIGNS)
npm run build                              # Next.js (apps/web)
npm run build:abi -w @d17/contracts        # ABIs + docs/contract-explorer.html
npm run release:protocol && npm run release:checksums && npm run check:release
```

After any contract change: `npx hardhat clean && npx hardhat compile` (a single
build-info, otherwise `release:protocol` may read a stale build), `build:abi`, copy
`contracts/abi/*.abi.json` to `apps/web/public/abi/` and `apps/api/abi/`,
`release:protocol`, regenerate `contracts/SHA256SUMS.txt`
(`cd contracts && sha256sum contracts/D17*.sol contracts/interfaces/*.sol contracts/lib/*.sol > SHA256SUMS.txt`),
then `release:checksums` **last** (the manifest covers every file in the repository,
including this file) and `check:release`. CI runs `git diff --exit-code` on
`contracts/abi`, `release/protocol-build.json`, `release/solc-input.json`.

Compiler: solc 0.8.24, viaIR, optimizer runs=1, evm shanghai, bytecodeHash none.

### Cloud sandbox: solc download blocked
The proxy refuses `binaries.soliditylang.org`. Workaround (outside the repo): native
binary from the GitHub releases + `soljson.js` from the npm package `solc@0.8.24`, placed
in `~/.cache/hardhat-nodejs/compilers-v3/{linux-amd64,wasm}/` with a minimal `list.json`
(`path`, `version`, `longVersion`, `sha256`). Hardhat requires both platforms.
For a background local node, never run `pkill -f "hardhat node"` in the same shell
command (it kills the shell itself); run the node as a separate background task.

## V15 architecture (11 contracts, `contracts/contracts/`)

| Contract | Role |
|---|---|
| `D17Factory` | Registry, config validation, fee snapshot (`feeConfig` immutable), `isLocker`. Refuses `createLaunch` while `owner != 0`. Mainnet floors (chainid 1): start ≥ 24 h ahead, windows ≥ 1 h. |
| `D17FeeConfig` | **Only remaining owner** (multisig). `protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS = 200`, recipient; two-step ownership; renounceable. Affects future launches only. |
| `D17LaunchFactory` | Creates token + launch (via deployer) + vault; refuses if the token/vault factory or deployer still has an owner; mints the `manual` allocation **into the vault**. |
| `D17LaunchDeployer` | `create`s `D17Launch` from pre-encoded params (EIP-170 headroom). Pinned, then renounced. |
| `D17TokenFactory`, `D17LiquidityVaultFactory`, `D17LockerFactory` | Unchanged apart from IDs. |
| `D17Token` | Unchanged apart from ID (transfer gate before the pool exists). |
| `D17Launch` | `LaunchParams` struct. Protocol fee frozen (immutables + `rulesHash`), penalties to the pool, anchor floor on the final round, `effectiveLpTokens`, burn of unsold + unused LP, late LP reserve cap, `burnResidualTokens`, ETH→WETH sweep. |
| `D17Locker` | Penalty → vault; pays `protocolFeeWeth`; `protocolFeeWeth` field inserted in `LockerPosition` (decode by **name**, not by index). |
| `D17LiquidityVault` | Initial pool = settled WETH + penalties; late liquidity at the live ratio (remainder burned, zero-LP → burned); 180-day creator vesting (`releaseCreatorTokens`, callable by anyone); `burnFailedLaunchPenalties`; ETH→WETH sweep. |

IDs: `*_V15_HARDENED` everywhere (contracts, `scripts/lib.mjs`, apps, release).
Sizes: `D17LaunchDeployer` 22,759 bytes (1.8 KB headroom: any growth of `D17Launch`
consumes it), `D17Launch` 17,557 bytes, `D17LaunchFactory` 5,129 bytes.

## Fee decision (approved by the owner as "the most honest")

A **separate, visible** fee (option B), not hidden inside the treasury share:
`gross = pool + treasury (≤10%) + protocol (≤2%)`, pool ≥ 88%. Charged **only on
successful settlement**; never on refunds, penalties or failed launches. Frozen per
launch in `rulesHash`; the creator consents through `maxProtocolFeeBps` (`/deploy`
sends exactly the displayed rate). Recipient and rate can be changed by the multisig for
future launches only.

## Status of the risks from the analysis

| # | Risk | Status |
|---|---|---|
| 1 | Creator receives funds through the treasury | Mitigated: treasury ≤10%, penalties → pool, unsold burned, creator allocation vested over 180 days. Remaining: the published treasury share. |
| 2 | Anchor griefing (free refund) | Fixed: fixed 1% penalty in rounds 1-2 → pool (burned on failure). Tested. |
| 3 | Final round sold off cheaply | Fixed: anchor price floor, remainder burned; LP proportional to sales. |
| 4 | Code-size headroom | Fixed: `D17LaunchDeployer`. |
| 5 | No audit | **Cannot be fixed here.** Slither 0.11.6: no exploitable finding. External audit required before mainnet. |
| 6 | Late liquidity / MEV | Fixed: live ratio, remainder burned. Residual: IL of a sandwiched liquidity add. |
| 7 | Test coverage | Improved: `test/hardening-e2e.mjs` + shared helpers + stateful fuzz `test/fuzz-invariants.mjs` (4 seeds × 8 campaigns, 82,030 invariant checks, 381 adversarial probes, 0 failures). Fuzz is not in `npm test`/CI (runtime). |
| 8 | Deployment trust | Fixed: launches refused while an owner key exists; deploy script enforces renounce; `verify:factory` checks it. |
| 9 | Rounding dust | Fixed: `burnResidualTokens()`; plus a real bug fixed (last late settler blocked by `LP_RESERVE_EXCEEDED`). |
| 10 | WETH pre-seeded into the pair | Analysed: not exploitable, kept (documented). |
| 11 | Sweep blocked by the treasury | Fixed: ETH→WETH wrap. |
| 12 | Timestamps / stealth launches | Mainnet floors (24 h notice, windows ≥ 1 h). Not tested locally (chainid 1). |
| 13 | Front-end | Checks feeConfig + wiring; "not deployed" banner; decoding by name; "Creator vesting" panel + release button in the Trading stage (tested in a browser against a local node). |

Other bugs fixed: deploy script nonce (`NonceManager` per key).

## Deployment (owner's job, keys kept out of the repo)

1. `cp contracts/.env.example contracts/.env`; fill `RPC_URL` (Sepolia),
   `D17_FACTORY_PRIVATE_KEY`, `D17_LOCKER_FACTORY_PRIVATE_KEY` (a different key),
   `FEE_CONFIG_OWNER` (Safe), `PROTOCOL_FEE_RECIPIENT`, `PROTOCOL_FEE_BPS`,
   `RENOUNCE_D17_FACTORY_OWNER=1`.
2. `npm run compile -w @d17/contracts && npm run deploy:factory -w @d17/contracts`
3. `npm run verify:factory -w @d17/contracts` (every check must pass)
4. `npm run publish:deployment -w @d17/contracts` (writes manifests + provenance)
5. Full test launch (`create:launch` + terminal), then regenerate checksums/release and
   commit.
6. Mainnet only after an audit; `D17_CONFIRM_MAINNET_DEPLOY=1` + a contract fee owner.

Validated local dry run: deploy → verify (40/40) → create-launch (1% fee frozen).

Local UI test (without touching the repo): temporary Hardhat config with
`networks.hardhat.chainId = 11155111` started via
`npx hardhat --config <tmp> --network hardhat node` (without `--network hardhat` the
chain id stays 31337), `apps/web/deployments/sepolia.json` + `.env.local` pointed at the
node, Playwright (scratchpad) with an injected `window.ethereum` relaying to the node and
`page.clock` set to the chain time. Afterwards restore the manifest, delete `.env.local`
and `git checkout apps/web/next-env.d.ts` (rewritten by `next dev`).

## Documentation (keep in sync with the code)

- `docs/V15_HARDENING.md`: public disclosure of the V15 changes and the fee.
- `docs/CONTRACTS_TECHNICAL.md`: V15 reference with `File.sol:line` citations —
  **any contract change shifts lines: re-check the citations.**
- `contracts/docs/ABI_TRACEABILITY.md`: 364 classified entries (consumer, indexed or
  not). After an ABI change, keep the existing V15 classification and classify new
  entries by hand (there is no generator in the repo).
- `docs/blog/`: 9 V15 essays (post 09 explains the protocol fee).
- Opening price: it follows the average price paid and equals it (net of fees) only when
  `lpTokens == saleTokens`; never write that it is always equal.

## Still to do

- Mainnet-floor test (node with chainId 1).
- External audit.
- Optional: add a fork copyright line to `LICENSE` (without removing the existing one).
