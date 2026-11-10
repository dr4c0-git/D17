// Explains a "Collect for N buyers" transaction (D17LockerFactory.settleAfterGraceBatch):
// which contract it called, the outcome for each locker, and, for each locker that was
// skipped, why its settlement fails right now.
//
//   npm run inspect:batch -w @d17/contracts -- 0xTransactionHash
//
// Read-only: no key needed, uses RPC_URL from contracts/.env.
import { ethers } from "ethers";
import { artifact, providerFromEnv } from "./lib.mjs";

const hash = process.argv[2];
if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
  console.error("Usage: npm run inspect:batch -w @d17/contracts -- 0xTransactionHash");
  process.exit(1);
}
const provider = providerFromEnv();
const [tx, receipt] = await Promise.all([provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
if (!tx || !receipt) throw new Error(`Transaction ${hash} not found on this network.`);

const factoryAbi = artifact("D17LockerFactory.sol", "D17LockerFactory").abi;
const lockerFactory = new ethers.Interface(factoryAbi);
const show = (label, value) => console.log(`${label.padEnd(24)} ${value}`);
show("Called contract", tx.to);
show("Status", receipt.status === 1 ? "success" : "reverted");
show("Gas limit / used", `${tx.gasLimit} / ${receipt.gasUsed}`);

let call = null;
try {
  call = lockerFactory.parseTransaction({ data: tx.data, value: tx.value });
} catch {}
if (!call || call.name !== "settleAfterGraceBatch") {
  console.log("\nThis transaction is not a settleAfterGraceBatch call.");
  process.exit(0);
}
const launchAddress = call.args[0];
const lockers = [...call.args[1]];
show("Launch", launchAddress);
show("Lockers sent", lockers.join(", "));

// The locker factory must be the one this launch's factory accepts lockers from.
const launch = new ethers.Contract(launchAddress, artifact("D17Launch.sol", "D17Launch").abi, provider);
const d17Factory = new ethers.Contract(await launch.factory(), artifact("D17Factory.sol", "D17Factory").abi, provider);
const officialLockerFactory = await d17Factory.lockerFactory();
show("Launch's locker factory", `${officialLockerFactory}${officialLockerFactory.toLowerCase() === String(tx.to).toLowerCase() ? " (same as called)" : " (DIFFERENT from the called contract)"}`);

console.log("\nPer locker:");
for (const log of receipt.logs) {
  let parsed = null;
  try {
    parsed = lockerFactory.parseLog(log);
  } catch {}
  if (parsed?.name !== "BatchSettlementResult") continue;
  const locker = parsed.args.locker;
  console.log(`- ${locker}: ${parsed.args.success ? "settled" : "SKIPPED"}`);
  if (parsed.args.success) continue;
  console.log(`    registered locker of this suite: ${await d17Factory.isLocker(locker)}`);
  const lockerContract = new ethers.Contract(locker, artifact("D17Locker.sol", "D17Locker").abi, provider);
  const position = await lockerContract.positions(launchAddress).catch(() => null);
  if (position) console.log(`    position known: ${position.known}, already settled: ${position.liquiditySettled}`);
  try {
    const gas = await lockerContract.settleAfterGrace.estimateGas(launchAddress);
    console.log(`    settling it now would work, using ${gas} gas (the batch gives each locker ${await new ethers.Contract(tx.to, factoryAbi, provider).SETTLEMENT_CALL_GAS()})`);
  } catch (error) {
    console.log(`    settling it now fails: ${error.shortMessage || error.reason || error.message}`);
  }
}
provider.destroy?.();
