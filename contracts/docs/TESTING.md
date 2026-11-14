# Contract Testing

## Local lifecycle suite

Run:

```bash
npm ci
npm run compile
npm test
```

The suite executes 493 named assertions on an ephemeral local chain. Coverage
includes:

- factory deployment, one-time pins and ownership renunciation;
- configuration and metadata bounds;
- canonical launch and locker authentication;
- a failed weak-anchor launch and complete refunds;
- an 18-locker, five-round launch;
- refunds in every available window with exact penalty accounting;
- finalization, partial settlement and permissionless settlement;
- official pool creation with unsettled lockers;
- late liquidity top-ups before and after a price-moving trade;
- supply, WETH, sale-token and LP-token conservation;
- burn and transfer gates;
- double-claim, unauthorized-caller and malformed-action reverts;
- a zero-late-settlement control launch.

## Locker clones and gas

`test/locker-clone.mjs` (part of `npm test`) checks the exact code of a locker
clone, that its owner cannot be set or spoofed, that the shared `D17Locker` cannot
be used directly, and that the Locker ABI is unchanged. `npm run gas:locker` prints
the gas used to create a locker and by each locker action.

## Additional checks

```bash
npm run build:abi
npm run check:explorer
shasum -a 256 -c SHA256SUMS.txt
```

The ABI exporter covers all nine production contracts. The explorer check
confirms that every ABI entry appears in the readable HTML explorer.

## Scope limits

The suite is scenario-based rather than a property/fuzz suite. It does not
replace an independent audit. External WETH and Uniswap-V2-style behavior is an
assumption of the system and should be rechecked when deploying against any
different implementation.
