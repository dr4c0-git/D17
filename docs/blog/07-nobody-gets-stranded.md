# Nobody gets stranded

*D17 blog · 07 · settlement & the permissionless endgame*

There's a failure mode in on-chain systems that gets far less attention than theft: **abandonment**. The sale that can't finalize because only the deployer can press the button and the deployer is gone. The claim window that closed while you were on holiday. The funds that aren't stolen, exactly — just unreachable, forever, behind a step someone else was supposed to take.

D17's endgame is built so that no single absent, lazy, or malicious actor can strand anyone else. The design rule: **every step that must happen can be triggered by anyone; every claim that belongs to you waits for you indefinitely.**

## Finalization is a public service

When the five rounds complete, the launch needs finalizing — the step that snapshots the raise, locks the outcome, and burns what didn't sell. On most platforms this is the deployer's job, which means it's also the deployer's hostage.

On D17, `finalize` is **permissionless**. Any address can call it once the rounds are done. The creator finalizing their own launch is a courtesy, not a requirement; if they vanish at the finish line, the next interested participant — or an indexer bot, or you — completes the launch. The contract doesn't care whose gas it was.

## Claiming late costs you nothing extra

After finalization comes settlement: each participant's locker converts its committed WETH into tokens, paying the published fees and sending the liquidity share to the pool. Here D17 makes a promise most sales don't: **late settlement gives the same outcome as on-time settlement, and it never expires.**

Settle the day the window opens, or settle next year — you receive the same sale-token entitlement for the same commitment and pay the same fees. Your liquidity share joins the pool at its price at that moment, alongside a reserved share of liquidity tokens that waited for you in the launch. The resulting LP tokens are minted to the vault. There is no deadline after which your position decays and no unclaimed-position sweep to anyone.

One thing late settlement deliberately does *not* give you is an advantage. Whatever part of your liquidity share can't be paired at the current price is burned rather than returned, so waiting to see which way the market goes earns nothing.

## Even settlement itself can be done for you

One more layer down: after a grace period passes, **anyone can trigger settlement on a locker's behalf**. Not redirect it — the tokens still land in that locker, owned by that owner — just execute it. Lost your keys for six months? Your position settles into your locker anyway, safe, waiting. The permissionless caller gets nothing but the satisfaction; the locker owner loses nothing but the excuse.

The same philosophy runs through every other step:

- **Pool creation** is permissionless once its conditions are met.
- **Creator vesting** is released by anyone who presses the button — and the tokens can only go to the creator address fixed in the rules.
- **Cleanup** is public too: once everyone has settled, anyone can burn the rounding dust left in the launch; if a launch fails, anyone can burn the early-refund penalties that have no pool to go to.

Every step from "rounds over" to "token trading" can be walked by the public.

## Why this matters more than it sounds

Strandedness is the quiet tax on-chain systems levy on ordinary life — on people who travel, forget, procrastinate, or lose a phone. A mechanism is only as fair as its treatment of the participant who shows up late. D17's endgame treats the absent deployer as a nuisance to route around and the absent participant as someone whose property is simply *held* — not forfeited, not diluted, not swept.

The lifecycle has no step that requires a specific person, and no claim that expires. It finishes because anyone can finish it.

---

*The mechanics: `finalizeLaunch` is permissionless once rounds complete; settlement is claimable forever with late claims outcome-identical in tokens and fees (reserved LP tokens, capped at the remaining reserve, are added at the pair's live ratio with the remainder burned); after the grace period anyone may run `settleAfterGrace` for any locker; `createOfficialPool`, `releaseCreatorTokens`, `burnResidualTokens` and `burnFailedLaunchPenalties` are permissionless.*
