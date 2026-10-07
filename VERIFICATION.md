# Release verification

Run all commands from the repository root unless a command says otherwise.
Allow at least 2 GB of free disk space for dependencies and production build
output during a clean verification run.

## Contract suite

- Production Solidity checksums: 14/14.
- Solidity 0.8.24 compile with the documented settings.
- Published creation-bytecode and ABI parity: 11/11 deployable contracts.
- Local lifecycle suite: 567/567 named assertions; V15 hardening suite: 52/52;
  mainnet minimums suite (chain id 1 simulation): 33/33;
  stateful fuzz (`npm run test:fuzz -w @d17/contracts`): 4 seeds × 8 campaigns, 82,030 invariant checks, 381 adversarial probes, 0 failures.
- ABI export and readable explorer coverage: 11/11 contracts.
- Largest deployed code size: `D17LaunchDeployer` 22,759 bytes (limit 24,576);
  `D17LaunchFactory` 5,129 bytes.
- Static analysis: Slither 0.11.6, no exploitable finding (see
  `docs/V15_HARDENING.md`).

## Optional API

- REST and WebSocket smoke suite.
- Concurrent Sepolia/mainnet profile isolation.
- Chain, deployment-manifest and state-fingerprint mismatch rejection.
- Confirmed-range ingestion with websocket notification wake-ups.
- Shared-locker launch isolation and mirrored-event deduplication.
- Exact per-launch locker position and balance responses.
- Method, origin, rate, connection, payload and malformed-request guards.
- Noisy market-event exclusion.

Run:

```bash
npm test -w @d17/api
```

## Web application

- TypeScript typecheck.
- Production build in direct-RPC mode.
- Production build in optional API mode.
- Sepolia and mainnet participant/deploy route matrix.
- Full-navigation network teardown.
- HTTP-first API load, WebSocket notification refresh and visibility resume.
- Wallet writes re-verify the bundled factory suite, canonical launch, rules
  hash, locker ownership and vault wiring before signing.
- Browser console and responsive-layout check.

## Release hygiene

- Cross-package source, deployment, bytecode and ABI parity.
- Documentation relative links.
- Secret, personal-path and private-work-note scan.
- No committed environment files, dependencies, caches, runtime state or build
  output in the upload tree.
- No high or critical dependency advisories at the time of release assembly.

The primary commands are:

```bash
npm run verify
npm run check:release
npm run check:docs
```
