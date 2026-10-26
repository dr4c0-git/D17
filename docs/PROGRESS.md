# Progress

Where D17 V15 stands today, and what comes next. Every change is listed in the
[changelog](../CHANGELOG.md).

## Done

- **V15 contracts deployed on Sepolia** (Ethereum testnet), block 11958083: the full
  suite, checked by `verify:factory` (45 checks out of 45), every factory owner key
  renounced. Addresses and transactions: [release/deployments/sepolia.json](../release/deployments/sepolia.json).
- **Complete launches run on Sepolia**, from creation to trading: five rounds, take-backs,
  closing the sale, collecting tokens, the official pool, sending tokens to wallets.
- **Protocol fee in the open**: 1% (hard cap 2%), frozen per launch, paid only on a
  successful sale to a fee splitter with no owner, which splits it 50 / 12.5 / 12.5 / 25.
  Distributed for real on Sepolia.
- **Source code verified on Etherscan** for the 8 contracts of the suite, so anyone can
  read the code behind each address, for example the
  [fee splitter](https://sepolia.etherscan.io/address/0x6ad3FAF084f554aAd54A47134bf168c4FAe9Ab23#code).
- **Web app**: a plain-language simple view, the full expert view, a guided
  create-a-launch form, and this documentation.

## Next

- **External security audit** of the contracts.
- **Mainnet deployment**, with the protocol fee settings held by a multisig.
- **Own domain and dedicated RPC** for the site.

## Status

D17 V15 runs on Sepolia only: test ETH, no real value. It is not on mainnet yet and has
no professional third-party audit. Nothing here is investment advice.
