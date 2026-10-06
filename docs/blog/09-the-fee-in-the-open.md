# The fee, in the open

*D17 blog · 09 · the protocol fee*

Every launchpad gets paid somehow. The question is never *whether* there's a fee — it's whether you can see it, whether it can change under you, and whether it shows up somewhere you didn't expect.

D17 charges a protocol fee. Here is all of it.

## What it is

At most **2%** of each successful commitment, paid to the platform's published fee address. The 2% isn't a policy; it's a constant in the fee contract, and any attempt to set more is rejected.

It shows up as its own line, next to the creator's treasury share — not folded into it, not hidden in the liquidity math. When your locker settles, your commitment splits three ways, and the launch page shows each rate before you commit:

```
your commitment = pool share (≥ 88%) + creator treasury (≤ 10%) + protocol fee (≤ 2%)
```

## When it is charged — and when it isn't

Only when a commitment **succeeds**: when your locker settles and receives its tokens.

- Refund in a refund window? **No protocol fee.** (You pay the published refund penalty, which goes into the pool — not to the platform.)
- Launch fails its round-1 floor? **No protocol fee.** Everyone is refunded in full.
- Late settlement? **Exactly the same fee** as settling on time, never more.

The platform earns when a launch works, and only then. That's the incentive we want it to have.

## Why it can't change under you

The fee lives in one small contract, controlled by a multisig. That multisig can do exactly two things: change the fee (within 0–2%) and its recipient, **for launches created afterwards**, or give up control entirely.

At the moment a launch is created, the factory copies the current fee and recipient into the launch itself, as permanent values that are part of its rules hash — the fingerprint your locker checks before every commitment. From then on, nothing anyone does to the fee contract can reach that launch. No upgrade, no "temporary adjustment," no new recipient.

The creator is protected too. Their deploy transaction states the highest fee they accept. If the fee were raised between the moment they reviewed it and the moment their transaction landed, the deploy simply fails, and they can review it again.

## What the fee owner cannot do

It's worth listing, because this is where fees usually hide their teeth:

- It **cannot** touch any participant's WETH or tokens. The fee contract holds nothing and is never called by a launch, a locker or a vault.
- It **cannot** change the fee of any existing launch.
- It **cannot** pause, upgrade or redirect anything. It is the only owner left in the whole system, and that is all it can do.

A fee you can read, that can't move, that's only paid when you get what you came for. That's the whole arrangement.

---

*The mechanics: `D17FeeConfig` stores `(feeRecipient, protocolFeeBps)` with `MAX_PROTOCOL_FEE_BPS = 200` and two-step ownership; `D17Factory.createLaunch` reads `currentFee()`, requires it to be ≤ the config's `maxProtocolFeeBps`, and passes it into the launch's immutables (`protocolFeeBps`, `protocolFeeRecipient`), which are part of `rulesHash()`; the locker pays `protocolFeeWeth = gross × protocolFeeBps ÷ 10,000` at settlement only.*
