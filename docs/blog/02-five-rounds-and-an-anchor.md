# Five rounds and an anchor: how the price finds itself

*D17 blog · 02 · price discovery*

Most token sales pick a price and hope. The creator guesses what the market will bear; the market punishes the guess in one direction or the other. Price too low and insiders scoop the discount; too high and the sale dies quietly.

A D17 launch does not hard-code one final sale price. It **discovers** the sale outcome, in public, over five timed rounds. The creator still chooses the token allocation, minimum anchor requirements, and schedule before deployment.

## Round one is the vote

Round 1 is the anchor round. Committers put WETH in against a fixed slice of the sale allocation, and when the round and its refund window close, the ratio of *money committed* to *tokens allocated* becomes the launch's **anchor price**. The creator chose the allocation and minimums; the resulting ratio comes from actual commitments.

Pulling out of round 1 costs a fixed 1%, paid into the launch's pool. That small number matters: it means nobody can pump the anchor with a huge commitment and withdraw it for free at the last second.

## Every later round is held to the anchor

Each subsequent round offers its own allocation of tokens, with a target: the WETH needed to sell that allocation *at the anchor price*. A round that beats its target sells everything, at a higher price. A round that falls short sells only what its money covers at the anchor price — never more.

That rule now applies to all four later rounds. **No round can sell tokens below the price round 1 established.** The sale's economics are set by its earliest, most-committed participants — not by the creator's optimism and not by whoever shows up last.

Because the schedule is fixed and published before round 1 opens — allocations per round, lengths, refund windows — there's no lever for anyone to pull once price discovery begins. The creator watches like everyone else.

## Round five takes what's left, at a fair price

Real sales are lumpy. Some rounds oversubscribe, some fall short. Allocation that rounds 2–4 didn't place rolls into round 5, which gets one last chance to sell it — at or above the anchor price.

What round 5 can't sell at that price isn't handed out at a discount, and it isn't given to anyone. It's **burned**, along with the matching share of the liquidity allocation, so the pool's opening price follows what buyers actually paid. (In the earlier version of the protocol, round 5 handed its whole pool to whoever committed, at whatever price — a gift to a last-minute sniper. That door is closed.)

## Why this beats a fixed price

- **No hidden presale price inside the round mechanism.** Any creator allocation is a separate, capped, visible part of the supply split — and it vests over six months.
- **No stale guess.** A price set weeks before launch can't respond to the market. An anchor set by round 1 is, by construction, current.
- **No bargain bin at the end.** The last round is held to the same floor as the others.
- **The anchor requirements are explicit.** If round 1 does not meet the published minimum raise and minimum anchor price, the launch **fails** and remaining commitments can be reclaimed in full, without penalty. Participants still pay their own transaction gas.

The quiet radical idea here is that a launch's price is a *finding*, not a *setting*. Five rounds is how long D17 gives the market to speak — and the contract writes down exactly what it heard.

---

*The mechanics: 5 fixed rounds; round 1 sets the anchor price; rounds 2–5 sell `min(allocation, raised ÷ anchor price)` tokens; unsold allocation from rounds 2–4 rolls into round 5; whatever round 5 cannot sell at the anchor is burned at finalization, and the LP allocation is scaled to the share sold. A launch that misses its round-1 anchor requirements provides a permanent penalty-free refund path for remaining commitments.*
