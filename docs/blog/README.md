# D17 blog

> **Version note.** These essays describe the upstream V14 rules. V15 changed refunds
> (1% early penalty, every penalty paid into the pool), caps, unsold-token handling,
> creator vesting and added a protocol fee — see [V15_HARDENING.md](../V15_HARDENING.md).

Short essays on the ideas inside the D17 launch mechanism — one per topic, each readable in about five minutes. They're written for a curious participant, not a Solidity developer; the developer-grade detail lives in the [technical reference](../CONTRACTS_TECHNICAL.md), and the full plain-language walkthrough in [contracts, explained for humans](../CONTRACTS.md).

| # | Post | The idea |
|---|---|---|
| 01 | [Your money never touches the app](./01-your-money-never-touches-the-app.md) | Participant-owned lockers hold WETH positions. The website is a window, not a wallet. |
| 02 | [Five rounds and an anchor](./02-five-rounds-and-an-anchor.md) | The price isn't set by the creator — it's discovered by the first round and disciplined across the rest. |
| 03 | [The exit is part of the design](./03-the-exit-is-part-of-the-design.md) | Refund windows on every early round: free while momentum forms, a posted fee late, full refunds if the launch fails. |
| 04 | [The ✓ is earned, not granted](./04-the-tick-is-earned-not-granted.md) | Metadata and economic rules have separate mechanical consistency checks. Neither is an endorsement. |
| 05 | [Liquidity that cannot leave](./05-liquidity-that-cannot-leave.md) | The vault holds the LP position forever, and the token can't trade anywhere before its official pool opens. |
| 06 | [Supply math that cannot lie](./06-supply-math-that-cannot-lie.md) | The split must sum exactly, the caps are `require` statements, and the dead-address allocation is computed — never typed. |
| 07 | [Nobody gets stranded](./07-nobody-gets-stranded.md) | Every mandatory step is permissionless; every personal claim waits forever. Absence strands no one. |
| 08 | [One signature](./08-one-signature.md) | A launch is born complete in one transaction — validated, minted, ownership renounced — or not at all. |

## Reading order

They stand alone, but they build: **01** (where your money lives) → **02–03** (how the sale works) → **04–06** (what can't be faked) → **07–08** (how it ends, and how it begins).

---

*All posts describe the contracts included in `contracts/` and were checked against that source. The suite has extensive local and Sepolia test evidence but no formal professional third-party audit. Nothing here is investment advice — these essays explain a mechanism, not a token's value.*
