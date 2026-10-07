import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import hardhatVerify from "@nomicfoundation/hardhat-verify";
import { configVariable, defineConfig } from "hardhat/config";

const configDir = path.dirname(fileURLToPath(import.meta.url));

for (const envPath of [path.join(configDir, ".env")]) {
  if (!existsSync(envPath)) continue;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export default defineConfig({
  plugins: [hardhatVerify],
  solidity: {
    version: "0.8.24",
    settings: {
      evmVersion: "shanghai",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 1
      },
      metadata: {
        bytecodeHash: "none"
      }
    }
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      blockGasLimit: 40_000_000,
      transactionGasCap: false
    },
    // Local simulation with chain id 1, used only by test/mainnet-floors-e2e.mjs to exercise
    // the mainnet-only launch minimums (24 h notice, 1 h windows). Not a real network.
    mainnetSim: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 1,
      blockGasLimit: 40_000_000,
      transactionGasCap: false
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL")
    }
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY")
    }
  },
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts",
    cache: "./cache"
  }
});
