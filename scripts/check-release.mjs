import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReleaseFiles, RELEASE_MANIFEST_NAME } from "./release-files.mjs";
import { EXPLORER_CONTRACTS as contractNames } from "../contracts/scripts/contract-list.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [];
function check(label, condition) {
  checks.push({ label, ok: Boolean(condition) });
  if (!condition) throw new Error(label);
}

for (const network of ["sepolia", "mainnet"]) {
  const copies = [
    `deployments/${network}.json`,
    `apps/web/deployments/${network}.json`,
    `apps/api/deployments/${network}.json`,
    `contracts/deployments/${network}.json`,
  ].map(read);
  check(`${network} deployment manifests are byte-identical`, copies.every((value) => value === copies[0]));

  const publicManifest = JSON.parse(copies[0]);
  const provenance = json(`release/deployments/${network}.json`);
  check(`${network} provenance chain matches`, Number(provenance.chainId) === Number(publicManifest.chainId));
  check(`${network} provenance start block matches`, Number(provenance.startBlock) === Number(publicManifest.startBlock));
  check(`${network} provenance status matches`, provenance.status === publicManifest.status);
  for (const key of ["d17Factory", "feeConfig", "tokenFactory", "launchDeployer", "liquidityVaultFactory", "launchFactory", "lockerFactory"]) {
    check(
      `${network} ${key} provenance matches`,
      String(provenance.contracts[key]).toLowerCase() === String(publicManifest.contracts[key]).toLowerCase()
    );
  }
}

for (const name of contractNames) {
  const canonical = read(`contracts/abi/${name}.abi.json`);
  check(`${name} web ABI matches`, read(`apps/web/public/abi/${name}.abi.json`) === canonical);
  check(`${name} API ABI matches`, read(`apps/api/abi/${name}.abi.json`) === canonical);
}

const protocolBuild = json("release/protocol-build.json");
for (const [source, record] of Object.entries(protocolBuild.sources)) {
  check(`${source} matches protocol manifest`, sha256(read(source)) === record.sha256);
}
for (const name of contractNames) {
  check(`${name} protocol ABI parity recorded`, protocolBuild.contracts[name]?.artifactAbiMatch === true);
  check(`${name} protocol bytecode parity recorded`, protocolBuild.contracts[name]?.artifactCreationBytecodeMatch === true);
}

const checksumLines = read("contracts/SHA256SUMS.txt").trim().split(/\r?\n/);
for (const line of checksumLines) {
  const match = /^([a-f0-9]{64})\s{2}(.+)$/.exec(line);
  check(`valid Solidity checksum line: ${line}`, match);
  const file = `contracts/${match[2]}`;
  check(`${file} matches SHA256SUMS`, sha256(read(file)) === match[1]);
}

for (const forbidden of [
  "apps/web/.env.local",
  "apps/api/.env.sepolia",
  "apps/api/.env.mainnet",
  "contracts/.env",
]) {
  check(`${forbidden} is absent`, !existsSync(path.join(root, forbidden)));
}

const publicText = collectTextFiles(root, new Set([
  "node_modules",
  ".git",
  ".next",
  "artifacts",
  "cache",
  "runs",
]));
const sensitivePatterns = [
  { label: "absolute user-home path", pattern: /\/(?:Users|home)\/[a-z0-9._-]+\//i },
  { label: "workspace metadata path", pattern: new RegExp(`\\.${["co", "dex"].join("")}(?:/|\\\\)`, "i") },
  { label: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { label: "private key assignment", pattern: /\b(?:PRIVATE_KEY|SECRET_KEY|SEED_PHRASE|MNEMONIC)\s*=\s*(?!<|your-|replace-|$)[^\s#]+/i },
  {
    label: "private publication marker",
    pattern: new RegExp(`\\b${["PRIVATE", "WORK", "NOTE"].join(" ")}\\b`, "i"),
  },
];
for (const { label, pattern } of sensitivePatterns) {
  const hit = publicText.find(({ text }) => pattern.test(text));
  check(`no ${label}`, !hit);
}

// The release manifest must describe the CURRENT tree byte-for-byte.
// This catches ordering failures where a later step (a production build
// rewriting next-env.d.ts, a tooling edit) postdates checksum generation.
{
  const manifestLines = read(RELEASE_MANIFEST_NAME).trim().split(/\r?\n/);
  const manifest = new Map();
  for (const line of manifestLines) {
    const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
    check(`release manifest line parses: ${line.slice(0, 40)}`, Boolean(match));
    manifest.set(match[2], match[1]);
  }
  const treeFiles = collectReleaseFiles(root);
  check(
    `release manifest covers the exact release file set (${treeFiles.length} files)`,
    treeFiles.length === manifest.size && treeFiles.every((file) => manifest.has(file))
  );
  let mismatched = 0;
  for (const [file, digest] of manifest) {
    const actual = createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex");
    if (actual !== digest) {
      console.error(`Digest mismatch: ${file}\n  manifest ${digest}\n  actual   ${actual}`);
      mismatched += 1;
    }
  }
  check(`all ${manifest.size} release manifest digests match the tree`, mismatched === 0);
}

console.log(`Release checks passed: ${checks.length}/${checks.length}`);

function read(relative) {
  return readFileSync(path.join(root, relative), "utf8");
}

function json(relative) {
  return JSON.parse(read(relative));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function collectTextFiles(directory, ignoredNames, relative = "") {
  const records = [];
  for (const name of readdirSync(directory)) {
    if (ignoredNames.has(name)) continue;
    const absolute = path.join(directory, name);
    const nextRelative = path.join(relative, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      records.push(...collectTextFiles(absolute, ignoredNames, nextRelative));
      continue;
    }
    if (
      stat.size > 2_000_000 ||
      name.endsWith(".tsbuildinfo") ||
      /\.(png|ico|woff2?|jpg|jpeg|gif|pdf)$/i.test(name)
    ) continue;
    records.push({ file: nextRelative, text: readFileSync(absolute, "utf8") });
  }
  return records;
}
