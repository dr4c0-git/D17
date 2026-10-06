# D17 Contract Architecture

D17 separates global deployment, per-launch state, participant custody and
liquidity management into small contracts with explicit authority boundaries.

## Factory suite

- `D17Factory` validates launch configuration, records canonical launches and
  maintains the canonical locker registry.
- `D17LaunchFactory` creates the token, launch and liquidity vault for one
  launch and completes their one-time wiring.
- `D17TokenFactory` and `D17LiquidityVaultFactory` can be called only by the
  pinned launch factory.
- `D17LockerFactory` creates personal lockers and registers them with the
  canonical factory.

Factory dependencies are pinned once. Ownership is renounced after deployment,
leaving no administrator able to replace the mechanism for existing launches.

## Per-launch contracts

- `D17Launch` stores immutable economics and timing, accounts for commitments
  and refunds, finalizes outcomes and releases settlement amounts.
- `D17Token` enforces the fixed supply and pre-trading transfer/burn gate.
- `D17LiquidityVault` creates the official pair and permanently holds all LP
  tokens minted to the protocol. It also vests the creator allocation (180 days)
  and adds late settlers' liquidity at the pair's live ratio.
- `D17Locker` holds one participant's WETH and claimed tokens. A locker can
  contain positions across multiple canonical launches.

## Lifecycle

1. A creator submits one immutable five-round launch configuration.
2. Participants commit through personal lockers. WETH remains in each locker.
3. Rounds 1-4 have refund windows. Rounds 1-2 cost a fixed 1%; rounds 3-4 use
   the configured refund penalty (1-25%). Penalties are paid into the vault and
   paired into the official pool. Round 5 has no normal refund window.
4. Anyone can finalize after the last round.
5. Participants settle during the settlement window. After the grace boundary,
   anyone can trigger settlement for a locker; assets still credit its owner.
6. Anyone can create the official pool once pool creation opens.
7. Unsettled positions can settle after pool creation. Their reserved token
   share and liquidity WETH are added to the official pair atomically, and the
   resulting LP remains locked in the vault.

## Core properties

- Participant WETH stays in the participant's locker until refund or
  settlement.
- Launch terms and the rules hash cannot change after creation.
- No unsettled participant can block finalization, pool creation or trading.
- Claims do not expire.
- LP held by the vault has no withdrawal path.
- The treasury receives only configured refund penalties, settlement fees and
  explicitly documented donation sweeps.
- Contract identity checks prevent a canonical locker from treating an
  incompatible launch as valid.

See `ABI_TRACEABILITY.md` for the complete callable surface and
`contract-explorer.html` for a browsable ABI reference.
