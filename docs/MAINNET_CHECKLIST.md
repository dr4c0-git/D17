# Mainnet deployment checklist

The V15 suite goes to Ethereum mainnet exactly as it was deployed and verified on
Sepolia: same commit, same commands, real ETH. Follow the steps in order and stop at the
first one that does not come out as described. No private key, no `.env` content and no
fee address ever goes into the repository or a chat.

## Timing

- **Launch rules on mainnet:** round 1 of a launch opens at least **24 hours** after the
  launch is created, and every window lasts at least 1 hour. A launch meant to open on a
  given day must be created the day before, so the suite must be deployed, verified and
  live on the site **at least 2 days before** the first launch opens.
- Deploy when gas is low (check the Etherscan gas tracker): the cost scales with it.

## Before the day

### 1. The Safe (fee settings owner)

- Create a Safe on Ethereum mainnet at [app.safe.global](https://app.safe.global), with
  several owners and a threshold of at least 2 (for example 2 of 3).
- Its address is `FEE_CONFIG_OWNER`. It is the only key that can change the protocol fee
  of **future** launches (0% to 2%, hard cap in the contract) or where it is paid; it can
  never touch a launch already created or anyone's funds. `deploy:factory` refuses a
  plain wallet here.
- Send one small test transaction from the Safe so every owner knows how to sign.

### 2. Two fresh deployer wallets

- Create two **new** wallets used for nothing else: the factory key and the locker
  factory key (the script refuses one key for both).
- Gas they spend, measured on a full run:

  | Key | Gas | At 3 gwei | At 10 gwei | At 30 gwei |
  |---|---|---|---|---|
  | Factory key (`D17_FACTORY_PRIVATE_KEY`) | ~15.5M | ~0.05 ETH | ~0.16 ETH | ~0.47 ETH |
  | Locker factory key (`D17_LOCKER_FACTORY_PRIVATE_KEY`) | ~2.3M | ~0.007 ETH | ~0.023 ETH | ~0.07 ETH |

- Fund each one a little above its line for the expected gas price; `check:env` prints
  what each needs at the current price, with a margin. Only the gas used is spent.
- After the deployment both keys own nothing (every factory owner key is renounced):
  what is left on them can be sent back.

### 3. The site

- Domain connected to the Vercel project (Settings, Domains).
- A paid mainnet RPC with full log history and a **domain allowlist** set at the
  provider (the URL is visible in the browser). In Vercel, set
  `NEXT_PUBLIC_D17_MAINNET_RPC_URL` to it.

### 4. `contracts/.env` for mainnet

Keep the Sepolia file aside (`cp contracts/.env contracts/.env.sepolia`, ignored by git),
then fill `contracts/.env` with:

| Variable | Value |
|---|---|
| `RPC_URL` | the mainnet RPC URL |
| `D17_EXPECTED_CHAIN_ID` | `1` |
| `WETH_ADDRESS` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| `UNISWAP_V2_ROUTER` | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` |
| `FEE_CONFIG_OWNER` | the Safe address |
| `PROTOCOL_FEE_BPS` | `100` (1%) |
| `PROTOCOL_FEE_RECIPIENT` | empty (the fee splitter becomes the recipient) |
| `FEE_SPLIT_RECIPIENTS` | the 4 fee addresses, comma separated, no spaces, in the agreed order |
| `FEE_SPLIT_BPS` | `5000,1250,1250,2500` (same order) |
| `D17_FACTORY_PRIVATE_KEY` | factory key |
| `D17_LOCKER_FACTORY_PRIVATE_KEY` | locker factory key |
| `RENOUNCE_D17_FACTORY_OWNER` | `1` |
| `D17_CONFIRM_MAINNET_DEPLOY` | `1` |
| `ETHERSCAN_API_KEY` | the same key as for Sepolia |

The fee splitter's recipients and shares can **never** be changed once deployed: read
each address twice against the source it came from.

### 5. Code and checks

```bash
git pull && npm ci
npm run compile -w @d17/contracts
npm test -w @d17/contracts
npm run check:env -w @d17/contracts
```

`check:env` must end with "contracts/.env looks good". On mainnet it also checks the
WETH and router addresses, that the fee owner is a contract (the Safe), the confirmation
flag, the Etherscan key and each key's balance against the current gas price. Note the
commit hash (`git rev-parse HEAD`): it is the code being deployed.

## On the day

### 6. Deploy

```bash
npm run check:env -w @d17/contracts
npm run deploy:factory -w @d17/contracts
```

It sends 17 transactions in a row (fee splitter, fee config, the factories, the pins,
then every owner key renounced) and writes `contracts/runs/factory-deployment.json`.
Let it finish. If it stops halfway, do **not** run it again: keep the output and the
`runs/` folder as they are, and ask for help (a second run deploys a second suite and
spends the gas again).

### 7. Check the deployment

```bash
npm run verify:factory -w @d17/contracts
```

Must report **45 checks out of 45** passed (`contracts/runs/factory-verification.json`).

### 8. Publish the addresses

```bash
npm run publish:deployment -w @d17/contracts
npm run content:sync
npm run release:checksums && npm run check:release
git add -A && git commit -m "Deploy V15 on mainnet" && git push
```

This writes `deployments/mainnet.json` (and its copies for the web app and the API)
and the provenance record `release/deployments/mainnet.json`. The site reads them on its
next deploy.

### 9. Verify the source code on Etherscan

```bash
npm run verify:etherscan -w @d17/contracts -- --network mainnet --dry-run
npm run verify:etherscan -w @d17/contracts -- --network mainnet
```

The dry run must show 8 lines "OK"; the real run must end with "8 of 8 contracts
verified".

### 10. Switch the site

- In Vercel, set `NEXT_PUBLIC_D17_DEFAULT_NETWORK=mainnet` (visitors land on mainnet;
  the network switch keeps Sepolia one click away) and redeploy.
- Open the site in a private window: the header says Ethereum mainnet, the launch list
  loads (empty at first), and "Create a launch" offers start times at least 24 hours
  ahead.
- On Etherscan, read `owner()` on the fee config: it must be the Safe. Read
  `recipients()` on the fee splitter: the 4 addresses and shares.

### 11. Afterwards

- Restore the Sepolia file if needed (`cp contracts/.env.sepolia contracts/.env`).
- Send what is left on the two deployer keys back to a wallet you keep.
- Update `docs/PROGRESS.md` and `CHANGELOG.md` (mainnet deployed, block, date), then
  `npm run content:sync`.
