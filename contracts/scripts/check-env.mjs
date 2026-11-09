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
  problems.push("RPC_URL does not answer: paste the full HTTPS URL of your RPC provider for this network.");
}

// Gas each key spends in deploy:factory, measured on a full run (fee splitter included):
// 15.5M for the factory key, 2.3M for the locker factory key, rounded up.
const DEPLOY_GAS = { factory: 16_000_000n, locker: 2_500_000n };
let gasPrice = null;
if (chainId !== null) {
  try {
    const fees = await provider.getFeeData();
    gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
    if (gasPrice) show("Gas price now", `${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  } catch {}
}

const deployKey = wallet("D17_FACTORY_PRIVATE_KEY");
const lockerKey = wallet("D17_LOCKER_FACTORY_PRIVATE_KEY");
for (const [label, key, gas] of [["Deployer (factory key)", deployKey, DEPLOY_GAS.factory], ["Locker factory key", lockerKey, DEPLOY_GAS.locker]]) {
  if (!key) continue;
  let balance = "unknown";
  if (chainId !== null) {
    try {
      const wei = await provider.getBalance(key.address);
      balance = `${ethers.formatEther(wei)} ETH`;
      if (wei === 0n) problems.push(`${label} ${key.address} has no ETH on this network.`);
      else if (gasPrice) {
        // 30% margin: the gas price can rise during the deployment.
        const needed = (gas * gasPrice * 13n) / 10n;
        balance += `, needs about ${Number(ethers.formatEther(needed)).toFixed(4)} ETH at this gas price`;
        if (wei < needed) problems.push(`${label} ${key.address} has ${ethers.formatEther(wei)} ETH, less than the ${Number(ethers.formatEther(needed)).toFixed(4)} ETH its part of the deployment needs at the current gas price.`);
      }
    } catch {}
  }
  show(label, `${key.address} (${balance})`);
}
if (deployKey && lockerKey && deployKey.address === lockerKey.address && process.env.ALLOW_SHARED_DEPLOYER !== "1") {
  problems.push("D17_FACTORY_PRIVATE_KEY and D17_LOCKER_FACTORY_PRIVATE_KEY must be two different keys.");
}

const renounceFeeConfig = process.env.RENOUNCE_FEE_CONFIG_OWNER === "1";
const feeOwner = renounceFeeConfig ? null : address("FEE_CONFIG_OWNER");
if (renounceFeeConfig) {
  show("Fee config owner", "none: renounced at the end of the deployment (fee final)");
  if ((process.env.FEE_CONFIG_OWNER || "").trim()) problems.push("Leave FEE_CONFIG_OWNER empty with RENOUNCE_FEE_CONFIG_OWNER=1.");
} else if (feeOwner) show("Fee config owner", feeOwner);
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

// Mainnet rules deploy:factory enforces too, checked here before any ETH is spent.
if (chainId === 1) {
  const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  const MAINNET_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
  const weth = address("WETH_ADDRESS");
  const router = address("UNISWAP_V2_ROUTER");
  if (weth && weth !== MAINNET_WETH) problems.push(`WETH_ADDRESS must be the mainnet WETH, ${MAINNET_WETH}.`);
  if (router && router !== MAINNET_ROUTER) problems.push(`UNISWAP_V2_ROUTER must be the mainnet Uniswap V2 router, ${MAINNET_ROUTER}.`);
  if (feeOwner) {
    const code = await provider.getCode(feeOwner).catch(() => null);
    if (code === "0x") problems.push("FEE_CONFIG_OWNER must be the Safe (multisig) address on mainnet: this address is a plain wallet. Or leave it empty and set RENOUNCE_FEE_CONFIG_OWNER=1.");
    else if (code) show("Fee config owner type", "contract (Safe expected)");
  }
  if (process.env.D17_CONFIRM_MAINNET_DEPLOY !== "1") problems.push("Add D17_CONFIRM_MAINNET_DEPLOY=1 to confirm the mainnet deployment.");
  if (!process.env.ETHERSCAN_API_KEY) problems.push("ETHERSCAN_API_KEY is empty: it is needed right after the deployment (verify:etherscan).");
}

console.log(lines.join("\n"));
provider.destroy?.();
if (problems.length) {
  console.log(`\n${problems.length} problem(s) to fix in contracts/.env:`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exit(1);
}
console.log("\ncontracts/.env looks good. Next: npm run compile -w @d17/contracts, then npm run deploy:factory -w @d17/contracts");
