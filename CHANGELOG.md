# Changelog

All notable changes to this fork of [0xlocker/D17](https://github.com/0xlocker/D17),
newest first. V15 is deployed on Sepolia (testnet) and not on mainnet yet.

## 2026-10-26 - Etherscan source verification command

- **Done on Sepolia: the 8 contracts of the suite are verified on Etherscan** (fee
  splitter, fee config, factory, token factory, liquidity vault factory, launch deployer,
  launch factory, locker factory). Their source code is readable on each address's
  "Contract" tab.

- `npm run verify:etherscan -w @d17/contracts` publishes the source code of the
  deployed suite on Etherscan (Sepolia by default, `-- --network mainnet` later), so
  anyone can read the code behind each address. Addresses come from
  `release/deployments/<network>.json`; each contract's constructor arguments are read
  back from its own deployment transaction, after checking that the local build
  produces exactly the deployed bytecode. `-- --dry-run` runs every check and sends
  nothing. Needs a free `ETHERSCAN_API_KEY` in `contracts/.env`, no private key.

## 2026-10-26 - Docs, blog and progress on the site

- **The documentation is now part of the web app**, on the same domain as the launches:
  **/docs** (user guide, contracts explained, technical reference, V15 changes,
  self-hosting), **/blog** (the nine essays) and **/progress** (where the project
  stands, what comes next, and this changelog). A "Docs" link sits in the app's header.
- The pages are built from the markdown in `docs/` and `CHANGELOG.md`: links between
  documents open the matching page, links to other repository files open them on GitHub.
  `npm run content:sync` refreshes the copy the web app reads, and `check:release` fails
  if it is out of date.
- New `docs/PROGRESS.md`: done, next, status.
- The guide no longer points to the upstream testnet site, and the blog's footer says V15
  is deployed on Sepolia.

## 2026-10-23 - Wording: defection cost, no "Launchpad"

- The fee for taking ETH back after round 3 or 4 is now called the **defection cost**
  everywhere (expert view, guide, contract docs, blog), instead of "deflection".
  The round table's column reads "Defection cost". The simple view keeps its plain
  "take-back fee".
- The word **"Launchpad"** is gone from the header of the simple view and the
  create-a-launch page: D17 is a protocol. The expert view keeps "Launch terminal".

## 2026-10-22 - Simple view opens on the list of launches

- **The simple view now opens on the list of launches**, newest first, instead of
  picking a launch for the visitor. Click a launch to see its rounds and take part;
  **"← All launches"** at the top of a launch goes back to the list. A link to a
  launch (`?launch=0x...`) still opens that launch directly. The expert view keeps
  opening on the newest launch.
- The list rows are highlighted on hover and show "Opening…" right after a click.
- While the list is read from the chain the page says "Looking for launches…"; with
  no launch yet it links to "Create a launch".

## 2026-10-21 - First full launch on Sepolia

- **A complete launch ran on Sepolia**, from creation to trading: round 1 reached its
  minimum (0.25 ETH), the sale was closed, buyers collected their tokens (one of them
  after trading opened), the official pool was created and tokens were sent to wallets.
- **The protocol fee reached the fee splitter and was split exactly 50 / 12.5 / 12.5 /
  25** between four test addresses, twice, with `distribute:fees`.

### Fixed on the way
- Free RPC plans cap `eth_getLogs` ranges and request bursts. The web app now shrinks
  log ranges when refused, retries rate-limited reads, queues its RPC calls (4 at a time)
  and reads a launch's history from its own creation block.
- A wallet with several vaults saw "You did not take part": the app now picks the vault
  holding a position in the launch, and forgets the previous account's vault when the
  wallet switches accounts.

### Added
- `npm run inspect:launch -w @d17/contracts -- <launch or token> [wallet]` prints a
  launch's phase, raise and protocol fee, and optionally a wallet's vaults and positions.
- `apps/web/.env.example` recommends an RPC that accepts wide log ranges (PublicNode).

## 2026-10-21 - Fee distribution command

- `npm run distribute:fees -w @d17/contracts` splits the fees held by the published
  `D17FeeSplitter` between its recipients and prints what each one received. Anyone can
  run it, it only pays gas.

## 2026-10-20 - Deployed on Sepolia

- **The V15 suite is live on Sepolia** (block 11958083), deployed with `deploy:factory`
  and checked by `verify:factory`: **45 checks out of 45 passed**, every factory owner
  key renounced.
- Factory `0xF02Ab7326c4212693a7a53Aa7BBa635213749C07`, protocol fee 1%, paid to a
  `D17FeeSplitter` (`0x6ad3FAF084f554aAd54A47134bf168c4FAe9Ab23`) that splits it
  50 / 12.5 / 12.5 / 25 between four test addresses, the same layout planned for
  mainnet. Every address and transaction is listed in `release/deployments/sepolia.json`.
- Fixed before deploying: `hardhat compile` could fail with HHE905 on a machine without
  a cached compiler (the undici override was too old for Hardhat 3.18).

## 2026-10-20 - Fee splitter

### Added
- **`D17FeeSplitter`**, an optional recipient for the protocol fee. It has no owner and
  no setter: its recipients (1 to 5) and their shares (adding up to 100%) are fixed when
  it is deployed and readable on-chain. Anyone can trigger the split; the fee arrives in
  WETH, plain ETH is wrapped first, and the last recipient gets the rounding remainder so
  nothing stays behind. The launch contracts are unchanged: the splitter is simply set as
  the fee recipient.
- `deploy:factory` deploys it when `FEE_SPLIT_RECIPIENTS` and `FEE_SPLIT_BPS` are set,
  `verify:factory` checks it (identity, recipients, shares, fee config pointing to it).
- New test suite `fee-splitter-e2e` (25 assertions): constructor rules, then a real
  launch whose 1% fee lands in the splitter and is split 50/25/25, odd amounts, plain ETH
  and other tokens. A full local deployment dry run passes all 45 verification checks.
- `npm run check:env -w @d17/contracts` checks `contracts/.env` before a deployment
  without printing any key or the RPC URL: network, address and balance behind each key,
  fee settings and fee split, with a plain-English message for each problem found.

## 2026-10-14 - Round changes shown on time, floor target in the chart

### Fixed
- **Round changes could show late in the local demo and with a direct RPC.** The page
  re-read the chain every 15 seconds only, so with short rounds (the demo's 60-second
  rounds) the "Put in" button could appear late, and a hidden tab (slowed down by the
  browser) could miss a whole round. The page now re-reads the chain right after each
  round and take-back window ends, and as soon as the tab is visible again. Checked with
  one page left open through all 5 rounds: every round, round 4 included, accepts ETH.

### Added
- **Why a round's bar stays at the floor**: under the chart, the open round shows how
  much ETH it needs before its price rises above the round-1 price, for example "Round
  5 stays at the round-1 price until 0.6 ETH comes in (0.1 ETH so far)". Round 5 needs
  more than the others: it also sells every token rounds 2 to 4 did not sell.

## 2026-10-14 - Collecting after trading opens

### Fixed
- **Tokens not collected before trading opened could no longer be collected from the
  app.** The contract allows it (late settlement) but the app hid the button once
  trading was open and said "You have no tokens waiting in your vault". Trading open
  now shows "You have about X to collect" with "Collect my tokens", then "Send my
  tokens to my wallet". Same fix in the expert view.
- **"Open trading" could fail with `NO_SETTLED_LIQUIDITY`** when nobody had collected
  yet: the contract only opens trading once at least one buyer has collected. The page
  now says so and shows the button only when it can work.
- After the sale, a round with no buyers reads "no buyers" in the chart instead of "no
  price yet".
- The chart's "Round 1 price (the floor)" label sat on top of the last bar; it is now
  on the left, above round 1 (which is always at the floor), and reads "Floor" on
  phones.

### Added
- **"Show X in my wallet"** once the tokens are in the wallet: wallets only list the
  tokens they were told about, this asks the wallet to add it.
- On test networks, the trading card explains that the token now trades in its
  official pool and points to the expert view (on mainnet it links to Uniswap).

## 2026-10-14 - Price per round chart and UX pass

### Added
- **Price per round chart** in the simple view, shown from round 1 onward. One bar per
  round with the price everyone paid in it, a dashed line for the round-1 price (the
  floor no round can go under), the current round highlighted, rounds not priced yet
  drawn as outlines. Hover or tap a bar for its price and the ETH raised. Readable on
  phones (labels R1 to R5) and backed by a table for screen readers. It is a price per
  round, not a trading chart: the token only trades once the sale is over.

### Fixed
- **Round 1 minimum was always read as 0** by the web app, on both the RPC and the API
  paths: `roundAnchorTargetWeth(0)` is always 0 because round 1 sets the anchor. The
  minimum now comes from `minPhase1Weth`. Before this fix none of the "round 1 needs at
  least X ETH" messages could appear.
- **Take-back window after a round 1 that missed its minimum**: the page now says the
  launch will be cancelled and that everyone gets all of their ETH back with no fee,
  warns not to take ETH back (it would cost the 1% fee for nothing), and step 3 reads
  "Wait for the cancellation" instead of "Take back my ETH".
- **Round 1 token estimate**: no longer shows "about 0" while round 1 is open; it
  estimates against the minimum and says "if round 1 reaches its minimum".
- **Cancelled launches**: "You put in X ETH: all of it comes back to you", then after
  "Get my ETH back" a clear last step to send the ETH to the wallet, then "Your ETH is
  back in your wallet".
- **After a take-back**: confirms it and points to the last step (send the ETH to the
  wallet).

### Changed
- Transaction notifications in plain words in the simple view ("Put in ETH", "Collect
  your tokens", "Done", "...: it did not go through").
- "Wallet connected" message no longer says "You can now take part" on launches that
  are over or cancelled.
- No wallet in the browser: the page says to install MetaMask or open it in the
  wallet app's browser.
- Create-a-launch form: problems are listed in the order of the form's steps.

## 2026-10-07 to 2026-10-11 - Simple interface and local demo

### Added
- **Simple view**, now the default participant view: one column in plain language, the
  current step in one sentence, one action at a time (connect wallet, create personal
  vault, put in ETH, take it back, collect tokens, send them to the wallet) and the
  launch's rules in everyday words. The full terminal stays one click away (**Expert
  view**, or `?view=expert`); the choice is remembered.
- **Guided "Create a launch" form**, now the default deploy page: duration presets,
  safe defaults, the round-1 floor price computed automatically, plain-language error
  messages. The full form stays available.
- **Automatic network switch**: the wallet is asked to switch to the page's network
  (and, for the local demo only, to add it) instead of failing.
- **Free local demo** (`npm run demo:local`): a local chain, the V15 contracts, demo
  launches with bots, and the web app, without spending any ETH.
  `npm run demo:fund -- 0xAddress [amount]` credits test ETH to any address.
- **Send ETH back to the wallet** after a take-back or a cancellation (out of the
  vault, then WETH to ETH).
- **Mainnet minimums test**: a chain-id-1 simulation checks the 24-hour notice and the
  1-hour minimum windows.

## 2026-10-06 - V15 contracts

Hardened launch rules and a published protocol fee. Every rule change, with the V14
value next to the V15 one, is in [docs/V15_HARDENING.md](./docs/V15_HARDENING.md). In
short:

- Protocol fee 0-2%, fixed per launch at creation, charged only on successful
  settlement, capped by the creator (`maxProtocolFeeBps`).
- Creator treasury share capped at 10% (was 20%); at least 88% of every successful
  commitment is locked in the official pool (was 80%).
- Take-back fees go into the official pool, never to the creator: 1% after rounds 1-2,
  1-25% after rounds 3-4. Fees on a cancelled launch are burned.
- No round, the final one included, sells below the round-1 price; unsold tokens are
  always burned.
- LP allocation scaled to the share actually sold; late liquidity added at the pair's
  live ratio.
- Creator tokens vested over 180 days from pool creation.
- Launch creation reverts until every factory owner key is renounced.
- Mainnet launches start at least 24 hours after creation, every window at least 1
  hour.
- Bugs fixed: factory at the contract size limit (creation moved to
  `D17LaunchDeployer`), a last late settler that could revert forever
  (`LP_RESERVE_EXCEEDED`), dust positions reverting in the pair's `mint`.
- Stateful fuzz and invariant suite added.

Based on upstream commit `57a63ab` (D17 V14.1, 2026-07-20). Original MIT license
kept in [LICENSE](./LICENSE).
