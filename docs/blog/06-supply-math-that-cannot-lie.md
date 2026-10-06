# Supply math that cannot lie

*D17 blog · 06 · tokenomics enforcement*

Read enough token launch pages and you develop a reflex: find the pie chart, then find the footnote that contradicts it. "Team: 5%*" — asterisk — "*additional advisor allocation TBD." Tokenomics, as usually practiced, is a genre of creative writing.

D17 makes it arithmetic, checked by a machine that refuses bad answers.

## The split must be exact

A D17 launch declares its supply split at deploy: how many tokens are for **sale** to committers, how many seed the **liquidity pool**, how many the **creator** receives, and how many are sent to the canonical **dead address**. The factory then checks one unforgiving equation:

```
sale + LP + creator + dead-address allocation = maximum supply
```

Not approximately. Not "at least." Exactly — to the token. A configuration that's off by one unit is rejected before anything deploys. There is no unallocated remainder for anyone to quietly claim later, because the launch literally cannot exist unless every token has a declared destination.

The terminal mirrors this at the design level: on the deploy page, the **DEAD ADDRESS** allocation is computed, never typed. You enter sale, LP, and creator; the remainder is minted directly to the canonical dead address. The interface makes the complete structure the only structure you can express.

## The caps nobody can negotiate

Beyond the split, the factory enforces hard limits on the numbers that most tempt abuse:

| Parameter | Limit | What it prevents |
|---|---|---|
| Creator's own allocation | **≤ 10%** of supply, vested over 180 days | The launch that's mostly a gift to its deployer, dumped on day one |
| Treasury share of each successful commitment | **≤ 10%** | The "sale" that's mostly a fee |
| Protocol fee | **≤ 2%**, fixed per launch | A platform that quietly raises its cut |
| Refund penalty, rounds 3–4 | **1%–25%**, paid into the pool | The exit fee that's really a wall — or a creator revenue stream |

Put together: at least **88%** of every successful commitment ends up in the locked pool. These aren't policies or community guidelines. They're `require` statements. A launch violating any of them doesn't get flagged or reviewed — it simply never deploys, no matter who submits it or why.

## Immutable means immutable

Every one of these numbers is fixed in the launch's constructor and covered by its rules hash. After deploy there is no function — for the creator, the platform, or anyone — that adjusts an allocation, raises a fee, or revises the refund penalty. The one-time mint happens at deploy, minting **closes**, and the token's ownership is **renounced** in the same transaction. There is no "mint more later." There is no later.

## Burned means burned

Sending the initial remainder to the canonical dead address makes it inaccessible from creation. This is economically similar to removing it from circulation, but it is not an ERC-20 burn: those tokens remain included in `totalSupply`. The distinction matters, so the terminal labels it **Dead address**, not **Burned**.

Unsold sale tokens are a different story, and there is no longer a choice about them. If the rounds don't fully place the sale allocation, finalization performs a **real burn** that reduces `totalSupply` — and burns the matching share of the liquidity allocation with it, so the pool's opening price still reflects what buyers paid. Nobody, the creator's treasury included, ever receives tokens the market didn't buy. (The earlier version let a creator choose to send unsold tokens to their own treasury. That option is gone.)

The theme, once you see it, is everywhere in the suite: **replace disclosure with impossibility.** Don't ask participants to read the footnotes. Build a factory where the footnotes can't compile.

---

*The mechanics: the factory validates `saleTokens + lpTokens + creatorAllocation + deadTokens == maxSupply` exactly; caps creator allocation at 10% (minted into the vault, vested linearly over 180 days), `treasuryBps ≤ 1,000`, `100 ≤ refundPenaltyBps ≤ 2,500`; `D17FeeConfig` caps the protocol fee at 200 bps; all values are immutable and hashed into `rulesHash`; finalization burns unsold sale tokens and the unused LP allocation; minting closes and token ownership is renounced in the deploy transaction.*
