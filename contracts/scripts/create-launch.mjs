#!/usr/bin/env node
import { ethers } from "ethers";
import {
  artifact,
  buildLaunchConfig,
  launchMetadataHash,
  normalizeLaunchMetadata,
  providerFromEnv,
  readJson,
  requireEnv,
  writeJson
} from "./lib.mjs";

const configPath = process.argv.includes("--config")
  ? process.argv[process.argv.indexOf("--config") + 1]
  : "scripts/example-launch.config.json";
const out = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : "runs/launch-deployment.json";

const provider = providerFromEnv();
const network = await provider.getNetwork();
const chainId = Number(network.chainId);
const expectedChainId = Number(process.env.D17_EXPECTED_CHAIN_ID || process.env.EXPECTED_CHAIN_ID || chainId);
if (chainId !== expectedChainId) {
  throw new Error(`RPC chain id ${chainId} does not match expected chain id ${expectedChainId}.`);
}
const signer = new ethers.Wallet(requireEnv("TOKEN_DEPLOYER_PRIVATE_KEY"), provider);
const factoryAddress = process.env.FACTORY_ADDRESS || requireEnv("FACTORY_ADDRESS");
const config = readJson(configPath);
const block = await provider.getBlock("latest");
const treasury = config.treasury || requireEnv("TREASURY_ADDRESS");
const launchConfig = buildLaunchConfig(config, Number(block.timestamp), treasury);

const factoryArt = artifact("D17Factory.sol", "D17Factory");
const launchArt = artifact("D17Launch.sol", "D17Launch");
const factory = new ethers.Contract(factoryAddress, factoryArt.abi, signer);
const tx = await factory.createLaunch(launchConfig);
const receipt = await tx.wait();
if (receipt.status !== 1) throw new Error("createLaunch reverted");
const receiptBlock = await provider.getBlock(receipt.blockNumber);
const created = parseLaunchCreated(factory, receipt);
if (!created) throw new Error("LaunchCreated event not found");

const launch = new ethers.Contract(created.launch, launchArt.abi, provider);
const launchId = await launch.D17_LAUNCH_ID();
const rulesHash = await launch.rulesHash();
const metadata = normalizeLaunchMetadata(config);
const metadataEvent = parseLaunchMetadataPublished(factory, receipt);

const deployment = {
  schema: "d17-launch-deployment-v1",
  createdAt: new Date().toISOString(),
  chainId,
  factory: factoryAddress,
  tokenDeployer: await signer.getAddress(),
  token: created.token,
  launch: created.launch,
  liquidityVault: created.liquidityVault,
  launchId,
  rulesHash,
  manualDistribution: {
    tokens: (await launch.manualDistributionTokens()).toString(),
    recipient: await launch.manualDistributionRecipient(),
    vestedBy: created.liquidityVault
  },
  protocolFee: {
    bps: Number(await launch.protocolFeeBps()),
    recipient: await launch.protocolFeeRecipient()
  },
  metadataHash: await launch.metadataHash(),
  metadata: {
    ...metadata,
    logoBytes: Buffer.byteLength(metadata.logoSvgUri, "utf8"),
    linkCount: metadata.links.length,
    expectedHash: launchMetadataHash(config, launchId),
    eventHash: metadataEvent?.metadataHash || null
  },
  transaction: tx.hash,
  gas: {
    used: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.gasPrice?.toString() || null,
    blockNumber: receipt.blockNumber,
    blockGasLimit: receiptBlock?.gasLimit?.toString() || null,
    gasUsedToBlockGasLimitBps: receiptBlock?.gasLimit
      ? ((receipt.gasUsed * 10_000n) / receiptBlock.gasLimit).toString()
      : null
  },
  config: {
    ...config,
    startTime: launchConfig.startTime,
    treasury: launchConfig.treasury
  }
};

writeJson(out, deployment);
console.log(JSON.stringify(deployment, null, 2));
provider.destroy?.();

function parseLaunchCreated(factory, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "LaunchCreated") {
        return {
          creator: parsed.args.creator,
          launch: parsed.args.launch,
          token: parsed.args.token,
          liquidityVault: parsed.args.liquidityVault,
          rulesHash: parsed.args.rulesHash,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

function parseLaunchMetadataPublished(factory, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "LaunchMetadataPublished") {
        return {
          launch: parsed.args.launch,
          metadataHash: parsed.args.metadataHash,
          description: parsed.args.description,
          logoSvgUri: parsed.args.logoSvgUri,
          linkTypes: Array.from(parsed.args.linkTypes),
          linkUrls: Array.from(parsed.args.linkUrls)
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}
