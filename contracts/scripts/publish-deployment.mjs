#!/usr/bin/env node
// Writes the public deployment manifests (root, web, API, contracts copies) and the release
// provenance record from a deploy:factory output that verify:factory has accepted.
//
//   node scripts/publish-deployment.mjs --deployment runs/factory-deployment.json \
//     --verification runs/factory-verification.json
import { writeFileSync } from "node:fs";
import path from "node:path";
import { readJson, root } from "./lib.mjs";

const NETWORKS = {
  11155111: { network: "sepolia", provenanceName: "sepolia" },
  1: { network: "mainnet", provenanceName: "ethereum-mainnet" }
};
const CONTRACT_KEYS = [
  ["d17Factory", "factory"],
  ["feeConfig", "feeConfig"],
  ["tokenFactory", "tokenFactory"],
  ["launchDeployer", "launchDeployer"],
  ["launchFactory", "launchFactory"],
  ["liquidityVaultFactory", "liquidityVaultFactory"],
  ["lockerFactory", "lockerFactory"]
];

const deploymentPath = argValue("--deployment", "runs/factory-deployment.json");
const verificationPath = argValue("--verification", "runs/factory-verification.json");
const deployment = readJson(deploymentPath);
const verification = readJson(verificationPath);
const target = NETWORKS[deployment.chainId];
if (!target) throw new Error(`No public manifest for chain ${deployment.chainId}.`);
if (!verification.ok || verification.chainId !== deployment.chainId || verification.factory !== deployment.factory) {
  throw new Error("Refusing to publish: verification report is missing, failed, or for another deployment.");
}

const contracts = Object.fromEntries(CONTRACT_KEYS.map(([key, source]) => {
  if (!deployment[source]) throw new Error(`Deployment is missing ${source}.`);
  return [key, deployment[source]];
}));

const publicManifest = {
  schema: "d17-public-deployment-v2",
  chainId: deployment.chainId,
  network: target.network,
  protocolVersion: "V15_HARDENED",
  status: "deployed",
  startBlock: deployment.startBlock,
  contracts,
  weth: deployment.weth,
  router: deployment.router
};
const text = `${JSON.stringify(publicManifest, null, 2)}\n`;
const repo = path.resolve(root, "..");
for (const copy of ["deployments", "apps/web/deployments", "apps/api/deployments", "contracts/deployments"]) {
  writeFileSync(path.join(repo, copy, `${target.network}.json`), text);
}

const provenance = {
  schema: "d17-public-deployment-provenance-v2",
  network: target.provenanceName,
  chainId: deployment.chainId,
  protocolVersion: "V15_HARDENED",
  status: "deployed",
  startBlock: deployment.startBlock,
  deployedAt: deployment.createdAt,
  weth: deployment.weth,
  router: deployment.router,
  contracts,
  protocolFee: verification.protocolFee,
  feeConfigOwner: deployment.feeConfigOwner,
  transactions: Object.fromEntries(Object.entries(deployment).filter(([key]) => key.endsWith("Transaction"))),
  verification: {
    report: path.basename(verificationPath),
    checks: verification.checks.length,
    ok: verification.ok
  }
};
writeFileSync(path.join(repo, "release", "deployments", `${target.network}.json`), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Published ${target.network} V15 deployment manifests (factory ${deployment.factory}).`);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}
