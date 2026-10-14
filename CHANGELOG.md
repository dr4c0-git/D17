# Changelog

All notable changes to this fork of [0xlocker/D17](https://github.com/0xlocker/D17),
newest first. V15 is not deployed yet: everything below runs locally and in the test
suites, Sepolia comes next.

## 2026-10-14 - Price per round chart and UX pass

### Added
- **Price per round chart** in the simple view, shown during the sale. One bar per
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
