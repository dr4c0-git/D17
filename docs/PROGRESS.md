# Progress

Where D17 V15 stands today, and what comes next. Every change is listed in the
[changelog](../CHANGELOG.md).

## Done

- **V15.1 contracts deployed on Sepolia** (Ethereum testnet), block 12108022, with the
  mainnet settings: 1% fee split 75 / 25 by a fee splitter with no owner, and the fee
  settings renounced, so nobody can change them. Checked by `verify:factory` (45 checks
  out of 45), every owner key renounced. The first V15 suite (block 11958083) ran the
  earlier test launches. Addresses and transactions: [release/deployments/sepolia.json](../release/deployments/sepolia.json).
- **Complete launches run on Sepolia**, from creation to trading: five rounds, take-backs,
  closing the sale, collecting tokens, the official pool, sending tokens to wallets.
- **V15.1 tested end to end on Sepolia**: a successful launch with one buyer away
  (trading stayed closed until a third party collected for them; the pool then opened
  and the absent buyer received all of their tokens; the 1% fee was split 75 / 25 to the
  wei), and a cancelled launch (both buyers got everything back, including the 1%
  take-back fee one of them had paid).
- **Protocol fee in the open**: 1% (hard cap 2%), frozen per launch, paid only on a
  successful sale to a fee splitter with no owner. Distributed for real on Sepolia.
- **Source code verified on Etherscan** for the 8 contracts of the V15.1 suite, so
  anyone can read the code behind each address, for example the
  [fee splitter](https://sepolia.etherscan.io/address/0x5D31d29910419d6103Ae75fA2f319aEcEFAeAfa2#code).
- **Web app**: a plain-language simple view, the full expert view, a guided
  create-a-launch form, and this documentation.

## Next


- **External security audit** of the contracts: mainnet comes only after it. The
  [audit package](./AUDIT.md) is ready for the reviewer.
- **Mainnet deployment** on V15, with the protocol fee settings renounced at deployment:
  the 1% fee and its split (75% D17 buybacks, 25% development fund) are then final, with
  no admin key.
- **V16**, after the mainnet launch: what happens to the liquidity left in a pool once a
  token is no longer traded, and contract rules for how a pool opens.
- **Own domain and dedicated RPC** for the site.

## Status

D17 V15 runs on Sepolia only: test ETH, no real value. It is not on mainnet yet and has
no professional third-party audit. Nothing here is investment advice.
