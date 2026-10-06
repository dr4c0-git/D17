import mainnetDeployment from "@/deployments/mainnet.json";
import sepoliaDeployment from "@/deployments/sepolia.json";
import { CHAIN_ID } from "@/lib/d17Api";

export type PublicDeployment = {
  chainId: number;
  network: "mainnet" | "sepolia";
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

export const DEPLOYMENTS: Record<number, PublicDeployment> = {
  11155111: sepoliaDeployment as PublicDeployment,
  1: mainnetDeployment as PublicDeployment,
};

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
