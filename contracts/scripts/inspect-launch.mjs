// Prints the on-chain state of a launch: phase, raise, protocol fee and where it goes.
//
//   npm run inspect:launch -w @d17/contracts -- 0xLaunchAddress [0xWallet]
//
// Read-only: no key needed, uses RPC_URL from contracts/.env.
import { ethers } from "ethers";
import { artifact, providerFromEnv } from "./lib.mjs";

const PHASES = ["not started", "round open", "take-back window", "ready to close", "collect tokens", "ready to open trading", "trading open", "cancelled"];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];

let address = process.argv[2];
if (!address || !ethers.isAddress(address)) {
  console.error("Usage: npm run inspect:launch -w @d17/contracts -- 0xLaunchAddress");
  process.exit(1);
}
const provider = providerFromEnv();
const code = await provider.getCode(address);
if (code === "0x") throw new Error(`${address} has no contract on this network.`);
let launch = new ethers.Contract(address, artifact("D17Launch.sol", "D17Launch").abi, provider);
let phase = await launch.launchPhase().catch(() => null);
if (!phase) {
  // Given the launch's token or liquidity vault instead: both point back to their launch.
  const pointer = new ethers.Contract(address, ["function launch() view returns (address)"], provider);
  const resolved = await pointer.launch().catch(() => null);
  if (!resolved || resolved === ethers.ZeroAddress) throw new Error(`${address} is not a D17 launch, token or liquidity vault.`);
  console.log(`${address} is the launch's token or vault; its launch is ${resolved}.\n`);
  address = resolved;
  launch = new ethers.Contract(address, artifact("D17Launch.sol", "D17Launch").abi, provider);
  phase = await launch.launchPhase();
}
const read = (name, ...args) => launch[name](...args).catch(() => null);
const [token, weth, feeRecipient, feeBps, feePaid, finalized, total, finalCommitted, settledCommitted, poolCreated] = await Promise.all([
  read("token"), read("weth"), read("protocolFeeRecipient"), read("protocolFeeBps"), read("protocolFeeWethPaid"),
  read("finalized"), read("totalCommittedWeth"), read("finalCommittedWeth"), read("settledCommittedWeth"), read("liquidityPoolCreated"),
]);
const symbol = token ? await new ethers.Contract(token, ERC20, provider).symbol().catch(() => "?") : "?";
const show = (label, value) => console.log(`${label.padEnd(28)} ${value}`);
const eth = (value) => (value === null ? "unknown" : `${ethers.formatEther(value)} ETH`);

show("Launch", `${address} (${symbol})`);
show("Phase", PHASES[Number(phase[0])] ?? `kind ${phase[0]}`);
show("Finalized", String(finalized));
show("Trading pool created", String(poolCreated));
show("Total committed", eth(total));
show("Final commitments", eth(finalCommitted));
show("Settled (collected)", eth(settledCommitted));
show("Protocol fee rate", feeBps === null ? "unknown" : `${Number(feeBps) / 100}%`);
show("Protocol fee recipient", feeRecipient ?? "unknown");
show("Protocol fee paid so far", eth(feePaid));
if (feeRecipient && weth) {
  const held = await new ethers.Contract(weth, ERC20, provider).balanceOf(feeRecipient);
  show("WETH held by the recipient", eth(held));
}

// Optional second argument: a wallet. Lists its vaults and what each holds in this launch.
const wallet = process.argv[3];
if (wallet && ethers.isAddress(wallet)) {
  const factoryAddress = await launch.factory();
  const factory = new ethers.Contract(factoryAddress, artifact("D17Factory.sol", "D17Factory").abi, provider);
  const vaults = await factory.lockersOfOwner(wallet);
  console.log(`\nWallet ${wallet}: ${vaults.length} vault(s)`);
  for (const vault of vaults) {
    const locker = new ethers.Contract(vault, artifact("D17Locker.sol", "D17Locker").abi, provider);
    const position = await locker.positions(address);
    const rounds = await Promise.all([0, 1, 2, 3, 4].map((round) => launch.previewRoundTokens(vault, round).catch(() => 0n)));
    console.log(`- ${vault}`);
    console.log(`    in this launch: ${position.known ? "yes" : "no"}, put in ${ethers.formatEther(position.wethCommitted)} ETH, taken back ${ethers.formatEther(position.wethRefunded)} ETH`);
    console.log(`    collected: ${position.liquiditySettled ? "yes" : "no"}, tokens waiting in the vault: ${ethers.formatEther(position.withdrawableTokens)}, tokens to collect: ${ethers.formatEther(rounds.reduce((a, b) => a + b, 0n))}`);
  }
}
provider.destroy?.();
