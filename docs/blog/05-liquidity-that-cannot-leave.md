# Liquidity that cannot leave

*D17 blog · 05 · the vault & the trading gate*

The rug pull has a precise anatomy. A token launches, a pool is seeded, price discovery begins - and then the deployer, who holds the LP tokens, withdraws the liquidity. The pool empties, the chart goes vertical in the wrong direction, and everyone else discovers they were providing exit liquidity for one wallet.

D17's response is architectural: **the LP tokens are never in anyone's hands.**

## The vault holds the pool, forever

Every launch deploys with its own **liquidity vault** - a contract whose purpose is to create the official trading pool and then hold the resulting LP position permanently. When the launch settles, at least 88% of every successful commitment flows through the vault into the pool, together with every refund penalty paid during the sale, and the LP tokens the pool mints land in the vault.

They don't leave. There is no withdraw function, no admin override, no timelock that eventually expires. The vault has no owner to renounce because it never had the power in the first place. The liquidity that backs the token's market is, by construction, locked from the moment it exists.

## The opening price is the price people paid

How many tokens go into the pool is not a number the creator gets to tune after the fact. The liquidity allocation is scaled to the share of the sale that actually sold: if only 60% of the sale tokens found buyers, only 60% of the liquidity tokens are used and the rest are burned. The pool's opening price therefore follows what buyers actually paid - not a price inflated or deflated by tokens nobody bought. When the creator sets the liquidity allocation equal to the sale allocation, the pool opens at the average price paid, net of fees; any other ratio between the two is in the published rules for everyone to read before committing.

## The token can't front-run its own pool

Locked liquidity solves the ending of the rug; the **trading gate** solves the beginning. Before the official pool opens, the token itself refuses to move: transfers and burns are blocked for everyone, with the only exceptions being the launch's own distribution and the vault seeding the official pair.

This closes a quieter exploit. Without a gate, anyone holding early tokens - a creator's allocation, a claimed settlement - could seed their *own* pool before the official one, set a fake price, and harvest the confusion. On D17, until **TRADING OPEN**, there is nothing to trade anywhere, for anyone. The official pool is necessarily the first market.

The creator allocation goes one step further: it isn't even in the creator's wallet. It is minted into the vault and released linearly over 180 days after the pool opens. No day-one dump is possible.

## The pool waits for everyone

The pool opens only once every buyer's position is settled, so all of the liquidity goes in at once, at the price buyers paid. Nobody's share arrives after trading has moved the price, so nothing has to be burned to fit a new price and nothing is left for an arbitrageur to grab.

A buyer who never shows up can't hold the pool hostage either: once the claim window is over, anyone can settle their position for them, and their tokens still land in their own vault.

## Even pool creation trusts no one

Who presses the "create pool" button? Anyone. Once settlement conditions are met, pool creation is **permissionless** - the vault builds the official pool for whoever calls it, because everything that matters (which pair, how much of each asset, where the LP goes) is already determined by the contract. A creator who disappears after finalize can't strand a launch at the last step.

The pattern across all of it: don't ask the deployer to behave - remove the levers. No LP tokens to pull, no early market to fake, no allocation to dump, no button only insiders can press. The pool isn't protected by promises. It's protected by not having a door.

---

*The mechanics: the vault creates the official pool permissionlessly from settled liquidity WETH plus all refund penalties, holds all LP tokens with no withdrawal path, opens only once every final commitment is settled (anyone may settle absent lockers after the grace period, up to 8 per batch), and vests the creator allocation over 180 days; `effectiveLpTokens = lpTokens × sold ÷ saleTokens`; the token blocks transfers and burns before trading opens, excepting the launch and vault-to-pair paths.*
