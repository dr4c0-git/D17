import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// This exact string is the immutable identity of the deployed contract family.
export const CURRENT_LAUNCH_ID = ethers.keccak256(ethers.toUtf8Bytes("D17_LAUNCH_V15_HARDENED"));

loadDotEnv(path.join(root, ".env"));

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function readJson(file) {
  return JSON.parse(readFileSync(path.isAbsolute(file) ? file : path.join(root, file), "utf8"));
}

export function writeJson(file, value) {
  const output = path.isAbsolute(file) ? file : path.join(root, file);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
}

export function artifact(file, name) {
  return readJson(path.join(root, "artifacts", "contracts", file, `${name}.json`));
}

export function providerFromEnv() {
  const rpcUrl = process.env.RPC_URL || process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
  const options = {};
  if (process.env.RPC_BATCH_MAX_COUNT) {
    options.batchMaxCount = Number(process.env.RPC_BATCH_MAX_COUNT);
  }
  return new ethers.JsonRpcProvider(rpcUrl, undefined, options);
}

export function parseTokenAmount(value) {
  return ethers.parseUnits(String(value), 18);
}

export function parseEthAmount(value) {
  return ethers.parseEther(String(value));
}

export function parsePriceWad(config) {
  if (config.minAnchorPriceWethPerToken !== undefined) {
    return ethers.parseEther(String(config.minAnchorPriceWethPerToken));
  }
  if (config.minAnchorPriceWad !== undefined) {
    return BigInt(String(config.minAnchorPriceWad));
  }
  return 1_000_000n;
}

export function normalizeLaunchMetadata(config = {}) {
  const inputLinks = Array.isArray(config.links) ? config.links : [];
  return {
    description: String(config.description || ""),
    logoSvgUri: String(config.logoSvgUri || ""),
    links: inputLinks.map((link) => ({
      linkType: String(link.linkType ?? link.type ?? ""),
      url: String(link.url ?? "")
    }))
  };
}

export function metadataHashForLaunch(launchId, fields = {}) {
  const metadata = normalizeLaunchMetadata(fields);
  if (!launchId) return null;
  const normalizedId = ethers.hexlify(launchId).toLowerCase();
  if (normalizedId !== CURRENT_LAUNCH_ID.toLowerCase()) return null;
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "string", "tuple(string linkType,string url)[]"],
      [
        String(fields.tokenName ?? fields.name ?? ""),
        String(fields.tokenSymbol ?? fields.symbol ?? ""),
        metadata.description,
        metadata.logoSvgUri,
        metadata.links
      ]
    )
  );
}

export function launchMetadataHash(config = {}, launchId = CURRENT_LAUNCH_ID) {
  const hash = metadataHashForLaunch(launchId, config);
  if (!hash) throw new Error(`Unknown D17 launch metadata hash recipe for launch ID ${launchId}`);
  return hash;
}

export function parseContractUriJson(uri) {
  const prefixes = [
    "data:application/json;charset=utf-8,",
    "data:application/json;utf8,"
  ];
  const prefix = prefixes.find((candidate) => String(uri).startsWith(candidate));
  if (!prefix) return null;
  return JSON.parse(String(uri).slice(prefix.length));
}

export function buildLaunchConfig(config, now, treasury) {
  const startTime = config.startTime || now + Number(config.startDelaySeconds || 3600);
  const metadata = normalizeLaunchMetadata(config);
  return {
    tokenName: String(config.tokenName || ""),
    tokenSymbol: String(config.tokenSymbol || ""),
    description: metadata.description,
    logoSvgUri: metadata.logoSvgUri,
    links: metadata.links,
    tokenSupply: parseTokenAmount(config.tokenSupply),
    saleTokens: parseTokenAmount(config.saleTokens),
    lpTokens: parseTokenAmount(config.lpTokens),
    manualDistributionTokens: parseTokenAmount(config.manualDistributionTokens || "0"),
    deadTokens: parseTokenAmount(config.deadTokens || "0"),
    deadRecipient: ethers.getAddress(config.deadRecipient || "0x000000000000000000000000000000000000dEaD"),
    treasury: ethers.getAddress(config.treasury || treasury),
    startTime,
    roundSeconds: config.roundSeconds.map(Number),
    refundSeconds: Number(config.refundSeconds),
    settlementSeconds: Number(config.settlementSeconds),
    minCommitWeth: parseEthAmount(config.minCommitWeth || "0.01"),
    minPhase1Weth: parseEthAmount(config.minPhase1Weth || "1"),
    minAnchorPriceWad: parsePriceWad(config),
    roundSharesBps: config.roundSharesBps.map(Number),
    treasuryBps: Number(config.treasuryBps),
    refundPenaltyBps: Number(config.refundPenaltyBps),
    // Consent bound: creation reverts if D17FeeConfig's fee is above this at execution.
    maxProtocolFeeBps: Number(config.maxProtocolFeeBps ?? 200)
  };
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function assertFile(file) {
  if (!existsSync(file)) throw new Error(`Missing file: ${file}`);
}
