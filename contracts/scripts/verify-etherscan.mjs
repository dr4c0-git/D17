// Publishes the source code of the deployed V15 suite on Etherscan, so anyone can read
// the code behind each address (the "Contract" tab shows a green check).
//
//   npm run verify:etherscan -w @d17/contracts                     Sepolia
//   npm run verify:etherscan -w @d17/contracts -- --network mainnet
//   npm run verify:etherscan -w @d17/contracts -- --dry-run         check only, sends nothing
//   add --print-args to print each contract's ABI-encoded constructor arguments, for a manual
//   verification on etherscan.io when the API queue is stuck
//   add --direct to skip Hardhat and call the Etherscan API itself: all contracts are sent
//   at once and every Etherscan answer is printed
//
// Needs RPC_URL and ETHERSCAN_API_KEY in contracts/.env (a free key from
// etherscan.io > My Account > API Keys, valid on every network). No private key: it
// only reads the chain and uploads source code. Addresses come from the public
// provenance file release/deployments/<network>.json; each contract's constructor
// arguments are read back from its own deployment transaction, after checking that
// the local build produces exactly the bytecode that was deployed.
import { ethers } from "ethers";
import { artifact, providerFromEnv, readJson, root } from "./lib.mjs";
import path from "node:path";

const SUITE = [
  { key: "feeSplitter", tx: "feeSplitterTransaction", name: "D17FeeSplitter" },
  { key: "feeConfig", tx: "feeConfigTransaction", name: "D17FeeConfig" },
  { key: "d17Factory", tx: "factoryTransaction", name: "D17Factory" },
  { key: "tokenFactory", tx: "tokenFactoryTransaction", name: "D17TokenFactory" },
  { key: "liquidityVaultFactory", tx: "liquidityVaultFactoryTransaction", name: "D17LiquidityVaultFactory" },
  { key: "launchDeployer", tx: "launchDeployerTransaction", name: "D17LaunchDeployer" },
  { key: "launchFactory", tx: "launchFactoryTransaction", name: "D17LaunchFactory" },
  { key: "lockerFactory", tx: "lockerFactoryTransaction", name: "D17LockerFactory" },
];

const args = process.argv.slice(2);
const network = args.includes("--network") ? args[args.indexOf("--network") + 1] : "sepolia";
const dryRun = args.includes("--dry-run");
if (!["sepolia", "mainnet"].includes(network)) fail(`Unknown network "${network}": use sepolia or mainnet.`);

const provenance = readJson(path.join(root, "..", "release", "deployments", `${network}.json`));
if (provenance.status !== "deployed") fail(`release/deployments/${network}.json says the suite is not deployed on ${network}.`);
if (!process.env.RPC_URL) fail("RPC_URL is missing in contracts/.env.");
if (!dryRun && !process.env.ETHERSCAN_API_KEY) {
  fail("ETHERSCAN_API_KEY is missing in contracts/.env: create a free key on etherscan.io > My Account > API Keys.");
}

const provider = providerFromEnv();
const chainId = Number((await provider.getNetwork()).chainId);
if (chainId !== Number(provenance.chainId)) fail(`RPC_URL is on chain ${chainId}, not ${network} (${provenance.chainId}).`);

// 1. Check every contract against the local build and recover its constructor arguments.
const targets = [];
for (const item of SUITE) {
  const address = item.key === "feeSplitter" ? provenance.feeSplitter?.address : provenance.contracts[item.key];
  if (!address) {
    if (item.key === "feeSplitter") continue; // a suite deployed without a splitter
    fail(`${item.key} is missing from release/deployments/${network}.json.`);
  }
  const build = artifact(`${item.name}.sol`, item.name);
  const tx = await provider.getTransaction(provenance.transactions[item.tx]);
  if (!tx) fail(`${item.name}: deployment transaction ${provenance.transactions[item.tx]} not found on ${network}.`);
  const receipt = await provider.getTransactionReceipt(tx.hash);
  if (tx.to !== null || receipt?.contractAddress?.toLowerCase() !== address.toLowerCase()) {
    fail(`${item.name}: transaction ${tx.hash} did not deploy ${address}.`);
  }
  if (!tx.data.toLowerCase().startsWith(build.bytecode.toLowerCase())) {
    fail(
      `${item.name}: the local build does not match the deployed bytecode. Compile from the deployed commit ` +
        "(npm run compile -w @d17/contracts) without changing the compiler settings, then try again."
    );
  }
  const encoded = `0x${tx.data.slice(build.bytecode.length)}`;
  const constructor = new ethers.Interface(build.abi).deploy;
  const constructorArgs = constructor.inputs.length ? [...ethers.AbiCoder.defaultAbiCoder().decode(constructor.inputs, encoded)] : [];
  targets.push({ ...item, address, encoded: encoded.slice(2), constructorArgs: normalize(constructorArgs) });
  console.log(`OK   ${item.name.padEnd(26)} ${address}  build matches, ${constructorArgs.length} constructor argument(s)`);
  // For a manual verification on etherscan.io (Standard-Json-Input with release/solc-input.json),
  // the form asks for these ABI-encoded constructor arguments, without the 0x prefix.
  if (args.includes("--print-args")) console.log(`     constructor arguments: ${encoded.slice(2) || "(none)"}`);
}
provider.destroy?.();

if (dryRun) {
  console.log(`\nDry run: ${targets.length} contracts ready to verify on ${network}. Nothing was sent.`);
  process.exit(0);
}

if (args.includes("--direct")) {
  await verifyDirect();
  process.exit(0);
}

// 2. Upload the sources through Hardhat's official Etherscan plugin. Hardhat reads the
//    network and its URL from these variables (hardhat.config.js).
process.env.HARDHAT_NETWORK = network;
process.env[`${network.toUpperCase()}_RPC_URL`] ??= process.env.RPC_URL;
const { default: hre } = await import("hardhat");
const { verifyContract } = await import("@nomicfoundation/hardhat-verify/verify");

const failed = [];
for (const target of targets) {
  console.log(`\nVerifying ${target.name} at ${target.address}...`);
  try {
    await verifyContract(
      {
        address: target.address,
        constructorArgs: target.constructorArgs,
        contract: `contracts/${target.name}.sol:${target.name}`,
        provider: "etherscan",
      },
      hre
    );
  } catch (error) {
    failed.push(target.name);
    console.error(`FAILED ${target.name}: ${error instanceof Error ? error.message : error}`);
  }
}

const explorer = network === "mainnet" ? "https://etherscan.io" : "https://sepolia.etherscan.io";
console.log(`\n${targets.length - failed.length} of ${targets.length} contracts verified. Check one: ${explorer}/address/${targets[0].address}#code`);
if (failed.length) {
  console.error(`Not verified: ${failed.join(", ")}. Run the command again: contracts already verified are skipped.`);
  process.exit(1);
}

/**
 * --direct: talks to the Etherscan API itself instead of going through Hardhat, and prints
 * every answer. It sends all the contracts first, then waits for all of them together, so a
 * slow Etherscan queue is waited on once instead of once per contract. Same files as the
 * manual form: release/solc-input.json and the constructor arguments read above.
 */
async function verifyDirect() {
  const api = `https://api.etherscan.io/v2/api?chainid=${provenance.chainId}`;
  const explorer = network === "mainnet" ? "https://etherscan.io" : "https://sepolia.etherscan.io";
  const sourceCode = JSON.stringify(readJson(path.join(root, "..", "release", "solc-input.json")));
  // The free Etherscan key allows 3 calls per second: wait between calls, and try again when
  // Etherscan still answers with its rate limit message.
  const call = async (fields, post = false) => {
    const body = new URLSearchParams({ ...fields, apikey: process.env.ETHERSCAN_API_KEY });
    for (let attempt = 0; ; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 1_000));
      const response = post ? await fetch(api, { method: "POST", body }) : await fetch(`${api}&${body}`);
      const json = await response.json();
      if (!/rate limit/i.test(String(json.result)) || attempt >= 5) return json;
    }
  };

  const pending = [];
  for (const target of targets) {
    const current = await call({ module: "contract", action: "getsourcecode", address: target.address });
    if (current.result?.[0]?.SourceCode) {
      console.log(`DONE ${target.name.padEnd(26)} already verified`);
      continue;
    }
    const sent = await call(
      {
        module: "contract",
        action: "verifysourcecode",
        codeformat: "solidity-standard-json-input",
        sourceCode,
        contractaddress: target.address,
        contractname: `project/contracts/${target.name}.sol:${target.name}`,
        compilerversion: "v0.8.24+commit.e11b9ed9",
        constructorArguements: target.encoded, // Etherscan's own spelling
      },
      true
    );
    if (sent.status === "1") {
      console.log(`SENT ${target.name.padEnd(26)} Etherscan ticket ${sent.result}`);
      pending.push({ ...target, guid: sent.result });
    } else {
      console.log(`NO   ${target.name.padEnd(26)} Etherscan refused: ${sent.result}`);
    }
  }

  // Etherscan answers "Pending in queue" until its compiler has run; ask every 15 s, up to 20 min.
  for (let round = 0; pending.length && round < 80; round++) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    for (const target of [...pending]) {
      const status = await call({ module: "contract", action: "checkverifystatus", guid: target.guid });
      if (/pending/i.test(status.result)) continue;
      pending.splice(pending.indexOf(target), 1);
      const ok = status.status === "1" || /already verified/i.test(status.result);
      console.log(`${ok ? "DONE" : "NO  "} ${target.name.padEnd(26)} ${status.result}`);
    }
    if (pending.length) console.log(`     still waiting in Etherscan's queue: ${pending.map((t) => t.name).join(", ")}`);
  }
  if (pending.length) console.log("Etherscan has not answered after 20 minutes. Run the same command later: verified contracts are skipped.");
  console.log(`Check: ${explorer}/address/${targets[0].address}#code`);
}

/** Decoded ABI values (ethers Result, bigint) → plain values Hardhat can re-encode. */
function normalize(value) {
  if (Array.isArray(value)) return [...value].map(normalize);
  if (typeof value === "bigint") return value.toString();
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
