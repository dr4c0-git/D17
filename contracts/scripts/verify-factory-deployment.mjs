#!/usr/bin/env node
import { ethers } from "ethers";
import { artifact, providerFromEnv, readJson, writeJson } from "./lib.mjs";

const MAINNET_CHAIN_ID = 1;
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const MAINNET_UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const ZERO = ethers.ZeroAddress;

const deploymentPath = argValue("--deployment", "runs/factory-deployment.json");
const out = argValue("--out", "runs/factory-verification.json");
const deployment = readJson(deploymentPath);
const provider = providerFromEnv();
const network = await provider.getNetwork();
const chainId = Number(network.chainId);
const expectedChainId = Number(process.env.D17_EXPECTED_CHAIN_ID || process.env.EXPECTED_CHAIN_ID || deployment.chainId || chainId);

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

function sameAddress(a, b) {
  return ethers.getAddress(a) === ethers.getAddress(b);
}

async function hasCode(label, address) {
  const code = await provider.getCode(address);
  check(`${label} has deployed bytecode`, code && code !== "0x", address);
}

if (chainId !== expectedChainId) {
  throw new Error(`RPC chain id ${chainId} does not match expected chain id ${expectedChainId}.`);
}

const factoryArt = artifact("D17Factory.sol", "D17Factory");
const tokenFactoryArt = artifact("D17TokenFactory.sol", "D17TokenFactory");
const vaultFactoryArt = artifact("D17LiquidityVaultFactory.sol", "D17LiquidityVaultFactory");
const launchFactoryArt = artifact("D17LaunchFactory.sol", "D17LaunchFactory");
const launchDeployerArt = artifact("D17LaunchDeployer.sol", "D17LaunchDeployer");
const lockerFactoryArt = artifact("D17LockerFactory.sol", "D17LockerFactory");

const factory = new ethers.Contract(deployment.factory, factoryArt.abi, provider);
const tokenFactory = new ethers.Contract(deployment.tokenFactory, tokenFactoryArt.abi, provider);
const vaultFactory = new ethers.Contract(deployment.liquidityVaultFactory, vaultFactoryArt.abi, provider);
const launchFactory = new ethers.Contract(deployment.launchFactory, launchFactoryArt.abi, provider);
const launchDeployer = new ethers.Contract(deployment.launchDeployer, launchDeployerArt.abi, provider);
const lockerFactory = new ethers.Contract(deployment.lockerFactory, lockerFactoryArt.abi, provider);

await hasCode("D17Factory", deployment.factory);
await hasCode("D17TokenFactory", deployment.tokenFactory);
await hasCode("D17LiquidityVaultFactory", deployment.liquidityVaultFactory);
await hasCode("D17LaunchFactory", deployment.launchFactory);
await hasCode("D17LaunchDeployer", deployment.launchDeployer);
await hasCode("D17LockerFactory", deployment.lockerFactory);

check("deployment chain id matches RPC", deployment.chainId === chainId, `${deployment.chainId} vs ${chainId}`);
if (chainId === MAINNET_CHAIN_ID) {
  check("mainnet deployment has startBlock", Number.isInteger(deployment.startBlock) && deployment.startBlock >= 0, String(deployment.startBlock));
} else {
  check("deployment has startBlock", Number.isInteger(deployment.startBlock) && deployment.startBlock >= 0, String(deployment.startBlock));
}

check("D17Factory identity matches", await factory.D17_FACTORY_ID() === ethers.keccak256(ethers.toUtf8Bytes("D17_FACTORY_V14_1_REFUND_SCHEDULE_BURN_GATE")));
check("D17TokenFactory identity matches", await tokenFactory.D17_TOKEN_FACTORY_ID() === ethers.keccak256(ethers.toUtf8Bytes("D17_TOKEN_FACTORY_V14_1_REFUND_SCHEDULE_BURN_GATE")));
check(
  "D17LiquidityVaultFactory identity matches",
  await vaultFactory.D17_LIQUIDITY_VAULT_FACTORY_ID() === ethers.keccak256(ethers.toUtf8Bytes("D17_LIQUIDITY_VAULT_FACTORY_V14_1_REFUND_SCHEDULE_BURN_GATE"))
);

check("factory WETH matches deployment", sameAddress(await factory.weth(), deployment.weth));
check("factory router matches deployment", sameAddress(await factory.router(), deployment.router));
check("factory launch factory pinned", await factory.launchFactoryPinned());
check("factory locker factory pinned", await factory.lockerFactoryPinned());
check("factory launchFactory address", sameAddress(await factory.launchFactory(), deployment.launchFactory));
check("factory lockerFactory address", sameAddress(await factory.lockerFactory(), deployment.lockerFactory));

check("token factory launch factory pinned", await tokenFactory.launchFactoryPinned());
check("token factory launchFactory address", sameAddress(await tokenFactory.launchFactory(), deployment.launchFactory));
check("vault factory launch factory pinned", await vaultFactory.launchFactoryPinned());
check("vault factory launchFactory address", sameAddress(await vaultFactory.launchFactory(), deployment.launchFactory));

check("launch deployer launch factory pinned", await launchDeployer.launchFactoryPinned());
check("launch deployer launchFactory address", sameAddress(await launchDeployer.launchFactory(), deployment.launchFactory));
check("launch factory points to launch deployer", sameAddress(await launchFactory.launchDeployer(), deployment.launchDeployer));
check("launch factory points to D17Factory", sameAddress(await launchFactory.d17Factory(), deployment.factory));
check("launch factory points to token factory", sameAddress(await launchFactory.tokenFactory(), deployment.tokenFactory));
check("launch factory points to liquidity vault factory", sameAddress(await launchFactory.liquidityVaultFactory(), deployment.liquidityVaultFactory));
check("locker factory points to D17Factory", sameAddress(await lockerFactory.d17Factory(), deployment.factory));

if (chainId === MAINNET_CHAIN_ID) {
  check("mainnet WETH is canonical", sameAddress(deployment.weth, MAINNET_WETH));
  check("mainnet Uniswap V2 router is canonical", sameAddress(deployment.router, MAINNET_UNISWAP_V2_ROUTER));
}

const expectRenounced = chainId === MAINNET_CHAIN_ID || process.env.EXPECT_RENOUNCED === "1" || Boolean(deployment.renounceTransaction);
if (expectRenounced) {
  check("D17Factory owner renounced", sameAddress(await factory.owner(), ZERO));
  check("D17TokenFactory owner renounced", sameAddress(await tokenFactory.owner(), ZERO));
  check("D17LiquidityVaultFactory owner renounced", sameAddress(await vaultFactory.owner(), ZERO));
  check("D17LaunchDeployer owner renounced", sameAddress(await launchDeployer.owner(), ZERO));
} else {
  check("D17Factory owner matches deployment owner", sameAddress(await factory.owner(), deployment.factoryOwner));
  check("D17TokenFactory owner matches launch deployer", sameAddress(await tokenFactory.owner(), deployment.launchFactoryDeployer));
  check("D17LiquidityVaultFactory owner matches launch deployer", sameAddress(await vaultFactory.owner(), deployment.launchFactoryDeployer));
  check("D17LaunchDeployer owner matches launch deployer", sameAddress(await launchDeployer.owner(), deployment.launchFactoryDeployer));
}

const ok = checks.every((entry) => entry.ok);
const report = {
  schema: "d17-factory-verification-v1",
  createdAt: new Date().toISOString(),
  deployment: deploymentPath,
  chainId,
  factory: deployment.factory,
  startBlock: deployment.startBlock ?? null,
  ok,
  checks
};

writeJson(out, report);
console.log(JSON.stringify(report, null, 2));
provider.destroy?.();

if (!ok) process.exit(1);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
