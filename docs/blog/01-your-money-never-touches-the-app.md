# Your money never touches the app

*D17 blog · 01 · custody*

Every launch platform makes the same promise: *trust us with your deposit.* D17's answer is to remove the "us."

When you commit to a D17 launch, your ETH doesn't go to the website, the launch creator, or some shared protocol pot. It goes into a **locker** — a small contract deployed for you, owned by you, that exists to do exactly one job: hold your position and act only on your instruction.

## What a locker actually is

The first time you take part, you create a locker. One transaction, one contract, yours. A locker can hold positions across multiple launches. From then on:

- Your committed ETH is wrapped to WETH and sits **in your locker** — not in the launch, not in a pool of everyone's funds.
- When you refund, the locker credits your WETH back to you, minus the published refund penalty for that round, which it sends into the launch's official pool.
- When you settle, the locker pays the published fees, sends the liquidity share to the pool, and receives your purchased tokens, holding them until you withdraw.

The terminal — the website — is a window, not a wallet. It reads public data and asks your wallet to sign things. If the site vanished tomorrow, your locker and everything in it would be untouched, and every action it supports could be performed directly on-chain.

## The locker is paranoid on your behalf

A locker doesn't take the website's word for which launch it is talking to. Before the first commitment, it checks the launch identity, WETH address, exact rules hash, and canonical factory registration. The rules hash covers every economic setting of the launch, including its fees. Rules-sensitive recovery and settlement paths repeat those checks. A canonical D17 locker refuses to interact with an incompatible launch — including launches from an older version of the protocol. Wrong identity, no interaction.

This matters because the classic launch-scam move is a look-alike contract. You think you're committing to the real sale; you're actually feeding an imitation. A D17 locker structurally can't be pointed at an imitation: the verification runs inside your own contract, using on-chain facts, on every action.

## What this means in practice

- **Nobody can add a pause.** There is no administrator function over your locker. Refunds and withdrawals follow the immutable time windows and owner checks.
- **The site does not custody the funds.** A compromised frontend could still propose a misleading wallet transaction, so the wallet destination and calldata still matter. Calls through the locker remain constrained by its on-chain checks.
- **Your commitment is visible but not poolable.** Anyone can watch the totals move, but no contract in the suite can spend your locker's WETH except along the exact paths the launch rules define: a refund to you (minus the published penalty, which deepens the pool), or settlement through the sale (minus the published treasury and protocol fees).

Custody is the boring part of a launch, right up until it's the only part that matters. D17's position is that it should never be a promise. It should be an address you can check.

---

*The mechanics: owner-controlled `D17Locker` contracts self-register through the factory; each locker can hold multiple launch positions, verifies the V15 launch identity, WETH, canonical registration and rules hash on entry and settlement paths, and holds committed WETH plus claimed tokens. The contracts pass two local end-to-end suites but have not been deployed publicly yet and have no formal professional third-party audit.*
