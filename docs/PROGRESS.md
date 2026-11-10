# Progress

Where D17 V15 stands today, and what comes next. Every change is listed in the
[changelog](../CHANGELOG.md).

## Done

- **V15.1 contracts deployed on Sepolia** (Ethereum testnet), block 12104784, with the
  mainnet settings: 1% fee split 75 / 25 by a fee splitter with no owner, and the fee
  settings renounced, so nobody can change them. Checked by `verify:factory` (45 checks
  out of 45), every owner key renounced. The first V15 suite (block 11958083) ran the
  earlier test launches. Addresses and transactions: [release/deployments/sepolia.json](../release/deployments/sepolia.json).
- **Complete launches run on Sepolia**, from creation to trading: five rounds, take-backs,
  closing the sale, collecting tokens, the official pool, sending tokens to wallets.
- **Protocol fee in the open**: 1% (hard cap 2%), frozen per launch, paid only on a
  successful sale to a fee splitter with no owner. Distributed for real on Sepolia.
- **Source code verified on Etherscan** for the 8 contracts of the V15.1 suite, so
  anyone can read the code behind each address, for example the
  [fee splitter](https://sepolia.etherscan.io/address/0xdee4D77a0Bb32Aa435c0cf66EDB793A3B17eD543#code).
- **Web app**: a plain-language simple view, the full expert view, a guided
  create-a-launch form, and this documentation.

## Next

- **V15.1**: three contract issues fixed (a pool that could never open after every
  buyer collected first, token supplies too large for Uniswap V2, and liquidity burned
  when buyers collected after trading opened), plus full refunds of take-back fees when a
  launch is cancelled. Next: a fresh Sepolia deployment with complete successful and
  cancelled test launches.

- **External security audit** of the contracts: mainnet comes only after it.
- **Mainnet deployment** on V15, with the protocol fee settings renounced at deployment:
  the 1% fee and its split (75% D17 buybacks, 25% development fund) are then final, with
  no admin key.
- **V16**, after the mainnet launch: what happens to the liquidity left in a pool once a
  token is no longer traded, and contract rules for how a pool opens.
- **Own domain and dedicated RPC** for the site.

## Status

D17 V15 runs on Sepolia only: test ETH, no real value. It is not on mainnet yet and has
no professional third-party audit. Nothing here is investment advice.
