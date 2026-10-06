#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const requestedChainId = Number(process.env.CHAIN_ID || (process.env.NETWORK === "mainnet" ? 1 : 11155111));
const networkName = requestedChainId === 11155111 ? "sepolia" : requestedChainId === 1 ? "mainnet" : "";
if (!networkName) throw new Error(`Unsupported public deployment chain: ${requestedChainId}`);
const rpcUrl = process.env.RPC_URL || (networkName === "mainnet"
  ? process.env.NEXT_PUBLIC_D17_MAINNET_RPC_URL
  : process.env.NEXT_PUBLIC_D17_SEPOLIA_RPC_URL);
if (!rpcUrl) throw new Error(`Set RPC_URL or the ${networkName} frontend RPC variable.`);

const deploymentFile = process.env.DEPLOYMENT_FILE || path.resolve("deployments", `${networkName}.json`);
const deployment = JSON.parse(readFileSync(deploymentFile, "utf8"));
if (deployment.status !== "deployed") {
  console.log(`D17 V15 is not deployed on ${networkName} yet (manifest status "${deployment.status}"); RPC smoke skipped.`);
  process.exit(0);
}
const abi = JSON.parse(readFileSync(path.resolve("public/abi/D17Factory.abi.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(rpcUrl, requestedChainId, { batchMaxCount: 1 });
const expectedFactoryId = ethers.keccak256(ethers.toUtf8Bytes("D17_FACTORY_V15_HARDENED"));
const expectedConfigFields = [
  "tokenName", "tokenSymbol", "description", "logoSvgUri", "links",
  "tokenSupply", "saleTokens", "lpTokens", "manualDistributionTokens", "deadTokens",
  "deadRecipient", "treasury", "startTime", "roundSeconds", "refundSeconds",
  "settlementSeconds", "minCommitWeth", "minPhase1Weth", "minAnchorPriceWad",
  "roundSharesBps", "treasuryBps", "refundPenaltyBps", "maxProtocolFeeBps",
];
const createLaunch = abi.find((entry) => entry.type === "function" && entry.name === "createLaunch");
const configFields = createLaunch?.inputs?.[0]?.components?.map((component) => component.name) || [];
if (JSON.stringify(configFields) !== JSON.stringify(expectedConfigFields)) {
  throw new Error(`Unexpected createLaunch config fields: ${configFields.join(",")}`);
}

try {
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== requestedChainId) {
    throw new Error(`Expected chain ${requestedChainId}, received ${network.chainId}`);
  }

  for (const [name, address] of Object.entries(deployment.contracts)) {
    const code = await provider.getCode(address);
    if (code === "0x") throw new Error(`No deployed code for ${name} at ${address}`);
  }

  const factory = new ethers.Contract(deployment.contracts.d17Factory, abi, provider);
  const factoryId = await factory.D17_FACTORY_ID();
  if (factoryId.toLowerCase() !== expectedFactoryId.toLowerCase()) {
    throw new Error(`Unexpected D17 factory ID: ${factoryId}`);
  }

  const latestBlock = await provider.getBlockNumber();
  const chunkSize = Math.max(1, Number(process.env.EVENT_CHUNK_SIZE || 1_000));
  const launches = [];
  for (let start = Number(deployment.startBlock); start <= latestBlock; start += chunkSize) {
    const end = Math.min(latestBlock, start + chunkSize - 1);
    const logs = await provider.getLogs({
      address: deployment.contracts.d17Factory,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name !== "LaunchCreated") continue;
        launches.push({
          launch: ethers.getAddress(parsed.args.launch),
          token: ethers.getAddress(parsed.args.token),
          blockNumber: Number(log.blockNumber),
        });
      } catch {
        // Ignore unrelated factory events.
      }
    }
  }

  console.log(JSON.stringify({
    ok: true,
    chainId: requestedChainId,
    factory: deployment.contracts.d17Factory,
    factoryId,
    createLaunchConfigFields: configFields,
    latestBlock,
    launchCount: launches.length,
    launches,
  }, null, 2));
} finally {
  provider.destroy();
}
