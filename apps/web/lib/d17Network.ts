export type D17NetworkKey = "sepolia" | "mainnet" | "local";

export type D17NetworkConfig = {
  key: D17NetworkKey;
  chainId: number;
  chainName: string;
  networkLabel: string;
  explorerBase: string;
  apiBase: string;
  wsUrl: string;
  rpcUrl: string;
  rpcWsUrl: string;
  launchAddressOverride: string;
  fromBlockOverride: string;
  /** Optional standalone ETH/USD endpoint (D17 price envelope). Lets a
   *  direct-RPC deployment opt into USD display without any indexed API. */
  priceUrl: string;
};

/** Local Hardhat chain for testing the interface with free test ETH. Only exists when
 *  NEXT_PUBLIC_D17_ENABLE_LOCAL=true (written by `npm run demo:local`), never in a
 *  normal build. */
export const LOCAL_NETWORK_ENABLED = process.env.NEXT_PUBLIC_D17_ENABLE_LOCAL === "true";

const DEFAULT_NETWORK: D17NetworkKey =
  process.env.NEXT_PUBLIC_D17_DEFAULT_NETWORK === "mainnet"
    ? "mainnet"
    : process.env.NEXT_PUBLIC_D17_DEFAULT_NETWORK === "local" && LOCAL_NETWORK_ENABLED
      ? "local"
      : "sepolia";

const NETWORKS: Record<D17NetworkKey, D17NetworkConfig> = {
  sepolia: {
    key: "sepolia",
    chainId: 11155111,
    chainName: "Sepolia",
    networkLabel: "Sepolia · Testnet",
    explorerBase: process.env.NEXT_PUBLIC_D17_SEPOLIA_EXPLORER_BASE || "https://sepolia.etherscan.io",
    apiBase: process.env.NEXT_PUBLIC_D17_SEPOLIA_API_BASE || "",
    wsUrl: process.env.NEXT_PUBLIC_D17_SEPOLIA_WS_URL || "",
    rpcUrl: process.env.NEXT_PUBLIC_D17_SEPOLIA_RPC_URL || "",
    rpcWsUrl: process.env.NEXT_PUBLIC_D17_SEPOLIA_RPC_WS_URL || "",
    launchAddressOverride: process.env.NEXT_PUBLIC_D17_SEPOLIA_LAUNCH_ADDRESS || "",
    fromBlockOverride: process.env.NEXT_PUBLIC_D17_SEPOLIA_FROM_BLOCK || "",
    priceUrl: process.env.NEXT_PUBLIC_D17_SEPOLIA_PRICE_URL || "",
  },
  mainnet: {
    key: "mainnet",
    chainId: 1,
    chainName: "Mainnet",
    networkLabel: "Mainnet",
    explorerBase: process.env.NEXT_PUBLIC_D17_MAINNET_EXPLORER_BASE || "https://etherscan.io",
    apiBase: process.env.NEXT_PUBLIC_D17_MAINNET_API_BASE || "",
    wsUrl: process.env.NEXT_PUBLIC_D17_MAINNET_WS_URL || "",
    rpcUrl: process.env.NEXT_PUBLIC_D17_MAINNET_RPC_URL || "",
    rpcWsUrl: process.env.NEXT_PUBLIC_D17_MAINNET_RPC_WS_URL || "",
    launchAddressOverride: process.env.NEXT_PUBLIC_D17_MAINNET_LAUNCH_ADDRESS || "",
    fromBlockOverride: process.env.NEXT_PUBLIC_D17_MAINNET_FROM_BLOCK || "",
    priceUrl: process.env.NEXT_PUBLIC_D17_MAINNET_PRICE_URL || "",
  },
  local: {
    key: "local",
    chainId: 31337,
    chainName: "Localhost",
    networkLabel: "Local · Hardhat",
    explorerBase: "",
    apiBase: "",
    wsUrl: "",
    rpcUrl: process.env.NEXT_PUBLIC_D17_LOCAL_RPC_URL || "http://127.0.0.1:8545",
    rpcWsUrl: "",
    launchAddressOverride: process.env.NEXT_PUBLIC_D17_LOCAL_LAUNCH_ADDRESS || "",
    fromBlockOverride: "0",
    priceUrl: "",
  },
};

function isNetworkKey(value: string | null): value is D17NetworkKey {
  return value === "sepolia" || value === "mainnet" || (value === "local" && LOCAL_NETWORK_ENABLED);
}

function resolveActiveNetwork(): D17NetworkKey {
  if (typeof window === "undefined") return DEFAULT_NETWORK;

  const requested = new URLSearchParams(window.location.search).get("network");
  if (isNetworkKey(requested)) {
    try {
      window.localStorage.setItem("d17-network", requested);
    } catch {}
    return requested;
  }

  try {
    const saved = window.localStorage.getItem("d17-network");
    if (isNetworkKey(saved)) return saved;
  } catch {}

  return DEFAULT_NETWORK;
}

export const ACTIVE_NETWORK_KEY = resolveActiveNetwork();
export const ACTIVE_NETWORK = NETWORKS[ACTIVE_NETWORK_KEY];
export const D17_NETWORKS = NETWORKS;

/** Internal navigation always carries an explicit network. Chain-specific
 * state is included only when the caller supplies it. */
export function d17Href(pathname: string, values: Record<string, string> = {}): string {
  const params = new URLSearchParams({ network: ACTIVE_NETWORK_KEY, ...values });
  return `${pathname}?${params.toString()}`;
}

/** A network change is a full navigation by design. That tears down every
 * provider, socket, timer, and request before the other chain initializes. */
export function networkSwitchHref(network: D17NetworkKey): string {
  const pathname = typeof window === "undefined" ? "/" : window.location.pathname;
  return `${pathname}?network=${network}`;
}
