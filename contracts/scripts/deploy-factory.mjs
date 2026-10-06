#!/usr/bin/env node
import { ethers } from "ethers";
import { artifact, providerFromEnv, requireEnv, writeJson } from "./lib.mjs";

const MAINNET_CHAIN_ID = 1;
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const MAINNET_UNISWAP_V2_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";

const out = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "runs/factory-deployment.json";

const provider = providerFromEnv();
const network = await provider.getNetwork();
const chainId = Number(network.chainId);
const expectedChainId = Number(process.env.D17_EXPECTED_CHAIN_ID || process.env.EXPECTED_CHAIN_ID || chainId);
if (chainId !== expectedChainId) {
  throw new Error(`RPC chain id ${chainId} does not match expected chain id ${expectedChainId}.`);
}
const startBlock = await provider.getBlockNumber();

const weth = requireEnv("WETH_ADDRESS");
const router = requireEnv("UNISWAP_V2_ROUTER");
// V15 refuses to create launches while any factory owner key exists, so the deployment is
// only usable once every owner has renounced. Keep the flag explicit for the operator.
if (process.env.RENOUNCE_D17_FACTORY_OWNER !== "1") {
  throw new Error("RENOUNCE_D17_FACTORY_OWNER=1 is required: V15 launches cannot be created before renounce.");
}

const feeConfigOwner = ethers.getAddress(requireEnv("FEE_CONFIG_OWNER"));
const protocolFeeRecipient = process.env.PROTOCOL_FEE_RECIPIENT ? ethers.getAddress(process.env.PROTOCOL_FEE_RECIPIENT) : ethers.ZeroAddress;
const protocolFeeBps = Number(process.env.PROTOCOL_FEE_BPS ?? "0");
if (!Number.isInteger(protocolFeeBps) || protocolFeeBps < 0 || protocolFeeBps > 200) {
  throw new Error("PROTOCOL_FEE_BPS must be an integer between 0 and 200 (2% hard cap).");
}
if (protocolFeeBps > 0 && protocolFeeRecipient === ethers.ZeroAddress) {
  throw new Error("PROTOCOL_FEE_RECIPIENT is required when PROTOCOL_FEE_BPS > 0.");
}

if (chainId === MAINNET_CHAIN_ID) {
  if ((await provider.getCode(feeConfigOwner)) === "0x") {
    throw new Error("Mainnet FEE_CONFIG_OWNER must be a contract (multisig), not an EOA.");
  }
  if (process.env.D17_CONFIRM_MAINNET_DEPLOY !== "1") {
    throw new Error("Refusing mainnet deployment without D17_CONFIRM_MAINNET_DEPLOY=1.");
  }
  if (process.env.RENOUNCE_D17_FACTORY_OWNER !== "1") {
    throw new Error("Mainnet deployment requires RENOUNCE_D17_FACTORY_OWNER=1.");
  }
  if (ethers.getAddress(weth) !== MAINNET_WETH) {
    throw new Error(`Mainnet WETH_ADDRESS must be ${MAINNET_WETH}.`);
  }
  if (ethers.getAddress(router) !== MAINNET_UNISWAP_V2_ROUTER) {
    throw new Error(`Mainnet UNISWAP_V2_ROUTER must be ${MAINNET_UNISWAP_V2_ROUTER}.`);
  }
}

// One NonceManager per key: the script chains many transactions from the same key
// (possibly through several roles), and RPCs can report a stale pending nonce.
const nonceManagers = new Map();
function managedSigner(privateKey) {
  const wallet = new ethers.Wallet(privateKey, provider);
  if (!nonceManagers.has(wallet.address)) nonceManagers.set(wallet.address, new ethers.NonceManager(wallet));
  return nonceManagers.get(wallet.address);
}
const d17FactorySigner = managedSigner(requireEnv("D17_FACTORY_PRIVATE_KEY"));
const launchFactorySigner = managedSigner(process.env.D17_LAUNCH_FACTORY_PRIVATE_KEY || requireEnv("D17_FACTORY_PRIVATE_KEY"));
const lockerFactorySigner = managedSigner(requireEnv("D17_LOCKER_FACTORY_PRIVATE_KEY"));
const d17FactoryDeployer = await d17FactorySigner.getAddress();
const launchFactoryDeployer = await launchFactorySigner.getAddress();
const lockerFactoryDeployer = await lockerFactorySigner.getAddress();
if (d17FactoryDeployer === lockerFactoryDeployer && process.env.ALLOW_SHARED_DEPLOYER !== "1") {
  throw new Error("D17_FACTORY_PRIVATE_KEY and D17_LOCKER_FACTORY_PRIVATE_KEY must be different for this run.");
}

const owner = process.env.D17_FACTORY_OWNER || d17FactoryDeployer;
if (ethers.getAddress(owner) !== d17FactoryDeployer) {
  throw new Error("D17_FACTORY_OWNER must match D17_FACTORY_PRIVATE_KEY so the official locker factory can be pinned.");
}

const feeConfigArt = artifact("D17FeeConfig.sol", "D17FeeConfig");
const FeeConfig = new ethers.ContractFactory(feeConfigArt.abi, feeConfigArt.bytecode, d17FactorySigner);
const feeConfig = await FeeConfig.deploy(feeConfigOwner, protocolFeeRecipient, protocolFeeBps);
await feeConfig.waitForDeployment();

const art = artifact("D17Factory.sol", "D17Factory");
const contractFactory = new ethers.ContractFactory(art.abi, art.bytecode, d17FactorySigner);
const factory = await contractFactory.deploy(owner, weth, router, await feeConfig.getAddress());
await factory.waitForDeployment();

const tokenFactoryArt = artifact("D17TokenFactory.sol", "D17TokenFactory");
const TokenFactory = new ethers.ContractFactory(tokenFactoryArt.abi, tokenFactoryArt.bytecode, launchFactorySigner);
const tokenFactory = await TokenFactory.deploy(launchFactoryDeployer);
await tokenFactory.waitForDeployment();

const vaultFactoryArt = artifact("D17LiquidityVaultFactory.sol", "D17LiquidityVaultFactory");
const VaultFactory = new ethers.ContractFactory(vaultFactoryArt.abi, vaultFactoryArt.bytecode, launchFactorySigner);
const vaultFactory = await VaultFactory.deploy(launchFactoryDeployer);
await vaultFactory.waitForDeployment();

const launchDeployerArt = artifact("D17LaunchDeployer.sol", "D17LaunchDeployer");
const LaunchDeployer = new ethers.ContractFactory(launchDeployerArt.abi, launchDeployerArt.bytecode, launchFactorySigner);
const launchDeployer = await LaunchDeployer.deploy(launchFactoryDeployer);
await launchDeployer.waitForDeployment();

const launchFactoryArt = artifact("D17LaunchFactory.sol", "D17LaunchFactory");
const LaunchFactory = new ethers.ContractFactory(launchFactoryArt.abi, launchFactoryArt.bytecode, launchFactorySigner);
const launchFactory = await LaunchFactory.deploy(
  await factory.getAddress(),
  await tokenFactory.getAddress(),
  await vaultFactory.getAddress(),
  await launchDeployer.getAddress()
);
await launchFactory.waitForDeployment();
const pinLaunchDeployerTx = await launchDeployer.connect(launchFactorySigner).pinLaunchFactory(await launchFactory.getAddress());
await pinLaunchDeployerTx.wait();
const pinTokenFactoryTx = await tokenFactory.connect(launchFactorySigner).pinLaunchFactory(await launchFactory.getAddress());
await pinTokenFactoryTx.wait();
const pinVaultFactoryTx = await vaultFactory.connect(launchFactorySigner).pinLaunchFactory(await launchFactory.getAddress());
await pinVaultFactoryTx.wait();
const pinLaunchTx = await factory.connect(d17FactorySigner).pinLaunchFactory(await launchFactory.getAddress());
await pinLaunchTx.wait();

const lockerFactoryArt = artifact("D17LockerFactory.sol", "D17LockerFactory");
const LockerFactory = new ethers.ContractFactory(lockerFactoryArt.abi, lockerFactoryArt.bytecode, lockerFactorySigner);
const lockerFactory = await LockerFactory.deploy(await factory.getAddress());
await lockerFactory.waitForDeployment();
const pinTx = await factory.connect(d17FactorySigner).pinLockerFactory(await lockerFactory.getAddress());
await pinTx.wait();

let renounceTransaction = null;
let tokenFactoryRenounceTransaction = null;
let vaultFactoryRenounceTransaction = null;
let launchDeployerRenounceTransaction = null;
{
  const tokenFactoryRenounceTx = await tokenFactory.connect(launchFactorySigner).renounceOwnership();
  await tokenFactoryRenounceTx.wait();
  tokenFactoryRenounceTransaction = tokenFactoryRenounceTx.hash;
  const vaultFactoryRenounceTx = await vaultFactory.connect(launchFactorySigner).renounceOwnership();
  await vaultFactoryRenounceTx.wait();
  vaultFactoryRenounceTransaction = vaultFactoryRenounceTx.hash;
  const launchDeployerRenounceTx = await launchDeployer.connect(launchFactorySigner).renounceOwnership();
  await launchDeployerRenounceTx.wait();
  launchDeployerRenounceTransaction = launchDeployerRenounceTx.hash;
  const renounceTx = await factory.connect(d17FactorySigner).renounceOwnership();
  await renounceTx.wait();
  renounceTransaction = renounceTx.hash;
}

const deployment = {
  schema: "d17-factory-deployment-v1",
  createdAt: new Date().toISOString(),
  chainId,
  startBlock,
  d17FactoryDeployer,
  launchFactoryDeployer,
  lockerFactoryDeployer,
  factoryOwner: owner,
  weth,
  router,
  factory: await factory.getAddress(),
  feeConfig: await feeConfig.getAddress(),
  feeConfigOwner,
  protocolFeeRecipient,
  protocolFeeBps,
  tokenFactory: await tokenFactory.getAddress(),
  liquidityVaultFactory: await vaultFactory.getAddress(),
  launchDeployer: await launchDeployer.getAddress(),
  launchFactory: await launchFactory.getAddress(),
  lockerFactory: await lockerFactory.getAddress(),
  feeConfigTransaction: feeConfig.deploymentTransaction()?.hash,
  factoryTransaction: factory.deploymentTransaction()?.hash,
  tokenFactoryTransaction: tokenFactory.deploymentTransaction()?.hash,
  liquidityVaultFactoryTransaction: vaultFactory.deploymentTransaction()?.hash,
  launchDeployerTransaction: launchDeployer.deploymentTransaction()?.hash,
  launchFactoryTransaction: launchFactory.deploymentTransaction()?.hash,
  pinLaunchDeployerTransaction: pinLaunchDeployerTx.hash,
  pinTokenFactoryTransaction: pinTokenFactoryTx.hash,
  pinLiquidityVaultFactoryTransaction: pinVaultFactoryTx.hash,
  pinLaunchFactoryTransaction: pinLaunchTx.hash,
  lockerFactoryTransaction: lockerFactory.deploymentTransaction()?.hash,
  pinLockerFactoryTransaction: pinTx.hash,
  renounceTransaction,
  tokenFactoryRenounceTransaction,
  vaultFactoryRenounceTransaction,
  launchDeployerRenounceTransaction
};

writeJson(out, deployment);
console.log(JSON.stringify(deployment, null, 2));
provider.destroy?.();
