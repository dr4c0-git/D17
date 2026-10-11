import mainnetDeployment from "@/deployments/mainnet.json";
import sepoliaDeployment from "@/deployments/sepolia.json";
import { CHAIN_ID } from "@/lib/d17Api";
import { LOCAL_NETWORK_ENABLED } from "@/lib/d17Network";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export type PublicDeployment = {
  chainId: number;
  network: "mainnet" | "sepolia" | "local";
  protocolVersion: string;
  /** "not-deployed" until the V15 contract suite is deployed and published. */
  status: "deployed" | "not-deployed";
  startBlock: number;
  contracts: {
    d17Factory: string;
    feeConfig: string;
    tokenFactory: string;
    launchDeployer: string;
    launchFactory: string;
    liquidityVaultFactory: string;
    lockerFactory: string;
  };
  weth: string;
  router: string;
};

/** Local Hardhat suite deployed by `npm run demo:local`, read from apps/web/.env.local
 *  (git-ignored). Next.js only inlines literal process.env.NEXT_PUBLIC_* reads. */
const localDeployment: PublicDeployment = {
  chainId: 31337,
  network: "local",
  protocolVersion: "V15_HARDENED",
  status: process.env.NEXT_PUBLIC_D17_LOCAL_D17_FACTORY ? "deployed" : "not-deployed",
  startBlock: 0,
  contracts: {
    d17Factory: process.env.NEXT_PUBLIC_D17_LOCAL_D17_FACTORY || ZERO_ADDRESS,
    feeConfig: process.env.NEXT_PUBLIC_D17_LOCAL_FEE_CONFIG || ZERO_ADDRESS,
    tokenFactory: process.env.NEXT_PUBLIC_D17_LOCAL_TOKEN_FACTORY || ZERO_ADDRESS,
    launchDeployer: process.env.NEXT_PUBLIC_D17_LOCAL_LAUNCH_DEPLOYER || ZERO_ADDRESS,
    launchFactory: process.env.NEXT_PUBLIC_D17_LOCAL_LAUNCH_FACTORY || ZERO_ADDRESS,
    liquidityVaultFactory: process.env.NEXT_PUBLIC_D17_LOCAL_VAULT_FACTORY || ZERO_ADDRESS,
    lockerFactory: process.env.NEXT_PUBLIC_D17_LOCAL_LOCKER_FACTORY || ZERO_ADDRESS,
  },
  weth: process.env.NEXT_PUBLIC_D17_LOCAL_WETH || ZERO_ADDRESS,
  router: process.env.NEXT_PUBLIC_D17_LOCAL_ROUTER || ZERO_ADDRESS,
};

export const DEPLOYMENTS: Record<number, PublicDeployment> = {
  11155111: sepoliaDeployment as PublicDeployment,
  1: mainnetDeployment as PublicDeployment,
};
if (LOCAL_NETWORK_ENABLED) DEPLOYMENTS[31337] = localDeployment;

export const PUBLIC_DEPLOYMENT = DEPLOYMENTS[CHAIN_ID];

if (!PUBLIC_DEPLOYMENT) {
  throw new Error(`D17 has no bundled deployment for chain ${CHAIN_ID}`);
}

/** False until the V15 suite for this network is deployed and its manifest published. */
export const PROTOCOL_DEPLOYED = PUBLIC_DEPLOYMENT.status === "deployed";
const IS_MAINNET_CHAIN = PUBLIC_DEPLOYMENT.chainId === 1;

export const LOCAL_DEPLOYER_SCHEMA = {
  profile: PUBLIC_DEPLOYMENT.network,
  chainId: CHAIN_ID,
  contractVersion: "D17_V15_HARDENED",
  contracts: PUBLIC_DEPLOYMENT.contracts,
  manualDistribution: {
    supportedByCurrentContract: true,
    configField: "manualDistributionTokens",
    recipient: "launch creator / msg.sender",
    maxBpsOfSupply: 1000,
    vestingDays: 180,
  },
  protocolFee: {
    maxBps: 200,
    chargedOn: "successful settlement only",
  },
  validation: {
    roundCount: 5,
    refundStageCount: 4,
    tokenNameBytes: { min: 1, max: 64 },
    tokenSymbolBytes: { min: 1, max: 16 },
    descriptionBytes: { max: 512 },
    links: {
      max: 8,
      linkTypeBytes: { max: 32, pattern: "^[a-z0-9-]+$" },
      urlBytes: { max: 128 },
    },
    earlyRefundPenaltyBps: 100,
    refundPenaltyBps: { min: 100, max: 2500 },
    treasuryBps: { min: 0, max: 1000 },
    roundSeconds: { length: 5, min: IS_MAINNET_CHAIN ? 3600 : 60, max: 7776000 },
    windowSeconds: { min: IS_MAINNET_CHAIN ? 3600 : 1 },
    startDelaySeconds: { min: IS_MAINNET_CHAIN ? 86400 : 0 },
  },
  knownContractGaps: [],
} as const;
