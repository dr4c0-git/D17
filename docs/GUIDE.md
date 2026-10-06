# D17 Launch Terminal — User Guide

> A fair-launch terminal for tokens. Commit over timed rounds, leave during refund windows, and — if the sale clears its floor — watch the launch finalize into a live pool you can trade. No accounts, no custody, no private keys held by the app.

**Live testnet:** [d17testnet.vercel.app](https://d17testnet.vercel.app) · Runs on Ethereum **Sepolia** — use a testnet wallet only.

---

## Contents

- [What D17 is](#what-d17-is)
- [The 60-second version](#the-60-second-version)
- [Glossary](#glossary)
- [The launch lifecycle](#the-launch-lifecycle)
- [The terminal at a glance](#the-terminal-at-a-glance)
- [Participating, step by step](#participating-step-by-step)
- [Reading the numbers](#reading-the-numbers)
- [Launching your own token](#launching-your-own-token)
- [Hosted vs. self-hosted](#hosted-vs-self-hosted)
- [Themes, alerts, mobile](#themes-alerts-mobile)
- [Trust & safety](#trust--safety)
- [Troubleshooting](#troubleshooting)
- [Under the hood](#under-the-hood)

---

## What D17 is

D17 is a **launch mechanism** and a **terminal to watch and take part in it**.

A launch raises **WETH** across a fixed sequence of **timed rounds**. Between rounds there are **refund windows** — you can pull your commitment back out. Early refunds cost a fixed 1%; later refunds use the published **deflection** fee. Every refund penalty goes into the official pool, never to the creator. The token supply is minted once when the launch is created. Finalization later locks the sale accounting and burns unsold sale tokens. Settlement then funds the official pool and credits participants' tokens.

The whole thing is **on-chain and rule-bound**. The creator publishes the exact rules up front and the launch records their hash. The terminal checks token metadata consistency separately, while the locker's **Check rules** action verifies the canonical launch and exact rules hash before commitment. Nothing about the schedule, split, or refund policy is discretionary once it is live.

The terminal is **read-mostly**. It shows you every launch, its live phase, the money in and out, who holds what, and — when you connect a wallet — your own position. Your funds never sit in the app; committed WETH lives in your own **locker** contract until you refund or the launch settles.

---

## The 60-second version

1. **Find a launch.** Open the terminal; it opens on the newest launch. Switch between launches from the top bar or the **LAUNCHES** list.
2. **Read the rules.** The masthead shows the token, the supply split (sale / LP / deployer / dead address), the treasury cut, the protocol fee, and the round schedule. **RULES · DETAILS** expands the full terms.
3. **Connect & commit.** Connect a Sepolia wallet, create your **locker**, and commit WETH while a round is **OPEN**. You must meet the round's floor.
4. **Change your mind?** During a **refund window** you can withdraw. Rounds 1–2 cost 1%; rounds 3–4 charge the published deflection %; round 5 has no window.
5. **Settle & claim.** When the rounds end the launch **finalizes** and **settles**. You **claim** your tokens; your share of the raise seeds the pool.
6. **Trade.** Once **POOL READY → TRADING OPEN**, the token is live on a pool. Your leftover balances are always withdrawable from your locker.

---

## Glossary

| Term | Meaning |
|---|---|
| **Launch** | One token sale with its own schedule, split, and rules. Each has its own page. |
| **Round** | A timed window (fixed at **5** per launch) during which you can commit WETH. Each round has its own allocation and minimum. |
| **Commit** | Deposit WETH toward the launch during an open round. |
| **Locker** | *Your* personal contract that holds committed WETH and, later, claimable tokens. A locker can hold positions across multiple launches. The app never holds funds — your locker does. |
| **Refund window** | The window after a round where you can withdraw what you committed. |
| **Deflection** | The refund fee: a fixed 1% on rounds 1–2, the launch's published percentage on rounds 3–4. It is paid into the official pool, never to the creator. |
| **Floor** | The published minimum commitment and round-1 anchor requirements. If round 1 does not establish its required anchor, the launch fails. |
| **Finalize** | End-of-rounds step that locks the sale accounting and processes unsold sale tokens. |
| **Settlement / Claim** | The window where committers claim their tokens and the pool is prepared. |
| **Pool** | The Uniswap-style liquidity pool the launch seeds, where the token trades afterward. |
| **Treasury** | The creator's ETH cut, stated as a percentage. |
| **Deployer allocation** | Tokens the creator assigns to themselves (e.g. an airdrop / team allocation), shown as **DEPLOYER**. |
| **Verified (✓)** | The token metadata agrees across its on-chain storage, hashes, factory event, and contract URI. Use **Check rules** for the separate canonical rules-hash verification. |

---

## The launch lifecycle

Every launch moves through the same states. The terminal reflects the current one live — the stage banner, the rounds table, the left-rail timeline, and even the browser tab title all move **without a refresh**.

```
NOT STARTED
   │
   ▼
ROUND 1 · OPEN ──▶ ROUND 1 · REFUND WINDOW
   │
   ▼
ROUND 2 · OPEN ──▶ ROUND 2 · REFUND WINDOW
   │
   ▼           (rounds 3, 4, 5 …)
   ▼
FINALIZE ──▶ SETTLEMENT · CLAIM WINDOW ──▶ POOL READY ──▶ TRADING OPEN
   │
   └─▶ FAILED  (floor never met → everyone can withdraw in full)
```

| Stage | What's happening | What you can do |
|---|---|---|
| **NOT STARTED** | Launch is published; round 1 hasn't opened. | Read the rules; get your wallet ready. |
| **ROUND N · OPEN** | Commit window is live for round N. | Commit WETH (≥ the round floor). |
| **ROUND N · REFUND WINDOW** | The window to leave round N. | Withdraw — 1% early, deflection % later. |
| **FINALIZE** | Rounds are done and the sale outcome can be locked. | Anyone may submit the one-time finalize transaction. |
| **SETTLEMENT · CLAIM WINDOW** | Tokens are claimable; the pool is being prepared. | **Claim** your tokens; withdraw any leftover WETH. |
| **POOL READY** | The settlement grace boundary has passed and the official pool is eligible for creation. | Create/observe the pool; prepare to trade. |
| **TRADING OPEN** | The token is live on its pool. | Trade; claim/withdraw anything remaining. |
| **FAILED** | The launch never met its floor. | Withdraw your commitment in full. |

> **Why refund windows exist.** They make the sale honest. If a launch stalls or you change your mind, you're not trapped — you leave. The escalating deflection fee simply discourages last-minute churn once real momentum has built.

---

## The terminal at a glance

The screen is three columns under a top bar. Nothing is hidden behind menus — the whole state of a launch is visible at once.

### Top bar
- **LIGHT / NOTIFY / SOUND** — theme toggle, plus optional desktop notifications and sound on new activity.
- **UPDATED hh:mm:ss** — last data refresh.
- **DEPLOY** — open the launch-a-token page.
- **WALLET SETUP** — the exact network/token details to add to your wallet.
- **CONNECT WALLET** — connect / disconnect.

### Left rail — STAGES & LAUNCHES
- **ROUNDS / LAUNCHES** toggle. **ROUNDS** shows this launch's stage timeline; **LAUNCHES** lists every launch (with a count and "new" pill).
- **STAGES** — the live timeline: the current phase glows; each round, refund window, finalize, claim, and pool step is a row you can expand for its numbers and a sparkline.
- **ETH / USD** — flip every value on screen between ETH and a USD reference (see [Reading the numbers](#reading-the-numbers)). The toggle appears when a price provider is configured: API mode uses the indexed service's `/api/prices/eth-usd` by default; direct-RPC deployments opt in with `NEXT_PUBLIC_D17_<NETWORK>_PRICE_URL`. With no provider the terminal stays ETH-only.

### Masthead (top center)
- Token logo, name, and **✓ VERIFIED** when the on-chain metadata records agree.
- **TOKEN** and **POOL** address **copy chips**.
- The **supply split**: **SUPPLY**, **SALE %**, **LP %**, **DEAD ADDRESS %**, plus **DEPLOYER %** when the creator took an allocation, and **TREASURY % ETH**.

### Center — the stage
- **Stage banner** — the current phase in plain words (e.g. *TRADING OPEN · OFFICIAL POOL LIVE*).
- **RULES · DETAILS** — expand the full published terms.
- **Live tallies** — **TOTAL RAISED**, **FINAL PRICE**, **PARTICIPANTS**, **SETTLED** (n/N).
- **Pool composition line** — how much token + WETH seeded the pool at creation and what was added later.
- The primary action for the current phase (connect, commit, claim, **CREATE POOL**, trade).
- **CHARTS** — price / raise over the launch.

### Right rail — PARTICIPANTS & ACTIVITY
- **PARTICIPANTS** — **LOCKERS**, **SETTLED**, **NET ETH**.
- **CONCENTRATION** — a **TOP 10 HOLD %** bar showing how spread-out the holders are.
- **Live feed** — event count, source (**VIA API** / **LIVE WS**), and a real-time **ACTIVITY** stream (commits, refunds, settlements, liquidity, mints). Tabs switch between **ACTIVITY**, **LOCKERS**, and **YOUR LOCKER**.

---

## Participating, step by step

> Check the network label before connecting. Sepolia uses test assets; Ethereum mainnet uses real ETH and WETH.

1. **Set up your wallet.** Network **Sepolia**, chain id **11155111**. You commit **WETH** (wrapped ETH), not raw ETH.
2. **Connect.** Click **CONNECT WALLET** and pick your wallet. The app connects via wallet announcements and never redefines your wallet — it holds no keys.
3. **Create your locker.** On the launch page, create your locker. This is your personal contract; it can hold positions for more than one launch. Your committed WETH lives here.
4. **Commit.** While a round is **OPEN**, enter an amount at or above the round floor and confirm. The flow walks a short ladder — *wallet ✓ → locker ✓ → commit* — and the feed shows your commit when it lands.
5. **Track your position.** **YOUR LOCKER** shows committed amount, your share %, and balances. Locker WETH figures come from the indexer; your wallet ETH/WETH come from the wallet.
6. **Refund (optional).** In a refund window, the CTA tells you the cost **before** you sign — *1%* in rounds 1–2, the launch's published deflection in rounds 3–4 (**17%** on the default preset; each launch sets its own, between 1% and 25%), and round 5 has no window. The returned WETH becomes withdrawable in your locker; an owner-only withdrawal moves it to your wallet.
7. **Claim.** In **SETTLEMENT · CLAIM WINDOW**, claim your tokens. Anything not converted stays withdrawable.
8. **Trade.** Once **TRADING OPEN**, the pool is live. Disconnecting clears your view; reconnecting restores it.

---

## Reading the numbers

**ETH is always canonical.** Everything you commit, refund, and claim is denominated in WETH/ETH. The **ETH ⇄ USD** toggle (bottom of the left rail) is a **display convenience** — flip it and every value surface (masthead, tallies, rounds, pool, charts) shows a USD figure derived from a once-a-minute mainnet **ETH/USD reference**. On Sepolia this is labelled a **Mainnet reference** — testnet ETH has no real price. USD never changes what you sign.

**The supply split** always sums to 100%: **SALE** (sold to committers) + **LP** (seeds the pool) + **DEPLOYER** (creator allocation, if any) + **DEAD ADDRESS** (the inaccessible remainder). The dead-address allocation is computed, never hand-entered — so the numbers can't lie. It remains part of ERC-20 `totalSupply`; only a real burn reduces that value.

**Concentration** (TOP 10 HOLD %) is a quick read on fairness: a lower number means the token is more widely held.

**Price.** Before trading, price is anchored by the launch's floor and raise; after **TRADING OPEN** it's the live pool price. The **FINAL PRICE** tile shows the settlement price in ETH per token (and USD if toggled).

---

## Launching your own token

Open **DEPLOY** in the top bar. It's **one page, one signature** — not a wizard — with a **live participant preview** on the right rendered with the real components, so what you see is exactly what launchers will see.

A one-line strip up top restates the lifecycle: **ROUNDS raise ETH → REFUNDS let people leave → FINALIZE → CLAIM → TRADING.**

**1 · TOKEN** — name, **Symbol**, **Total supply**, a compact SVG data URI, description, and links. This identity is included in the on-chain metadata hash.

**2 · ECONOMICS** — a split bar with inputs for **SALE / LP / DEPLOYER**; **DEAD ADDRESS is the remainder** and is never entered (over-allocation flags red and blocks deploy). Set **Treasury % (ETH)** and its address, and the **Min commit (WETH)** / **Round 1 floor**.

**3 · ROUNDS & SCHEDULE** — choose when round 1 opens (with the resolved local time shown). Rounds default to a sensible preset (allocations, lengths, and a *free-early / 17%-late* refund policy) rendered as a readable schedule; **CUSTOMIZE** expands per-round editing: **Allocation**, **Length · minutes**, **Refund** window, and **Refund cost % (rounds 3–4)**.

**4 · DEPLOY** — the page checks the immutable D17 factory identity and **runs a simulation** against your configured RPC before the real transaction. Sign once. The deployment receipt reveals the launch, token, and canonical rules hash.

**Validation is a ladder, not a dead button** — it names exactly what's missing (a field, an over-limit value, an over-allocation, a start time in the past) instead of silently disabling deploy. Client-side checks use the factory's own published limits.

**After you deploy**, the receipt confirms the launch on-chain. RPC mode discovers it from the factory event; API mode shows it when the configured indexer has processed the same event.

---

## Hosted vs. self-hosted

- **Hosted showcase.** The temporary demonstration reads indexed data from a hosted API. It is a viewer and test surface, not a permanent launchpad service.
- **Local RPC.** Clone this repository, bring your own RPC, and choose testnet or mainnet from the top navigation. Participant reads and wallet actions work without a D17 server. The deploy page always signs directly through the wallet.

The app has two data modes under the hood: **API mode** (reads the hosted indexer — the public experience) and **RPC mode** (reads the chain directly — for local/self-hosted use). ETH/USD and other hosted conveniences degrade gracefully when self-hosting.

---

## Themes, alerts, mobile

- **Theme.** **LIGHT** is the default (a cream, paper-like terminal); a dark mode is one click away and remembered.
- **Notifications & sound.** Opt in to desktop **NOTIFY** and **SOUND** to get pinged on new activity for the launch you're watching — useful for catching a phase transition without staring at the tab.
- **Realtime.** Updates are **WebSocket-first** (**LIVE WS**), backed by low-frequency indexed-API safety refreshes so a sleeping tab or a missed message still reconciles. When the backend is briefly unreachable the header shows **Stale · Retrying** and keeps the last data on screen.
- **Mobile.** At phone widths the layout collapses to a section nav with a live phase chip, thumb-friendly controls, and no horizontal scrolling — the full connect → commit flow works in a wallet's in-app browser.

---

## Trust & safety

- **No custody, no keys.** The app never holds your funds or your keys. Committed WETH sits in **your** locker contract; signing happens in your wallet.
- **Rules are published and hashed.** The locker verifies the canonical launch and exact rules hash before commitment. The masthead checkmark is the separate metadata-consistency check.
- **You can leave.** Refund windows exist on every round but the last; failed launches refund in full.
- **The numbers can't hide.** The supply split sums to 100% with **DEAD ADDRESS** computed as the remainder; concentration is shown; every commit and refund is in the public feed.
- **Display reads never touch your wallet.** In hosted mode the terminal reads only the indexed API — RPC is reserved for wallet signing and the deploy dry-run.
- **Testnet is testnet.** Use a throwaway Sepolia wallet. Sepolia ETH has no monetary value; any USD figure shown is a mainnet reference only.

---

## Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| **Stale · Retrying** in the header | The backend was briefly unreachable; the last data stays on screen and it auto-recovers. |
| A network-switch warning when connecting | Your wallet is on the wrong chain. Match the network and chain id shown in the header. Nothing is signed until you do. |
| A new launch isn't showing | Discovery is near-instant, but a slow indexer can lag; the panel says so plainly. Your launch is live on-chain regardless. |
| Commit rejected below the floor | You're under the round's minimum — raise the amount to at least the round floor. |
| Deploy button won't enable | The validation ladder names the exact blocker (missing field, over-limit, over-allocation, past start time). Fix that item. |
| "Committed WETH not in my wallet" | Correct — it's in your **locker**, not your wallet balance. It returns on refund, or converts on claim. |

---

## Under the hood

D17 is a small suite of contracts behind a factory. In brief:

- A **factory** deploys each launch and its satellites in one transaction.
- A **launch** contract runs the rounds, refunds, finalize, and settlement logic and enforces the published rules.
- A **locker** is a participant-owned contract that can hold positions across launches; it custodies committed WETH and claimable tokens.
- A **token** is minted once during launch creation; minting then closes and ownership is renounced.
- A **liquidity vault / pool** seeds and holds the launch's liquidity, after which the token trades.

For the full picture, see the companion docs:

- **[Contracts, explained for humans](./CONTRACTS.md)** — how the mechanism works from a participant's point of view (no Solidity required).
- **[Contracts, technical reference](./CONTRACTS_TECHNICAL.md)** — the developer-grade specification: every contract, function, invariant, and event.

These documents describe the contracts included in `contracts/`. Re-check them against source before relying on a different deployment.

---

<sub>D17 Launch Terminal · ETH is canonical, USD is display-only · testnet uses Sepolia (chain id 11155111) · the app holds no keys and no funds.</sub>
