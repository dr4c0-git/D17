# Progress

Where D17 V15 stands today, and what comes next. Every change is listed in the
[changelog](../CHANGELOG.md).

## Done

- **V15.1 deployed on Ethereum mainnet** (2026-11-12, block 26397656): factory
  `0xB46eb48f982b63B879E00592880D12d1741fDB02`, 2% protocol fee split 75 / 25 (D17 buybacks / development fund) by the fee
  splitter `0xAefA3a5A469d89Aa100b80628aE604BBA25eA22B`, fee settings renounced, every owner key renounced, 48 checks out of
  48. Reviewed beforehand by the project lead's Solidity reviewer, with no blocking issue.
  Addresses and transactions: [release/deployments/mainnet.json](../release/deployments/mainnet.json).
- **V15.1 contracts deployed on Sepolia** (Ethereum testnet), block 12112991, with the
  mainnet settings (at a 1% fee; mainnet uses 2%): the fee is split 75 / 25 by a fee splitter with no owner, and the fee
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
  [fee splitter](https://sepolia.etherscan.io/address/0x6E6F46d2DdA1E0c70A467148bB43B7b76e59FeF7#code).
- **Web app**: a plain-language simple view, the full expert view, a guided
  create-a-launch form, and this documentation.

## Next

- **Etherscan verification** of the mainnet contracts, then the **site switched to
  mainnet** with its own domain and a dedicated RPC.
- **Announcement**, a 24-hour countdown and a first test launch on mainnet.
- **V16**: what happens to the liquidity left in a pool once a token is no longer traded,
  and contract rules for how a pool opens.
- **Formal audit**: the [audit package](./AUDIT.md) is ready for a professional reviewer.
- Later: an IPFS mirror through ENS and eth.limo, and public analytics on Dune.

## Status

D17 V15.1 is live on Ethereum mainnet since 2026-11-12 (factory `0xB46eb48f982b63B879E00592880D12d1741fDB02`), and on Sepolia
for testing. It was reviewed by the project lead's Solidity reviewer and has no formal
professional third-party audit: launches use real ETH, at your own risk. Nothing here is
investment advice.
