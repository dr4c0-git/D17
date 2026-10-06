import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ethers } from "ethers";

// Shared helpers for the local Hardhat E2E suites.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const hardhatCli = path.join(path.dirname(require.resolve("hardhat/package.json")), "dist/src/cli.js");

export const rows = {
  action: [],
  assertion: [],
  locker: [],
  walletPrice: []
};

export const failures = [];

export function artifact(file, name) {
  return JSON.parse(readFileSync(path.join(root, "artifacts", "contracts", file, `${name}.json`), "utf8"));
}

export function eth(value) {
  return ethers.parseEther(String(value));
}

export function record(table, row) {
  rows[table].push(row);
}

export function assertOk(name, condition, detail = "") {
  record("assertion", { name, passed: condition ? 1 : 0, detail });
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

export function errorMessage(error) {
  return String(error.shortMessage || error.message || error);
}

export function revertReason(error) {
  if (typeof error.reason === "string") return error.reason;
  if (Array.isArray(error.revert?.args) && typeof error.revert.args[0] === "string") return error.revert.args[0];
  const message = errorMessage(error);
  const match = /execution reverted: "([^"]+)"/.exec(message);
  return match ? match[1] : message;
}

export async function expectRevert(name, promiseFactory, expected) {
  try {
    const result = await promiseFactory();
    if (result?.wait) await result.wait();
  } catch (error) {
    const message = errorMessage(error);
    const reason = revertReason(error);
    assertOk(name, expected ? reason === expected : true, message.slice(0, 240));
    return;
  }
  assertOk(name, false, "transaction did not revert");
}

export async function wait(tx, label = "transaction") {
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${label} reverted`);
  return receipt;
}

export function parseLaunchCreated(factory, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "LaunchCreated") {
        return {
          creator: parsed.args.creator,
          launch: parsed.args.launch,
          token: parsed.args.token,
          liquidityVault: parsed.args.liquidityVault,
          rulesHash: parsed.args.rulesHash
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error("LaunchCreated event not found");
}

export async function deploy(file, name, signer, args = []) {
  const art = artifact(file, name);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

export async function now(provider) {
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  return Number(BigInt(block.timestamp));
}

export async function setTime(provider, timestamp) {
  const latest = await now(provider);
  await provider.send("evm_setNextBlockTimestamp", [Math.max(Number(timestamp), latest + 1)]);
  await provider.send("evm_mine", []);
}

export function compile() {
  execFileSync(process.execPath, [hardhatCli, "compile"], {
    cwd: root,
    stdio: "inherit"
  });
}

export function startNode(port) {
  const child = spawn(process.execPath, [hardhatCli, "--network", "hardhat", "node", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}

export async function waitForRpc(port, child) {
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) break;
    try {
      await provider.getBlockNumber();
      return provider;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("local Hardhat RPC did not start");
}
