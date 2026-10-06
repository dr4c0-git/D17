# D17 Documentation

Documentation for the D17 open-source experiment.

## Start here

- [User guide](./GUIDE.md)
- [Contracts explained for humans](./CONTRACTS.md)
- [Technical contract reference](./CONTRACTS_TECHNICAL.md)
- [V15 changes and protocol fee](./V15_HARDENING.md)
- [Self-hosting](./SELF_HOSTING.md)
- [Short essays](./blog/README.md)

## Repository map

- `apps/web` - one Sepolia/mainnet participant terminal and deployer.
- `apps/api` - optional provider-neutral RPC indexer and read API.
- `contracts` - Solidity source, tests, ABIs, and deployment tools.
- `deployments` - public Sepolia and mainnet factory manifests (V15: not deployed yet).
- `release` - reproducible contract build and public deployment provenance.

## Status

D17 is experimental and non-custodial. The contracts have extensive local and
Sepolia test evidence but no formal professional third-party audit. These
documents explain a mechanism; they are not investment advice and do not
promise token value, trading liquidity, or freedom from defects.
