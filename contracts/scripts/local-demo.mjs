// Local UI playground: starts a Hardhat chain (chain id 31337, free test ETH), deploys the
// V15 suite with mock WETH / Uniswap V2, creates two demo launches driven by bot wallets,
// points the web app at the chain (apps/web/.env.local) and starts it.
//
//   npm run demo:local            # chain + bots + web app on http://localhost:3000
//   npm run demo:local -- --no-web
//
// Everything runs on this machine and disappears when the script stops (Ctrl+C).
// Nothing here costs real money; the test accounts' keys are public and must never hold
// real funds.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { artifact, compile, deploy, eth, parseLaunchCreated, root, wait } from "../test/helpers.mjs";

const RPC_PORT = Number(process.env.D17_LOCAL_RPC_PORT || 8545);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const WITH_WEB = !process.argv.includes("--no-web");
const repoRoot = path.resolve(root, "..");
const webRoot = path.join(repoRoot, "apps", "web");
const envLocalPath = path.join(webRoot, ".env.local");
const envBackupPath = path.join(webRoot, ".env.local.before-demo");
const nextEnvPath = path.join(webRoot, "next-env.d.ts");
const hardhatCli = path.join(path.dirname(createRequire(import.meta.url).resolve("hardhat/package.json")), "dist/src/cli.js");
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const FEE_RECIPIENT = "0x00000000000000000000000000000000000fee01";

const children = [];
const nextEnvOriginal = existsSync(nextEnvPath) ? readFileSync(nextEnvPath, "utf8") : null;
let envWritten = false;

function log(message) {
  const time = new Date().toLocaleTimeString();
  console.log(`[demo ${time}] ${message}`);
}

function cleanup() {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  if (envWritten) {
    rmSync(envLocalPath, { force: true });
    if (existsSync(envBackupPath)) renameSync(envBackupPath, envLocalPath);
  }
  // `next dev` rewrites this tracked file; put it back as it was.
  if (nextEnvOriginal !== null) writeFileSync(nextEnvPath, nextEnvOriginal);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    log("stopping: chain, bots and web app shut down; apps/web/.env.local removed.");
    cleanup();
    process.exit(0);
  });
}
process.on("exit", cleanup);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chainProvider;
/** Waits until the chain's next block would carry at least `timestamp` (+2 s margin). */
async function waitUntil(timestamp) {
  for (;;) {
    const latest = Number((await chainProvider.getBlock("latest")).timestamp);
    const chainNow = Math.max(latest, Math.floor(Date.now() / 1000));
    const delay = (Number(timestamp) + 2 - chainNow) * 1000;
    if (delay <= 0) return;
    await sleep(Math.min(delay, 5000));
  }
}

function startChain() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hardhatCli, "--network", "localDemo", "node", "--hostname", "127.0.0.1", "--port", String(RPC_PORT)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push(child);
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      if (/Started HTTP and WebSocket JSON-RPC server/.test(output) && /Account #9/.test(output) && /Private Key/.test(output.split("Account #9")[1] || "")) {
        child.stdout.off("data", onData);
        resolve({ child, banner: output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("exit", (code) => reject(new Error(`Hardhat node exited (${code}). Is port ${RPC_PORT} already in use?`)));
  });
}

/** Account lines printed by `hardhat node`: these keys are Hardhat's public test keys. */
function accountsFromBanner(banner) {
  const accounts = [];
  const pattern = /Account #(\d+):\s+(0x[0-9a-fA-F]{40})[^\n]*\n\s*Private Key:\s+(0x[0-9a-fA-F]{64})/g;
  for (const match of banner.matchAll(pattern)) accounts[Number(match[1])] = { address: match[2], key: match[3] };
  return accounts;
}

function launchConfig(name, symbol, startTime, durations, treasury) {
  return {
    tokenName: name,
    tokenSymbol: symbol,
    description: `${name}: local demo launch on a throwaway Hardhat chain.`,
    logoSvgUri: "",
    links: [{ linkType: "website", url: "https://example.com" }],
    tokenSupply: eth("100000000"),
    saleTokens: eth("50000000"),
    lpTokens: eth("40000000"),
    manualDistributionTokens: eth("5000000"),
    deadTokens: eth("5000000"),
    deadRecipient: BURN_ADDRESS,
    treasury,
    startTime,
    roundSeconds: Array(5).fill(durations.round),
    refundSeconds: durations.refund,
    settlementSeconds: durations.settlement,
    minCommitWeth: eth("0.001"),
    minPhase1Weth: eth("0.5"),
    minAnchorPriceWad: eth("0.000000001"),
    roundSharesBps: [4000, 1500, 1500, 1500, 1500],
    treasuryBps: 500,
    refundPenaltyBps: 1000,
    maxProtocolFeeBps: 100
  };
}

async function main() {
  compile();
  log(`starting local chain on ${RPC_URL} (chain id 31337)`);
  const { banner } = await startChain();
  const accounts = accountsFromBanner(banner);
  const provider = new ethers.JsonRpcProvider(RPC_URL, 31337, { batchMaxCount: 1 });
  chainProvider = provider;
  const signer = (index) => provider.getSigner(index);

  const deployer = await signer(0);
  const creator = await signer(1);
  const bots = [await signer(2), await signer(3), await signer(4)];
  const treasuryAddress = accounts[8].address;
  const deployerAddress = await deployer.getAddress();

  log("deploying mock WETH / Uniswap V2 and the V15 suite");
  const weth = await deploy("test/TestWETH.sol", "TestWETH", deployer);
  const v2Factory = await deploy("test/TestV2Factory.sol", "TestV2Factory", deployer);
  const router = await deploy("test/TestV2Router.sol", "TestV2Router", deployer, [await v2Factory.getAddress()]);
  const feeConfig = await deploy("D17FeeConfig.sol", "D17FeeConfig", deployer, [deployerAddress, FEE_RECIPIENT, 100]);
  const d17Factory = await deploy("D17Factory.sol", "D17Factory", deployer, [
    deployerAddress,
    await weth.getAddress(),
    await router.getAddress(),
    await feeConfig.getAddress()
  ]);
  const tokenFactory = await deploy("D17TokenFactory.sol", "D17TokenFactory", deployer, [deployerAddress]);
  const vaultFactory = await deploy("D17LiquidityVaultFactory.sol", "D17LiquidityVaultFactory", deployer, [deployerAddress]);
  const launchDeployer = await deploy("D17LaunchDeployer.sol", "D17LaunchDeployer", deployer, [deployerAddress]);
  const launchFactory = await deploy("D17LaunchFactory.sol", "D17LaunchFactory", deployer, [
    await d17Factory.getAddress(),
    await tokenFactory.getAddress(),
    await vaultFactory.getAddress(),
    await launchDeployer.getAddress()
  ]);
  const lockerFactory = await deploy("D17LockerFactory.sol", "D17LockerFactory", deployer, [await d17Factory.getAddress()]);
  for (const pinned of [tokenFactory, vaultFactory, launchDeployer]) {
    await wait(await pinned.pinLaunchFactory(await launchFactory.getAddress()), "pin launch factory");
  }
  await wait(await d17Factory.pinLaunchFactory(await launchFactory.getAddress()), "pin d17 launch factory");
  await wait(await d17Factory.pinLockerFactory(await lockerFactory.getAddress()), "pin locker factory");
  for (const owned of [d17Factory, tokenFactory, vaultFactory, launchDeployer]) {
    await wait(await owned.renounceOwnership(), "renounce");
  }

  const lockerAbi = artifact("D17Locker.sol", "D17Locker").abi;
  const lockers = [];
  for (const bot of bots) {
    const owner = await bot.getAddress();
    const address = await lockerFactory.connect(bot).createLockerFor.staticCall(owner);
    await wait(await lockerFactory.connect(bot).createLockerFor(owner), "bot locker");
    lockers.push(new ethers.Contract(address, lockerAbi, bot));
  }

  async function createLaunch(cfg) {
    const receipt = await wait(await d17Factory.connect(creator).createLaunch(cfg, { gasLimit: 15_000_000 }), cfg.tokenName);
    const created = parseLaunchCreated(d17Factory, receipt);
    return {
      name: cfg.tokenName,
      address: created.launch,
      rulesHash: created.rulesHash,
      launch: new ethers.Contract(created.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer),
      vault: new ethers.Contract(created.liquidityVault, artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer)
    };
  }

  const t0 = Number((await provider.getBlock("latest")).timestamp);
  const fast = await createLaunch(launchConfig("Demo Fast Track", "FAST", t0 + 45, { round: 60, refund: 30, settlement: 30 }, treasuryAddress));
  const walk = await createLaunch(launchConfig("Demo Walkthrough", "WALK", t0 + 180, { round: 240, refund: 120, settlement: 120 }, treasuryAddress));

  if (WITH_WEB) {
    if (existsSync(envLocalPath)) renameSync(envLocalPath, envBackupPath);
    writeFileSync(envLocalPath, [
      "# Written by npm run demo:local and removed when it stops. Do not commit.",
      "NEXT_PUBLIC_D17_ENABLE_LOCAL=true",
      "NEXT_PUBLIC_D17_DEFAULT_NETWORK=local",
      "NEXT_PUBLIC_D17_DATA_MODE=rpc",
      `NEXT_PUBLIC_D17_LOCAL_RPC_URL=${RPC_URL}`,
      `NEXT_PUBLIC_D17_LOCAL_LAUNCH_ADDRESS=${walk.address}`,
      `NEXT_PUBLIC_D17_LOCAL_D17_FACTORY=${await d17Factory.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_FEE_CONFIG=${await feeConfig.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_TOKEN_FACTORY=${await tokenFactory.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_LAUNCH_DEPLOYER=${await launchDeployer.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_LAUNCH_FACTORY=${await launchFactory.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_VAULT_FACTORY=${await vaultFactory.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_LOCKER_FACTORY=${await lockerFactory.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_WETH=${await weth.getAddress()}`,
      `NEXT_PUBLIC_D17_LOCAL_ROUTER=${await router.getAddress()}`,
      "NEXT_PUBLIC_SITE_MODE=full",
      "NEXT_PUBLIC_ENABLE_DEPLOY=true",
      "NEXT_PUBLIC_ENABLE_USD=false",
      "NEXT_PUBLIC_D17_EVENT_POLL_SECONDS=3",
      "NEXT_PUBLIC_D17_STATE_POLL_SECONDS=3",
      ""
    ].join("\n"));
    envWritten = true;
    const web = spawn("npm", ["run", "dev", "-w", "@d17/web"], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
    children.push(web);
  }

  const you = accounts[5];
  const friend = accounts[6];
  console.log(`
==========================================================================
 D17 local demo is running (Ctrl+C stops everything)
--------------------------------------------------------------------------
 Web app        ${WITH_WEB ? "http://localhost:3000/?network=local" : "(not started: --no-web)"}
 Chain RPC      ${RPC_URL}   chain id 31337   currency ETH

 Wallet (MetaMask or similar, ideally in a separate browser profile):
   1. Add a network: RPC ${RPC_URL}, chain id 31337, symbol ETH.
   2. Import one of these PUBLIC Hardhat test accounts (10,000 test ETH each):
        you     ${you.address}
                ${you.key}
        friend  ${friend.address}
                ${friend.key}
      These keys are published by Hardhat: never send real funds to them.
   3. After each restart of this script, reset the wallet's nonce cache
      (MetaMask: Settings > Advanced > Clear activity tab data).

 Demo launches (created by ${await creator.getAddress()}):
   - Demo Fast Track  ${fast.address}
       starts in ~45 s, 60 s rounds; bots commit, refund, finalize, settle and
       open the pool by themselves (~8 min) so you can see every stage up to
       Trading and the creator vesting panel.
   - Demo Walkthrough ${walk.address}
       starts in ~3 min, 4 min rounds, 2 min windows; bots add a little
       activity; finalize / settle / create pool are left to you.
   Use /deploy to create your own launch (local rules: rounds >= 60 s).
==========================================================================
`);

  await Promise.all([runFastTrack(fast, lockers), runWalkthrough(walk, lockers)]);
  log("bot scripts finished; the chain and web app keep running until Ctrl+C.");
  await new Promise(() => {});
}

async function act(label, fn) {
  try {
    await wait(await fn(), label);
    log(label);
  } catch (error) {
    log(`${label} skipped: ${error.shortMessage || error.message}`);
  }
}

async function runFastTrack(demo, lockers) {
  const { launch, vault, address, rulesHash, name } = demo;
  const [a, b, c] = lockers;
  await waitUntil(await launch.roundStart(0));
  await act(`${name}: bot A commits 0.6 ETH in round 1`, () => a.commitToRound(address, 0, rulesHash, { value: eth("0.6") }));
  await act(`${name}: bot B commits 0.4 ETH in round 1`, () => b.commitToRound(address, 0, rulesHash, { value: eth("0.4") }));
  await act(`${name}: bot C commits 0.3 ETH in round 1`, () => c.commitToRound(address, 0, rulesHash, { value: eth("0.3") }));
  await waitUntil(await launch.roundEnd(0));
  await act(`${name}: bot C refunds round 1 (1% penalty into the pool)`, () => c.refundCurrentRound(address));
  for (let round = 1; round < 5; round++) {
    await waitUntil(await launch.roundStart(round));
    await act(`${name}: bot B commits 0.15 ETH in round ${round + 1}`, () => b.commitToRound(address, round, rulesHash, { value: eth("0.15") }));
    if (round % 2 === 0) {
      await act(`${name}: bot A commits 0.1 ETH in round ${round + 1}`, () => a.commitToRound(address, round, rulesHash, { value: eth("0.1") }));
    }
  }
  await waitUntil(await launch.roundEnd(4));
  await act(`${name}: finalize`, () => launch.finalizeLaunch());
  // C refunded its only commitment, so it has no position to settle.
  for (const [label, locker] of [["A", a], ["B", b]]) {
    await act(`${name}: bot ${label} settles and claims`, () => locker.settleAndClaim(address, rulesHash));
  }
  await waitUntil(await launch.poolCreationOpensAt());
  await act(`${name}: official pool created, trading open`, async () => {
    const block = await launch.runner.provider.getBlock("latest");
    return vault.createOfficialPool(1n, Number(block.timestamp) + 3600);
  });
}

async function runWalkthrough(demo, lockers) {
  const { launch, address, rulesHash, name } = demo;
  const [a, b] = lockers;
  await waitUntil(await launch.roundStart(0));
  await act(`${name}: bot A commits 0.4 ETH in round 1`, () => a.commitToRound(address, 0, rulesHash, { value: eth("0.4") }));
  await act(`${name}: bot B commits 0.3 ETH in round 1`, () => b.commitToRound(address, 0, rulesHash, { value: eth("0.3") }));
  for (let round = 1; round < 4; round++) {
    await waitUntil(Number(await launch.roundStart(round)) + 30);
    await act(`${name}: bot B commits 0.05 ETH in round ${round + 1}`, () => b.commitToRound(address, round, rulesHash, { value: eth("0.05") }));
  }
}

main().catch((error) => {
  console.error(error);
  cleanup();
  process.exit(1);
});
