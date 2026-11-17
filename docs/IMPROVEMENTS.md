# Improvement notes

A running list of what to improve, collected from real launches on mainnet and from the
project lead's notes. Nothing here is a commitment or a schedule: items are picked for a
version when they are ready, and not everything has to land in the same version.

Split in two, because the process is different:

- **Site only**: changes to the web app. No contract change, built on a preview link,
  approved by the project lead, then put live.
- **New contract version**: changes to the rules. They need a new suite of contracts
  (existing launches keep their code), tests, a Sepolia run and a review before mainnet.

## Site only

- **Show who created the launch** (project lead, 2026-11-15). The launch page shows the
  creator's wallet (it receives the creator allocation) and, when it is a different
  address, the treasury (it receives the treasury fee), each linked to the explorer.
  Status: live since 2026-11-15.
- **A backup RPC for mainnet** (2026-11-17). The site reads every launch from the visitor's
  browser through one RPC (the project lead's dRPC key). When it hiccups, the launch
  list stops loading, as it did briefly on 2026-11-17. Idea: a second RPC in the site's
  settings that the site switches to automatically when the first one does not answer.
  The app has no fallback today (`apps/web/lib/readProvider.ts` uses a single URL).
  Errors and usage of the current RPC are visible in the dRPC dashboard, not in Cloudflare.
- **Alerts for new launches** (suggested by a user, 2026-11-15). People without time to
  watch the site would like to be told when a launch is created, opens or opens trading:
  for example an X or Telegram bot, or alerts on the site.
- **Public analytics on Dune.**
- **IPFS mirror** of the site through ENS and eth.limo ([IPFS_MIRROR.md](./IPFS_MIRROR.md)).

## New contract version

- **Auto-settle and auto-pool** (project lead, 2026-11-15). Today every buyer has to be
  settled (at most 4 per transaction for a third party), then someone creates the pool:
  several transactions after every sale. The constraint: each buyer's WETH sits in their
  own locker, and one transaction can only touch a limited number of lockers (gas cap).
  Two levels:
  1. The last settlement creates the pool by itself: one step less, a small change.
  2. A full auto-settle: rethink where the WETH sits during the sale. That touches the
     "your money stays in your own contract" principle, so it needs a careful discussion.
- **Opening price equal to the average price paid** (observed on the first mainnet
  launches, 2026-11-15). The pool opens at the average price paid, minus the treasury and
  protocol fees, times sale tokens / LP tokens: below the average price with the usual
  split, far above it with a predatory split. Idea: compute the LP tokens from the WETH
  actually raised, so the pool always opens exactly at the average price paid, and burn
  the rest. It fixes both directions at once.
- **Price discovery that flattens to a presale** (observed 2026-11-15). When no round
  goes over its target, every round sells at the anchor price and the five rounds behave
  like a single presale. Worth a look when the round rules are next revisited.
- **Liquidity left in dead pools.** Options and numbers in
  [V16_POOL_LIQUIDITY.md](./V16_POOL_LIQUIDITY.md). The project lead prefers concentrated
  liquidity (Uniswap V3 or V4 from a floor price) over a dormancy trigger, which can always
  be gamed to some degree. Ownership principle: the liquidity belongs overwhelmingly to the
  token's holders, a little to the developer, minimally to the ecosystem.
