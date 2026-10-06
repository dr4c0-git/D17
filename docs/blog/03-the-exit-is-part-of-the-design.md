# The exit is part of the design

*D17 blog · 03 · refunds & deflection*

The most telling question you can ask any token sale is: *what happens if I change my mind?*

Most mechanisms answer with silence. Once you're in, you're in; your exit is whatever the secondary market gives you, whenever it exists. D17 answers with a schedule, published before round 1 opens and enforced by the contract:

| When you leave | What it costs | Where the cost goes |
|---|---|---|
| Refund window after round 1 or 2 | **1%** (fixed) | Into the official pool |
| Refund window after round 3 or 4 | The launch's published **deflection** (1%–25%) | Into the official pool |
| Round 5 | No refund window | — |
| The launch **fails** its floor | **Nothing — everyone, in full** | — |

## Why windows at all

Because commitment without an exit isn't conviction — it's capture. A refund window after every early round means the sale's momentum is real: everyone still in a launch at round 3 is someone who had two cheap chances to leave and didn't. That's information. A raise total built from trapped money tells you nothing; one built from people who could walk tells you a lot.

## Why even early exits cost 1%

The early exits used to be free, and free turned out to be exploitable. A whale could commit an enormous amount in round 1, make the anchor look strong or the price look awful, wait for others to react — and then pull everything out at the last second for nothing, possibly sinking the launch with it. Gas was the only cost.

One percent is small for someone who genuinely changed their mind, and very real for someone moving a large amount to manipulate others. It turns a free attack into a paid one.

## Why leaving late costs more

The deflection fee isn't a punishment; it's a stabilizer for the same reason, scaled up. Late in the sale, the price signal is mostly formed; a large exit then distorts what everyone else committed to. A published percentage on late exits makes that distortion cost real money.

Three design choices keep it honest:

- **The fee is fixed at deploy and bounded by the factory.** A creator picks the deflection rate (the common preset is 17%) between 1% and 25%, and the number is immutable from then on. It's on the launch page before you commit your first wei.
- **You see the cost before you sign.** The terminal states the exact charge on the refund button before your wallet opens. No fine print, no discovering the fee in a transaction trace.
- **Nobody profits from your exit.** Penalties are not paid to the creator, and not to the platform. They go into the launch's liquidity vault and are paired into the official pool when it opens — making the market slightly deeper for everyone who stayed. A creator therefore gains nothing by setting a harsh penalty.

## The failure case is the cleanest case

If a launch never clears its floor, all of this machinery steps aside. **Failed launch, full refund** — every participant, every remaining commitment, no deflection, no argument. There is no deadline on withdrawing from a failed launch, and no one's approval is needed.

What about the 1% already paid by someone who left round 1 before the launch failed? There's no pool for it to deepen, and handing it to the creator or the platform would reward a failure. So anyone can trigger its **burn**: it is sent to the dead address, where no one can ever spend it.

A launch mechanism reveals its values in how it treats the people who leave. D17's answer: early doubt is cheap, late churn pays a posted price, every penalty benefits the people who stayed, and a failed launch pays everyone else back to the wei.

---

*The mechanics: contract rounds 0–1 refund at a fixed `EARLY_REFUND_PENALTY_BPS = 100`; rounds 2–3 at the launch's immutable `refundPenaltyBps` (factory bounds 100–2,500); every penalty is sent by the locker to the liquidity vault and paired into the initial pool, or burned via `burnFailedLaunchPenalties()` if the launch fails; round 5 has no window; failed launches refund remaining commitments in full via a permanent, penalty-free path.*
