# Maintainer notes

Fork of `0xlocker/D17` (MIT license), turned into the "D17 V15" protocol
with a protocol fee. Repository: `dr4c0-git/D17`. Work directly on
`main` (owner's choice): no side branches. Upstream docs: https://d17docs.vercel.app/docs
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
- **No em dash for the owner**: in everything written for the owner (documents, notes,
  messages, drafts to send), never use the em dash (U+2014); use a plain hyphen "-" instead.

## Sepolia deployment progress (2026-10-20)

Owner works on a Mac (Terminal, project clone in a `D17/D17` folder), browser profile
"D17 Test" with a separate MetaMask wallet (new secret phrase, never real funds): Test 1
Deploy (factory key, fee config owner), Test 2 Lockers (locker factory key), Test 3
Creator, Test 4 and 5 Buyers.
- Done: suite deployed and verified (45/45), manifests published and committed. Fee
  split on Sepolia: Test 2, Test 3, Test 4, Test 5 at 5000/1250/1250/2500 bps (the
  mainnet layout: D17 buybacks, 2027 buybacks, XBT buybacks, development fund).
- Done (2026-10-21): first full test launch STEST, launch
  `0x3cACdD55749BA777bd0806156F4596746B6df4b6` (token `0xfb87...74BD`): 0.25 ETH in round 1
  (Test 1 0.15, Test 5 0.1), closed, collected (Test 1 late, after trading opened),
  official pool created, tokens sent to wallets; protocol fee 0.0025 WETH split twice by
  `distribute:fees`, exactly 50/12.5/12.5/25 to Test 2..5.
- Lessons: free Alchemy caps `eth_getLogs` at 10 blocks and throttles bursts (429 without
  CORS headers, seen as opaque network errors). The web app now shrinks log ranges,
  retries rate-limited reads and queues RPC calls (`apps/web/lib/readProvider.ts`), but the
  UI needs an RPC that keeps the full log history and accepts wide ranges: Tenderly's
  public gateway (`https://sepolia.gateway.tenderly.co`) does. PublicNode and 1rpc prune
  old logs ("pruned history unavailable"), so a fresh visitor saw an empty launch list
  two days after the deployment; dRPC free accepts ranges up to 10,000 blocks. Alchemy
  stays fine for the deploy scripts. Don't confuse a launch with its token: the token
  page is what MetaMask/Etherscan show; `inspect:launch` resolves either.
- Tools for the owner: `check:env`, `inspect:launch -- <launch|token> [wallet]`,
  `distribute:fees`.
- Done (2026-10-22): web app online on Vercel (Hobby plan, project imported from this
  repo, root directory `apps/web`, Tenderly gateway RPCs in the `NEXT_PUBLIC_*` variables,
  no key; PublicNode was replaced because it prunes old logs). Every push to `main` redeploys it. The link was sent to the project lead only and
  is kept out of the repo until the launch is announced.
- Next: add the project lead on GitHub (waiting for the username), then the external audit.
- Etherscan: the 8 suite contracts are verified on Sepolia (2026-10-26, `verify:etherscan`,
  needs `ETHERSCAN_API_KEY` in `contracts/.env`; `-- --dry-run` checks without sending).
  Redo it on mainnet with `-- --network mainnet` right after the mainnet deployment.
- Site content: `/docs`, `/blog` and `/progress` render `docs/` and `CHANGELOG.md` from
  `apps/web/content/site-content.json`. After editing any of them, run
  `npm run content:sync` before `release:checksums` (`check:release` fails otherwise).
- Mainnet split confirmed by the project lead (2026-10-21): D17 buybacks 50%, 2027
  buybacks 12.5%, XBT buybacks 12.5%, development fund 25%, i.e. `FEE_SPLIT_BPS=
  5000,1250,1250,2500` with `FEE_SPLIT_RECIPIENTS` in that exact order. The four
  addresses were provided by the project lead and are kept off the repo until the
  mainnet deployment (the owner has them). The project lead is creating a dedicated
  GitHub account to be added as a collaborator. Never ask for a key or the content of a `.env`.

## Status (2026-10-06)

- Step 1 (analysis) done. Step 2 (fee + fix for every risk) done and pushed: commits
  `f3442cb` (deployer), `fd9e635` (contracts), `4a3d92e` (tooling), `b8ecb7e` (apps),
  then docs/release, creator-vesting UI (`f5aee23`), V15 docs rewrite (`f944f69`).
- **V15 is deployed on Sepolia** (2026-10-20, start block 11958083, factory
  `0xF02Ab7326c4212693a7a53Aa7BBa635213749C07`, fee splitter
  `0x6ad3FAF084f554aAd54A47134bf168c4FAe9Ab23` paying Test 2 to Test 5 50/12.5/12.5/25,
  verify 45/45). Provenance in `release/deployments/sepolia.json`. **Not on mainnet**:
  `deployments/mainnet.json` still says `"not-deployed"`. The upstream V14 addresses are
  incompatible (different ABIs/IDs).

## Commands

```bash
npm ci                                     # Node 22.13+ or 24+
npm test                                   # typecheck + api + contracts + web tests
npm run test:contracts                     # E2E suites (~2 min): 567 + 52 + 33 assertions
npm run test:fuzz -w @d17/contracts        # stateful fuzz, ~15 min per 8 campaigns (FUZZ_SEED, FUZZ_CAMPAIGNS)
npm run build                              # Next.js (apps/web)
npm run demo:local                         # local chain + V15 suite + bot launches + web app (free test ETH)
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

## V15 architecture (12 contracts, `contracts/contracts/`)

| Contract | Role |
|---|---|
| `D17Factory` | Registry, config validation, fee snapshot (`feeConfig` immutable), `isLocker`. Refuses `createLaunch` while `owner != 0`. Mainnet floors (chainid 1): start ≥ 24 h ahead, windows ≥ 1 h. |
| `D17FeeConfig` | **Only remaining owner** (multisig). `protocolFeeBps ≤ MAX_PROTOCOL_FEE_BPS = 200`, recipient; two-step ownership; renounceable. Affects future launches only. |
| `D17FeeSplitter` | Optional fee recipient, no owner: fixed recipients and shares (sum 10 000 bps), permissionless `distribute(token)` / `distributeEth()`. Deployed by `deploy:factory` when `FEE_SPLIT_RECIPIENTS` / `FEE_SPLIT_BPS` are set (then leave `PROTOCOL_FEE_RECIPIENT` empty); checked by `verify:factory`. |
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
| 12 | Timestamps / stealth launches | Mainnet floors (24 h notice, windows ≥ 1 h). Tested by `test/mainnet-floors-e2e.mjs` on the `mainnetSim` network (local EDR, chain id 1): exact boundaries plus a full launch at the minimum durations (33 assertions). |
| 13 | Front-end | Checks feeConfig + wiring; "not deployed" banner; decoding by name; "Creator vesting" panel + release button in the Trading stage (tested in a browser against a local node). |

Other bugs fixed: deploy script nonce (`NonceManager` per key).

## Deployment (owner's job, keys kept out of the repo)

1. `cp contracts/.env.example contracts/.env`; fill `RPC_URL` (Sepolia),
   `D17_FACTORY_PRIVATE_KEY`, `D17_LOCKER_FACTORY_PRIVATE_KEY` (a different key),
   `FEE_CONFIG_OWNER` (Safe), `PROTOCOL_FEE_RECIPIENT`, `PROTOCOL_FEE_BPS`,
   `RENOUNCE_D17_FACTORY_OWNER=1`. Optional fee split: `FEE_SPLIT_RECIPIENTS` (comma-separated)
   and `FEE_SPLIT_BPS` (adding up to 10000), with `PROTOCOL_FEE_RECIPIENT` left empty.
2. `npm run check:env -w @d17/contracts` (checks `.env` without printing any key: network,
   addresses and balances behind the keys, fee settings, fee split), then
   `npm run compile -w @d17/contracts && npm run deploy:factory -w @d17/contracts`
3. `npm run verify:factory -w @d17/contracts` (every check must pass)
4. `npm run publish:deployment -w @d17/contracts` (writes manifests + provenance)
5. Full test launch (`create:launch` + terminal), then regenerate checksums/release and
   commit.
6. Mainnet only after an audit; `D17_CONFIRM_MAINNET_DEPLOY=1` + a contract fee owner.

Validated local dry run: deploy → verify (40/40) → create-launch (1% fee frozen).

Local UI test: `npm run demo:local` (`contracts/scripts/local-demo.mjs`). The web app has
a third network, `local` (chain id 31337), that only exists when
`NEXT_PUBLIC_D17_ENABLE_LOCAL=true`; the script writes that and the suite addresses into
`apps/web/.env.local` and removes it (and restores `next-env.d.ts`) on Ctrl+C. The UI
uses the wall clock, so the demo never time-travels the chain: launches use short real
durations. For automated checks, Playwright with an injected `window.ethereum` relaying
`eth_sendTransaction` to the node works (the node's accounts are unlocked).

## Documentation (keep in sync with the code)

- `docs/V15_HARDENING.md`: public disclosure of the V15 changes and the fee.
- `docs/CONTRACTS_TECHNICAL.md`: V15 reference with `File.sol:line` citations -
  **any contract change shifts lines: re-check the citations.**
- `contracts/docs/ABI_TRACEABILITY.md`: 364 classified entries (consumer, indexed or
  not). After an ABI change, keep the existing V15 classification and classify new
  entries by hand (there is no generator in the repo).
- `apps/web/app/simple-view.tsx`: the default plain-language participant view (presentation
  only; data and transactions come from `ParticipantsTerminal`). Vocabulary: locker =
  "personal vault", commit = "put in", refund = "take back", settle = "collect tokens",
  finalize = "close the sale", create pool = "open trading". Any rule change must be
  reflected in its "How this launch works" sentences.
- Round 1 minimum in the web app is `minPhase1Weth`: `roundAnchorTargetWeth(0)` is always 0
  (round 1 sets the anchor), so never read the minimum from it.
- `apps/web/app/deploy/deploy-client.tsx`: guided form by default (same state, checks,
  simulation and transaction as the advanced form). Duration presets live in
  `DURATION_PRESETS` (quick is disabled on mainnet: windows must be >= 1 h). In guided
  mode `minAnchorPriceWad` = round-1 minimum / round-1 allocation (floored at the
  contract minimum), so the price floor never adds a second condition.
- `docs/blog/`: 9 V15 essays (post 09 explains the protocol fee).
- Opening price: it follows the average price paid and equals it (net of fees) only when
  `lpTokens == saleTokens`; never write that it is always equal.

## Still to do

- External audit.
- Optional: add a fork copyright line to `LICENSE` (without removing the existing one).
