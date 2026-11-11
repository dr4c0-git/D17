# IPFS mirror through ENS and eth.limo

The Vercel site stays the main entry. The mirror is the same site exported as static
files, stored on IPFS and reached through an ENS name, for example `d17.eth` at
`https://d17.eth.limo`. No server, no host account: as long as one IPFS node keeps the
files and the ENS record points to them, the site is up.

## What it needs

- **An ENS name**, owned by whoever should control the mirror (the project lead). Whoever
  controls the name's content hash decides what the mirror shows.
- **An IPFS pinning service** that keeps the files online: for example Pinata, Filebase
  or 4EVERLAND (free tiers cover a 5 MB site). Several can pin the same CID.
- **The same public settings as the Vercel site** (`NEXT_PUBLIC_*`): network, RPC URLs,
  explorer. They are baked into the files at build time.

## 1. Build

On a machine with the repository:

```bash
git pull && npm ci
```

Create `apps/web/.env.production.local` (git-ignored) with the values set on Vercel,
for example:

```
NEXT_PUBLIC_D17_DATA_MODE=rpc
NEXT_PUBLIC_D17_DEFAULT_NETWORK=mainnet
NEXT_PUBLIC_D17_MAINNET_RPC_URL=https://your-mainnet-rpc
NEXT_PUBLIC_D17_SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co
NEXT_PUBLIC_D17_MAINNET_EXPLORER_BASE=https://etherscan.io
NEXT_PUBLIC_D17_SEPOLIA_EXPLORER_BASE=https://sepolia.etherscan.io
NEXT_PUBLIC_SITE_MODE=full
NEXT_PUBLIC_ENABLE_DEPLOY=true
NEXT_PUBLIC_ENABLE_TEST_CONTROLS=false
NEXT_PUBLIC_ENABLE_USD=false
```

Then:

```bash
npm run build:ipfs -w @d17/web
```

The site is written to `apps/web/out` (about 5 MB): every page is a folder with an
`index.html`, and the app itself runs in the browser exactly as on Vercel.

## 2. Publish on IPFS

Upload the **contents** of `apps/web/out` as one folder to the pinning service (Pinata:
"Upload > Folder"). It returns a CID for the folder, starting with `bafy...`. Check it
in a browser through a subdomain gateway, for example `https://<CID>.ipfs.dweb.link`:
the launch list and `/docs/` must open.

Use a subdomain gateway or eth.limo, not a path gateway (`https://ipfs.io/ipfs/<CID>/`):
the site uses absolute paths and only works at the root of a domain.

## 3. Point the ENS name to it

On [app.ens.domains](https://app.ens.domains), open the name, then Records, Edit, and set
**Content hash** to `ipfs://<CID>`. It is one mainnet transaction, signed by the name's
manager. After a few minutes, `https://<name>.eth.limo` serves the mirror.

## 4. RPC allowlist

Add `<name>.eth.limo` to the RPC provider's domain allowlist, next to the Vercel domain,
otherwise the mirror cannot read the chain.

## Updating

Each change of the site gives a new CID: rebuild, upload, and update the content hash
(one transaction each time). Keep the previous CIDs pinned for a while, so older links
keep working.
