# D17 blog

Short essays on the ideas inside the D17 V15 launch mechanism — one per topic, each readable in about five minutes. They're written for a curious participant, not a Solidity developer; the developer-grade detail lives in the [technical reference](../CONTRACTS_TECHNICAL.md), the full plain-language walkthrough in [contracts, explained for humans](../CONTRACTS.md), and the list of changes from the earlier version in [V15_HARDENING.md](../V15_HARDENING.md).

| # | Post | The idea |
|---|---|---|
| 01 | [Your money never touches the app](./01-your-money-never-touches-the-app.md) | Participant-owned lockers hold WETH positions. The website is a window, not a wallet. |
| 02 | [Five rounds and an anchor](./02-five-rounds-and-an-anchor.md) | The price is discovered by the first round, and no later round — the last one included — can sell below it. |
| 03 | [The exit is part of the design](./03-the-exit-is-part-of-the-design.md) | Refund windows on every early round: 1% early, a posted fee late, every penalty into the pool, full refunds if the launch fails. |
| 04 | [The ✓ is earned, not granted](./04-the-tick-is-earned-not-granted.md) | Metadata and economic rules — fees included — have separate mechanical consistency checks. Neither is an endorsement. |
| 05 | [Liquidity that cannot leave](./05-liquidity-that-cannot-leave.md) | The vault holds the LP position forever, the pool opens at the price people paid, and late liquidity can't be sandwiched. |
| 06 | [Supply math that cannot lie](./06-supply-math-that-cannot-lie.md) | The split must sum exactly, the caps are `require` statements, and unsold tokens are always burned. |
| 07 | [Nobody gets stranded](./07-nobody-gets-stranded.md) | Every mandatory step is permissionless; every personal claim waits forever. Absence strands no one. |
| 08 | [One signature](./08-one-signature.md) | A launch is born complete in one transaction — no admin keys, fee consented, minted, ownership renounced — or not at all. |
| 09 | [The fee, in the open](./09-the-fee-in-the-open.md) | At most 2%, only on success, frozen per launch, and the fee owner can't touch anyone's funds. |

## Reading order

They stand alone, but they build: **01** (where your money lives) → **02–03** (how the sale works) → **04–06** (what can't be faked) → **07–08** (how it ends, and how it begins) → **09** (how the platform gets paid).

---

*All posts describe the V15 contracts included in `contracts/` and were checked against that source. V15 passes two local end-to-end suites but is not deployed publicly yet and has no formal professional third-party audit. Nothing here is investment advice — these essays explain a mechanism, not a token's value.*
