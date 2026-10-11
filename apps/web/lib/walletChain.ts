import type { Eip1193Provider } from "ethers";
import { ACTIVE_NETWORK } from "@/lib/d17Network";

type WalletError = { code?: number; message?: string; data?: { originalError?: { code?: number } } };

const chainHex = `0x${ACTIVE_NETWORK.chainId.toString(16)}`;

async function walletChainId(wallet: Eip1193Provider): Promise<bigint> {
  return BigInt((await wallet.request({ method: "eth_chainId" })) as string);
}

/**
 * Puts the wallet on the page's network: asks it to switch, and on the local demo chain
 * also offers to add the network when the wallet does not know it yet (MetaMask's own
 * "Localhost 8545" entry uses chain id 1337, not Hardhat's 31337). Public networks are
 * never added from here: wallets already know Sepolia and mainnet, and the page's RPC URL
 * may be a private endpoint.
 */
export async function ensureWalletChain(wallet: Eip1193Provider): Promise<void> {
  if ((await walletChainId(wallet)) === BigInt(ACTIVE_NETWORK.chainId)) return;
  try {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
  } catch (error) {
    const issue = error as WalletError;
    const code = issue.code ?? issue.data?.originalError?.code;
    const unknownChain = code === 4902 || /unrecognized chain|not been added|unknown chain/i.test(issue.message ?? "");
    if (unknownChain && ACTIVE_NETWORK.key === "local") {
      await wallet.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainHex,
            chainName: "D17 local demo",
            rpcUrls: [ACTIVE_NETWORK.rpcUrl],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          },
        ],
      });
    } else {
      throw new Error(`Switch your wallet to ${ACTIVE_NETWORK.chainName} (chain ${ACTIVE_NETWORK.chainId}).`);
    }
  }
  if ((await walletChainId(wallet)) !== BigInt(ACTIVE_NETWORK.chainId)) {
    throw new Error(`Switch your wallet to ${ACTIVE_NETWORK.chainName} (chain ${ACTIVE_NETWORK.chainId}).`);
  }
}
