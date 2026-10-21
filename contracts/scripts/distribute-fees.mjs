// Splits the protocol fees held by the published D17FeeSplitter between its recipients.
//
//   npm run distribute:fees -w @d17/contracts
//
// Anyone can trigger a split (the splitter has no owner); this script signs with
// DISTRIBUTOR_PRIVATE_KEY, or D17_FACTORY_PRIVATE_KEY when unset, and only pays gas.
// It reads the splitter address from release/deployments/<network>.json and prints each
// recipient's WETH balance before and after.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { artifact, providerFromEnv, root } from "./lib.mjs";

const NETWORKS = { 11155111: "sepolia", 1: "mainnet" };
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

const provider = providerFromEnv();
const chainId = Number((await provider.getNetwork()).chainId);
const network = NETWORKS[chainId] ?? `chain ${chainId}`;
let splitterAddress = process.env.FEE_SPLITTER_ADDRESS;
if (!splitterAddress) {
  const provenancePath = path.resolve(root, "..", "release", "deployments", `${NETWORKS[chainId]}.json`);
  if (!NETWORKS[chainId] || !existsSync(provenancePath)) throw new Error(`No published D17 deployment for chain ${chainId}.`);
  splitterAddress = JSON.parse(readFileSync(provenancePath, "utf8")).feeSplitter?.address;
  if (!splitterAddress) throw new Error(`The ${network} deployment has no fee splitter.`);
}

const key = process.env.DISTRIBUTOR_PRIVATE_KEY || process.env.D17_FACTORY_PRIVATE_KEY;
if (!key) throw new Error("Set DISTRIBUTOR_PRIVATE_KEY (or D17_FACTORY_PRIVATE_KEY) in contracts/.env to pay the gas.");
const signer = new ethers.Wallet(key, provider);

const splitter = new ethers.Contract(splitterAddress, artifact("D17FeeSplitter.sol", "D17FeeSplitter").abi, signer);
const weth = new ethers.Contract(await splitter.weth(), ERC20, provider);
const [recipients, shares] = await splitter.recipients();
const balances = () => Promise.all(recipients.map((address) => weth.balanceOf(address)));

const held = await weth.balanceOf(splitterAddress);
const ethHeld = await provider.getBalance(splitterAddress);
console.log(`Fee splitter ${splitterAddress} on ${network}`);
console.log(`Holds ${ethers.formatEther(held)} WETH and ${ethers.formatEther(ethHeld)} ETH`);
if (held === 0n && ethHeld === 0n) {
  console.log("Nothing to split yet: fees arrive when buyers collect their tokens.");
  provider.destroy?.();
  process.exit(0);
}

const before = await balances();
const tx = ethHeld > 0n ? await splitter.distributeEth() : await splitter.distribute(await weth.getAddress());
console.log(`Sent ${tx.hash}, waiting for confirmation...`);
await tx.wait();
const after = await balances();

recipients.forEach((address, index) => {
  const received = after[index] - before[index];
  console.log(`${address}  ${(Number(shares[index]) / 100).toString().padStart(5)}%  +${ethers.formatEther(received)} WETH`);
});
console.log(`Splitter now holds ${ethers.formatEther(await weth.balanceOf(splitterAddress))} WETH.`);
provider.destroy?.();
