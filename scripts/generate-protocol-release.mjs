import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { EXPLORER_CONTRACTS as contracts } from "../contracts/scripts/contract-list.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contractRoot = path.join(root, "contracts");
const releaseRoot = path.join(root, "release");

const productionSources = [
  "contracts/D17Factory.sol",
  "contracts/D17FeeConfig.sol",
  "contracts/D17LaunchDeployer.sol",
  "contracts/D17Launch.sol",
  "contracts/D17LaunchFactory.sol",
  "contracts/D17LiquidityVault.sol",
  "contracts/D17LiquidityVaultFactory.sol",
  "contracts/D17Locker.sol",
  "contracts/D17LockerFactory.sol",
  "contracts/D17Token.sol",
  "contracts/D17TokenFactory.sol",
  "contracts/interfaces/ID17.sol",
  "contracts/interfaces/ID17LaunchFactory.sol",
  "contracts/lib/D17SafeTransfer.sol",
];

const buildInfoName = readdirSync(path.join(contractRoot, "artifacts/build-info"))
  .find((name) => name.endsWith(".json") && !name.endsWith(".output.json"));
if (!buildInfoName) throw new Error("Compile contracts before generating protocol release metadata.");
const buildInfo = readJson(path.join(contractRoot, "artifacts/build-info", buildInfoName));

const contractRecords = {};
for (const name of contracts) {
  const fresh = readJson(path.join(contractRoot, `artifacts/contracts/${name}.sol/${name}.json`));
  const referenceArtifact = readJson(path.join(contractRoot, `abi/${name}.artifact.json`));
  const abiPath = path.join(contractRoot, `abi/${name}.abi.json`);
  const abiText = readFileSync(abiPath, "utf8");
  if (fresh.bytecode !== referenceArtifact.bytecode) throw new Error(`${name} creation bytecode differs from the published artifact.`);
  if (JSON.stringify(fresh.abi) !== JSON.stringify(JSON.parse(abiText))) throw new Error(`${name} ABI differs from the published artifact.`);
  contractRecords[name] = {
    source: `contracts/contracts/${name}.sol`,
    abiSha256: sha256(abiText),
    creationBytecodeBytes: hexBytes(fresh.bytecode),
    creationBytecodeKeccak256: ethers.keccak256(fresh.bytecode),
    deployedBytecodeBytes: hexBytes(fresh.deployedBytecode),
    deployedBytecodeKeccak256: ethers.keccak256(fresh.deployedBytecode),
    immutableReferences: fresh.immutableReferences,
    artifactCreationBytecodeMatch: true,
    artifactAbiMatch: true,
  };
}

const identityLiterals = {
  factory: "D17_FACTORY_V15_HARDENED",
  feeConfig: "D17_FEE_CONFIG_V15_HARDENED",
  tokenFactory: "D17_TOKEN_FACTORY_V15_HARDENED",
  liquidityVaultFactory: "D17_LIQUIDITY_VAULT_FACTORY_V15_HARDENED",
  launchDeployer: "D17_LAUNCH_DEPLOYER_V15_HARDENED",
  launch: "D17_LAUNCH_V15_HARDENED",
  liquidityVault: "D17_LIQUIDITY_VAULT_V15_HARDENED",
  token: "D17_TOKEN_V15_HARDENED",
};

// Reference hashes from the compiler artifacts used for this release build.
// Keeping these values deterministic makes the manifest identical on every OS;
// bytecode parity below is the authoritative build-output check.
const compilerReferenceArtifacts = [
  {
    filename: "solc-macosx-amd64-v0.8.24+commit.e11b9ed9",
    sha256: "cc2d44c706905ccc382f484625dff61d741e0c24232d226f139a6835fc644f3f",
  },
  {
    filename: "soljson-v0.8.24+commit.e11b9ed9.js",
    sha256: "11b054b55273ec55f6ab3f445eb0eb2c83a23fed43d10079d34ac3eabe6ed8b1",
  },
];

const manifest = {
  schema: "d17-protocol-build-v1",
  release: "1.1.0-v15",
  compiler: {
    version: buildInfo.solcVersion,
    longVersion: buildInfo.solcLongVersion,
    settings: {
      evmVersion: buildInfo.input.settings.evmVersion,
      viaIR: buildInfo.input.settings.viaIR,
      optimizer: buildInfo.input.settings.optimizer,
      metadata: buildInfo.input.settings.metadata,
    },
    referenceArtifacts: compilerReferenceArtifacts,
  },
  standardJsonInput: "solc-input.json",
  standardJsonInputSha256: sha256(`${JSON.stringify(buildInfo.input, null, 2)}\n`),
  identities: Object.fromEntries(
    Object.entries(identityLiterals).map(([name, literal]) => [name, { literal, keccak256: ethers.id(literal) }])
  ),
  sources: Object.fromEntries(
    productionSources.map((file) => [
      `contracts/${file}`,
      { sha256: sha256(readFileSync(path.join(contractRoot, file))) },
    ])
  ),
  contracts: contractRecords,
};

mkdirSync(releaseRoot, { recursive: true });
writeFileSync(path.join(releaseRoot, "solc-input.json"), `${JSON.stringify(buildInfo.input, null, 2)}\n`);
writeFileSync(path.join(releaseRoot, "protocol-build.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log("Generated release/protocol-build.json and release/solc-input.json");

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hexBytes(value) {
  return Math.max(0, (String(value).length - 2) / 2);
}
