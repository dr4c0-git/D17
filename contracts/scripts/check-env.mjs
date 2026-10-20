// Checks contracts/.env before a deployment, without ever printing a key or the RPC URL.
//
//   npm run check:env -w @d17/contracts
//
// Shows the network the RPC answers for, the address and balance behind each key, the fee
// settings and the fee split, and stops with a clear message on the first problem.
import { ethers } from "ethers";
import { providerFromEnv } from "./lib.mjs";

const problems = [];
const lines = [];
const show = (label, value) => lines.push(`${label.padEnd(26)} ${value}`);

function address(name, { optional = false } = {}) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    if (!optional) problems.push(`${name} is empty.`);
    return null;
  }
  try {
    return ethers.getAddress(value);
  } catch {
    problems.push(`${name} is not a valid address (check for a typo or a missing character).`);
    return null;
  }
}

function wallet(name) {
  const value = (process.env[name] || "").trim();
  if (!value) {
    problems.push(`${name} is empty.`);
    return null;
  }
  try {
    return new ethers.Wallet(value);
  } catch {
    problems.push(`${name} is not a valid private key (it should be 64 hexadecimal characters, with or without 0x).`);
    return null;
  }
}

const provider = providerFromEnv();
let chainId = null;
try {
  if (!process.env.RPC_URL || /your-rpc\.example/.test(process.env.RPC_URL)) throw new Error("placeholder");
  chainId = Number((await provider.getNetwork()).chainId);
  const expected = Number(process.env.D17_EXPECTED_CHAIN_ID || chainId);
  show("Network (chain id)", `${chainId}${chainId === 11155111 ? " (Sepolia)" : chainId === 1 ? " (Ethereum mainnet)" : ""}`);
  if (chainId !== expected) problems.push(`The RPC is on chain ${chainId}, but D17_EXPECTED_CHAIN_ID is ${expected}.`);
} catch {
  problems.push("RPC_URL does not answer: paste the full HTTPS URL of your Alchemy (or Infura) Sepolia app.");
}

const deployKey = wallet("D17_FACTORY_PRIVATE_KEY");
const lockerKey = wallet("D17_LOCKER_FACTORY_PRIVATE_KEY");
for (const [label, key] of [["Deployer (factory key)", deployKey], ["Locker factory key", lockerKey]]) {
  if (!key) continue;
  let balance = "unknown";
  if (chainId !== null) {
    try {
      const wei = await provider.getBalance(key.address);
      balance = `${ethers.formatEther(wei)} ETH`;
      if (wei === 0n) problems.push(`${label} ${key.address} has no ETH on this network.`);
    } catch {}
  }
  show(label, `${key.address} (${balance})`);
}
if (deployKey && lockerKey && deployKey.address === lockerKey.address && process.env.ALLOW_SHARED_DEPLOYER !== "1") {
  problems.push("D17_FACTORY_PRIVATE_KEY and D17_LOCKER_FACTORY_PRIVATE_KEY must be two different keys.");
}

const feeOwner = address("FEE_CONFIG_OWNER");
if (feeOwner) show("Fee config owner", feeOwner);
const feeBps = Number(process.env.PROTOCOL_FEE_BPS ?? "0");
if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 200) problems.push("PROTOCOL_FEE_BPS must be a whole number from 0 to 200 (2% maximum).");
else show("Protocol fee", `${feeBps} bps (${feeBps / 100}%)`);

const splitRaw = (process.env.FEE_SPLIT_RECIPIENTS || "").trim();
const directRecipient = address("PROTOCOL_FEE_RECIPIENT", { optional: true });
if (splitRaw) {
  if (directRecipient) problems.push("Leave PROTOCOL_FEE_RECIPIENT empty when FEE_SPLIT_RECIPIENTS is set.");
  if (/\s/.test(splitRaw)) problems.push("FEE_SPLIT_RECIPIENTS contains spaces: separate the addresses with commas only.");
  const recipients = splitRaw.split(",").map((item) => item.trim()).filter(Boolean);
  const shares = (process.env.FEE_SPLIT_BPS || "").split(",").map((item) => Number(item.trim()));
  if (recipients.length !== shares.length) problems.push(`FEE_SPLIT_RECIPIENTS has ${recipients.length} addresses but FEE_SPLIT_BPS has ${shares.length} shares.`);
  const total = shares.reduce((sum, value) => sum + (Number.isInteger(value) ? value : NaN), 0);
  if (total !== 10000) problems.push(`FEE_SPLIT_BPS must add up to 10000 (it adds up to ${Number.isNaN(total) ? "an invalid number" : total}).`);
  const seen = new Set();
  recipients.forEach((item, index) => {
    let checked = null;
    try {
      checked = ethers.getAddress(item);
    } catch {
      problems.push(`Fee split address ${index + 1} is not a valid address.`);
    }
    if (checked && seen.has(checked)) problems.push(`Fee split address ${index + 1} appears twice.`);
    if (checked) seen.add(checked);
    show(`Fee split ${index + 1}`, `${checked ?? item} -> ${(shares[index] ?? 0) / 100}%`);
  });
} else if (feeBps > 0) {
  if (directRecipient) show("Fee recipient", directRecipient);
  else problems.push("Set PROTOCOL_FEE_RECIPIENT, or FEE_SPLIT_RECIPIENTS and FEE_SPLIT_BPS, when the fee is above 0.");
}

if (process.env.RENOUNCE_D17_FACTORY_OWNER !== "1") problems.push("RENOUNCE_D17_FACTORY_OWNER must stay 1.");

console.log(lines.join("\n"));
provider.destroy?.();
if (problems.length) {
  console.log(`\n${problems.length} problem(s) to fix in contracts/.env:`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exit(1);
}
console.log("\ncontracts/.env looks good. Next: npm run compile -w @d17/contracts, then npm run deploy:factory -w @d17/contracts");
