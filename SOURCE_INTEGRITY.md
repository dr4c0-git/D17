# Source integrity

This repository keeps contract source, compiler inputs, generated interfaces
and public deployment records together so they can be checked as one release.

## Canonical contract source

The twelve production Solidity files are under `contracts/contracts/`. Verify
their published checksums with:

```bash
cd contracts
shasum -a 256 -c SHA256SUMS.txt
```

Protocol identity strings containing `V15_HARDENED` are immutable on-chain
identity values. Applications and deployment checks intentionally verify those
exact hashes.

## Reproducible compiler output

The contract build uses Solidity 0.8.24, the Shanghai EVM target, IR
compilation, one optimizer run and no metadata bytecode hash.

`release/solc-input.json` is the standard JSON compiler input.
`release/protocol-build.json` records source, ABI and bytecode hashes, sizes,
immutable references and compiler settings. Regenerate and verify it with:

```bash
npm run compile -w @d17/contracts
npm run release:protocol
```

The command fails when a freshly compiled production ABI or creation bytecode
does not match the published contract artifacts.

## Cross-package parity

The web app, optional API and contract package each carry the interfaces and
deployment manifests they need at runtime. `npm run check:release` verifies
that those copies match the canonical files in `contracts/abi/` and
`deployments/`.

The readable contract explorer is generated from the same complete ABI set and
checked with:

```bash
npm run check:explorer -w @d17/contracts
```

`RELEASE_SHA256SUMS.txt` covers the final distributable tree after dependencies,
build output, caches and runtime state are removed. Generate it last with
`npm run release:checksums`.
