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
- **Fewer RPC requests** (2026-11-17, approved by the project lead). The first $50 of dRPC
  credit went in a few days: every visitor's browser reads the chain itself, and kept
  polling even in a background tab. Done (live since 2026-11-18): no request at all
  from a hidden tab, a refresh once a minute instead of every 12-15 s while a launch is
  quiet (not started, trading, failed), the launch list every minute instead of 30 s, and
  each round's share, start and end read once per launch instead of on every refresh
  (27% fewer calls per refresh during a sale). Next step: group the ~40 reads of a refresh
  into a single call through Multicall3, which should cut the cost by an order of
  magnitude.
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
- **Lockers as small clones** (pull request
  [#1](https://github.com/dr4c0-git/D17/pull/1) by whytrade, 2026-11-15). Every buyer pays
  today to store the whole Locker code (9,048 bytes, about 2M gas, about 0.0064 ETH at
  3 gwei). The proposal deploys that code once and makes each Locker a 105-byte EIP-1167
  clone carrying its owner, factory and WETH in its own code: creating a Locker goes to
  about 152k gas (-92%), each action costs about 3k gas more. Reviewed: the clone bytecode
  and the argument reads are correct, there is no initializer to attack, and the tests
  pass. Not mergeable as is: it targets the next version (V15.1 cannot change), its second
  commit rewrites the V15.1 release files that `main` must keep (they match the mainnet
  deployment and its Etherscan verification), and it conflicts with later changes. Before
  adopting it: check on Sepolia how Etherscan shows the clones (transparency), and teach
  the deployment and verification scripts about the shared Locker.
- **Opening price between the round 1 and round 5 prices** (rule set by the project lead,
  2026-11-21; first observed on the mainnet launches, 2026-11-15). Today the pool opens at
  the average price paid, minus the treasury and protocol fees, times sale tokens / LP
  tokens. It ignores the round prices: when every round sells at the anchor, the pool
  opens about 7% below the round 1 price (round 1 buyers are at a loss at the open), and
  a predatory split opens it far above. Rule: the opening price must lie in
  `[min(R1, R5), max(R1, R5)]`. It must not sit above R1 by construction either: a
  guaranteed gain makes round 1 a near risk-free trade (a failed launch refunds everything)
  and a dump at the first block of every launch. The round 1 gain has to be earned by
  demand. Target under discussion (2026-11-21): the round 5 price, R5 acting as a
  premarket whose buyers pay for the information of rounds 1-4. R5 buyers break even at
  the open, earlier rounds gain only if demand pushed the price up, and when every round
  sells at the anchor, R5 = R1 and nobody gains for free. Edge case: an under-filled R5
  sells at the anchor while rounds 2-4 may have sold higher; candidate rule
  `max(R5 price, average price paid)`. The V15 floor on R5 (never below the anchor) stays:
  a round 5 that can sell very low makes everyone wait for it and empties the early rounds.
  Mechanism: at finalization, compute the LP tokens to pair with the pool's WETH to open
  exactly at the target price, and burn the rest of the LP allocation. Open case: a creator who set too few LP tokens to reach the target (refuse
  that configuration at creation, or return the extra WETH to buyers). It fits the floor
  range: the floor could start at the round 1 price.
- **Price discovery that flattens to a presale** (observed 2026-11-15). When no round
  goes over its target, every round sells at the anchor price and the five rounds behave
  like a single presale. Worth a look when the round rules are next revisited.
- **Liquidity left in dead pools.** Options and numbers in
  [V16_POOL_LIQUIDITY.md](./V16_POOL_LIQUIDITY.md). The project lead prefers concentrated
  liquidity (Uniswap V3 or V4 from a floor price) over a dormancy trigger, which can always
  be gamed to some degree. Ownership principle: the liquidity belongs overwhelmingly to the
  token's holders, a little to the developer, minimally to the ecosystem. Open to community
  proposals since 2026-11-20 in issue [#2](https://github.com/dr4c0-git/D17/issues/2).
