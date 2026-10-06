# One signature

*D17 blog · 08 · deploying a launch*

Launching a token, as commonly practiced, is a small DevOps project. Deploy the token. Deploy the sale. Wire them together. Set the parameters — carefully, across several transactions, each one a chance to fat-finger something immutable. Then explain to your community why they should believe you did all of it right.

On D17, launching a token is **one page and one signature.**

## What the signature buys

When you sign a D17 deploy, the factory executes the entire birth of a launch atomically:

1. **Checks that nobody holds the keys.** The factory refuses to create any launch while any contract in the creation path still has an owner. There is no window where a platform admin could interfere.
2. **Validates everything.** The supply split must sum exactly; the treasury share, creator allocation and refund penalty must sit within their limits; the round schedule must be coherent. A config that fails any check deploys nothing.
3. **Fixes the protocol fee — with your consent.** The current protocol fee (at most 2%) is read and written into your launch's rules for good. Your transaction carries the highest fee you accept; if the fee were raised while your transaction was pending, the deploy would simply fail.
4. **Deploys the trio.** Token, launch, and liquidity vault come into existence together, wired to each other and to nothing else.
5. **Mints once, then never again.** Sale and LP tokens go to the launch, your creator allocation goes into the vault to vest over 180 days, and the dead-address allocation goes directly to the canonical dead address — then minting **closes** and token ownership is **renounced**, inside the same transaction.
6. **Registers the launch as canonical.** From this moment, lockers can verify it's real.

There is no step two. There's no window between "token exists" and "rules apply" for anything to slip through — the launch is born complete, constrained, and ownerless, or it isn't born at all.

## The form can't express a dishonest launch

The deploy page mirrors the contract's discipline. **DEAD ADDRESS is computed, never entered** — you allocate sale, LP, and your own slice; the remainder goes to the canonical dead address, so the split always sums. Next to the treasury field the page shows the protocol fee it read from the chain and the share of every commitment that will end up locked in the pool. Validation is a ladder, not a dead button: if something's wrong, the page names it — a missing field, an out-of-bounds value, a start time too soon — using the factory's own published limits, before you spend gas discovering them.

On Ethereum mainnet the factory adds two more rules: round 1 must open at least **24 hours** after the launch is created, and every round, refund window and claim window must last at least an hour. A launch can't be sprung on the market as a surprise that only bots can catch.

And beside the form, the entire time: a **live preview of your launch page**, rendered with the terminal's real components. Before your wallet ever opens, the page **simulates the deployment** against a public node. If the factory would reject your config, you find out in seconds, for free — not after signing.

## What you give up, and why it's the point

Deploying on D17 means accepting what you *can't* do afterward. You can't mint more. You can't adjust the split. You can't raise the treasury share, change a fee, extend a round, or pull the liquidity. You can't sell your own allocation on day one: it unlocks gradually over six months, visible to everyone. You don't receive refund penalties or unsold tokens — those deepen the pool or are burned.

That list reads like a sacrifice until you realize it's the product. Every lever you surrender is a suspicion your participants no longer need to hold. The one-signature deploy isn't just convenient — it's the moment a creator converts their promises into constraints, publicly, all at once.

You sign once. After that, the rules run the launch — including for you.

---

*The mechanics: `createLaunch` requires every creation-path owner to be renounced, validates the full config, snapshots the protocol fee against the creator's `maxProtocolFeeBps`, deploys token + launch (via `D17LaunchDeployer`) + vault atomically, performs the one-time mint (creator allocation into the vault), closes minting, renounces token ownership, and registers the launch as canonical — one transaction; mainnet adds a 24-hour notice and 1-hour minimum windows; the deploy page simulates via public RPC before requesting the signature.*
