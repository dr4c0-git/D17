# D17 contracts, explained for humans

## What this document is

This is a plain-language explanation of the D17 V15 contracts for someone considering a launch. It describes what the code does with participant funds, which rules are fixed, and which risks remain. The source passes 619 local assertions across two end-to-end suites. It has not received a formal professional third-party audit, and V15 is not deployed on any network yet. The full list of V15 changes, including the protocol fee, is in [V15_HARDENING.md](./V15_HARDENING.md).

## The pieces

| Contract | What it does |
|---|---|
| `D17Factory` | The public entry point and canonical registry. It validates launch settings and records which launches and lockers are genuine D17 deployments. |
| `D17LaunchFactory` | Creates a launch, token, and liquidity vault as one matching set. It also performs the token's one-time initial mint and closes minting. |
| `D17LaunchDeployer` | A narrow deployer that only the pinned launch factory can use to create launch contracts. |
| `D17FeeConfig` | Holds the protocol fee (hard-capped at 2%) and its recipient for future launches. Each launch copies them into its immutable rules at creation. |
| `D17Launch` | Holds the launch rules and accounting. It controls rounds, refunds, finalization, settlement amounts, and the official-pool records. |
| `D17Locker` | Your personal vault and claim agent. It holds your WETH and, after settlement, your purchased tokens. A locker can hold positions in more than one launch. |
| `D17LiquidityVault` | Creates the official token/WETH pool, receives its LP tokens, and holds those LP tokens permanently. It also adds late settlers' liquidity and vests the creator allocation. |
| `D17Token` | The launched ERC-20 token. It fixes the maximum supply and blocks transfers and holder burns until the official pool opens. |
| `D17TokenFactory` | A narrow factory that only the pinned launch factory can use to create tokens. |
| `D17LiquidityVaultFactory` | A narrow factory that only the pinned launch factory can use to create liquidity vaults. |
| `D17LockerFactory` | Creates a locker for the wallet requesting it and registers that locker with `D17Factory`. |

Every D17 component carries a matching version identity. A D17 locker rejects a launch from another version. It also rejects a launch that is not registered by the expected factory or whose published rules hash does not match.

## What happens to your money

### 1. You commit through your locker

Only the wallet that owns a locker can ask it to commit. The locker receives ETH and wraps it into WETH in the same transaction. The WETH remains in that locker. It is not sent to the website, the launch creator, or a shared D17 pot. The launch contract records how much that locker committed, but it does not take custody of the WETH. *Enforced by `D17Locker` and `D17Launch`.*

The locker first checks four things:

- the launch is a contract;
- it has the expected D17 launch identity;
- it uses the expected WETH contract; and
- its current rules hash matches the canonical record in `D17Factory`.

Your WETH is self-custodied in the specific sense that the creator and app operator have no function that can withdraw it. It is still locked by the launch rules. You cannot withdraw a live commitment whenever you like; you can only refund during an applicable refund window, recover it if the launch fails, or settle it after the sale.

```text
wallet ETH
    |
    v
your D17Locker -> WETH held against your launch position
    |                         |
    | refund/failure          | settlement
    v                         v
withdrawable WETH       treasury fee + protocol fee + official-pool WETH
in your locker          purchased tokens into your locker
    |                         |
    v                         v
your wallet             your wallet after trading opens
```

### 2. Five rounds discover the sale outcome

A D17 launch always has five rounds. The duration of each round is configured before deployment and cannot change afterwards.

Round 1 establishes the anchor price from the WETH raised and that round's token allocation. It must also meet the published minimum raise and minimum anchor price. If it does not, the launch fails and later rounds do not proceed normally.

Rounds 2 to 5 use targets derived from the anchor: no round sells below the anchor price. Unsold allocations from rounds 2 to 4 roll into round 5; whatever round 5 cannot sell at the anchor price is burned at finalization. Contributions determine the resulting price and each participant receives a pro-rata share; the creator does not have a function that can change the result after seeing demand. *Enforced by `D17Launch`.*

The creator does choose the launch's timings, allocation split, minimums, treasury, treasury fee, and refund penalty before deployment. The protocol fee is read from `D17FeeConfig` at creation; the creator states the maximum they accept. Those choices are part of the published rules and should be read before committing.

### 3. Your position takes one of three paths

**Normal refund:** the applicable round commitment is removed. The penalty is paid into the launch's liquidity vault and deepens the official pool (it is burned if the launch fails); it never goes to the creator. The remainder becomes withdrawable WETH in your locker. You must then withdraw it to your wallet.

**Failed launch:** all WETH still committed by your locker becomes withdrawable without a penalty. Penalties already paid on earlier round-1 refunds are burned. This is a claim, not an automatic push; the locker owner must call the failed-launch refund and then withdraw the WETH.

**Successful launch:** settlement calculates your final token entitlement. Your WETH is divided between the official liquidity path, the published treasury fee and the published protocol fee. Your purchased tokens are sent into your locker. You can withdraw those tokens to your wallet once the official pool has opened trading.

## Getting out: refunds

The refund schedule is fixed by the contract. A deployer cannot choose which rounds are free or penalized.

| Display round | Normal refund window | Cost |
|---|---:|---|
| Round 1 | Yes | 1% (fixed) |
| Round 2 | Yes | 1% (fixed) |
| Round 3 | Yes | The launch's published `refundPenaltyBps` |
| Round 4 | Yes | The launch's published `refundPenaltyBps` |
| Round 5 | No | No normal refund window |

The round 3-4 penalty is one global launch setting. It is not always 17%. The factory allows values from 1% up to 25%. For example, if the published penalty is 17%, refunding a 1 WETH round position returns 0.83 WETH to the locker and sends 0.17 WETH to the liquidity vault, where it is paired into the official pool. The fixed 1% on rounds 1-2 exists so that a large commitment cannot be pulled out for free at the last second to scare others away or fail the launch. Integer rounding applies at wei precision. *Enforced by `D17Factory`, `D17Launch`, and `D17Locker`.*

The first four rounds share one configured refund-window duration. Round 5 is deliberately final: a normal change-of-mind refund is not available after committing in that round.

If round 1 fails to establish the required anchor, the launch fails. Every remaining commitment can then be reclaimed in full, including any amount that would otherwise have been subject to a penalty. No refund penalty is charged on the failed-launch path.

## What you cannot be rugged on by these contracts

These protections are about the mechanics enforced by this exact source. They do not make the token valuable or its creator trustworthy in matters outside the contracts.

### The creator cannot take WETH from your locker

Refunds, owner settlement, and withdrawals are owner-only. After the grace period opens, anyone may trigger settlement for a known locker, but they cannot redirect the result: purchased tokens remain credited to that locker, the liquidity share goes to the official pool, and the fixed treasury and protocol fees go to their published recipients. *Enforced by `D17Locker`.*

### One participant cannot hold the launch hostage

Finalization is permissionless after round 5. Pool creation does not wait for every locker to settle. After the fixed settlement grace period, anyone may settle a known locker, and this permissionless settlement remains available without an expiry. A pool needs at least one settled position before it can be created; after grace, any known funded locker can be settled to satisfy that condition. *Enforced by `D17Launch`, `D17Locker`, and `D17LiquidityVault`.*

### The seeded liquidity cannot be pulled by the creator

The official pool mints its LP position to `D17LiquidityVault`. The vault has no function for withdrawing the official LP token. Recovery functions explicitly refuse the D17 token, WETH, and official LP token. The LP position is therefore held permanently by the vault. *Enforced by `D17LiquidityVault`.*

If some lockers settle after the pool has opened, their WETH and reserved token share are added to the same pair in one transaction, at the pair's current price. The new LP tokens are also minted to the vault; whatever cannot be paired at that price is burned.

### The supply split must balance exactly

Before deployment, the factory requires:

```text
sale tokens + LP tokens + creator allocation + dead tokens = total supply
```

The creator allocation is optional and cannot exceed 10% of total supply. Its recipient is fixed to the wallet that creates the launch, and it vests linearly over 180 days from pool creation. The treasury fee cannot exceed 10% and the protocol fee 2%. The rounds 3-4 refund penalty is between 1% and 25%. Every round must receive a positive sale allocation and all five round shares must total 100%. *Enforced by `D17Factory`.*

These are caps, not recommendations. A 10% treasury fee or 25% refund penalty is valid contract input and should be treated as an important economic choice, not as a default.

At deployment, the complete supply is minted once. Minting is then closed and token ownership is renounced. No later administrator can mint more tokens. Dead-token allocations, when used, must go to the canonical dead address. *Enforced by `D17LaunchFactory` and `D17Token`.*

### Unsold tokens are always burned

At finalization, unsold sale tokens are burned, and so is the matching share of the LP allocation (the LP allocation is scaled to the share of the sale that actually sold, so the opening price follows what buyers actually paid instead of being set by tokens nobody bought; it equals the average sale price net of fees when the LP allocation equals the sale allocation). Nobody, including the treasury, receives tokens the market did not buy. *Enforced by `D17Launch`.*

### Tokens cannot circulate before the official pool opens

Before trading opens, ordinary holders cannot transfer tokens. The creator allocation sits in the liquidity vault and only starts vesting once the official pool exists, so it cannot seed a competing pool or be dumped at open. The only pre-open token movements allowed are the launch distributing entitlements and liquidity tokens, and the liquidity vault seeding the official pair. Once the official pool is created, normal transfers and holder burns open. *Enforced by `D17Token`.*

### The rules can be checked on-chain

The launch calculates a rules hash from its version identity, contract addresses, timings, round shares, treasury and protocol fees and recipients, allocations, metadata hash, and other economic settings. `D17Factory` stores that hash when it registers the launch. A locker checks the hash before accepting a commitment.

The current terminal separates two checks. Its token-metadata mark means the name, symbol, description, image, links, token storage, launch metadata hash, factory metadata event, and token `contractURI` agree. Its separate **Check rules** action asks the locker to verify the D17 launch identity, WETH address, canonical factory registration, and exact rules hash before a commitment is signed.

Neither check means the token, creator, website, economics, or market value has been endorsed or audited.

### The launch cannot be upgraded in place

These contracts are not proxies. After deployment there is no function for replacing a launch's code or changing its immutable rules. The deployment process pins the component factories once and renounces their setup ownership; V15 refuses to create any launch while one of those owner keys still exists. The only remaining owner is `D17FeeConfig`'s, which can only change the fee (≤2%) for future launches. A future D17 version requires a new factory suite; existing launches continue under their original code.

This removes an administrator's ability to change the mechanism later. It also removes the ability to patch an existing launch if a defect is discovered.

## What you end up with

For a successful launch, the user-visible sequence is:

1. **Finalize.** After round 5, anyone can finalize once. Finalization records total committed WETH, fixes the final-round token pool, and burns unsold sale tokens and the unused LP allocation.
2. **Settle and claim.** The locker owner may settle at any time after the launch is finalizable. Settlement does not expire. It calculates the exact tokens owed and the WETH split.
3. **Permissionless settlement after grace.** Once `poolCreationOpensAt` is reached, anyone may call `settleAfterGrace` for a known locker. The caller receives nothing; the outcome stays assigned to the locker owner.
4. **Create the official pool.** After the fixed settlement window and scheduled trading boundary, anyone may create the pool once at least one position is settled. The initial pool uses the WETH settled so far plus every refund penalty, and the matching proportional LP-token allocation.
5. **Late top-up.** A locker settled after pool creation receives the same token entitlement and pays the same configured fees. Its liquidity WETH and reserved token share are added to the official pair atomically at the pair's current price.
6. **Withdraw and trade.** Purchased tokens first sit in the locker. Only the locker owner can withdraw them, and only after the official pool has opened. Refund WETH and any residual WETH are withdrawn separately by the owner.

"Claim" therefore does not always mean "tokens appear immediately in your wallet." Settlement claims them into your locker. A separate owner-only withdrawal moves them from the locker to your wallet after trading opens.

## What could still go wrong

### Smart-contract risk remains

Testing and source review reduce risk; they do not prove the absence of bugs. This source has not received a formal third-party professional audit. The contracts are immutable, so a defect in an existing launch cannot be fixed through an administrator upgrade.

### Mainnet has different consequences

Sepolia testing uses test assets. Mainnet transactions use real ETH and WETH. Gas prices, failed transactions, MEV, network congestion, and mistakes in wallet prompts have real cost.

### The token can lose all market value

Locked liquidity prevents the creator from withdrawing the vault's LP position. It does not guarantee market demand, trading volume, a minimum post-launch price, or the absence of large holders selling. A creator allocation of up to 10% unlocks gradually over 180 days after trading opens and can be sold as it vests.

### In-bounds settings can still be unattractive

The factory checks hard safety bounds and structural consistency. It does not judge whether a launch is a good deal. The creator chooses the treasury address, treasury fee, refund penalty, round allocation, minimums, timing and creator allocation. Read the actual values for each launch.

### Late liquidity can meet a moved market

Late settlement adds liquidity at the pair's current price; the part that cannot be paired at that price is burned. Someone who moves the price around a late settlement pays swap fees both ways and can at most capture the impermanent loss of that late liquidity. The participant still receives the same sale-token entitlement and pays the same WETH amount.

### External contracts matter

D17 relies on the configured WETH contract and a Uniswap-V2-style factory and pair. A fault, incompatibility, or unexpected change in those external systems can affect wrapping, pool creation, liquidity accounting, and trading.

### Losing the locker owner's key is still losing access

Permissionless settlement can stop a forgotten locker from blocking the launch and can place its tokens safely into that locker. It cannot recover the owner's private key. Only the locker owner can withdraw refunded WETH or purchased tokens to a wallet.

### Failed-launch creator tokens stay locked

If a launch fails, trading never opens. Participant commitments remain fully refundable, and the creator allocation stays locked in the vault forever. The token has no official trading pool.

### Small rounding residue can remain

Token and liquidity calculations use integer division. Very small amounts of token allocation can remain in the launch contract as rounding dust. Once every commitment has settled, anyone can burn that dust with `burnResidualTokens()`.

### The website is not the contract

An unavailable website or API does not change the on-chain rules. A participant can interact through another compatible interface or directly with the contracts. Doing that safely requires the correct network, addresses, ABI, rules hash, and transaction parameters.

## Glossary

| Term | Meaning |
|---|---|
| **Commit** | Send ETH through your locker, where it becomes WETH assigned to a particular launch round. |
| **Locker** | An owner-controlled contract that holds your WETH positions and purchased tokens. |
| **Round** | One of five timed commitment periods in a D17 launch. |
| **Anchor price** | The round-1 WETH raise divided by round 1's token allocation, provided the published minimums are met. |
| **Deflection** | The refund penalty: a fixed 1% in rounds 1 and 2, the launch's published rate in rounds 3 and 4. It is paid into the official pool, never to the creator. |
| **Finalize** | Fix the successful sale totals and process unsold sale tokens after round 5. |
| **Settle** | Apply the final sale accounting to a locker and route its WETH between liquidity, the treasury fee and the protocol fee. |
| **Claim** | Credit the locker with the purchased tokens calculated at settlement. Withdrawal to the wallet is a separate step. |
| **Pool** | The official D17-token/WETH Uniswap-V2-style trading pair created by the liquidity vault. |
| **Treasury** | The address published by the launch creator that receives the treasury share of settled commitments (at most 10%). |
| **Protocol fee** | At most 2% of each settled commitment, paid to the platform's published fee recipient. Fixed per launch at creation; never charged on refunds or failed launches. |
| **Verified** | A consistency check. Metadata verification and locker rules verification are separate; neither is an endorsement or price guarantee. |

---

*Reference source: the production contracts and checksums in `contracts/`.*
