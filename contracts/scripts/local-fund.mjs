// Gives test ETH to any address on the local demo chain (npm run demo:local must be running).
//
//   npm run demo:fund -- 0xYourAddress          # 100 test ETH
//   npm run demo:fund -- 0xYourAddress 500      # 500 test ETH
//
// Only works on the local Hardhat chain (chain id 31337): it sets the balance directly,
// nothing is sent from anyone.
import { ethers } from "ethers";

const RPC_URL = `http://127.0.0.1:${process.env.D17_LOCAL_RPC_PORT || 8545}`;
const [address, amount = "100"] = process.argv.slice(2);

if (!address || !ethers.isAddress(address)) {
  console.error("Usage: npm run demo:fund -- 0xYourAddress [amount in ETH, default 100]");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
try {
  const chainId = Number(await provider.send("eth_chainId", []));
  if (chainId !== 31337) throw new Error(`The chain at ${RPC_URL} has chain id ${chainId}, not the local demo chain (31337).`);
  const target = ethers.getAddress(address);
  const before = await provider.getBalance(target, "pending");
  const after = before + ethers.parseEther(amount);
  await provider.send("hardhat_setBalance", [target, ethers.toQuantity(after)]);
  // The new balance is applied with the next block (the demo chain mines one per second).
  console.log(`${target} now has ${ethers.formatEther(after)} test ETH on the local demo chain.`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(/ECONNREFUSED|failed to detect network/i.test(message) ? `No local chain at ${RPC_URL}: start it first with npm run demo:local.` : message);
  process.exitCode = 1;
} finally {
  provider.destroy();
}
