"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, Loader2 } from "lucide-react";
import { ethers } from "ethers";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  apiBase,
  CHAIN_ID,
  CHAIN_NAME,
  dataMode,
  EXPLORER_BASE,
  getActivity,
  getDeployerSchema,
  getEthUsd,
  PRICE_URL,
  getLaunch,
  getLaunches,
  getLaunchMetadata,
  getLockers,
  getPhase,
  IS_MAINNET,
  NETWORK_LABEL,
  READ_RPC_URL,
  SITE_MODE,
  subscribeWs,
  unwrapList,
  type ApiActivityItem,
  type LaunchMetadata,
} from "@/lib/d17Api";
import { NetworkSwitch } from "@/components/network-switch";
import { ACTIVE_NETWORK, d17Href } from "@/lib/d17Network";
import { PROTOCOL_DEPLOYED, PUBLIC_DEPLOYMENT } from "@/lib/d17Manifest";
import { commitIfCurrentGeneration, isCurrentGeneration } from "@/lib/refresh-guard.mjs";
import { dedupeActivityActions, dedupeActivityForDisplay } from "@/lib/activity-dedupe.mjs";
import { loadActivityHistory } from "@/lib/activity-history.mjs";
import { redirect } from "next/navigation";

declare global {
  interface Window {
    ethereum?: ethers.Eip1193Provider;
  }
}

/* EIP-6963: wallets announce themselves via window events, so the UI never
   has to fight over the contested window.ethereum global. */
type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: ethers.Eip1193Provider;
};

// Chain identity comes from lib/d17Api (env-driven); no chain literals here.
const CHAIN_ID_BIG = BigInt(CHAIN_ID);
const API_URL = process.env.NEXT_PUBLIC_D17_API_URL || "";
const READ_WS_URL = process.env.NEXT_PUBLIC_SEPOLIA_WS_URL || "";
// Scans anchor to the bundled deployment's start block (per-network override
// wins) — a fresh visitor must find launches older than any lookback window.
const EVENT_FROM_BLOCK = Number(ACTIVE_NETWORK.fromBlockOverride || PUBLIC_DEPLOYMENT?.startBlock || "0");
const EVENT_LOOKBACK_BLOCKS = Number(process.env.NEXT_PUBLIC_D17_LOOKBACK_BLOCKS || "25000");
const EVENT_CHUNK_SIZE = Number(process.env.NEXT_PUBLIC_D17_EVENT_CHUNK_SIZE || "5000");
const EVENT_POLL_SECONDS = Number(process.env.NEXT_PUBLIC_D17_EVENT_POLL_SECONDS || "12");
const STATE_POLL_SECONDS = Number(process.env.NEXT_PUBLIC_D17_STATE_POLL_SECONDS || "15");
// Optional ETH/USD display. Hosted (api) only — the local/rpc build has no
// backend price collector. Env kill-switch, default on.
const USD_ENABLED = process.env.NEXT_PUBLIC_ENABLE_USD !== "false";
// Canonical WETH per chain — display fallback only; api mode adopts the
// launch detail's `weth`, and rpc mode reads it from the contract.
const DEFAULT_WETH = IS_MAINNET
  ? "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
  : "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const TOKEN_SYMBOL = process.env.NEXT_PUBLIC_D17_TOKEN_SYMBOL || "D17";
// Testing aids (stage replay and launch-switcher dropdown)
// render only when explicitly enabled — the public site ships without them.
const TEST_CONTROLS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_TEST_CONTROLS === "true";
const DEFAULT_LAUNCH = ACTIVE_NETWORK.launchAddressOverride || process.env.NEXT_PUBLIC_D17_LAUNCH_ADDRESS || "";
const SEEN_LAUNCHES_KEY = `d17-seen-launches:${dataMode()}:${CHAIN_ID}`;
const DEFAULT_LOCKER_FACTORY = process.env.NEXT_PUBLIC_D17_LOCKER_FACTORY_ADDRESS || "";
const DEFAULT_LOCKER = process.env.NEXT_PUBLIC_D17_LOCKER_ADDRESS || "";
const DEFAULT_RULES_HASH = process.env.NEXT_PUBLIC_D17_RULES_HASH || "";
const ROUND_COUNT = 5;
const REFUND_STAGE_COUNT = 4;
// Contract refund schedule: refund windows follow rounds 1-4; the first
// EARLY_REFUND_ROUNDS windows charge the fixed early penalty, the rest charge
// refundPenaltyBps, and the final round has no window. Every penalty is paid into
// the official pool (or burned if the launch fails), never to the creator.
const EARLY_REFUND_ROUNDS = 2;
const EARLY_REFUND_PENALTY_PCT = 1;
const NO_ROUND = 255;

const PHASE = {
  NOT_STARTED: 0,
  ROUND_OPEN: 1,
  REFUND_OPEN: 2,
  READY_TO_FINALIZE: 3,
  SETTLEMENT_OPEN: 4,
  POOL_READY: 5,
  TRADING_OPEN: 6,
  FAILED: 7,
} as const;

const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"];

/** Jump targets for the mobile sticky section nav, in mobile visual order.
 *  The first entry renders as the live phase chip. */
const NAV_SECTIONS = [
  { id: "stage", label: "Stage" },
  { id: "rounds", label: "Rounds" },
  { id: "launches", label: "Launches" },
  { id: "charts", label: "Charts" },
  { id: "contracts", label: "Contracts" },
  { id: "participants", label: "Activity" },
  { id: "timeline", label: "Stages" },
] as const;

/** A discovered launch for the switcher + discovery list. Fields are read
 *  tolerantly from /api/launches (the item shape is only partly confirmed
 *  until a launch indexes): a wrong guess degrades, never throws. */
type KnownLaunch = {
  launch: string;
  symbol: string;
  phaseLabel: string;
  phaseKind: number | null; // populated by detail enrichment (list has no phase)
  createdBlock: number | null; // ordering key: newest launches first
  label: string; // topbar <select> label
};

function toKnownLaunch(item: Record<string, unknown>): KnownLaunch | null {
  const address = (item.launch || item.address || "") as string;
  if (typeof address !== "string" || !ethers.isAddress(address)) return null;
  const launch = ethers.getAddress(address);
  // Confirmed shape: the list item nests token metadata under `metadata`
  // (tokenSymbol/tokenName/verified/links) and carries createdBlock AND phase
  // (kind/label) inline — no detail fetch needed to render the switcher row.
  const meta = (item.metadata as Record<string, unknown>) || {};
  const symbol = (
    ((item.tokenSymbol as string) ||
      (item.symbol as string) ||
      (meta.tokenSymbol as string) ||
      (meta.tokenName as string) ||
      "") as string
  ).trim();
  const phaseObj = (item.phase as { label?: string; kind?: number }) || {};
  const phaseLabel = (phaseObj.label as string) || "";
  const phaseKind = typeof phaseObj.kind === "number" ? phaseObj.kind : null;
  const createdBlockNum = Number(item.createdBlock);
  const createdBlock = Number.isFinite(createdBlockNum) && createdBlockNum > 0 ? createdBlockNum : null;
  const label = `${symbol || shortAddress(launch)}${phaseLabel ? ` · ${phaseLabel}` : ""}`;
  return { launch, symbol, phaseLabel, phaseKind, createdBlock, label };
}

type RpcLaunchCacheEntry = KnownLaunch & { token: string };

async function discoverRpcLaunches(): Promise<KnownLaunch[]> {
  if (!READ_RPC_URL || !PUBLIC_DEPLOYMENT?.contracts.d17Factory) return [];
  const provider = readProvider();
  const cacheKey = `d17-rpc-launches:${CHAIN_ID}:${PUBLIC_DEPLOYMENT.contracts.d17Factory.toLowerCase()}`;
  try {
    let cached: { indexedToBlock?: number; launches?: RpcLaunchCacheEntry[] } = {};
    try {
      cached = JSON.parse(localStorage.getItem(cacheKey) || "{}");
    } catch {
      cached = {};
    }

    const byLaunch = new Map<string, RpcLaunchCacheEntry>();
    for (const entry of cached.launches || []) {
      if (ethers.isAddress(entry.launch) && ethers.isAddress(entry.token)) {
        byLaunch.set(entry.launch.toLowerCase(), entry);
      }
    }

    const latestBlock = await provider.getBlockNumber();
    const startBlock = Math.max(
      EVENT_FROM_BLOCK,
      cached.indexedToBlock ? Math.max(EVENT_FROM_BLOCK, cached.indexedToBlock - 12) : EVENT_FROM_BLOCK
    );
    const factory = await contractWithProvider("D17Factory", PUBLIC_DEPLOYMENT.contracts.d17Factory, provider);
    const logs = startBlock <= latestBlock
      ? await queryContractLogs(provider, factory, ["LaunchCreated"], startBlock, latestBlock)
      : [];

    for (const event of logs) {
      const launch = ethers.getAddress(event.args.launch as string);
      const token = ethers.getAddress(event.args.token as string);
      const previous = byLaunch.get(launch.toLowerCase());
      byLaunch.set(launch.toLowerCase(), {
        launch,
        token,
        symbol: previous?.symbol || "",
        phaseKind: previous?.phaseKind ?? null,
        phaseLabel: previous?.phaseLabel || "",
        createdBlock: Number(event.blockNumber),
        label: previous?.label || shortAddress(launch),
      });
    }

    const hydrated = await Promise.all([...byLaunch.values()].map(async (entry) => {
      let symbol = entry.symbol;
      let phaseKind = entry.phaseKind;
      let phaseLabel = entry.phaseLabel;
      try {
        const [token, launch] = await Promise.all([
          contractWithProvider("D17Token", entry.token, provider),
          contractWithProvider("D17Launch", entry.launch, provider),
        ]);
        const [loadedSymbol, rawPhase] = await Promise.all([
          token.symbol().catch(() => symbol) as Promise<string>,
          launch.launchPhase().catch(() => null) as Promise<ethers.Result | null>,
        ]);
        symbol = loadedSymbol || symbol;
        if (rawPhase) {
          phaseKind = Number(rawPhase[0]);
          phaseLabel = describePhase({
            phaseKind,
            index: Number(rawPhase[1]),
            startsAt: Number(rawPhase[2]),
            endsAt: Number(rawPhase[3]),
          });
        }
      } catch {
        // Keep the last cached label. The selected launch performs its own
        // full contract read and will surface any provider error there.
      }
      return {
        ...entry,
        symbol,
        phaseKind,
        phaseLabel,
        label: `${symbol || shortAddress(entry.launch)}${phaseLabel ? ` · ${phaseLabel}` : ""}`,
      };
    }));

    hydrated.sort((a, b) => (a.createdBlock ?? 0) - (b.createdBlock ?? 0));
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ indexedToBlock: latestBlock, launches: hydrated }));
    } catch {
      // Private browsing or a full storage quota only removes the cache.
    }
    return hydrated;
  } finally {
    provider.destroy();
  }
}

// ── RPC metadata + verification ─────────────────────────────────────────
// The same checks the indexed backend performs, run directly against the
// chain: the token's stored metadata hash, the launch's copy, the factory's
// LaunchMetadataPublished event and the contractURI JSON must all agree with
// the hash recomputed from the on-chain fields. Any disagreement → unverified.

const CURRENT_LAUNCH_ID = ethers.keccak256(ethers.toUtf8Bytes("D17_LAUNCH_V15_HARDENED"));

function parseContractUriJson(uri: string): Record<string, unknown> | null {
  const prefixes = ["data:application/json;charset=utf-8,", "data:application/json;utf8,"];
  const prefix = prefixes.find((item) => String(uri || "").startsWith(item));
  if (!prefix) return null;
  try {
    return JSON.parse(String(uri).slice(prefix.length)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function metadataHashForLaunch(
  launchId: string | null,
  fields: { tokenName: string; tokenSymbol: string; description: string; logoSvgUri: string; links: { linkType: string; url: string }[] }
): string | null {
  if (!launchId) return null;
  if (ethers.hexlify(launchId).toLowerCase() !== CURRENT_LAUNCH_ID.toLowerCase()) return null;
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "string", "tuple(string linkType,string url)[]"],
      [fields.tokenName || "", fields.tokenSymbol || "", fields.description || "", fields.logoSvgUri || "", fields.links]
    )
  );
}

async function loadRpcLaunchMetadata(launchAddress: string): Promise<LaunchMetadata | null> {
  if (!READ_RPC_URL) return null;
  const provider = readProvider();
  try {
    const launch = await contractWithProvider("D17Launch", launchAddress, provider);
    const tokenAddress = (await launch.token().catch(() => "")) as string;
    if (!ethers.isAddress(tokenAddress)) return null;
    const token = await contractWithProvider("D17Token", tokenAddress, provider);
    const [launchId, tokenName, tokenSymbol, description, logoSvgUri, tokenMetadataHash, launchMetadataHash, contractUri, linkCountRaw] =
      await Promise.all([
        launch.D17_LAUNCH_ID().catch(() => null) as Promise<string | null>,
        token.name().catch(() => "") as Promise<string>,
        token.symbol().catch(() => "") as Promise<string>,
        token.description().catch(() => "") as Promise<string>,
        token.logoSvgUri().catch(() => "") as Promise<string>,
        token.metadataHash().catch(() => null) as Promise<string | null>,
        launch.metadataHash().catch(() => null) as Promise<string | null>,
        token.contractURI().catch(() => "") as Promise<string>,
        token.linkCount().catch(() => 0n) as Promise<bigint>,
      ]);
    const links: { linkType: string; url: string }[] = [];
    for (let index = 0; index < Number(linkCountRaw); index++) {
      const item = (await token.links(index).catch(() => null)) as null | { linkType?: string; url?: string } & string[];
      if (!item) continue;
      links.push({ linkType: (item.linkType ?? item[0]) as string, url: (item.url ?? item[1]) as string });
    }
    const computedHash = metadataHashForLaunch(launchId, { tokenName, tokenSymbol, description, logoSvgUri, links });

    // The factory's publish event, filtered by the indexed launch topic —
    // one narrow eth_getLogs from the bundled deployment's start block.
    let eventHash: string | null = null;
    if (PUBLIC_DEPLOYMENT?.contracts.d17Factory) {
      const factory = await contractWithProvider("D17Factory", PUBLIC_DEPLOYMENT.contracts.d17Factory, provider);
      const fromBlock = Math.max(EVENT_FROM_BLOCK, PUBLIC_DEPLOYMENT.startBlock || 0);
      // Chunked scan — free-tier RPCs reject wide eth_getLogs ranges, and
      // queryContractLogs already paces them the way discovery does.
      const latestBlock = await provider.getBlockNumber();
      const logs = await queryContractLogs(provider, factory, ["LaunchMetadataPublished"], fromBlock, latestBlock).catch(() => [] as any[]);
      const mine = logs.filter((log) => String(log.args?.launch || "").toLowerCase() === launchAddress.toLowerCase());
      const last = mine[mine.length - 1];
      const raw = last?.args?.metadataHash as string | undefined;
      eventHash = raw ? ethers.hexlify(raw).toLowerCase() : null;
    }

    const eq = (value: string | null) => Boolean(computedHash && value && ethers.hexlify(value).toLowerCase() === computedHash.toLowerCase());
    const parsedContractUri = parseContractUriJson(contractUri);
    const contractUriMatches = Boolean(
      parsedContractUri &&
        parsedContractUri.name === tokenName &&
        parsedContractUri.symbol === tokenSymbol &&
        parsedContractUri.description === description &&
        parsedContractUri.image === logoSvgUri &&
        JSON.stringify(((parsedContractUri.links as { type?: string; url?: string }[]) || []).map((link) => ({ linkType: link.type, url: link.url }))) ===
          JSON.stringify(links)
    );
    const verified = Boolean(computedHash && eq(tokenMetadataHash) && eq(launchMetadataHash) && eventHash && eventHash === computedHash.toLowerCase() && contractUriMatches);

    return {
      launchId: launchId ?? undefined,
      verified,
      tokenName,
      tokenSymbol,
      description,
      logoSvgUri,
      links,
    };
  } finally {
    provider.destroy();
  }
}

/** Parse a wei value (string or JSON number) to bigint, tolerating
 *  null/empty/garbage → 0n. */
function toWei(value: unknown): bigint {
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value !== "string" || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/** Backend phase object → the app's PhaseSnapshot. raw = [kind, roundIndex,
 *  startsAt, endsAt]; kind/roundIndex prefer the typed fields when present. */
function apiPhaseToSnapshot(phase: { kind?: number; roundIndex?: number; raw?: string[] }): PhaseSnapshot {
  const raw = phase.raw || [];
  const phaseKind = typeof phase.kind === "number" ? phase.kind : Number(raw[0] ?? 0);
  const index = typeof phase.roundIndex === "number" ? phase.roundIndex : Number(raw[1] ?? 0);
  const startsAt = Number(raw[2] ?? 0);
  const endsAt = Number(raw[3] ?? 0);
  return {
    phaseKind: Number.isFinite(phaseKind) ? phaseKind : 0,
    index: Number.isFinite(index) ? index : 0,
    startsAt: Number.isFinite(startsAt) ? startsAt : 0,
    endsAt: Number.isFinite(endsAt) ? endsAt : 0,
  };
}

type ApiLockerSummary = {
  locker?: string;
  owner?: string;
  committedWeth?: string;
  refundedWeth?: string;
  penaltyWeth?: string;
  settledWeth?: string;
  saleTokens?: string;
  settled?: boolean;
  lastBlock?: number;
  rounds?: { round?: number; committedWeth?: string; refundedWeth?: string; penaltyWeth?: string }[];
  // Locker WETH balances, served by the backend (cached contract reads).
  lockedWeth?: string;
  withdrawableWeth?: string;
  lockerWethBalance?: string;
  balances?: { lockedWeth?: string; withdrawableWeth?: string; accountedWeth?: string };
};

/** Backend locker summary → the app's per-round RoundSnapshot[] (enough for
 *  commit/refund gating; token/preview fields aren't on this endpoint). */
function apiLockerToRoundPositions(locker: ApiLockerSummary): RoundSnapshot[] {
  const rounds = locker.rounds || [];
  return Array.from({ length: ROUND_COUNT }, (_, round) => {
    const entry = rounds.find((item) => Number(item.round) === round);
    const committed = toWei(entry?.committedWeth);
    const refunded = toWei(entry?.refundedWeth);
    return {
      round,
      committedWeth: formatEth(committed),
      claimedTokens: "0",
      refunded: refunded > 0n,
      tokensClaimed: false,
      previewTokens: "0",
      roundNetWeth: "0",
      roundPriceWeth: "0",
      walletPriceWeth: "0",
    };
  });
}

type RoundTerm = {
  id: number;
  allocationPct: number;
  deflectionCostPct: number;
  startAt: number;
  endAt: number;
  refundStartAt: number;
  refundEndAt: number;
};

type ApiRefundPolicy = {
  refundable?: boolean;
  reason?: string | null;
  refundWindowStart?: number | null;
  refundWindowEnd?: number | null;
  refundPenaltyBps?: number | null;
  deflectionCostBps?: number | null;
};

type ApiRound = {
  round?: number;
  displayRound?: number;
  start?: number;
  end?: number;
  shareBps?: number;
  raisedWeth?: string;
  discoveredPriceWad?: string;
  anchorTargetWeth?: string;
  refundPolicy?: ApiRefundPolicy;
};

/** Backend rounds[] → the app's RoundTerm[]. The refund window and per-round
 *  deflection cost come straight from rounds[].refundPolicy. */
function apiRoundsToTerms(rounds: ApiRound[]): RoundTerm[] {
  return rounds.map((entry, index) => {
    const policy = entry.refundPolicy || {};
    const refundable = Boolean(policy.refundable);
    const endAt = Number(entry.end ?? 0);
    return {
      id: typeof entry.displayRound === "number" ? entry.displayRound : index + 1,
      allocationPct: Number(entry.shareBps ?? 0) / 100,
      deflectionCostPct: refundable ? Number(policy.deflectionCostBps ?? 0) / 100 : 0,
      startAt: Number(entry.start ?? 0),
      endAt,
      refundStartAt: refundable ? Number(policy.refundWindowStart ?? endAt) : endAt,
      refundEndAt: refundable ? Number(policy.refundWindowEnd ?? 0) : 0,
    };
  });
}

/** Whether a round has a refund window. Loaded terms carry the real window
 *  (API refundPolicy / contract refundSeconds); placeholder terms (nothing
 *  loaded yet, startAt 0) keep the pre-load shape. */
function roundHasRefundWindow(round: RoundTerm | undefined, index: number): boolean {
  if (!round || round.startAt === 0) return index < REFUND_STAGE_COUNT;
  return round.refundEndAt > 0;
}

type RoundMarket = {
  raisedWeth: string;
  priceWeth: string;
  hasPrice: boolean;
};

type RoundDetail = {
  commits: number;
  refunds: number;
  lockers: number;
  refundedWeth: number;
  spark: number[];
  raised: string;
  price: string | null;
};

type LaunchStats = {
  totalCommittedWeth: string;
  minCommitWeth: string;
  minCommitLabel: string;
  anchorReady: boolean;
  anchorTargetWeth: string;
};

/** Static launch config + tokenomics, from the launch detail's
 *  config/tokenomics objects in api mode (contract reads in rpc mode). */
type LaunchConfig = {
  refundPenaltyPct: number; // e.g. 17
  treasuryPct: number; // WETH % to treasury, e.g. 1
  protocolFeePct: number; // WETH % protocol fee, fixed at launch creation (V15)
  settlementSeconds: number; // claim-window length — settlement countdown fallback
  saleTokens: bigint;
  lpTokens: bigint;
  deadTokens: bigint;
  manualTokens: bigint; // deployer/airdrop allocation (0 on older contracts)
};

type PhaseSnapshot = {
  phaseKind: number;
  index: number;
  startsAt: number;
  endsAt: number;
};

/** V14 pool composition, reduced to what the stage line states: what actually
 *  entered the pool (seed + late top-ups) and what's still reserved. When a
 *  data source doesn't carry it the line simply hides. */
type PoolCompositionLine = {
  seededToken: bigint;
  seededWeth: bigint;
  lateToken: bigint;
  lateWeth: bigint;
  reservedTokens: bigint;
};

/** Only non-zero parts render — and never the lpTokens allocation, which is
 *  not the same thing as pool contents (the pool can be seeded partially and
 *  topped up by late settlements). */
function poolCompositionParts(comp: PoolCompositionLine, symbol: string, ctx: CurrencyCtx): string[] {
  const token = (value: bigint) => compactNumber(Number(ethers.formatUnits(value, 18)));
  // WETH → active currency. Small pools need enough precision to avoid
  // turning a real non-zero reserve into the false statement "0 WETH".
  const weth = (value: bigint) => {
    const eth = Number(ethers.formatUnits(value, 18));
    if (ctx.usd && ctx.rate) {
      const usd = eth * ctx.rate;
      return `$${usd.toLocaleString("en-US", { maximumFractionDigits: usd >= 1000 ? 0 : 2 })}`;
    }
    if (eth > 0 && eth < 0.000001) return "<0.000001 WETH";
    const digits = eth > 0 && eth < 0.01 ? 6 : eth < 1 ? 4 : 2;
    return `${trimDecimals(eth.toFixed(digits), digits)} WETH`;
  };
  const parts: string[] = [];
  if (comp.seededToken > 0n || comp.seededWeth > 0n)
    parts.push(`At creation ${token(comp.seededToken)} ${symbol} + ${weth(comp.seededWeth)}`);
  if (comp.lateToken > 0n || comp.lateWeth > 0n)
    parts.push(`Added later ${token(comp.lateToken)} ${symbol} + ${weth(comp.lateWeth)}`);
  if (comp.reservedTokens > 0n) {
    const reserved = Number(ethers.formatUnits(comp.reservedTokens, 18));
    parts.push(`Reserved ${reserved >= 0.01 ? compactNumber(reserved) : "<0.01"} ${symbol}`);
  }
  return parts;
}

type RoundSnapshot = {
  round: number;
  committedWeth: string;
  claimedTokens: string;
  refunded: boolean;
  tokensClaimed: boolean;
  previewTokens: string;
  roundNetWeth: string;
  roundPriceWeth: string;
  walletPriceWeth: string;
};

type PositionSnapshot = {
  known: boolean;
  lockedWeth: string;
  withdrawableWeth: string;
  withdrawableWethExact: string;
  residualWeth: string;
  withdrawableTokens: string;
  withdrawableTokensExact: string;
  claimedSaleTokens: string;
  liquiditySettled: boolean;
  liquidityVault: string;
  wethSentToVault: string;
  treasuryWeth: string;
  protocolFeeWeth: string;
  finalSaleTokensClaimed: boolean;
};

type TxLog = {
  label: string;
  hash: string;
  at: number;
};

type BalanceSnapshot = {
  walletEth: string;
  walletWeth: string;
  lockerWeth: string;
  lockedWeth: string;
  withdrawableWeth: string;
};

type ActivityItem = {
  id: string;
  event: string;
  label: string;
  detail: string;
  /** api feed only: which contract emitted this row ("launch" | "locker").
   *  The same on-chain action is emitted by both; accounting must count it
   *  once, preferring the canonical launch emission. */
  sourceKind?: string;
  locker?: string;
  round?: number;
  amountWeth?: string;
  amountToken?: string;
  penaltyWeth?: string;
  recipient?: string;
  hash: string;
  blockNumber: number;
  logIndex: number;
  timestamp?: number;
};

type LockerSummary = {
  locker: string;
  owner?: string;
  committedWeth: bigint;
  refundedWeth: bigint;
  penaltyWeth: bigint;
  settledWeth: bigint;
  saleTokens: bigint;
  rounds: bigint[];
  settled: boolean;
  lastBlock: number;
};

function apiLockerToSummary(locker: ApiLockerSummary): LockerSummary | null {
  if (!locker.locker || !ethers.isAddress(locker.locker)) return null;
  const rounds = Array.from({ length: ROUND_COUNT }, () => 0n);
  for (const entry of locker.rounds || []) {
    const round = Number(entry.round);
    if (Number.isInteger(round) && round >= 0 && round < ROUND_COUNT) rounds[round] = toWei(entry.committedWeth);
  }
  return {
    locker: ethers.getAddress(locker.locker),
    owner: locker.owner && ethers.isAddress(locker.owner) ? ethers.getAddress(locker.owner) : undefined,
    committedWeth: toWei(locker.committedWeth),
    refundedWeth: toWei(locker.refundedWeth),
    penaltyWeth: toWei(locker.penaltyWeth),
    settledWeth: toWei(locker.settledWeth),
    saleTokens: toWei(locker.saleTokens),
    rounds,
    settled: Boolean(locker.settled),
    lastBlock: Number(locker.lastBlock || 0),
  };
}

async function loadApiActivityHistory(launch: string, cachedItems: ApiActivityItem[]) {
  return loadActivityHistory<ApiActivityItem>(async (cursor) => {
    const { data, meta } = await getActivity(launch, { limit: 500, ...(cursor ? { cursor } : {}) });
    return {
      items: (Array.isArray(data) ? data : data.items ?? []) as ApiActivityItem[],
      nextCursor: Array.isArray(data) ? null : data.nextCursor || null,
      stale: Boolean(meta.stale),
    };
  }, cachedItems);
}

type TimelineStage = {
  id: string;
  title: string;
  subtitle: string;
  startsAt: number;
  endsAt: number;
  active: boolean;
  done: boolean;
  failed?: boolean;
  skipped?: boolean;
  disabled?: boolean;
};

type ActivityMode = "activity" | "lockers" | "locker";

const defaultRounds: RoundTerm[] = Array.from({ length: ROUND_COUNT }, (_, index) => ({
  id: index + 1,
  allocationPct: index === 0 ? 40 : 15,
  deflectionCostPct: index < EARLY_REFUND_ROUNDS ? EARLY_REFUND_PENALTY_PCT : index < REFUND_STAGE_COUNT ? 17 : 0,
  startAt: 0,
  endAt: 0,
  refundStartAt: 0,
  refundEndAt: 0,
}));

/** Display-currency context. `usd` is only ever true when the user picked USD
 *  AND a live rate exists — so deep components can read one flag. ETH stays
 *  canonical for inputs/transactions; this is display-only. */
type CurrencyCtx = { usd: boolean; rate: number | null };
const CurrencyContext = createContext<CurrencyCtx>({ usd: false, rate: null });
const useCurrency = () => useContext(CurrencyContext);

/** ETH amount → active-currency string ("$2,732" or "1.5267 ETH"). */
function fmtAmount(eth: number, ctx: CurrencyCtx, ethDigits = 4): string {
  if (!Number.isFinite(eth)) return ctx.usd ? "$0" : `0 ETH`;
  if (ctx.usd && ctx.rate) {
    const value = eth * ctx.rate;
    const digits = value >= 1000 ? 0 : value >= 1 ? 2 : 4;
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }
  return `${trimDecimals(eth.toFixed(ethDigits), ethDigits)} ETH`;
}

/** ETH-per-token price → active-currency string (uses the subscript-zero
 *  formatter for tiny values). Symbol optional. */
function fmtPrice(ethPerToken: number, ctx: CurrencyCtx, symbol?: string): string {
  const suffix = symbol ? `/${symbol}` : "";
  if (ctx.usd && ctx.rate) return `$${formatCryptoPrice(ethPerToken * ctx.rate)}${suffix}`;
  return `${formatCryptoPrice(ethPerToken)} ETH${suffix}`;
}

/** ETH/USD rate for display-only USD annotations. Backend reads the oracle
 *  once/min; the browser fetches the cached value on load + at most once/min.
 *  Hosted (api) mode only. Any failure / stale flag → null (USD hides). */
function useEthUsd(): number | null {
  const [usd, setUsd] = useState<number | null>(null);
  useEffect(() => {
    if (!USD_ENABLED || !PRICE_URL) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { data, meta } = await getEthUsd();
        if (cancelled) return;
        const price = Number(data?.price);
        // Hide on stale/malformed/unavailable — never show a bad USD number.
        if (data?.stale || meta.stale || !Number.isFinite(price) || price <= 0) {
          setUsd(null);
          return;
        }
        setUsd(price);
      } catch {
        if (!cancelled) setUsd(null);
      }
    };
    void load();
    const interval = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);
  return usd;
}

export default function ParticipantsPage() {
  // Deploy-only site: the terminal doesn't exist here, only /deploy does.
  if (SITE_MODE === "deploy") redirect("/deploy");
  return <ParticipantsTerminal />;
}

function ParticipantsTerminal() {
  const usdPerEth = useEthUsd();
  const [displayUsd, setDisplayUsd] = useState(false);
  useEffect(() => {
    setDisplayUsd(localStorage.getItem("d17-display-usd") === "1");
  }, []);
  const setCurrency = (usd: boolean) => {
    setDisplayUsd(usd);
    try {
      localStorage.setItem("d17-display-usd", usd ? "1" : "0");
    } catch {
      /* private mode */
    }
  };
  // Only ever USD when the user picked it AND a rate exists.
  const currency: CurrencyCtx = { usd: displayUsd && usdPerEth != null, rate: usdPerEth };
  // Metric subline = the OTHER currency (empty when no rate to show).
  const amountSub = (eth: number) =>
    !usdPerEth ? "" : currency.usd ? `${trimDecimals(eth.toFixed(4), 4)} ETH` : usdFromEth(eth, usdPerEth);
  const priceSub = (ethPerToken: number, symbol?: string) => {
    if (!usdPerEth) return "";
    const suffix = symbol ? `/${symbol}` : "";
    return currency.usd
      ? `${formatCryptoPrice(ethPerToken)} ETH${suffix}`
      : `$${formatCryptoPrice(ethPerToken * usdPerEth)}${suffix}`;
  };

  // Deployed factory suite from the schema — so Contracts shows the full set
  // (factory / token / launch / vault / locker factories) even before any
  // launch exists. api mode only; indexed API, never wallet/RPC.
  useEffect(() => {
    if (dataMode() !== "api") return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await getDeployerSchema();
        if (cancelled) return;
        const contracts = (data?.contracts ?? {}) as Record<string, string>;
        setSchemaContracts(contracts);
        // Populate the base factory when a launch hasn't already set it (helps
        // the wallet-locker lookup work on a fresh network too).
        if (contracts.d17Factory && ethers.isAddress(contracts.d17Factory)) {
          setFactoryAddress((current) => (ethers.isAddress(current) ? current : ethers.getAddress(contracts.d17Factory)));
        }
      } catch {
        /* schema unreachable — Contracts falls back to env/launch values */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [walletAddress, setWalletAddress] = useState("");
  const [lockerFactoryAddress, setLockerFactoryAddress] = useState(DEFAULT_LOCKER_FACTORY);
  // api mode selects the newest indexed launch on load (see auto-select
  // effect), so we start blank to avoid loading the stale env launch first —
  // that pre-load was the "oldest, then newest" double-load. rpc/local mode
  // has no indexer to discover from, so it keeps the env default.
  const [launchAddress, setLaunchAddress] = useState(() => (dataMode() === "api" ? "" : DEFAULT_LAUNCH));
  const [joinLaunchAddress, setJoinLaunchAddress] = useState(() => (dataMode() === "api" ? "" : DEFAULT_LAUNCH));
  const [lockerAddress, setLockerAddress] = useState(DEFAULT_LOCKER);
  const [expectedRulesHash, setExpectedRulesHash] = useState(DEFAULT_RULES_HASH);
  const [selectedRound, setSelectedRound] = useState(0);
  const [contribution, setContribution] = useState("0.25");
  // Withdraw amounts start BLANK on purpose: a prefilled number reads like
  // "this is what you have", and the indexed amount can lag the chain. The
  // user's own entry is the source of truth; the Max chip is just a hint.
  const [wethWithdrawAmount, setWethWithdrawAmount] = useState("");
  const [tokenWithdrawAmount, setTokenWithdrawAmount] = useState("");
  const [excessWethAmount, setExcessWethAmount] = useState("");
  const [livePhase, setPhase] = useState<PhaseSnapshot | null>(null);
  const [roundPositions, setRoundPositions] = useState<RoundSnapshot[]>([]);
  const [position, setPosition] = useState<PositionSnapshot | null>(null);
  const [tokenAddress, setTokenAddress] = useState("");
  const [poolAddress, setPoolAddress] = useState("");
  const [poolComposition, setPoolComposition] = useState<PoolCompositionLine | null>(null);
  const [wethAddress, setWethAddress] = useState(DEFAULT_WETH);
  const [liquidityVaultAddress, setLiquidityVaultAddress] = useState("");
  const [factoryAddress, setFactoryAddress] = useState("");
  // The deployed factory suite from the schema — shown in Contracts even
  // before any launch exists (e.g. a fresh mainnet with 0 launches).
  // Contracts panel factory set. Direct-RPC mode starts from the bundled
  // deployment manifest; api mode replaces it with the served schema, which
  // stays authoritative there.
  const [schemaContracts, setSchemaContracts] = useState<Record<string, string>>(() =>
    dataMode() === "api" ? {} : ((PUBLIC_DEPLOYMENT?.contracts ?? {}) as unknown as Record<string, string>)
  );
  const [balances, setBalances] = useState<BalanceSnapshot>({
    walletEth: "0",
    walletWeth: "0",
    lockerWeth: "0",
    lockedWeth: "0",
    withdrawableWeth: "0",
  });
  const [ownerLockers, setOwnerLockers] = useState<string[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [txLog, setTxLog] = useState<TxLog[]>([]);
  const [rounds, setRounds] = useState<RoundTerm[]>(defaultRounds);
  const [liveActivityItems, setActivityItems] = useState<ActivityItem[]>([]);
  const [liveLockerSummaries, setLockerSummaries] = useState<LockerSummary[]>([]);
  const [activityMode, setActivityMode] = useState<ActivityMode>("activity");
  const [selectedLockerForFeed, setSelectedLockerForFeed] = useState("");
  const [indexStatus, setIndexStatus] = useState("Not indexed yet");
  const [isIndexing, setIsIndexing] = useState(false);
  const [liveNowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  const [stateLoaded, setStateLoaded] = useState(false);
  const [stateStale, setStateStale] = useState(false);
  const [launchVerified, setLaunchVerified] = useState(false);
  const [joinAddressInvalid, setJoinAddressInvalid] = useState(false);
  const [linkRulesHash, setLinkRulesHash] = useState(DEFAULT_RULES_HASH);
  const [manualIndexing, setManualIndexing] = useState(false);
  const [indexLoaded, setIndexLoaded] = useState(false);
  const [liveRoundMarket, setRoundMarket] = useState<RoundMarket[]>([]);
  const [liveLaunchStats, setLaunchStats] = useState<LaunchStats | null>(null);
  // Anchor price = round 1's discovered price (raised ÷ allocation). It's the
  // canonical price for every round after the first, shown when a round's own
  // per-round price isn't published.
  const [anchorPriceWeth, setAnchorPriceWeth] = useState("");
  const [launchConfig, setLaunchConfig] = useState<LaunchConfig | null>(null);
  const [txStartedAt, setTxStartedAt] = useState(0);
  const [lockerSyncedFor, setLockerSyncedFor] = useState("");
  const [lockerLookupPending, setLockerLookupPending] = useState(false);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [lightMode, setLightMode] = useState(true);
  const [sseLive, setSseLive] = useState(false);
  // Global discovery socket state — lets empty-index/mainnet pages report the
  // discovery WS honestly even before any launch is selected.
  const [discoveryWsLive, setDiscoveryWsLive] = useState(false);
  const [knownLaunches, setKnownLaunches] = useState<KnownLaunch[]>([]);
  const [newLaunchCount, setNewLaunchCount] = useState(0);
  const [railTab, setRailTab] = useState<"rounds" | "launches">("rounds");
  const knownLaunchesRef = useRef<KnownLaunch[]>([]);
  const seenLaunchesRef = useRef<Set<string> | null>(null);
  const launchesSeededRef = useRef(false);
  const autoSelectedLaunchRef = useRef(false);
  const [launchMetadata, setLaunchMetadata] = useState<LaunchMetadata | null>(null);
  // The selected launch's symbol beats the env default — the env value is a
  // deploy-wide fallback, but each indexed launch carries its own symbol.
  const tokenSymbol = launchMetadata?.tokenSymbol?.trim() || TOKEN_SYMBOL;
  const soundEnabledRef = useRef(false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const prevPhaseKeyRef = useRef<string | null>(null);
  const walletListenersRef = useRef<Set<unknown>>(new Set());

  useEffect(() => {
    setNotifyEnabled(typeof Notification !== "undefined" && Notification.permission === "granted" && localStorage.getItem("d17-notify") === "1");
    setSoundEnabled(localStorage.getItem("d17-sound") === "1");
    // The pre-hydration script in layout.tsx already applied the theme.
    // Light is the default; dark is signalled by the .dark class.
    setLightMode(!document.documentElement.classList.contains("dark"));
  }, []);

  const toggleTheme = () => {
    const next = !lightMode; // next === going to light?
    setLightMode(next);
    if (next) {
      document.documentElement.dataset.theme = "light";
      document.documentElement.classList.remove("dark");
    } else {
      delete document.documentElement.dataset.theme;
      document.documentElement.classList.add("dark");
    }
    try {
      localStorage.setItem("d17-theme", next ? "light" : "dark");
    } catch {
      /* private mode */
    }
  };

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
  }, [soundEnabled]);

  // Fast path: the instant a wallet connects (or switches), look up its
  // lockers instead of waiting for the full state refresh, and auto-select
  // the first one if no locker is set yet. Hosted/api mode reads the indexed
  // locker list (owner rides on each row) — never the public RPC; the
  // lockersOfOwner contract read survives only for local/rpc mode.
  useEffect(() => {
    if (!walletAddress || !ethers.isAddress(walletAddress)) return;
    const apiMode = dataMode() === "api";
    if (apiMode ? !ethers.isAddress(launchAddress) : !ethers.isAddress(factoryAddress)) return;
    let cancelled = false;
    setLockerLookupPending(true);
    (async () => {
      try {
        let normalized: string[];
        if (apiMode) {
          const { data } = await getLockers(ethers.getAddress(launchAddress));
          const lockers = (
            Array.isArray(data) ? data : (data as { lockers?: unknown[] }).lockers ?? []
          ) as ApiLockerSummary[];
          normalized = lockers
            .filter((locker) => (locker.owner || "").toLowerCase() === walletAddress.toLowerCase())
            .map((locker) => ethers.getAddress(locker.locker as string));
        } else {
          const provider = readProvider();
          const d17Factory = await contractWithProvider("D17Factory", factoryAddress, provider);
          const lockers = (await d17Factory.lockersOfOwner(walletAddress).catch(() => [])) as string[];
          normalized = lockers.map((item) => ethers.getAddress(item));
        }
        if (cancelled) return;
        setOwnerLockers(normalized);
        // Only auto-fill an EMPTY field — never clobber a partial manual entry.
        setLockerAddress((current) => (current.trim() === "" ? normalized[0] ?? current : current));
      } catch {
        /* lookup is best-effort; the full state refresh covers it */
      } finally {
        setLockerLookupPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [walletAddress, factoryAddress, launchAddress]);

  // A newly entered locker must never display the previous locker's numbers.
  useEffect(() => {
    setRoundPositions([]);
    setPosition(null);
  }, [lockerAddress]);
  const [flashIds, setFlashIds] = useState<Set<string>>(() => new Set());
  const seenActivityIdsRef = useRef<Set<string>>(new Set());
  // API activity loads complete history once, then pages only until it
  // overlaps this cache. This keeps lifecycle facts complete without turning
  // each 12s safety reconcile into a full-history download.
  const apiActivityCacheRef = useRef<{ key: string; items: ApiActivityItem[] } | null>(null);
  // RPC activity is scanned incrementally; decoded events + block times are
  // cached per launch+vault so the 12s poll only re-queries the recent window.
  const rpcActivityCacheRef = useRef<{ key: string; throughBlock: number; events: any[] } | null>(null);
  const rpcBlockTimesRef = useRef<Map<number, number>>(new Map());
  const launchGenRef = useRef(0);
  const [walletProviders, setWalletProviders] = useState<Eip6963ProviderDetail[]>([]);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [mobileWalletHelpOpen, setMobileWalletHelpOpen] = useState(false);
  const [activeWalletName, setActiveWalletName] = useState("");
  const activeWalletRef = useRef<ethers.Eip1193Provider | null>(null);

  useEffect(() => {
    setLaunchVerified(false);
  }, [lockerAddress, expectedRulesHash]);

  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
      if (!detail?.info?.uuid || !detail.provider) return;
      setWalletProviders((current) =>
        current.some((item) => item.info.uuid === detail.info.uuid) ? current : [...current, detail]
      );
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce as EventListener);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce as EventListener);
  }, []);

  // ── Replay ─────────────────────────────────────────────────────────
  // Re-render the whole launch as of a past moment, from the real indexed
  // events only: phase, clock, feed, charts, chips and leaderboard all
  // derive from these views. Pure presentation — the live state keeps
  // refreshing underneath, and transactions are guarded off while active.
  const [replayCutoff, setReplayCutoff] = useState<number | null>(null);
  const isReplay = replayCutoff !== null;

  const replayCheckpoints = useMemo(() => {
    if (!indexLoaded) return [] as { label: string; cutoff: number }[];
    if (!liveActivityItems.some((item) => (item.timestamp ?? 0) > 0)) return [];
    // The launch can finalize before later scheduled rounds — never offer
    // a checkpoint for a round that never ran.
    const settlementAt = liveActivityItems
      .filter(
        (item) =>
          item.timestamp && ["LaunchFinalized", "OfficialPoolCreated", "VaultSettlementClaimed"].includes(item.event)
      )
      .reduce((min, item) => Math.min(min, item.timestamp as number), Number.MAX_SAFE_INTEGER);
    const list: { label: string; cutoff: number }[] = [];
    rounds.forEach((round, index) => {
      if (!(round.startAt > 0 && round.endAt > round.startAt)) return;
      if (round.startAt >= settlementAt) return;
      list.push({
        label: `Round ${index + 1} · open`,
        cutoff: Math.floor((round.startAt + Math.min(round.endAt, settlementAt)) / 2),
      });
      if (round.refundEndAt > round.refundStartAt && round.refundStartAt < settlementAt) {
        list.push({
          label: `Round ${index + 1} · refund window`,
          cutoff: Math.floor((round.refundStartAt + Math.min(round.refundEndAt, settlementAt)) / 2),
        });
      }
    });
    if (settlementAt < Number.MAX_SAFE_INTEGER) list.push({ label: "Settlement", cutoff: settlementAt + 1 });
    return list;
  }, [indexLoaded, liveActivityItems, rounds]);

  const replayPhase = useMemo<PhaseSnapshot | null>(
    () => (replayCutoff === null ? null : phaseAtTime(replayCutoff, rounds)),
    [replayCutoff, rounds]
  );

  const rawPhase = isReplay && replayPhase ? replayPhase : livePhase;
  // Settlement snapshots sometimes arrive without an end time (the replay
  // fallback is open-ended; sparse API snapshots were observed on the
  // 25-wallet run) — derive it from settlementSeconds so the claim-window
  // countdown and green progress treatment can never silently vanish.
  const phase = useMemo<PhaseSnapshot | null>(() => {
    if (
      rawPhase &&
      rawPhase.phaseKind === PHASE.SETTLEMENT_OPEN &&
      !isFiniteEnd(rawPhase.endsAt) &&
      rawPhase.startsAt > 0 &&
      (launchConfig?.settlementSeconds ?? 0) > 0
    ) {
      return { ...rawPhase, endsAt: rawPhase.startsAt + (launchConfig?.settlementSeconds ?? 0) };
    }
    return rawPhase;
  }, [rawPhase, launchConfig]);
  const nowSeconds = isReplay ? (replayCutoff as number) : liveNowSeconds;
  const activityItems = useMemo(
    () =>
      isReplay
        ? liveActivityItems.filter((item) => (item.timestamp ?? 0) <= (replayCutoff as number))
        : liveActivityItems,
    [isReplay, liveActivityItems, replayCutoff]
  );
  const lockerSummaries = useMemo(() => {
    if (!isReplay) return liveLockerSummaries;
    const owners = new Map(liveLockerSummaries.map((summary) => [summary.locker, summary.owner]));
    return aggregateLockerSummaries(activityItems).map((summary) => ({ ...summary, owner: owners.get(summary.locker) }));
  }, [isReplay, liveLockerSummaries, activityItems]);
  const roundMarket = useMemo(() => {
    if (!isReplay) return liveRoundMarket;
    const cutoff = replayCutoff as number;
    return liveRoundMarket.map((entry, index) => {
      const round = rounds[index];
      // Raised-so-far replays from events; the discovered price only exists
      // once the round has ended before the cutoff.
      let raised = 0;
      for (const item of dedupeActivityActions(activityItems)) {
        if (item.round !== index) continue;
        if (item.event === "RoundCommitted") raised += Number(item.amountWeth || 0);
        else if (item.event === "RoundRefunded") raised -= Number(item.amountWeth || 0) + Number(item.penaltyWeth || 0);
      }
      const priced = Boolean(round && round.endAt > 0 && round.endAt <= cutoff && entry.hasPrice);
      return {
        raisedWeth: trimDecimals(Math.max(0, raised).toFixed(6), 6),
        priceWeth: priced ? entry.priceWeth : "0",
        hasPrice: priced,
      };
    });
  }, [isReplay, liveRoundMarket, replayCutoff, rounds, activityItems]);
  const launchStats = useMemo(() => {
    if (!isReplay || !liveLaunchStats) return liveLaunchStats;
    let total = 0;
    let roundOne = 0;
    for (const item of dedupeActivityActions(activityItems)) {
      const outflow = Number(item.amountWeth || 0) + Number(item.penaltyWeth || 0);
      if (item.event === "RoundCommitted") {
        total += Number(item.amountWeth || 0);
        if (item.round === 0) roundOne += Number(item.amountWeth || 0);
      } else if (item.event === "RoundRefunded" || item.event === "LaunchFailedRefunded") {
        total -= outflow;
        if (item.round === 0) roundOne -= outflow;
      }
    }
    const anchorTarget = Number(liveLaunchStats.anchorTargetWeth);
    return {
      ...liveLaunchStats,
      totalCommittedWeth: trimDecimals(Math.max(0, total).toFixed(6), 6),
      anchorReady: anchorTarget > 0 ? roundOne >= anchorTarget : liveLaunchStats.anchorReady,
    };
  }, [isReplay, liveLaunchStats, activityItems]);

  const selectReplay = (cutoff: number | null) => {
    setReplayCutoff(cutoff);
    if (cutoff !== null) {
      const at = phaseAtTime(cutoff, rounds);
      if (at.phaseKind === PHASE.ROUND_OPEN || at.phaseKind === PHASE.REFUND_OPEN) setSelectedRound(at.index);
    }
  };

  const currentRound = rounds[selectedRound] || rounds[0];
  const activeRound = phase?.phaseKind === PHASE.ROUND_OPEN ? phase.index : null;
  const refundRound = phase?.phaseKind === PHASE.REFUND_OPEN ? phase.index : null;
  const canCommit = activeRound !== null && activeRound === selectedRound;
  const canRefund = refundRound !== null;
  const canFinalize = phase?.phaseKind === PHASE.READY_TO_FINALIZE;
  const canSettleAndClaim =
    (phase?.phaseKind === PHASE.SETTLEMENT_OPEN || phase?.phaseKind === PHASE.POOL_READY) &&
    Boolean(position?.known && !position.liquiditySettled);
  const canWithdrawTokens = phase?.phaseKind === PHASE.TRADING_OPEN && Number(position?.withdrawableTokens || 0) > 0;
  const canFailedRefund = phase?.phaseKind === PHASE.FAILED;
  const totalCommitted = useMemo(
    () => roundPositions.reduce((total, item) => total + Number(item.committedWeth || 0), 0),
    [roundPositions]
  );
  const totalPreviewTokens = useMemo(
    () => roundPositions.reduce((total, item) => total + Number(item.previewTokens || 0) + Number(item.claimedTokens || 0), 0),
    [roundPositions]
  );
  const averageWalletPrice = totalCommitted > 0 && totalPreviewTokens > 0 ? totalCommitted / totalPreviewTokens : 0;
  const phaseText = phase ? describePhase(phase) : "Not loaded";
  const rulesHashForTx = expectedRulesHash.trim() || ZERO_HASH;
  const averageWalletPriceLabel = formatPriceNumber(averageWalletPrice);
  const participantLink = launchAddress ? d17Href("/", { launch: launchAddress }) : "";
  const displayActivityItems = useMemo(() => dedupeActivityForDisplay(activityItems), [activityItems]);
  const filteredActivity = selectedLockerForFeed
    ? displayActivityItems.filter((item) => item.locker?.toLowerCase() === selectedLockerForFeed.toLowerCase())
    : displayActivityItems;
  const indexedNetCommitted = useMemo(
    () => lockerSummaries.reduce((total, item) => total + netCommitted(item), 0n),
    [lockerSummaries]
  );
  const settledLockerCount = lockerSummaries.filter((item) => item.settled).length;

  // Facts for the lifecycle stage expandables — event-derived, so replay
  // mode shows period-correct history too.
  const lifecycleFacts = useMemo<LifecycleFacts>(() => {
    const find = (...names: string[]) => displayActivityItems.find((item) => names.includes(item.event));
    return {
      finalized: find("Finalized"),
      unsoldDisposition: find("UnsoldSaleTokensBurned", "UnsoldSaleTokensPaid"),
      poolCreated: find("OfficialPoolCreated", "LiquidityPoolCreated"),
      vaultLiquidity: find("VaultLiquidityTokensClaimed"),
      settledCount: settledLockerCount,
      lockerCount: lockerSummaries.length,
      totalRaisedWeth: indexedNetCommitted,
      poolAddress,
      factoryAddress,
      liquidityVaultAddress,
      tokenAddress,
    };
  }, [
    displayActivityItems,
    settledLockerCount,
    lockerSummaries.length,
    indexedNetCommitted,
    poolAddress,
    factoryAddress,
    liquidityVaultAddress,
    tokenAddress,
  ]);

  const hasLaunch = ethers.isAddress(launchAddress);
  const hasWallet = Boolean(walletAddress);
  const hasLocker = ethers.isAddress(lockerAddress);
  const stageRoundIndex = activeRound ?? refundRound;
  const stageMarket = stageRoundIndex !== null ? roundMarket[stageRoundIndex] : undefined;
  const latestPricedIndex = useMemo(() => {
    for (let index = roundMarket.length - 1; index >= 0; index--) {
      if (roundMarket[index]?.hasPrice) return index;
    }
    return -1;
  }, [roundMarket]);
  // Round 1 discovers the price as it fills — showing "discovering" there is
  // correct. Every later round has a concrete price: the round's own if
  // published, otherwise the anchor established by round 1.
  const pastFirstRound = (stageRoundIndex ?? 0) > 0;
  const stagePrice = stageMarket?.hasPrice
    ? { label: "Current price", value: stageMarket.priceWeth }
    : latestPricedIndex >= 0
      ? { label: "Last price", value: roundMarket[latestPricedIndex].priceWeth }
      : pastFirstRound && anchorPriceWeth
        ? { label: "Anchor price", value: anchorPriceWeth }
        : null;
  const commitEstimate = useMemo(() => {
    const price = Number(stagePrice?.value);
    const amount = Number(contribution);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(amount) || amount <= 0) return null;
    const tokens = amount / price;
    const compact =
      tokens >= 1_000_000
        ? `${(tokens / 1_000_000).toFixed(2)}M`
        : tokens >= 10_000
          ? `${(tokens / 1_000).toFixed(1)}K`
          : trimDecimals(tokens.toFixed(2), 2);
    return { compact, exact: trimDecimals(tokens.toFixed(2), 2) };
  }, [stagePrice?.value, contribution]);
  const refundableRound = refundRound !== null ? roundPositions[refundRound] : undefined;
  const refundableWeth = refundableRound && !refundableRound.refunded ? Number(refundableRound.committedWeth) : 0;
  const refundCostPct = refundRound !== null ? rounds[refundRound]?.deflectionCostPct ?? 0 : 0;
  const txElapsed = pendingAction && txStartedAt > 0 ? Math.max(0, nowSeconds - txStartedAt) : 0;
  const positionRows = roundPositions.filter(
    (item) => Number(item.committedWeth) > 0 || item.refunded || Number(item.claimedTokens) > 0
  );

  // Metrics/charts count each on-chain action once (launch/locker twins in
  // the indexed feed collapse); the ACTIVITY feed itself stays raw.
  const accountingItems = useMemo(() => dedupeActivityActions(activityItems), [activityItems]);

  const committedSeries = useMemo(() => {
    const events = accountingItems
      .filter(
        (item) =>
          (item.event === "RoundCommitted" || item.event === "RoundRefunded" || item.event === "LaunchFailedRefunded") &&
          item.timestamp
      )
      .sort((a, b) => (a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex));
    let total = 0;
    return events.map((item) => {
      // Refunds remove the refunded amount AND the retained penalty from the
      // net raise — matching the contract's roundRaised accounting.
      const outflow = Number(item.amountWeth || 0) + Number(item.penaltyWeth || 0);
      total += item.event === "RoundCommitted" ? Number(item.amountWeth || 0) : -outflow;
      return { t: item.timestamp as number, v: Math.max(0, total) };
    });
  }, [accountingItems]);

  const roundVolumes = useMemo(() => {
    const rows = Array.from({ length: ROUND_COUNT }, () => ({ commit: 0, refund: 0 }));
    for (const item of accountingItems) {
      if (item.round === undefined || item.round === null || item.round < 0 || item.round >= ROUND_COUNT) continue;
      const amount = Number(item.amountWeth || 0);
      if (item.event === "RoundCommitted") rows[item.round].commit += amount;
      if (item.event === "RoundRefunded") rows[item.round].refund += amount;
    }
    return rows;
  }, [accountingItems]);

  // Charts size to the rounds this launch actually schedules, not a fixed 5.
  const scheduledRoundCount = useMemo(() => {
    const scheduled = rounds.filter((round) => round.startAt > 0).length;
    return scheduled > 0 ? scheduled : rounds.length;
  }, [rounds]);

  // Per-round history for the timeline's expandable rows.
  const roundDetails = useMemo<RoundDetail[]>(() => {
    return Array.from({ length: ROUND_COUNT }, (_, round) => {
      const events = accountingItems
        .filter((item) => item.round === round && (item.event === "RoundCommitted" || item.event === "RoundRefunded"))
        .sort((a, b) => (a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex));
      const lockers = new Set<string>();
      const spark: number[] = [];
      let cumulative = 0;
      let commits = 0;
      let refunds = 0;
      let refundedWeth = 0;
      for (const event of events) {
        if (event.event === "RoundCommitted") {
          cumulative += Number(event.amountWeth || 0);
          commits += 1;
          if (event.locker) lockers.add(event.locker.toLowerCase());
        } else {
          const outflow = Number(event.amountWeth || 0) + Number(event.penaltyWeth || 0);
          cumulative -= outflow;
          refunds += 1;
          refundedWeth += Number(event.amountWeth || 0);
        }
        spark.push(Math.max(0, cumulative));
      }
      return {
        commits,
        refunds,
        lockers: lockers.size,
        refundedWeth,
        spark,
        raised: roundMarket[round]?.raisedWeth ?? "0",
        price: roundMarket[round]?.hasPrice ? roundMarket[round].priceWeth : null,
      };
    });
  }, [accountingItems, roundMarket]);

  // Your cumulative commits, for the blue overlay on the committed chart.
  const myCommittedSeries = useMemo(() => {
    if (!ethers.isAddress(lockerAddress)) return [];
    const key = lockerAddress.toLowerCase();
    const events = accountingItems
      .filter(
        (item) =>
          item.locker?.toLowerCase() === key &&
          (item.event === "RoundCommitted" || item.event === "RoundRefunded" || item.event === "LaunchFailedRefunded") &&
          item.timestamp
      )
      .sort((a, b) => (a.blockNumber !== b.blockNumber ? a.blockNumber - b.blockNumber : a.logIndex - b.logIndex));
    let total = 0;
    return events.map((item) => {
      const outflow = Number(item.amountWeth || 0) + Number(item.penaltyWeth || 0);
      total += item.event === "RoundCommitted" ? Number(item.amountWeth || 0) : -outflow;
      return { t: item.timestamp as number, v: Math.max(0, total) };
    });
  }, [accountingItems, lockerAddress]);

  // Project metadata (logo/name/symbol/description/links) + the ✓ verified
  // state. API mode reads the indexed endpoint; RPC mode performs the same
  // verification the backend does, directly against the chain (token storage
  // hash, launch hash, factory publish event, contractURI agreement).
  useEffect(() => {
    if (!ethers.isAddress(launchAddress)) {
      setLaunchMetadata(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (dataMode() === "api") {
          const { data } = await getLaunchMetadata(ethers.getAddress(launchAddress));
          if (!cancelled) setLaunchMetadata(data);
        } else {
          const data = await loadRpcLaunchMetadata(ethers.getAddress(launchAddress));
          if (!cancelled) setLaunchMetadata(data);
        }
      } catch {
        // Not indexed yet / no metadata — masthead hides until it appears.
        if (!cancelled) setLaunchMetadata(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [launchAddress]);

  // Ref mirror of knownLaunches so markLaunchesSeen (kept stable) can read
  // the current list without being re-created on every fetch.
  useEffect(() => {
    knownLaunchesRef.current = knownLaunches;
  }, [knownLaunches]);

  // Mark every currently-known launch as seen and clear the count. Called
  // when the discovery surface is opened or a launch is selected.
  const markLaunchesSeen = useCallback(() => {
    let seen = seenLaunchesRef.current;
    if (!seen) {
      seen = new Set<string>();
      seenLaunchesRef.current = seen;
    }
    let changed = false;
    for (const item of knownLaunchesRef.current) {
      if (!seen.has(item.launch)) {
        seen.add(item.launch);
        changed = true;
      }
    }
    if (changed) {
      try {
        localStorage.setItem(SEEN_LAUNCHES_KEY, JSON.stringify([...seen]));
      } catch {
        /* private mode — in-memory only */
      }
    }
    setNewLaunchCount(0);
  }, []);

  // Launch discovery + live new-launch detection. API mode polls the indexed
  // list. RPC mode scans the canonical factory from its deployment block and
  // caches the result locally, then only reconciles the recent block window.
  useEffect(() => {
    const apiMode = dataMode() === "api";
    if (!apiMode && (!READ_RPC_URL || !PUBLIC_DEPLOYMENT?.contracts.d17Factory)) return;
    let cancelled = false;
    let rpcWsProvider: ethers.WebSocketProvider | null = null;
    let rpcWsFilter: ethers.Filter | null = null;
    let rpcWsListener: (() => void) | null = null;

    const fetchLaunches = async () => {
      try {
        let list: KnownLaunch[];
        if (apiMode) {
          const { data } = await getLaunches();
          const base = unwrapList(data)
            .map((item) => toKnownLaunch(item as Record<string, unknown>))
            .filter((item): item is KnownLaunch => item !== null);
          if (cancelled) return;
          // Publish the list directly. The V14.1 /api/launches response already
          // carries createdBlock AND phase (kind/label), both consumed by
          // toKnownLaunch, so the switcher renders complete and auto-select can
          // jump straight to the newest launch. No per-launch detail fan-out:
          // the old code awaited up to 40 detail calls before the first paint
          // (stalling the list ~10s on a cold tunnel and causing the "oldest
          // then newest" flash), and a late enrichment could also race a newer
          // WS/30s refresh and overwrite the list with an older snapshot.
          setKnownLaunches(base);
          list = base;
        } else {
          // Direct-RPC discovery: factory LaunchCreated logs (cached in
          // localStorage), hydrated with symbol + live phase per launch.
          list = await discoverRpcLaunches();
          if (cancelled) return;
          setKnownLaunches(list);
        }

        // Load the seen set on first use; note whether it was ever persisted
        // so a brand-new visitor isn't alarmed by the existing backlog.
        let seen = seenLaunchesRef.current;
        let hadPersisted = true;
        if (!seen) {
          let stored: string | null = null;
          try {
            stored = localStorage.getItem(SEEN_LAUNCHES_KEY);
          } catch {
            stored = null;
          }
          hadPersisted = stored !== null;
          seen = new Set<string>(stored ? (JSON.parse(stored) as string[]) : []);
          seenLaunchesRef.current = seen;
        }
        const seenSet = seen;
        const addresses = list.map((item) => item.launch);
        if (!launchesSeededRef.current && !hadPersisted) {
          // First visit ever: treat the existing backlog as already seen.
          for (const address of addresses) seenSet.add(address);
          try {
            localStorage.setItem(SEEN_LAUNCHES_KEY, JSON.stringify([...seenSet]));
          } catch {
            /* private mode */
          }
          setNewLaunchCount(0);
        } else {
          setNewLaunchCount(addresses.filter((address) => !seenSet.has(address)).length);
        }
        launchesSeededRef.current = true;
      } catch {
        /* backend offline — switcher/list simply shows the empty state */
      }
    };

    void fetchLaunches();
    // Hosted mode is WebSocket-PRIMARY: a GLOBAL ws refetches the launch list
    // immediately on any lifecycle activity, with one reconciliation on
    // open/reconnect. The 30s API safety poll ALSO stays (indexed-API, never
    // Ethereum RPC) — it catches gaps if the socket sleeps/misses events.
    const interval = window.setInterval(fetchLaunches, 30_000);
    if (apiMode) {
      const unsubscribe = subscribeWs(null, {
        onOpen: () => {
          if (!cancelled) {
            setDiscoveryWsLive(true);
            void fetchLaunches();
          }
        },
        onClose: () => {
          if (!cancelled) setDiscoveryWsLive(false);
        },
        onActivity: () => {
          if (!cancelled) void fetchLaunches();
        },
      });
      // Reconcile the launch list on tab-resume too (see the state/activity
      // handler for why); reuses fetchLaunches, no new interval.
      const onVisible = () => {
        if (document.visibilityState === "visible" && !cancelled) void fetchLaunches();
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        cancelled = true;
        setDiscoveryWsLive(false);
        document.removeEventListener("visibilitychange", onVisible);
        unsubscribe();
        window.clearInterval(interval);
      };
    }
    if (READ_WS_URL && PUBLIC_DEPLOYMENT?.contracts.d17Factory) {
      void (async () => {
        try {
          const abi = await loadAbi("D17Factory");
          if (cancelled) return;
          const iface = new ethers.Interface(abi);
          const event = iface.getEvent("LaunchCreated");
          if (!event) return;
          rpcWsProvider = new ethers.WebSocketProvider(READ_WS_URL, CHAIN_ID);
          const network = await rpcWsProvider.getNetwork();
          if (network.chainId !== CHAIN_ID_BIG) throw new Error("RPC WebSocket chain mismatch");
          if (cancelled) {
            rpcWsProvider.destroy();
            return;
          }
          rpcWsFilter = {
            address: PUBLIC_DEPLOYMENT.contracts.d17Factory,
            topics: [event.topicHash],
          };
          rpcWsListener = () => {
            if (!cancelled) void fetchLaunches();
          };
          rpcWsProvider.on(rpcWsFilter, rpcWsListener);
        } catch {
          // HTTP safety discovery remains active when WS is unavailable.
        }
      })();
    }
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (rpcWsProvider && rpcWsFilter && rpcWsListener) {
        rpcWsProvider.off(rpcWsFilter, rpcWsListener).catch(() => undefined);
      }
      rpcWsProvider?.destroy();
    };
  }, []);

  // Phase-change notifications when the tab is hidden. Reads the LIVE
  // phase on purpose — replay must never fire real-world notifications.
  useEffect(() => {
    if (!stateLoaded || !livePhase) return;
    const key = `${livePhase.phaseKind}:${livePhase.index}`;
    const previous = prevPhaseKeyRef.current;
    prevPhaseKeyRef.current = key;
    if (previous === null || previous === key) return;
    if (!notifyEnabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      new Notification(`${describePhase(livePhase)} · ${tokenSymbol}`, {
        body: isFiniteEnd(livePhase.endsAt)
          ? timeLeft(livePhase.endsAt, Math.floor(Date.now() / 1000))
          : livePhase.phaseKind === PHASE.FAILED
            ? "Refunds available"
            : "Open now",
        icon: "/favicon-32x32.png",
      });
    } catch {
      /* notification constructor can throw on some platforms */
    }
  }, [stateLoaded, livePhase, notifyEnabled, tokenSymbol]);

  // Tab title is an ambient channel for the REAL launch — never replayed.
  useEffect(() => {
    if (
      stateLoaded &&
      livePhase &&
      (livePhase.phaseKind === PHASE.ROUND_OPEN || livePhase.phaseKind === PHASE.REFUND_OPEN) &&
      isFiniteEnd(livePhase.endsAt)
    ) {
      const seconds = Math.max(0, livePhase.endsAt - liveNowSeconds);
      const label = livePhase.phaseKind === PHASE.REFUND_OPEN ? "refund" : "open";
      document.title = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · R${livePhase.index + 1} ${label} · ${tokenSymbol}`;
    } else {
      document.title = "D17 Launch Terminal";
    }
  }, [stateLoaded, livePhase, liveNowSeconds, tokenSymbol]);
  const rulesState = !expectedRulesHash.startsWith("0x")
    ? null
    : linkRulesHash.startsWith("0x")
      ? expectedRulesHash.toLowerCase() === linkRulesHash.toLowerCase()
        ? "match"
        : "mismatch"
      : "unverified";

  const stageActionWord =
    phase?.phaseKind === PHASE.REFUND_OPEN
      ? "Refund"
      : phase?.phaseKind === PHASE.SETTLEMENT_OPEN || phase?.phaseKind === PHASE.POOL_READY
        ? "Settle"
        : phase?.phaseKind === PHASE.TRADING_OPEN
          ? "Withdraw"
          : phase?.phaseKind === PHASE.READY_TO_FINALIZE
            ? "Finalize"
            : phase?.phaseKind === PHASE.FAILED
              ? "Refund"
              : "Commit";

  const stageCta = (label: string, onClick: () => void, disabled: boolean, needsLocker = true) => {
    if (pendingAction) {
      return (
        <Button
          className="tx-pending mt-3 w-full disabled:border-ink disabled:bg-ink disabled:text-paper"
          aria-busy="true"
          disabled
        >
          Confirming on {CHAIN_NAME} · {txElapsed}s
        </Button>
      );
    }
    if (!hasWallet) {
      return (
        <Button className="mt-3 w-full" onClick={connectWallet}>
          Connect wallet <span aria-hidden>→</span>
        </Button>
      );
    }
    if (needsLocker && !hasLocker) {
      if (lockerLookupPending) {
        return (
          <Button className="mt-3 w-full" variant="secondary" disabled>
            Finding your lockers…
          </Button>
        );
      }
      return (
        <Button className="mt-3 w-full" onClick={createLocker} disabled={Boolean(pendingAction)}>
          Create locker <span aria-hidden>→</span>
        </Button>
      );
    }
    return (
      <Button className="mt-3 w-full" onClick={onClick} disabled={disabled}>
        {label} {!disabled && <span aria-hidden>→</span>}
      </Button>
    );
  };

  const stageLadder = (needsLocker = true) => (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
      <span className={hasWallet ? "text-dim" : "text-electric"}>1 Wallet{hasWallet ? " ✓" : ""}</span>
      {needsLocker && (
        <>
          <span aria-hidden>·</span>
          <span className={hasLocker ? "text-dim" : hasWallet ? "text-electric" : ""}>
            2 Locker{hasLocker ? " ✓" : lockerLookupPending ? " · finding…" : ""}
          </span>
        </>
      )}
      <span aria-hidden>·</span>
      <span className={hasWallet && (!needsLocker || hasLocker) ? "text-electric" : ""}>
        {needsLocker ? "3" : "2"} {stageActionWord}
      </span>
    </p>
  );

  const refreshState = useCallback(async ({ announce = true }: { announce?: boolean } = {}) => {
    // Same launch-generation guard as refreshActivity: a slow in-flight
    // refresh for the previous launch must never write onto the new one
    // (it would even restore the OLD rules hash used for signing).
    const generation = launchGenRef.current;
    const isStale = () => generation !== launchGenRef.current;

    // ── api mode: read state from the backend, not ~90 RPC calls ──────────
    // Two API calls (launch detail + all lockers) give phase, config, round
    // terms + refund policy, tokenomics, discovered prices, addresses,
    // total/per-round raised, and — by finding the wallet's locker in the
    // list — the user's per-round position and locker WETH balances. RPC is
    // reserved for the wallet (signing).
    if (dataMode() === "api") {
      if (!ethers.isAddress(launchAddress)) return;
      try {
        const [detailRes, lockersRes] = await Promise.all([
          getLaunch(ethers.getAddress(launchAddress)),
          getLockers(ethers.getAddress(launchAddress)),
        ]);
        if (isStale()) return;
        const detail = detailRes.data as Record<string, unknown>;
        const lockers = (
          Array.isArray(lockersRes.data) ? lockersRes.data : (lockersRes.data as { lockers?: unknown[] }).lockers ?? []
        ) as ApiLockerSummary[];

        // Phase comes from the detail: backend-derived from indexed state
        // plus server time, so it stays fresh between events.
        const detailPhase = detail.phase as { kind?: number; roundIndex?: number; raw?: string[] } | undefined;
        if (detailPhase) {
          const snapshot = apiPhaseToSnapshot(detailPhase);
          setPhase(snapshot);
          if (snapshot.phaseKind === PHASE.ROUND_OPEN || snapshot.phaseKind === PHASE.REFUND_OPEN) {
            setSelectedRound(snapshot.index);
          }
        }
        if (typeof detail.rulesHash === "string") setExpectedRulesHash(detail.rulesHash);
        if (typeof detail.token === "string" && ethers.isAddress(detail.token)) setTokenAddress(ethers.getAddress(detail.token));
        if (typeof detail.liquidityVault === "string" && ethers.isAddress(detail.liquidityVault))
          setLiquidityVaultAddress(ethers.getAddress(detail.liquidityVault));
        if (typeof detail.factory === "string" && ethers.isAddress(detail.factory)) setFactoryAddress(ethers.getAddress(detail.factory));
        if (typeof detail.weth === "string" && ethers.isAddress(detail.weth)) setWethAddress(ethers.getAddress(detail.weth));

        // Round terms — dates, allocation, refund window and per-round
        // deflection cost — straight from rounds[].refundPolicy.
        const config = (detail.config || {}) as Record<string, unknown>;
        const tokenomics = (detail.tokenomics || {}) as Record<string, unknown>;
        const apiRounds = (Array.isArray(detail.rounds) ? detail.rounds : []) as ApiRound[];
        if (apiRounds.length > 0) setRounds(apiRoundsToTerms(apiRounds));

        setLaunchConfig({
          refundPenaltyPct: Number(config.refundPenaltyBps ?? 0) / 100,
          treasuryPct: Number(config.treasuryBps ?? tokenomics.treasuryBps ?? 0) / 100,
          protocolFeePct: Number(config.protocolFeeBps ?? detail.protocolFeeBps ?? 0) / 100,
          settlementSeconds: Number(config.settlementSeconds ?? 0),
          saleTokens: toWei(tokenomics.saleTokens),
          lpTokens: toWei(tokenomics.lpTokens),
          deadTokens: toWei(tokenomics.deadTokens),
          manualTokens: toWei(tokenomics.manualDistributionTokens),
        });
        const officialPair = (config.officialPair || detail.officialPair || "") as string;
        setPoolAddress(
          ethers.isAddress(officialPair) && officialPair !== ethers.ZeroAddress ? ethers.getAddress(officialPair) : ""
        );

        // Pool composition: initial seed vs late top-ups vs reserved
        // remainder. Details without it → null hides the line.
        const composition = detail.poolComposition as
          | {
              initial?: { tokenUsedForLp?: string; wethUsedForLp?: string };
              lateTopUp?: { tokenUsedForLp?: string; wethUsedForLp?: string };
              reserved?: { remainingLpTokens?: string };
            }
          | undefined;
        setPoolComposition(
          composition
            ? {
                seededToken: toWei(composition.initial?.tokenUsedForLp),
                seededWeth: toWei(composition.initial?.wethUsedForLp),
                lateToken: toWei(composition.lateTopUp?.tokenUsedForLp),
                lateWeth: toWei(composition.lateTopUp?.wethUsedForLp),
                reservedTokens: toWei(composition.reserved?.remainingLpTokens),
              }
            : null
        );

        // Total + per-round raised, summed net across every locker; the
        // discovered price ladder rides on the detail's rounds.
        const perRoundRaised = Array.from({ length: ROUND_COUNT }, () => 0n);
        let totalNet = 0n;
        for (const locker of lockers) {
          totalNet += toWei(locker.committedWeth) - toWei(locker.refundedWeth) - toWei(locker.penaltyWeth);
          for (const roundEntry of locker.rounds || []) {
            const round = Number(roundEntry.round);
            if (Number.isInteger(round) && round >= 0 && round < ROUND_COUNT) {
              perRoundRaised[round] += toWei(roundEntry.committedWeth) - toWei(roundEntry.refundedWeth) - toWei(roundEntry.penaltyWeth);
            }
          }
        }
        setLockerSummaries(lockers.map(apiLockerToSummary).filter((item): item is LockerSummary => item !== null));
        setRoundMarket(() =>
          Array.from({ length: ROUND_COUNT }, (_, index) => {
            const priceWad = toWei(apiRounds[index]?.discoveredPriceWad);
            return {
              raisedWeth: formatEth(perRoundRaised[index] > 0n ? perRoundRaised[index] : 0n),
              priceWeth: formatWethPerToken(priceWad),
              hasPrice: priceWad > 0n,
            };
          })
        );
        // Anchor price from the launch detail (or round 1's discovered price).
        const anchorWad = (() => {
          const direct = toWei((detail as Record<string, unknown>).anchorPriceWad);
          if (direct > 0n) return direct;
          return toWei(apiRounds[0]?.discoveredPriceWad);
        })();
        setAnchorPriceWeth(anchorWad > 0n ? formatWethPerToken(anchorWad) : "");
        const minCommit = toWei(config.minCommitWeth ?? detail.minCommitWeth);
        const anchorTarget = toWei(apiRounds[0]?.anchorTargetWeth);
        // Canonical total: the contract's own totalCommittedWeth (served on
        // the detail). The old locker-sum retained refund PENALTIES that the
        // contract removes from the raise (fixture: 1.5078 vs correct 1.502).
        const canonicalTotal = toWei(detail.totalCommittedWeth ?? config.totalCommittedWeth);
        setLaunchStats((previous) => ({
          totalCommittedWeth: formatEth(canonicalTotal > 0n ? canonicalTotal : totalNet > 0n ? totalNet : 0n),
          minCommitWeth: ethers.formatEther(minCommit),
          minCommitLabel: formatEth(minCommit),
          anchorReady: previous?.anchorReady ?? true, // not exposed by the API
          anchorTargetWeth: anchorTarget > 0n ? formatEth(anchorTarget) : previous?.anchorTargetWeth ?? "0",
        }));

        // Auto-discover the wallet's locker from the list (no RPC lookup).
        if (walletAddress && ethers.isAddress(walletAddress)) {
          const owned = lockers.filter((locker) => (locker.owner || "").toLowerCase() === walletAddress.toLowerCase());
          if (owned.length > 0) {
            setOwnerLockers(owned.map((locker) => ethers.getAddress(locker.locker as string)));
            setLockerAddress((current) => (current.trim() === "" ? ethers.getAddress(owned[0].locker as string) : current));
          }
        }

        // The wallet's per-round position — enough to gate commit/refund —
        // plus locker WETH balances (backend cached contract reads). Wallet
        // ETH/WETH stays on the connected wallet's provider.
        if (ethers.isAddress(lockerAddress)) {
          const mine = lockers.find((locker) => (locker.locker || "").toLowerCase() === lockerAddress.toLowerCase());
          if (mine) {
            setRoundPositions(apiLockerToRoundPositions(mine));
            const lockedWeth = toWei(mine.lockedWeth ?? mine.balances?.lockedWeth);
            const withdrawableWeth = toWei(mine.withdrawableWeth ?? mine.balances?.withdrawableWeth);
            const lockerWeth = toWei(mine.lockerWethBalance);
            setBalances((previous) => ({
              ...previous,
              lockerWeth: formatEth(lockerWeth),
              lockedWeth: formatEth(lockedWeth),
              withdrawableWeth: formatEth(withdrawableWeth),
            }));
            setPosition(toPositionSnapshot(null, lockedWeth, withdrawableWeth));
          }
        }
        setLockerSyncedFor(lockerAddress);

        setStateLoaded(true);
        setStateStale(false);
        setLastRefreshedAt(new Date().toLocaleTimeString());
        if (announce) {
          toast("State refreshed", { description: "Launch data updated." });
        }
      } catch (error) {
        setStateStale(true);
        if (announce) showError("Refresh failed", error);
      }
      return;
    }

    try {
      const provider = readProvider();
      requireAddress(launchAddress, "Launch contract");
      const launch = await contractWithProvider("D17Launch", launchAddress, provider);
      // The free RPC rejects JSON-RPC batches, but concurrent single requests
      // are fine — waves of Promise.all cut a ~45-round-trip refresh to ~5.
      const [
        loadedRulesHash,
        loadedToken,
        loadedWeth,
        loadedVault,
        loadedPhase,
        loadedFactory,
        loadedRefundPenaltyBps,
        loadedRefundSeconds,
        loadedTotalCommitted,
        loadedMinCommit,
        loadedAnchorReady,
        loadedAnchorTarget,
        loadedSaleTokens,
        loadedLpTokens,
        loadedDeadTokens,
        loadedManualTokens,
        loadedTreasuryBps,
        loadedSettlementSeconds,
        loadedProtocolFeeBps,
      ] = await Promise.all([
        launch.rulesHash() as Promise<string>,
        launch.token() as Promise<string>,
        launch.weth().catch(() => DEFAULT_WETH) as Promise<string>,
        launch.liquidityVault().catch(() => "") as Promise<string>,
        launch.launchPhase() as Promise<ethers.Result>,
        launch.factory().catch(() => "") as Promise<string>,
        launch.refundPenaltyBps().catch(() => 1700n) as Promise<bigint>,
        launch.refundSeconds().catch(() => 0n) as Promise<bigint>,
        launch.totalCommittedWeth().catch(() => 0n) as Promise<bigint>,
        launch.minCommitWeth().catch(() => 0n) as Promise<bigint>,
        launch.anchorReady().catch(() => false) as Promise<boolean>,
        launch.roundAnchorTargetWeth(0).catch(() => 0n) as Promise<bigint>,
        launch.saleTokens().catch(() => 0n) as Promise<bigint>,
        launch.lpTokens().catch(() => 0n) as Promise<bigint>,
        launch.deadTokens().catch(() => 0n) as Promise<bigint>,
        launch.manualDistributionTokens().catch(() => 0n) as Promise<bigint>,
        launch.treasuryBps().catch(() => 0n) as Promise<bigint>,
        launch.settlementSeconds().catch(() => 0n) as Promise<bigint>,
        launch.protocolFeeBps().catch(() => 0n) as Promise<bigint>,
      ]);
      if (isStale()) return;

      // Same masthead/tokenomics surface as api mode — straight contract
      // reads instead of the detail's tokenomics object.
      setLaunchConfig({
        refundPenaltyPct: Number(loadedRefundPenaltyBps) / 100,
        treasuryPct: Number(loadedTreasuryBps) / 100,
        protocolFeePct: Number(loadedProtocolFeeBps) / 100,
        settlementSeconds: Number(loadedSettlementSeconds),
        saleTokens: loadedSaleTokens,
        lpTokens: loadedLpTokens,
        deadTokens: loadedDeadTokens,
        manualTokens: loadedManualTokens,
      });

      if (ethers.isAddress(loadedFactory)) {
        setFactoryAddress(ethers.getAddress(loadedFactory));
        const d17Factory = await contractWithProvider("D17Factory", loadedFactory, provider);
        const [loadedLockerFactory, lockers] = await Promise.all([
          d17Factory.lockerFactory().catch(() => "") as Promise<string>,
          walletAddress && ethers.isAddress(walletAddress)
            ? (d17Factory.lockersOfOwner(walletAddress).catch(() => []) as Promise<string[]>)
            : Promise.resolve([] as string[]),
        ]);
        if (ethers.isAddress(loadedLockerFactory)) setLockerFactoryAddress(ethers.getAddress(loadedLockerFactory));
        if (walletAddress && ethers.isAddress(walletAddress)) {
          setOwnerLockers(lockers.map((item) => ethers.getAddress(item)));
        }
      }

      const roundData = await Promise.all(
        Array.from({ length: ROUND_COUNT }, (_, round) =>
          Promise.all([
            launch.roundSharesBps(round).catch(() => BigInt(defaultRounds[round].allocationPct * 100)) as Promise<bigint>,
            launch.roundStart(round).catch(() => 0n) as Promise<bigint>,
            launch.roundEnd(round).catch(() => 0n) as Promise<bigint>,
            launch.roundRaised(round).catch(() => 0n) as Promise<bigint>,
            launch.roundDiscoveredPriceWad(round).catch(() => 0n) as Promise<bigint>,
          ])
        )
      );
      if (isStale()) return;
      const loadedRounds: RoundTerm[] = [];
      const loadedMarket: RoundMarket[] = [];
      roundData.forEach(([shareBps, startAt, endAt, raised, priceWad], round) => {
        const refundStartAt = Number(endAt);
        const refundEndAt = round < REFUND_STAGE_COUNT ? refundStartAt + Number(loadedRefundSeconds) : 0;
        loadedRounds.push({
          id: round + 1,
          allocationPct: Number(shareBps) / 100,
          deflectionCostPct:
            round < EARLY_REFUND_ROUNDS
              ? EARLY_REFUND_PENALTY_PCT
              : round < REFUND_STAGE_COUNT
                ? Number(loadedRefundPenaltyBps) / 100
                : 0,
          startAt: Number(startAt),
          endAt: Number(endAt),
          refundStartAt,
          refundEndAt,
        });
        loadedMarket.push({
          raisedWeth: formatEth(raised),
          priceWeth: formatWethPerToken(priceWad),
          hasPrice: priceWad > 0n,
        });
      });

      setExpectedRulesHash(loadedRulesHash);
      setTokenAddress(ethers.getAddress(loadedToken));
      if (ethers.isAddress(loadedWeth)) setWethAddress(ethers.getAddress(loadedWeth));
      if (ethers.isAddress(loadedVault)) setLiquidityVaultAddress(ethers.getAddress(loadedVault));
      setRounds(loadedRounds);
      setRoundMarket(loadedMarket);
      setLaunchStats((previous) => ({
        totalCommittedWeth: formatEth(loadedTotalCommitted),
        minCommitWeth: ethers.formatEther(loadedMinCommit),
        minCommitLabel: formatEth(loadedMinCommit),
        anchorReady: loadedAnchorReady,
        // RPC reads occasionally fail to 0; keep the last known target.
        anchorTargetWeth: loadedAnchorTarget > 0n ? formatEth(loadedAnchorTarget) : previous?.anchorTargetWeth ?? "0",
      }));
      setPhase({
        phaseKind: Number(loadedPhase[0]),
        index: Number(loadedPhase[1]),
        startsAt: Number(loadedPhase[2]),
        endsAt: Number(loadedPhase[3]),
      });
      if (Number(loadedPhase[0]) === PHASE.ROUND_OPEN || Number(loadedPhase[0]) === PHASE.REFUND_OPEN) {
        setSelectedRound(Number(loadedPhase[1]));
      }

      const weth = new ethers.Contract(ethers.getAddress(loadedWeth), ERC20_BALANCE_ABI, provider);
      let loadedLockedWeth = 0n;
      let loadedWithdrawableWeth = 0n;

      if (ethers.isAddress(lockerAddress)) {
        const locker = await contractWithProvider("D17Locker", lockerAddress, provider);
        const [lockerRounds, lockedWeth, withdrawableWeth, rawPosition] = await Promise.all([
          Promise.all(
            Array.from({ length: ROUND_COUNT }, (_, round) =>
              Promise.all([
                locker.roundPosition(launchAddress, round) as Promise<ethers.Result>,
                launch.previewRoundTokens(lockerAddress, round).catch(() => 0n) as Promise<bigint>,
              ])
            )
          ),
          locker.lockedWeth(launchAddress).catch(() => 0n) as Promise<bigint>,
          locker.withdrawableWeth().catch(() => 0n) as Promise<bigint>,
          locker.positions(launchAddress).catch(() => null) as Promise<ethers.Result | null>,
        ]);
        if (isStale()) return;
        const roundsLoaded: RoundSnapshot[] = lockerRounds.map(([roundPosition, previewTokens], round) => {
          const [committed, claimedTokens, refunded, tokensClaimed] = roundPosition;
          const market = loadedMarket[round];
          const walletTokens = Boolean(tokensClaimed) ? (claimedTokens as bigint) : previewTokens;
          return {
            round,
            committedWeth: formatEth(committed as bigint),
            claimedTokens: formatToken(claimedTokens as bigint),
            refunded: Boolean(refunded),
            tokensClaimed: Boolean(tokensClaimed),
            previewTokens: formatToken(previewTokens),
            roundNetWeth: market?.raisedWeth ?? "0",
            roundPriceWeth: market?.priceWeth ?? "0",
            walletPriceWeth: formatWethPerToken(pricePaidWad(committed as bigint, walletTokens)),
          };
        });
        setRoundPositions(roundsLoaded);
        loadedLockedWeth = lockedWeth;
        loadedWithdrawableWeth = withdrawableWeth;
        setPosition(toPositionSnapshot(rawPosition, lockedWeth, withdrawableWeth));
      }
      setLockerSyncedFor(lockerAddress);

      const [walletEth, walletWeth, lockerWeth] = await Promise.all([
        walletAddress && ethers.isAddress(walletAddress) ? provider.getBalance(walletAddress).catch(() => 0n) : 0n,
        walletAddress && ethers.isAddress(walletAddress) ? weth.balanceOf(walletAddress).catch(() => 0n) : 0n,
        ethers.isAddress(lockerAddress) ? weth.balanceOf(lockerAddress).catch(() => 0n) : 0n,
      ]);
      if (isStale()) return;
      setBalances({
        walletEth: formatEth(walletEth as bigint),
        walletWeth: formatEth(walletWeth as bigint),
        lockerWeth: formatEth(lockerWeth as bigint),
        lockedWeth: formatEth(loadedLockedWeth),
        withdrawableWeth: formatEth(loadedWithdrawableWeth),
      });

      setLastRefreshedAt(new Date().toLocaleTimeString());
      setStateLoaded(true);
      setStateStale(false);
      if (announce) {
        toast("State refreshed", {
          description: describePhase({
            phaseKind: Number(loadedPhase[0]),
            index: Number(loadedPhase[1]),
            startsAt: Number(loadedPhase[2]),
            endsAt: Number(loadedPhase[3]),
          }),
        });
      }
    } catch (error) {
      setStateStale(true);
      if (announce) showError("Refresh failed", error);
    }
  }, [launchAddress, lockerAddress, walletAddress]);

  // api mode: phase transitions are time-driven (a round can end with no
  // event to push), so poll the backend-derived phase between full refreshes.
  // This is the cheap JSON /phase endpoint — the old launchPhase() contract
  // poll is gone now that the backend keeps the indexed phase fresh.
  useEffect(() => {
    if (dataMode() !== "api" || !ethers.isAddress(launchAddress)) return;
    const generation = launchGenRef.current;
    let cancelled = false;
    const readPhase = async () => {
      try {
        const { data } = await getPhase(ethers.getAddress(launchAddress));
        if (cancelled || generation !== launchGenRef.current) return;
        const snapshot = apiPhaseToSnapshot(data);
        setPhase(snapshot);
        if (snapshot.phaseKind === PHASE.ROUND_OPEN || snapshot.phaseKind === PHASE.REFUND_OPEN) {
          setSelectedRound(snapshot.index);
        }
        setStateLoaded(true);
      } catch {
        /* phase read failed — keep the last-known phase */
      }
    };
    void readPhase();
    const interval = window.setInterval(readPhase, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [launchAddress]);

  // On top of the 8s safety poll: an IMMEDIATE one-shot reconcile the moment
  // the current time-bounded phase is due to end (round→refund, refund→next,
  // settlement→pool have no chain event at the exact boundary). A single
  // scheduled read per boundary — not a new interval; self-terminating when
  // the phase has no finite end.
  useEffect(() => {
    if (dataMode() !== "api" || !ethers.isAddress(launchAddress)) return;
    const endsAt = livePhase?.endsAt ?? 0;
    if (!livePhase || !isFiniteEnd(endsAt) || endsAt <= 0) return;
    const generation = launchGenRef.current;
    let cancelled = false;
    // +2s buffer for the backend to cross the boundary; min 2s so an
    // already-passed boundary retries (bounded) rather than firing in the past.
    const delayMs = Math.max(2000, endsAt * 1000 + 2000 - Date.now());
    const timer = window.setTimeout(async () => {
      if (cancelled || generation !== launchGenRef.current) return;
      try {
        const { data } = await getPhase(ethers.getAddress(launchAddress));
        if (cancelled || generation !== launchGenRef.current) return;
        const snapshot = apiPhaseToSnapshot(data);
        setPhase(snapshot);
        if (snapshot.phaseKind === PHASE.ROUND_OPEN || snapshot.phaseKind === PHASE.REFUND_OPEN) {
          setSelectedRound(snapshot.index);
        }
      } catch {
        /* phase read failed — the 8s poll and next boundary will retry */
      }
    }, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [launchAddress, livePhase]);

  const refreshActivity = useCallback(async ({ announce = false }: { announce?: boolean } = {}) => {
    if (!ethers.isAddress(launchAddress)) return;
    const generation = launchGenRef.current;
    setIsIndexing(true);
    if (announce) setManualIndexing(true);
    try {
      let activity: ActivityItem[];
      let summaries: LockerSummary[] | null;
      let statusLabel: string;
      let deferredCommit: (() => void) | null = null;

      if (dataMode() === "api") {
        // The win: the backend already indexed the launch, so we skip the
        // broad getLogs scan entirely and read decoded activity + owners.
        try {
          // Noisy pair/ERC20 events (Swap/Sync/Transfer/Approval) are excluded
          // at backend ingestion — nothing to filter client-side.
          const normalizedLaunch = ethers.getAddress(launchAddress);
          const cached = apiActivityCacheRef.current?.key === normalizedLaunch ? apiActivityCacheRef.current.items : [];
          const loaded = await loadApiActivityHistory(normalizedLaunch, cached);
          const apiItems = loaded.items;
          activity = apiItems
            .map(apiToActivityItem)
            .sort((a, b) => (a.blockNumber !== b.blockNumber ? b.blockNumber - a.blockNumber : b.logIndex - a.logIndex));
          // Authoritative locker totals come from /lockers in refreshState.
          // Activity remains complete for history/replay through this
          // overlap-aware cache, without downloading every old page on each
          // safety reconcile.
          summaries = null;
          statusLabel = `${dedupeActivityForDisplay(activity).length} events · via API${loaded.stale ? " · stale" : ""}`;
          deferredCommit = () => {
            apiActivityCacheRef.current = { key: normalizedLaunch, items: apiItems };
          };
        } catch {
          // A launch the indexer hasn't picked up yet (the frontend opens
          // before the launch deploys) 404s — that's a normal empty state,
          // not an error to toast about every poll.
          const cached = apiActivityCacheRef.current?.key === ethers.getAddress(launchAddress)
            ? apiActivityCacheRef.current.items
            : [];
          activity = cached
            .map(apiToActivityItem)
            .sort((a, b) => (a.blockNumber !== b.blockNumber ? b.blockNumber - a.blockNumber : b.logIndex - a.logIndex));
          summaries = null;
          statusLabel = cached.length > 0 ? `${dedupeActivityForDisplay(activity).length} events · reconnecting` : "Waiting for indexer";
        }
      } else {
        const provider = readProvider();
        const latestBlock = await provider.getBlockNumber();
        const baseFromBlock = EVENT_FROM_BLOCK > 0 ? EVENT_FROM_BLOCK : Math.max(0, latestBlock - EVENT_LOOKBACK_BLOCKS);
        // Incremental scan: cache decoded events per launch+vault and only
        // re-query the recent block window (12-block re-org cushion) — the
        // 12s safety poll must not rescan the whole range on a public RPC.
        const cacheKey = `${ethers.getAddress(launchAddress)}:${ethers.isAddress(liquidityVaultAddress) ? ethers.getAddress(liquidityVaultAddress) : ""}`;
        const cached = rpcActivityCacheRef.current?.key === cacheKey ? rpcActivityCacheRef.current : null;
        const fromBlock = cached ? Math.max(baseFromBlock, cached.throughBlock - 12) : baseFromBlock;
        const launch = await contractWithProvider("D17Launch", launchAddress, provider);
        const launchEvents = await queryContractLogs(
          provider,
          launch,
          [
            "RoundCommitted",
            "RoundRefunded",
            "Finalized",
            "LaunchFailedRefunded",
            "VaultSettlementClaimed",
            "LateVaultSettlementClaimed",
            "VaultLiquidityTokensClaimed",
            "UnsoldSaleTokensBurned",
            "UnsoldSaleTokensPaid",
          ],
          fromBlock,
          latestBlock
        );

        let vaultEvents: any[] = [];
        if (ethers.isAddress(liquidityVaultAddress)) {
          const vault = await contractWithProvider("D17LiquidityVault", liquidityVaultAddress, provider);
          vaultEvents = await queryContractLogs(
            provider,
            vault,
            ["OfficialPoolCreated", "LateLiquidityAdded", "UnsupportedTokenRecovered", "ExcessWethSwept", "UnexpectedEthSwept"],
            fromBlock,
            latestBlock
          );
        }

        const freshEvents = [...launchEvents, ...vaultEvents];
        const retainedEvents = cached ? cached.events.filter((event) => event.blockNumber < fromBlock) : [];
        const byId = new Map<string, any>();
        for (const event of [...retainedEvents, ...freshEvents]) {
          byId.set(`${event.transactionHash}:${event.logIndex}`, event);
        }
        const events = [...byId.values()].sort((a, b) => {
          if (a.blockNumber !== b.blockNumber) return b.blockNumber - a.blockNumber;
          return b.logIndex - a.logIndex;
        });
        // Everything below is computed locally; no cache, ref or state write
        // happens until the generation gate confirms this refresh is still
        // the active launch's.
        const nextBlockTimes = cached ? new Map(rpcBlockTimesRef.current) : new Map<number, number>();
        const missingTimes = events.filter((event) => !nextBlockTimes.has(event.blockNumber));
        const loadedTimes = await loadBlockTimes(provider, missingTimes);
        for (const [block, timestamp] of loadedTimes) nextBlockTimes.set(block, timestamp);
        activity = events.map((event) => toActivityItem(event, nextBlockTimes.get(event.blockNumber)));
        summaries = await buildLockerSummaries(activity, provider);
        statusLabel = `${dedupeActivityForDisplay(activity).length} events · blocks ${baseFromBlock.toLocaleString()}–${latestBlock.toLocaleString()}`;

        // The official pool address + composition ride on the vault events —
        // no indexer needed. The reserved remainder is the LP allocation not
        // yet released to the pool: lpTokens minus vault liquidity claims
        // minus tokens released through late top-ups, floored at zero.
        let poolPair = "";
        let poolLine: PoolCompositionLine | null = null;
        const poolEvent = events.find((event) => event?.eventName === "OfficialPoolCreated");
        if (poolEvent?.args) {
          const pair = poolEvent.args.pair as string;
          if (ethers.isAddress(pair)) poolPair = ethers.getAddress(pair);
          let lateToken = 0n;
          let lateWeth = 0n;
          let claimedLpTokens = 0n;
          for (const event of events) {
            if (event?.eventName === "LateLiquidityAdded" && event.args) {
              lateToken += BigInt(event.args.tokenUsed ?? 0);
              lateWeth += BigInt(event.args.wethUsed ?? 0);
            }
            if (event?.eventName === "VaultLiquidityTokensClaimed" && event.args) {
              claimedLpTokens += BigInt(event.args.liquidityTokens ?? 0);
            }
          }
          const lpAllocation = (await launch.lpTokens().catch(() => 0n)) as bigint;
          const reserved = lpAllocation - claimedLpTokens - lateToken;
          poolLine = {
            seededToken: BigInt(poolEvent.args.tokenUsed ?? 0),
            seededWeth: BigInt(poolEvent.args.wethUsed ?? 0),
            lateToken,
            lateWeth,
            reservedTokens: reserved > 0n ? reserved : 0n,
          };
        }
        deferredCommit = () => {
          rpcActivityCacheRef.current = { key: cacheKey, throughBlock: latestBlock, events };
          rpcBlockTimesRef.current = nextBlockTimes;
          if (poolPair) setPoolAddress(poolPair);
          if (poolLine) setPoolComposition(poolLine);
        };
      }
      // Generation gate: the final awaited read is behind us. A refresh that
      // no longer belongs to the selected launch is discarded whole.
      if (!commitIfCurrentGeneration(generation, launchGenRef.current, () => deferredCommit?.())) return;
      const seen = seenActivityIdsRef.current;
      if (seen.size > 0) {
        const fresh = new Set(activity.filter((item) => !seen.has(item.id)).map((item) => item.id));
        if (fresh.size > 0) {
          setFlashIds(fresh);
          window.setTimeout(() => setFlashIds(new Set()), 2200);
          if (soundEnabledRef.current) {
            try {
              const ctx = audioCtxRef.current ?? new AudioContext();
              audioCtxRef.current = ctx;
              const osc = ctx.createOscillator();
              const gain = ctx.createGain();
              osc.frequency.value = 880;
              gain.gain.setValueAtTime(0.04, ctx.currentTime);
              gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.start();
              osc.stop(ctx.currentTime + 0.1);
            } catch {
              /* audio unavailable */
            }
          }
        }
      }
      for (const item of activity) seen.add(item.id);
      setActivityItems(activity);
      if (summaries) setLockerSummaries(summaries);
      setIndexLoaded(true);
      setIndexStatus(statusLabel);
      if (announce) {
        toast("Activity indexed", {
          description: `${dedupeActivityForDisplay(activity).length} launch events loaded.`,
        });
      }
    } catch (error) {
      // A stale request's failure belongs to a launch that is no longer
      // selected — surface nothing.
      if (isCurrentGeneration(generation, launchGenRef.current)) {
        showError("Activity refresh failed", error);
        setIndexStatus("Index refresh failed");
      }
    } finally {
      // Loading flags belong to the active request; a stale one must not
      // clear them out from under it.
      if (isCurrentGeneration(generation, launchGenRef.current)) {
        setIsIndexing(false);
        setManualIndexing(false);
      }
    }
  }, [launchAddress, liquidityVaultAddress]);

  // Live updates: api mode subscribes to the indexed service's WebSocket;
  // direct-RPC mode uses its own event stream. Both coalesce bursts so N
  // events in one block trigger ONE re-index, not N racing runs. Polling
  // stays as the fallback in every mode.
  useEffect(() => {
    if (!ethers.isAddress(launchAddress)) return;
    const apiMode = dataMode() === "api";
    let stateTimer: number | undefined;
    let activityTimer: number | undefined;
    const scheduleStateRefresh = () => {
      window.clearTimeout(stateTimer);
      stateTimer = window.setTimeout(() => void refreshState({ announce: false }), 1500);
    };
    const scheduleActivityRefresh = () => {
      window.clearTimeout(activityTimer);
      activityTimer = window.setTimeout(() => void refreshActivity(), 400);
    };

    if (apiMode) {
      const unsubscribe = subscribeWs(ethers.getAddress(launchAddress), {
        onOpen: () => {
          setSseLive(true);
          // The WS has no missed-event replay across reconnect gaps, so treat
          // every (re)connect as a gap: refetch state + activity.
          scheduleActivityRefresh();
          scheduleStateRefresh();
        },
        onClose: () => setSseLive(false),
        onActivity: () => {
          // Only human-scale lifecycle events arrive here — noisy pair/ERC20
          // traffic is excluded at backend ingestion.
          scheduleActivityRefresh();
          scheduleStateRefresh();
        },
      });
      // Background tabs get their JS/socket throttled or suspended and the WS
      // has no replay — so on resume, reconcile current state+activity once
      // (coalesced through the same debounced schedulers; no new interval).
      const onVisible = () => {
        if (document.visibilityState === "visible") {
          scheduleStateRefresh();
          scheduleActivityRefresh();
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => {
        window.clearTimeout(stateTimer);
        window.clearTimeout(activityTimer);
        document.removeEventListener("visibilitychange", onVisible);
        unsubscribe();
        setSseLive(false);
      };
    }

    if (!API_URL) return;
    const source = new EventSource(`${API_URL}/api/stream?launch=${ethers.getAddress(launchAddress)}`);
    source.onopen = () => setSseLive(true);
    source.onerror = () => setSseLive(false);
    source.addEventListener("activity.created", () => {
      scheduleActivityRefresh();
      scheduleStateRefresh();
    });
    source.addEventListener("phase.changed", () => {
      void refreshState({ announce: false });
    });
    return () => {
      window.clearTimeout(stateTimer);
      window.clearTimeout(activityTimer);
      source.close();
      setSseLive(false);
    };
  }, [launchAddress, refreshActivity, refreshState]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const launch = params.get("launch");
    const lockerFactory = params.get("lockerFactory");
    const locker = params.get("locker");
    const rulesHash = params.get("rulesHash");
    if (launch && ethers.isAddress(launch)) {
      setLaunchAddress(ethers.getAddress(launch));
      setJoinLaunchAddress(ethers.getAddress(launch));
      // A shared ?launch= link is an explicit choice — claim the one-shot
      // auto-select so the newest-launch jump doesn't stomp the deep link.
      autoSelectedLaunchRef.current = true;
    }
    if (lockerFactory && ethers.isAddress(lockerFactory)) setLockerFactoryAddress(ethers.getAddress(lockerFactory));
    if (locker && ethers.isAddress(locker)) setLockerAddress(ethers.getAddress(locker));
    if (rulesHash && ethers.isHexString(rulesHash, 32)) {
      setExpectedRulesHash(rulesHash);
      setLinkRulesHash(rulesHash);
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!ethers.isAddress(launchAddress)) return;
    void refreshState({ announce: false });
    // WS is primary, but this low-frequency indexed-API safety refresh stays
    // in every mode: it catches gaps if the socket sleeps or misses events.
    // (Indexed-API reads only — never a browser Ethereum RPC.)
    const interval = window.setInterval(() => {
      void refreshState({ announce: false });
    }, STATE_POLL_SECONDS * 1000);
    return () => window.clearInterval(interval);
  }, [launchAddress, lockerAddress, walletAddress, refreshState]);

  useEffect(() => {
    if (!ethers.isAddress(launchAddress)) return;
    void refreshActivity();
    const interval = window.setInterval(() => {
      void refreshActivity();
    }, EVENT_POLL_SECONDS * 1000);
    return () => window.clearInterval(interval);
  }, [launchAddress, liquidityVaultAddress, refreshActivity]);

  useEffect(() => {
    if (!READ_WS_URL || !ethers.isAddress(launchAddress)) return;
    let destroyed = false;
    let wsProvider: ethers.WebSocketProvider | null = null;
    let launch: ethers.Contract | null = null;
    let vault: ethers.Contract | null = null;
    const handler = () => {
      if (!destroyed) void refreshActivity();
    };

    async function attach() {
      try {
        wsProvider = new ethers.WebSocketProvider(READ_WS_URL, CHAIN_ID);
        launch = await contractWithProvider("D17Launch", launchAddress, wsProvider);
        for (const eventName of [
          "RoundCommitted",
          "RoundRefunded",
          "Finalized",
          "VaultSettlementClaimed",
          "LateVaultSettlementClaimed",
          "LiquidityPoolCreated",
        ]) {
          launch.on(eventName, handler);
        }
        if (ethers.isAddress(liquidityVaultAddress)) {
          vault = await contractWithProvider("D17LiquidityVault", liquidityVaultAddress, wsProvider);
          vault.on("OfficialPoolCreated", handler);
          vault.on("LateLiquidityAdded", handler);
        }
        setIndexStatus((current) => `${current} - live websocket attached`);
      } catch {
        setIndexStatus((current) => `${current} - websocket unavailable, polling active`);
      }
    }

    void attach();
    return () => {
      destroyed = true;
      if (launch) launch.removeAllListeners();
      if (vault) vault.removeAllListeners();
      if (wsProvider) void wsProvider.destroy();
    };
  }, [launchAddress, liquidityVaultAddress, refreshActivity]);

  const connectWith = async (injected: ethers.Eip1193Provider, name: string) => {
    try {
      activeWalletRef.current = injected;
      setActiveWalletName(name);
      setWalletPickerOpen(false);
      const withEvents = injected as ethers.Eip1193Provider & {
        on?: (event: string, listener: (payload: unknown) => void) => void;
      };
      if (withEvents.on && !walletListenersRef.current.has(injected)) {
        walletListenersRef.current.add(injected);
        withEvents.on("accountsChanged", (payload: unknown) => {
          const accounts = Array.isArray(payload) ? (payload as string[]) : [];
          const next = accounts[0] && ethers.isAddress(accounts[0]) ? ethers.getAddress(accounts[0]) : "";
          setWalletAddress(next);
          setOwnerLockers([]);
        });
      }
      const provider = new ethers.BrowserProvider(injected);
      await provider.send("eth_requestAccounts", []);
      await assertChain(provider);
      const signer = await provider.getSigner();
      setWalletAddress(await signer.getAddress());
      toast("Wallet connected", {
        description: `${name || "Wallet"} is ready for locker actions on ${CHAIN_NAME}.`,
        icon: <span className="font-mono text-[12px] text-ink">✓</span>,
      });
    } catch (error) {
      showError("Wallet connection failed", error);
    }
  };

  const connectWallet = async () => {
    if (activeWalletRef.current) {
      await connectWith(activeWalletRef.current, activeWalletName);
      return;
    }
    if (walletProviders.length > 1) {
      setWalletPickerOpen(true);
      return;
    }
    if (walletProviders.length === 1) {
      await connectWith(walletProviders[0].provider, walletProviders[0].info.name);
      return;
    }
    if (window.ethereum) {
      await connectWith(window.ethereum, "Browser wallet");
      return;
    }
    // No injected provider. On touch devices that's the normal state —
    // extensions don't exist there — so guide to a wallet browser
    // instead of erroring.
    if (navigator.maxTouchPoints > 0 || /android|iphone|ipad|mobile/i.test(navigator.userAgent)) {
      setMobileWalletHelpOpen(true);
      return;
    }
    showError("Wallet connection failed", new Error("No browser wallet found."));
  };

  const disconnectWallet = async () => {
    // EIP-1193 wallets have no true "disconnect" — a dApp just forgets the
    // account. Best-effort revoke (EIP-2255) so the wallet re-prompts next
    // time; wallets that don't support it simply ignore this.
    const injected = activeWalletRef.current as
      | (ethers.Eip1193Provider & {
          request?: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
        })
      | null;
    if (injected?.request) {
      try {
        await injected.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
      } catch {
        /* wallet doesn't support revoke — forgetting locally is enough */
      }
    }
    activeWalletRef.current = null;
    setActiveWalletName("");
    setWalletAddress("");
    setOwnerLockers([]);
    setSelectedLockerForFeed("");
    toast("Wallet disconnected", {
      description: "Reconnect any time to manage your locker.",
      icon: <span className="font-mono text-[12px] text-ink">○</span>,
    });
  };

  const toggleNotify = async () => {
    if (!notifyEnabled) {
      if (typeof Notification === "undefined") {
        toast("Notifications unavailable", { description: "This browser does not support notifications." });
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast("Notifications blocked", { description: "Allow notifications for this site in your browser settings." });
        return;
      }
    }
    const next = !notifyEnabled;
    setNotifyEnabled(next);
    localStorage.setItem("d17-notify", next ? "1" : "0");
  };

  const toggleSound = () => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    localStorage.setItem("d17-sound", next ? "1" : "0");
    if (next) {
      // Create/unlock the AudioContext inside this user gesture — autoplay
      // policy would otherwise leave ticks permanently silent.
      try {
        const ctx = audioCtxRef.current ?? new AudioContext();
        audioCtxRef.current = ctx;
        void ctx.resume();
      } catch {
        /* audio unavailable */
      }
    }
  };

  const resolveWalletForTx = (): ethers.Eip1193Provider => {
    if (activeWalletRef.current) return activeWalletRef.current;
    if (walletProviders.length > 1) {
      setWalletPickerOpen(true);
      throw new Error("Multiple wallets detected.");
    }
    if (walletProviders.length === 1) {
      activeWalletRef.current = walletProviders[0].provider;
      setActiveWalletName(walletProviders[0].info.name);
      return walletProviders[0].provider;
    }
    if (window.ethereum) return window.ethereum;
    throw new Error("No browser wallet found.");
  };

  const createLocker = async () => {
    await sendTx("create locker", async (signer) => {
      requireAddress(lockerFactoryAddress, "D17LockerFactory");
      const owner = walletAddress || await signer.getAddress();
      const factory = await contractWithSigner("D17LockerFactory", lockerFactoryAddress, signer);
      const tx = await factory.createLockerFor(owner) as ethers.ContractTransactionResponse;
      const receipt = await waitForTx(tx, "Locker creation");
      const created = parseLockerCreated(factory, receipt);
      setLockerAddress(created);
      return tx.hash;
    });
  };

  const verifyLaunch = async () => {
    await sendTx("check launch rules", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      requireAddress(launchAddress, "Launch contract");
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const ok = await locker.verifyLaunch(launchAddress, rulesHashForTx) as boolean;
      if (!ok) throw new Error("verifyLaunch returned false");
      setLaunchVerified(true);
      toast("Launch verified", {
        description: "The locker accepts this launch and rules hash.",
        icon: <span className="font-mono text-[12px] text-ink">✓</span>,
      });
      return "";
    });
  };

  const applyLaunch = (nextLaunch: string) => {
    launchGenRef.current += 1;
    prevPhaseKeyRef.current = null;
    setLaunchAddress(nextLaunch);
    setJoinLaunchAddress(nextLaunch);
    setLaunchStats(null);
    setRoundMarket([]);
    setLastRefreshedAt("");
    setLockerSyncedFor("");
    setExpectedRulesHash("");
    setLinkRulesHash("");
    setLaunchVerified(false);
    setStateLoaded(false);
    setStateStale(false);
    setIndexLoaded(false);
    setTokenAddress("");
    setLiquidityVaultAddress("");
    setPosition(null);
    setRoundPositions([]);
    setActivityItems([]);
    setLockerSummaries([]);
    setSelectedLockerForFeed("");
    setReplayCutoff(null);
    setFlashIds(new Set());
    seenActivityIdsRef.current = new Set();
    // Everything launch-scoped resets so nothing from the previous launch can
    // flash while the new one loads.
    setPhase(null);
    setRounds(defaultRounds);
    setLaunchConfig(null);
    setLaunchMetadata(null);
    setPoolAddress("");
    setPoolComposition(null);
    setAnchorPriceWeth("");
    apiActivityCacheRef.current = null;
    rpcActivityCacheRef.current = null;
    rpcBlockTimesRef.current = new Map();
    toast("Launch selected", {
      description: "Rules, token, phase, and locker factory will be read from this launch.",
    });
  };

  // api mode: on first load, always jump to the newest indexed launch (the
  // site should open on the latest launch). Runs once; after that the user's
  // selection stands.
  useEffect(() => {
    if (autoSelectedLaunchRef.current || knownLaunches.length === 0) return;
    autoSelectedLaunchRef.current = true;
    const newest = [...knownLaunches].sort((a, b) => (b.createdBlock ?? 0) - (a.createdBlock ?? 0))[0];
    if (newest && (!ethers.isAddress(launchAddress) || newest.launch.toLowerCase() !== launchAddress.toLowerCase())) {
      applyLaunch(newest.launch);
    }
  }, [knownLaunches, launchAddress]);

  const joinLaunch = () => {
    if (!ethers.isAddress(joinLaunchAddress)) {
      setJoinAddressInvalid(true);
      toast("Invalid launch address", {
        description: "Paste the full 0x… launch contract address, then press Join launch.",
      });
      return;
    }
    setJoinAddressInvalid(false);
    applyLaunch(ethers.getAddress(joinLaunchAddress));
  };

  const commitToRound = async () => {
    await sendTx("commit to round", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      requireAddress(launchAddress, "Launch contract");
      const amount = ethers.parseEther(contribution);
      if (amount <= 0n) throw new Error("Contribution must be greater than 0 ETH.");
      if (!canCommit) throw new Error("ROUND_CLOSED");
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const tx = await locker.commitToRound(launchAddress, selectedRound, rulesHashForTx, { value: amount }) as ethers.ContractTransactionResponse;
      await waitForTx(tx, `Round ${selectedRound + 1} commitment`);
      return tx.hash;
    });
  };

  const refundCurrentRound = async () => {
    await sendTx("refund current round", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      requireAddress(launchAddress, "Launch contract");
      if (!canRefund) throw new Error("NO_REFUND_STAGE");
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const tx = await locker.refundCurrentRound(launchAddress) as ethers.ContractTransactionResponse;
      await waitForTx(tx, "Round refund");
      return tx.hash;
    });
  };

  const refundFailedLaunch = async () => {
    await sendTx("refund failed launch", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      requireAddress(launchAddress, "Launch contract");
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const tx = await locker.refundFailedLaunch(launchAddress, rulesHashForTx) as ethers.ContractTransactionResponse;
      await waitForTx(tx, "Failed launch refund");
      return tx.hash;
    });
  };

  const finalizeLaunch = async () => {
    await sendTx("finalize launch", async (signer) => {
      requireAddress(launchAddress, "Launch contract");
      const launch = await contractWithSigner("D17Launch", launchAddress, signer);
      const tx = await launch.finalizeLaunch() as ethers.ContractTransactionResponse;
      await waitForTx(tx, "Launch finalization");
      return tx.hash;
    });
  };

  const createOfficialPool = async () => {
    await sendTx("create official pool", async (signer) => {
      requireAddress(liquidityVaultAddress, "Liquidity vault");
      const vault = await contractWithSigner("D17LiquidityVault", liquidityVaultAddress, signer);
      // Amounts are protocol-determined into a fresh pair (the contract
      // rejects an already-live pair), so 0 min-LP is safe; 15-min deadline.
      const deadline = Math.floor(Date.now() / 1000) + 15 * 60;
      const tx = (await vault.createOfficialPool(0, deadline)) as ethers.ContractTransactionResponse;
      await waitForTx(tx, "Official pool creation");
      return tx.hash;
    });
  };

  const settleAndClaim = async () => {
    await sendTx(phase?.phaseKind === PHASE.POOL_READY ? "settle after claim window" : "settle and claim", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      requireAddress(launchAddress, "Launch contract");
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const tx = phase?.phaseKind === PHASE.POOL_READY
        ? await locker.settleAfterGrace(launchAddress) as ethers.ContractTransactionResponse
        : await locker.settleAndClaim(launchAddress, rulesHashForTx) as ethers.ContractTransactionResponse;
      await waitForTx(tx, "Settlement and sale-token claim");
      return tx.hash;
    });
  };

  const withdrawWeth = async () => {
    await sendTx("withdraw WETH", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      requireAddress(launchAddress, "Launch contract");
      const amount = ethers.parseEther(wethWithdrawAmount);
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const tx = await locker.withdrawUnlockedWeth(launchAddress, amount) as ethers.ContractTransactionResponse;
      await waitForTx(tx, "WETH withdrawal");
      return tx.hash;
    });
  };

  const withdrawTokens = async (amountOverride?: string) => {
    await sendTx("withdraw sale tokens", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      requireAddress(launchAddress, "Launch contract");
      const amount = ethers.parseUnits(amountOverride ?? tokenWithdrawAmount, 18);
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const tx = await locker.withdrawUnlockedTokens(launchAddress, amount) as ethers.ContractTransactionResponse;
      await waitForTx(tx, "Sale-token withdrawal");
      return tx.hash;
    });
  };

  const recoverExcessWeth = async () => {
    await sendTx("recover excess WETH", async (signer) => {
      requireAddress(lockerAddress, "Locker");
      const recipient = walletAddress || await signer.getAddress();
      const amount = ethers.parseEther(excessWethAmount);
      const locker = await contractWithSigner("D17Locker", lockerAddress, signer);
      const tx = await locker.recoverExcessWeth(recipient, amount) as ethers.ContractTransactionResponse;
      await waitForTx(tx, "Excess WETH recovery");
      return tx.hash;
    });
  };

  const sendTx = async (label: string, action: (signer: ethers.Signer) => Promise<string>) => {
    if (replayCutoff !== null) {
      toast("Replay view", { description: "Switch back to Live · now to send transactions." });
      return;
    }
    setPendingAction(label);
    setTxStartedAt(Math.floor(Date.now() / 1000));
    try {
      const provider = new ethers.BrowserProvider(resolveWalletForTx());
      await provider.send("eth_requestAccounts", []);
      await assertChain(provider);
      const signer = await provider.getSigner();
      setWalletAddress(await signer.getAddress());
      const hash = await action(signer);
      if (hash) {
        setTxLog((current) => [{ label, hash, at: Math.floor(Date.now() / 1000) }, ...current].slice(0, 8));
        toast("Transaction confirmed", {
          description: label,
          icon: <span className="font-mono text-[12px] text-live">✓</span>,
        });
        await Promise.all([refreshState({ announce: false }), refreshActivity()]);
      }
    } catch (error) {
      showError(`${label} failed`, error);
    } finally {
      setPendingAction("");
      setTxStartedAt(0);
    }
  };

  // ── Mobile sticky spine ─────────────────────────────────────────────
  // Section nav (top, sticky): phase chip + underlined jump links with a
  // scrollspy, so the 5-screen page never needs manual travel. Action bar
  // (bottom, fixed) appears when an action exists but its real CTA is
  // off-screen. Both are xl:hidden — desktop never sees them.
  const stageSectionRef = useRef<HTMLElement | null>(null);
  const stageCtaRef = useRef<HTMLDivElement | null>(null);
  const [ctaInView, setCtaInView] = useState(true);
  const [activeSection, setActiveSection] = useState("stage");
  useEffect(() => {
    // Scroll-measured rather than IntersectionObserver: IO callbacks are
    // rAF-aligned and stall in throttled/hidden tabs (including in-wallet
    // webviews), which would freeze the spine in a stale state. A handful
    // of rect reads per scroll event on a page this size is nothing, and
    // React bails out when the values don't change.
    const measure = () => {
      const viewport = window.innerHeight;
      const ctaRect = stageCtaRef.current?.getBoundingClientRect();
      setCtaInView(Boolean(ctaRect && ctaRect.bottom > 0 && ctaRect.top < viewport));
      // Scrollspy: the section whose top most recently crossed under the
      // sticky nav wins. Measured visually (not DOM order), so the mobile
      // reorder and the tablet order both spy correctly.
      let active = "stage";
      let best = -Infinity;
      // At the very bottom the last section may never reach the nav line
      // (scroll clamps) — count anything on screen as reachable there.
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 2;
      const threshold = atBottom ? viewport : 56;
      for (const { id } of NAV_SECTIONS) {
        const element = document.getElementById(id);
        if (!element) continue;
        const top = element.getBoundingClientRect().top;
        if (top <= threshold && top > best) {
          best = top;
          active = id;
        }
      }
      setActiveSection(active);
    };
    measure();
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure, { passive: true });
    return () => {
      window.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [stateLoaded, phase?.phaseKind, isReplay]);
  // Keep the active link visible inside the nav's own horizontal scroll.
  useEffect(() => {
    document.getElementById(`section-nav-${activeSection}`)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeSection]);
  const jumpToSection = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // One handler for both discovery surfaces (desktop rail tab + mobile
  // section), so behavior can't diverge. Replicates the switcher's no-op
  // guard (applyLaunch has none and would pointlessly reset + re-toast on the
  // already-selected launch), marks launches seen, and returns to the stage.
  const selectLaunch = (address: string) => {
    if (!ethers.isAddress(address)) return;
    const next = ethers.getAddress(address);
    markLaunchesSeen();
    if (!(hasLaunch && next.toLowerCase() === launchAddress.toLowerCase())) {
      applyLaunch(next);
    }
    setRailTab("rounds");
    jumpToSection("stage");
  };

  const mobileAction = (() => {
    if (!stateLoaded || !phase || isReplay) return null;
    if (!hasWallet) return { label: "Connect wallet", kind: "connect" as const };
    if (phase.phaseKind === PHASE.ROUND_OPEN)
      return canCommit ? { label: `Commit to round ${phase.index + 1}`, kind: "commit" as const } : null;
    if (phase.phaseKind === PHASE.REFUND_OPEN)
      return refundableWeth > 0 ? { label: `Refund round ${phase.index + 1}`, kind: "jump" as const } : null;
    if (phase.phaseKind === PHASE.READY_TO_FINALIZE) return { label: "Finalize launch", kind: "jump" as const };
    if (phase.phaseKind === PHASE.SETTLEMENT_OPEN || phase.phaseKind === PHASE.POOL_READY)
      return canSettleAndClaim ? { label: "Settle & claim", kind: "jump" as const } : null;
    if (phase.phaseKind === PHASE.TRADING_OPEN)
      return canWithdrawTokens ? { label: "Withdraw tokens", kind: "jump" as const } : null;
    if (phase.phaseKind === PHASE.FAILED)
      return hasLocker ? { label: "Refund from locker", kind: "jump" as const } : null;
    return null;
  })();
  const actionBarVisible = Boolean(mobileAction && !ctaInView && !pendingAction);
  const jumpToStageCta = () => {
    if (mobileAction?.kind === "connect") {
      void connectWallet();
      return;
    }
    (stageCtaRef.current ?? stageSectionRef.current)?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (mobileAction?.kind === "commit") {
      window.setTimeout(() => document.getElementById("commit-amount")?.focus({ preventScroll: true }), 450);
    }
  };

  // Topbar controls render twice: inline on md+ (unchanged desktop layout),
  // and in a thumb-scrollable strip row on mobile — so the launch switcher
  // and replay stay reachable on phones without a three-row header.
  const topbarControls = (
    <>
      {/* Mobile/tablet discovery reach (desktop uses the rail tabs): jumps to
          the #launches section and carries the unseen count pill. */}
      <button
          type="button"
          onClick={() => {
            jumpToSection("launches");
            markLaunchesSeen();
          }}
          className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink xl:hidden"
        >
          Launches
          {newLaunchCount > 0 && (
            <span className="inline-flex min-w-[16px] justify-center border border-ink bg-ink px-1 font-mono text-[10px] leading-none text-paper tabular-nums">
              {newLaunchCount}
            </span>
          )}
        </button>
      {/* Testing aids live in their own labelled cluster, visually fenced
          off from the real menu — and only when the flag says so. */}
      {TEST_CONTROLS_ENABLED && (knownLaunches.length > 1 || replayCheckpoints.length > 0) && (
        <span className="inline-flex items-center gap-2 border-r border-hairline pr-3">
          <span className="font-mono text-[9px] uppercase tracking-[0.08em] text-quiet" title="Testing aids — hidden on the public site">
            Test
          </span>
          {knownLaunches.length > 1 && (
            <select
              value={hasLaunch ? ethers.getAddress(launchAddress) : ""}
              onChange={(event) => {
                if (!ethers.isAddress(event.target.value)) return;
                const next = ethers.getAddress(event.target.value);
                if (hasLaunch && next.toLowerCase() === launchAddress.toLowerCase()) return;
                applyLaunch(next);
              }}
              aria-label="Switch launch"
              className="border border-hairline bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.02em] text-dim outline-none focus-visible:border-dim"
            >
              {!hasLaunch && <option value="">Select launch</option>}
              {hasLaunch &&
                !knownLaunches.some((item) => item.launch.toLowerCase() === launchAddress.toLowerCase()) && (
                  <option value={ethers.getAddress(launchAddress)}>{shortAddress(launchAddress)} · current</option>
                )}
              {knownLaunches.map((item) => (
                <option key={item.launch} value={item.launch}>
                  {item.label}
                </option>
              ))}
            </select>
          )}
          {replayCheckpoints.length > 0 && (
            <select
              value={replayCutoff === null ? "" : String(replayCutoff)}
              onChange={(event) => selectReplay(event.target.value === "" ? null : Number(event.target.value))}
              aria-label="Replay this launch at an earlier stage"
              title="Re-render the page as of a past moment, from the real indexed events. View only — transactions stay off."
              className={`border bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.02em] outline-none focus-visible:border-dim ${
                isReplay ? "border-electric text-electric" : "border-hairline text-dim"
              }`}
            >
              <option value="">Live · now</option>
              {replayCheckpoints.map((checkpoint) => (
                <option key={checkpoint.cutoff} value={String(checkpoint.cutoff)}>
                  Replay · {checkpoint.label}
                </option>
              ))}
            </select>
          )}
        </span>
      )}
      <button
        type="button"
        onClick={toggleTheme}
        aria-pressed={lightMode}
        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink"
      >
        <span
          className={`flex h-3 w-3 items-center justify-center border text-[8px] leading-none ${
            lightMode ? "border-ink bg-ink text-paper" : "border-hairline text-transparent"
          }`}
          aria-hidden
        >
          ✓
        </span>
        Light
      </button>
      <button
        type="button"
        onClick={() => void toggleNotify()}
        aria-pressed={notifyEnabled}
        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink"
      >
        <span
          className={`flex h-3 w-3 items-center justify-center border text-[8px] leading-none ${
            notifyEnabled ? "border-ink bg-ink text-paper" : "border-hairline text-transparent"
          }`}
          aria-hidden
        >
          ✓
        </span>
        Notify
      </button>
      <button
        type="button"
        onClick={toggleSound}
        aria-pressed={soundEnabled}
        className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink"
      >
        <span
          className={`flex h-3 w-3 items-center justify-center border text-[8px] leading-none ${
            soundEnabled ? "border-ink bg-ink text-paper" : "border-hairline text-transparent"
          }`}
          aria-hidden
        >
          ✓
        </span>
        Sound
      </button>
      {stateStale ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-dim">Stale · Retrying</span>
      ) : lastRefreshedAt ? (
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.02em] text-quiet tabular-nums md:inline">
          Updated {lastRefreshedAt}
        </span>
      ) : null}
    </>
  );

  return (
    <CurrencyContext.Provider value={currency}>
    <main className="flex min-h-dvh flex-col bg-paper text-ink xl:h-dvh xl:overflow-hidden">
      {!PROTOCOL_DEPLOYED && (
        <p className="shrink-0 border-b border-hairline px-4 py-2 font-mono text-[10px] uppercase tracking-[0.02em] text-alert sm:px-6" role="status">
          The D17 V15 contracts are not deployed on {CHAIN_NAME} yet — no launch can be created or joined on this network.
        </p>
      )}
      <header className="shrink-0 border-b border-hairline">
        <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6">
          <p className="flex items-baseline gap-3 font-mono text-[10px] uppercase tracking-[0.02em]">
            <span className="text-ink">D17</span>
            <span className="hidden text-dim sm:inline">Launch terminal</span>
            <span className="hidden text-quiet sm:inline">{NETWORK_LABEL}</span>
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="hidden flex-wrap items-center gap-x-3 gap-y-2 md:flex">{topbarControls}</div>
            {/* Nav links + wallet live in their own cluster, fenced from the
                status toggles by a hairline. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:border-l md:border-hairline md:pl-3">
            <NetworkSwitch disabled={Boolean(pendingAction)} />
            <a
              href={d17Href("/deploy")}
              className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink max-xl:min-h-11 max-xl:inline-flex max-xl:items-center"
            >
              Deploy
            </a>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" variant="ghost">
                  Wallet setup
                </Button>
              </DialogTrigger>
              <DialogContent className="border-hairline bg-panel">
                <DialogHeader>
                  <DialogTitle className="font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
                    How to connect on {CHAIN_NAME}
                  </DialogTitle>
                  <DialogDescription className="max-w-2xl text-[15px] leading-relaxed text-dim">
                    {IS_MAINNET ? "You need ETH for gas." : `Testnet wallet only — you need ${CHAIN_NAME} ETH for gas.`}
                  </DialogDescription>
                </DialogHeader>
                <div>
                  <CopyRow label="Network" value={CHAIN_NAME} />
                  <CopyRow label="Chain ID" value={String(CHAIN_ID)} />
                  <CopyRow label="RPC" value={READ_RPC_URL} />
                  <CopyRow label="Explorer" value={EXPLORER_BASE} />
                  <CopyRow label="WETH token" value={wethAddress} />
                  <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-dim">
                    Committed WETH sits in your D17 locker, not your wallet, until it is refunded or withdrawn.
                  </p>
                </div>
              </DialogContent>
            </Dialog>
            {walletAddress ? (
              <div className="inline-flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="border-ink normal-case text-ink"
                  onClick={connectWallet}
                  title={activeWalletName ? `${activeWalletName} — click to switch account` : "Click to switch account"}
                >
                  {shortAddress(walletAddress)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-2 text-quiet hover:text-ink"
                  onClick={() => void disconnectWallet()}
                  title="Disconnect wallet"
                >
                  Disconnect
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="default" onClick={connectWallet}>
                Connect wallet
              </Button>
            )}
            <Dialog open={walletPickerOpen} onOpenChange={setWalletPickerOpen}>
              <DialogContent className="border-hairline bg-panel">
                <DialogHeader>
                  <DialogTitle className="font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
                    Choose a wallet
                  </DialogTitle>
                  <DialogDescription className="max-w-2xl text-[15px] leading-relaxed text-dim">
                    More than one wallet extension is installed. Pick the one to use on {CHAIN_NAME}.
                  </DialogDescription>
                </DialogHeader>
                <div>
                  {walletProviders.map((detail) => (
                    <button
                      key={detail.info.uuid}
                      type="button"
                      onClick={() => void connectWith(detail.provider, detail.info.name)}
                      className="flex w-full items-center justify-between gap-3 border-b border-faint px-1 py-2.5 text-left transition-colors last:border-b-0 hover:bg-faint"
                    >
                      <span className="flex items-center gap-2.5">
                        {detail.info.icon ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={detail.info.icon} alt="" className="h-4 w-4" aria-hidden />
                        ) : null}
                        <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-ink">{detail.info.name}</span>
                      </span>
                      <span className="font-mono text-[9px] text-quiet">{detail.info.rdns}</span>
                    </button>
                  ))}
                </div>
              </DialogContent>
            </Dialog>
            <Dialog open={mobileWalletHelpOpen} onOpenChange={setMobileWalletHelpOpen}>
              <DialogContent className="border-hairline bg-panel">
                <DialogHeader>
                  <DialogTitle className="font-mono text-[12px] font-semibold uppercase tracking-[0.06em] text-ink">
                    No wallet in this browser
                  </DialogTitle>
                  <DialogDescription className="max-w-2xl text-[15px] leading-relaxed text-dim">
                    Mobile browsers can&apos;t run wallet extensions. Open this page inside your wallet app&apos;s
                    built-in browser and connect there — everything else works the same.
                  </DialogDescription>
                </DialogHeader>
                <div>
                  <Button
                    className="w-full"
                    onClick={() => {
                      window.location.href = `https://metamask.app.link/dapp/${window.location.host}${window.location.pathname}${window.location.search}`;
                    }}
                  >
                    Open in MetaMask <span aria-hidden>→</span>
                  </Button>
                  <p className="mt-4 text-[15px] leading-relaxed text-dim">
                    Using another wallet (Rainbow, Trust, Coinbase…)? Copy this page&apos;s link and paste it into
                    the browser inside the wallet app.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-3 w-full"
                    onClick={() => copyText(window.location.href)}
                  >
                    Copy page link
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            </div>
          </div>
        </div>
        {/* Mobile control strip: one thumb-scrollable row (launch switcher,
            replay, toggles) with 44px hit areas — type stays 10px. */}
        <div className="flex items-center gap-x-4 overflow-x-auto border-t border-faint px-4 whitespace-nowrap sm:px-6 md:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0 [&_button]:min-h-11 [&_select]:min-h-11">
          {topbarControls}
        </div>
      </header>

      {/* Mobile section nav: the phase chip + underlined jump links with a
          scrollspy — the 5-screen page never needs manual travel. Sticky,
          horizontally scrollable, xl:hidden. */}
      <nav
        aria-label="Page sections"
        className="sticky top-0 z-40 flex items-center gap-x-5 overflow-x-auto border-b border-hairline bg-paper px-4 whitespace-nowrap sm:px-6 xl:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
      >
        <button
          type="button"
          id="section-nav-stage"
          onClick={() => jumpToSection("stage")}
          className={`flex min-h-11 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.02em] transition-colors ${
            activeSection === "stage" ? "text-ink underline underline-offset-[6px]" : "text-quiet hover:text-ink"
          }`}
        >
          {stateLoaded && phase ? (
            <>
              <span
                aria-hidden
                className={
                  phase.phaseKind === PHASE.FAILED
                    ? "text-alert"
                    : phase.phaseKind === PHASE.ROUND_OPEN || phase.phaseKind === PHASE.REFUND_OPEN
                      ? "animate-pulse text-live"
                      : "text-dim"
                }
              >
                ●
              </span>
              <span className="font-semibold">{describePhase(phase)}</span>
              {isReplay && <span className="text-electric">Replay</span>}
              {(phase.phaseKind === PHASE.ROUND_OPEN || phase.phaseKind === PHASE.REFUND_OPEN) &&
                isFiniteEnd(phase.endsAt) && (
                  <span className="text-dim tabular-nums">{timeLeft(phase.endsAt, nowSeconds)}</span>
                )}
            </>
          ) : (
            <span className="font-semibold">Stage</span>
          )}
        </button>
        {NAV_SECTIONS.filter((section) => section.id !== "stage").map(({ id, label }) => (
          <button
            key={id}
            type="button"
            id={`section-nav-${id}`}
            onClick={() => jumpToSection(id)}
            className={`min-h-11 font-mono text-[10px] uppercase tracking-[0.02em] transition-colors ${
              activeSection === id ? "text-ink underline underline-offset-[6px]" : "text-quiet hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* App frame at xl: each column scrolls independently — scrolling the
          center never moves the rails (EoW terminal model). */}
      <div className={`grid w-full flex-1 grid-cols-1 xl:min-h-0 xl:grid-cols-[300px_minmax(0,1fr)_380px] xl:grid-rows-[100%] ${actionBarVisible ? "max-xl:pb-24" : ""}`}>
        <aside id="timeline" className="order-2 max-sm:order-5 scroll-mt-12 border-t border-hairline xl:order-1 xl:flex xl:min-h-0 xl:flex-col xl:overflow-y-auto xl:border-t-0 xl:border-r xl:border-hairline">
          {/* Desktop-only Rounds | Launches tabs (api mode). Mobile reaches
              discovery via the top-strip chip + #launches section instead. */}
          <div className="hidden border-b border-hairline px-4 py-3 sm:px-6 xl:flex xl:flex-wrap xl:items-center xl:gap-1.5">
              <button
                type="button"
                aria-pressed={railTab === "rounds"}
                onClick={() => setRailTab("rounds")}
                className={chipClass(railTab === "rounds")}
              >
                Rounds
              </button>
              <button
                type="button"
                aria-pressed={railTab === "launches"}
                onClick={() => {
                  setRailTab("launches");
                  markLaunchesSeen();
                }}
                className={`${chipClass(railTab === "launches")} inline-flex items-center gap-1.5`}
              >
                Launches
                {newLaunchCount > 0 && (
                  <span className="inline-flex min-w-[16px] justify-center border border-ink bg-ink px-1 font-mono text-[10px] leading-none text-paper tabular-nums">
                    {newLaunchCount}
                  </span>
                )}
              </button>
            </div>
          {/* Desktop honors railTab; mobile always shows the timeline. */}
          <div className={railTab === "launches" ? "xl:hidden" : "contents"}>
            <LaunchTimeline
              phase={phase}
              rounds={rounds}
              nowSeconds={nowSeconds}
              loaded={stateLoaded}
              hasLaunch={ethers.isAddress(launchAddress)}
              details={roundDetails}
              facts={lifecycleFacts}
              poolAction={
                ethers.isAddress(poolAddress)
                  ? { status: "created" }
                  : phase?.phaseKind === PHASE.POOL_READY && !isReplay
                    ? { status: "available", busy: Boolean(pendingAction) }
                    : { status: "hidden" }
              }
              onCreatePool={() => void createOfficialPool()}
            />
          </div>
          {railTab === "launches" && (
            <div className="hidden xl:block">
              <LaunchList launches={knownLaunches} selected={launchAddress} onSelect={selectLaunch} />
            </div>
          )}
          {/* ETH/USD reference + display-currency toggle. Display-only,
              hosted mode, backend-cached (no browser oracle/RPC). Bottom of
              the rail; flipping to USD swaps every value display on the page.
              On testnet it's explicitly a mainnet reference. Hides when the
              rate is unavailable. */}
          {USD_ENABLED && PRICE_URL && usdPerEth ? (
            <div className="border-t border-hairline px-4 py-2.5 xl:mt-auto">
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex overflow-hidden border border-hairline font-mono text-[9px] uppercase tracking-[0.02em]">
                  <button
                    type="button"
                    onClick={() => setCurrency(false)}
                    aria-pressed={!displayUsd}
                    className={`px-2 py-1 transition-colors ${!displayUsd ? "bg-ink text-paper" : "text-quiet hover:text-ink"}`}
                  >
                    ETH
                  </button>
                  <button
                    type="button"
                    onClick={() => setCurrency(true)}
                    aria-pressed={displayUsd}
                    className={`px-2 py-1 transition-colors ${displayUsd ? "bg-ink text-paper" : "text-quiet hover:text-ink"}`}
                  >
                    USD
                  </button>
                </span>
                <span className="text-right font-mono text-[10px] uppercase tracking-[0.02em] text-quiet tabular-nums">
                  ETH/USD{" "}
                  <span className="font-semibold text-dim">
                    ${usdPerEth.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                </span>
              </div>
              {!IS_MAINNET && (
                <p className="mt-1 text-right font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">Mainnet reference</p>
              )}
            </div>
          ) : null}
        </aside>

        <section className="@container order-1 min-w-0 max-sm:contents xl:order-2 xl:min-h-0 xl:overflow-y-auto">
          {launchMetadata && (
            <LaunchMasthead metadata={launchMetadata} config={launchConfig} tokenAddress={tokenAddress} poolAddress={poolAddress} />
          )}
          {/* Mobile/tablet discovery surface — the same LaunchList as the
              desktop rail tab. xl:hidden: desktop discovery is the rail tab. */}
          <section id="launches" className="max-sm:order-2 scroll-mt-12 border-b border-hairline xl:hidden">
              <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3 sm:px-6">
                <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">Launches</h2>
                {knownLaunches.length > 0 && (
                  <span className="font-mono text-[9px] uppercase tracking-[0.02em] text-quiet tabular-nums">
                    {knownLaunches.length} found
                  </span>
                )}
              </div>
              <LaunchList launches={knownLaunches} selected={launchAddress} onSelect={selectLaunch} />
            </section>
          <section id="stage" ref={stageSectionRef} className="max-sm:order-1 scroll-mt-12 border-b border-hairline px-4 py-6 sm:px-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className={`font-mono text-[16px] font-semibold uppercase leading-none tracking-[0.01em] tabular-nums ${
                    isReplay ? "text-electric" : phase?.phaseKind === PHASE.FAILED ? "text-alert" : "text-ink"
                  }`}
                >
                  {!hasLaunch ? "No launch selected" : stateLoaded && phase ? describePhase(phase) : `Connecting to ${CHAIN_NAME}…`}
                </span>
                <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-dim tabular-nums">
                  {(!hasLaunch
                    ? ["Open details below to join"]
                    : stateLoaded && phase
                      ? phaseMeta(phase, rounds, nowSeconds)
                      : ["Reading launch state"]
                  ).join(" · ")}
                </span>
                {isReplay && (
                  <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-electric tabular-nums">
                    Replay · as of {formatMinute(nowSeconds)} · actions off
                  </span>
                )}
              </h1>
              {rulesState && (
                <button
                  type="button"
                  onClick={() => jumpToSection("contracts")}
                  title="Jump to launch and contract details"
                  className={`font-mono text-[10px] uppercase tracking-[0.02em] transition-colors hover:text-ink max-xl:min-h-11 ${
                    rulesState === "match" ? "text-dim" : rulesState === "mismatch" ? "text-alert" : "text-quiet"
                  }`}
                >
                  Rules {rulesState === "match" ? "✓" : rulesState === "mismatch" ? "✗" : "·"} Details
                </button>
              )}
            </div>

            {/* Boxes bleed into the gutter so their inner text sits on the
                same left line as the flush section text. */}
            {stateLoaded && phase?.phaseKind === PHASE.TRADING_OPEN ? (
              // Final tally: a finished launch states its outcome, not
              // round-machinery artifacts.
              <>
                <div className="-mx-[13px] mt-5 grid grid-cols-2 gap-2 @3xl:grid-cols-4">
                  <Metric
                    label="Total raised"
                    value={fmtAmount(Number(launchStats?.totalCommittedWeth ?? 0), currency)}
                    sub={amountSub(Number(launchStats?.totalCommittedWeth ?? 0))}
                    loaded={stateLoaded}
                  />
                  <Metric
                    label="Final price"
                    value={stagePrice ? fmtPrice(Number(stagePrice.value), currency, tokenSymbol) : "—"}
                    sub={stagePrice ? priceSub(Number(stagePrice.value), tokenSymbol) : undefined}
                    loaded={stateLoaded}
                  />
                  <Metric label="Participants" value={String(lockerSummaries.length)} loaded={indexLoaded} />
                  <Metric label="Settled" value={`${settledLockerCount}/${lockerSummaries.length}`} loaded={indexLoaded} />
                </div>
                {poolComposition && poolCompositionParts(poolComposition, tokenSymbol, currency).length > 0 && (
                  <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet tabular-nums">
                    Pool · {poolCompositionParts(poolComposition, tokenSymbol, currency).join(" · ")}
                  </p>
                )}
              </>
            ) : (
            <div className="-mx-[13px] mt-5 grid grid-cols-2 gap-2 @3xl:grid-cols-4">
              <Metric
                label="Total committed"
                value={fmtAmount(Number(launchStats?.totalCommittedWeth ?? 0), currency)}
                sub={amountSub(Number(launchStats?.totalCommittedWeth ?? 0))}
                loaded={stateLoaded}
              />
              <Metric
                label={stageRoundIndex !== null ? `Round ${stageRoundIndex + 1} raised` : "Final round raised"}
                value={fmtAmount(
                  Number((stageRoundIndex !== null ? stageMarket?.raisedWeth : roundMarket[ROUND_COUNT - 1]?.raisedWeth) ?? 0),
                  currency
                )}
                sub={amountSub(
                  Number((stageRoundIndex !== null ? stageMarket?.raisedWeth : roundMarket[ROUND_COUNT - 1]?.raisedWeth) ?? 0)
                )}
                loaded={stateLoaded}
              />
              <Metric
                label={stagePrice?.label ?? "Price"}
                value={
                  stagePrice
                    ? `${formatCryptoPrice(Number(stagePrice.value))} ETH/${tokenSymbol}`
                    : phase?.phaseKind === PHASE.FAILED
                      ? "No price discovered"
                      : "Discovered as the round fills"
                }
                loaded={stateLoaded}
              />
              <Metric
                label="Min commit"
                value={fmtAmount(Number(launchStats?.minCommitLabel ?? 0), currency, 6)}
                sub={amountSub(Number(launchStats?.minCommitLabel ?? 0))}
                loaded={stateLoaded}
              />
            </div>
            )}
            {stateLoaded &&
              phase?.phaseKind === PHASE.ROUND_OPEN &&
              phase.index === 0 &&
              launchStats &&
              !launchStats.anchorReady &&
              launchStats.anchorTargetWeth !== "0" && (
                <p className="mt-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.02em] text-dim tabular-nums">
                  Anchor · {stageMarket?.raisedWeth ?? "0"} / {launchStats.anchorTargetWeth} ETH — round 1 must reach the anchor
                  before later rounds open
                </p>
              )}

            {stateLoaded && hasLocker && totalCommitted > 0 && (
              <p className="mt-4 border-t border-faint pt-3 font-mono text-[10px] uppercase tracking-[0.02em] text-dim tabular-nums">
                Your position · {fmtAmount(totalCommitted, currency)}{" "}
                {amountSub(totalCommitted) && <span className="text-quiet">({amountSub(totalCommitted)}) </span>}
                ≈ {trimDecimals(totalPreviewTokens.toFixed(2), 2)} {tokenSymbol}
              </p>
            )}

            {stateLoaded && phase && (
              <div ref={stageCtaRef} className={`-mx-[13px] mt-5 border p-3 ${pendingAction ? "tx-pending" : "border-hairline"}`}>
                {phase.phaseKind === PHASE.ROUND_OPEN && (
                  <>
                    {stageLadder()}
                    <div className="mt-3 flex items-center gap-2">
                      <Input
                        id="commit-amount"
                        inputMode="decimal"
                        pattern="[0-9]*[.]?[0-9]*"
                        value={contribution}
                        onChange={(event) => setContribution(event.target.value)}
                        className="tabular-nums"
                        aria-label="Contribution amount in ETH"
                        disabled={!canCommit || Boolean(pendingAction)}
                      />
                      <span className="font-mono text-[10px] uppercase text-dim">ETH</span>
                    </div>
                    <p
                      className={`mt-2 font-mono text-[10px] uppercase tracking-[0.02em] tabular-nums ${
                        commitEstimate ? "text-electric" : "text-dim"
                      }`}
                      title={commitEstimate ? `≈ ${commitEstimate.exact} ${tokenSymbol}` : undefined}
                    >
                      {commitEstimate
                        ? `≈ ${commitEstimate.compact} ${tokenSymbol} at ${stagePrice?.label.toLowerCase() ?? "price"}${
                            currency.usd && usdFromEth(Number(contribution), usdPerEth)
                              ? ` · ${usdFromEth(Number(contribution), usdPerEth)}`
                              : ""
                          }`
                        : "Price is discovered as the round fills"}
                    </p>
                    {stageCta(`Commit to round ${phase.index + 1}`, () => void commitToRound(), Boolean(pendingAction) || !canCommit)}
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                      {roundHasRefundWindow(rounds[phase.index], phase.index)
                        ? (rounds[phase.index]?.deflectionCostPct ?? 0) > 0
                          ? `Wrapped to WETH in your locker · Refundable after this round at ${rounds[phase.index]?.deflectionCostPct}% cost`
                          : "Wrapped to WETH in your locker · Refundable free after this round"
                        : "Wrapped to WETH in your locker · Final round · Rolls to settlement"}
                    </p>
                  </>
                )}
                {phase.phaseKind === PHASE.REFUND_OPEN && (
                  <>
                    {stageLadder()}
                    {refundableWeth > 0 ? (
                      <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.02em] text-dim tabular-nums">
                        Refundable · {trimDecimals(refundableWeth.toFixed(4), 4)} ETH — you receive{" "}
                        {trimDecimals((refundableWeth * (1 - refundCostPct / 100)).toFixed(4), 4)} ETH · cost{" "}
                        {trimDecimals(((refundableWeth * refundCostPct) / 100).toFixed(4), 4)} ETH
                      </p>
                    ) : (
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                        {hasLocker ? "No commitment in this refund window" : "Set a locker to check your refundable amount"}
                      </p>
                    )}
                    {stageCta(
                      `Refund round ${phase.index + 1}${refundCostPct > 0 ? ` (${refundCostPct}% deflection cost)` : ""}`,
                      () => void refundCurrentRound(),
                      Boolean(pendingAction) || !canRefund || refundableWeth <= 0
                    )}
                  </>
                )}
                {phase.phaseKind === PHASE.READY_TO_FINALIZE && (
                  <>
                    {stageLadder(false)}
                    <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-dim">
                      Sale rounds are complete. Anyone can finalize the launch to open the claim window.
                    </p>
                    {stageCta("Finalize launch", () => void finalizeLaunch(), Boolean(pendingAction) || !canFinalize, false)}
                  </>
                )}
                {(phase.phaseKind === PHASE.SETTLEMENT_OPEN || phase.phaseKind === PHASE.POOL_READY) && (
                  <>
                    {stageLadder()}
                    <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.02em] text-dim tabular-nums">
                      {position?.known && position.liquiditySettled
                        ? "Your locker is settled ✓"
                        : totalCommitted > 0
                          ? `Settling claims ≈ ${trimDecimals(totalPreviewTokens.toFixed(2), 2)} ${tokenSymbol} into your locker`
                          : "No position to settle in this locker"}
                    </p>
                    {stageCta(
                      phase.phaseKind === PHASE.POOL_READY ? "Settle after claim window" : "Settle & claim",
                      () => void settleAndClaim(),
                      Boolean(pendingAction) || !canSettleAndClaim
                    )}
                  </>
                )}
                {phase.phaseKind === PHASE.TRADING_OPEN && (
                  <>
                    {stageLadder()}
                    <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.02em] text-dim tabular-nums">
                      {canWithdrawTokens
                        ? `Withdrawable · ${compactNumber(Number(position?.withdrawableTokens || 0))} ${tokenSymbol}`
                        : !hasWallet
                          ? "The launch is complete — connect a wallet to check your locker"
                          : hasLocker
                            ? "Trading is live on the official pool — no unlocked tokens in this locker"
                            : "Trading is live — set your locker to check for unlocked tokens"}
                    </p>
                    {tokenAddress && (
                      <p className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono text-[11px] uppercase tracking-[0.02em]">
                        <a
                          href={`https://app.uniswap.org/swap?outputCurrency=${tokenAddress}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-electric underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
                        >
                          Trade on Uniswap <span aria-hidden>↗</span>
                        </a>
                        <a
                          href={`https://dexscreener.com/ethereum/${poolAddress || tokenAddress}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-electric underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
                        >
                          View on Dexscreener <span aria-hidden>↗</span>
                        </a>
                        {!IS_MAINNET && (
                          <span className="text-[10px] text-dim">
                            Mainnet link structure — will not resolve for {CHAIN_NAME} tokens
                          </span>
                        )}
                      </p>
                    )}
                    {stageCta(
                      "Withdraw all tokens",
                      () => void withdrawTokens(position?.withdrawableTokensExact),
                      Boolean(pendingAction) || !canWithdrawTokens
                    )}
                  </>
                )}
                {phase.phaseKind === PHASE.FAILED && (
                  <>
                    {stageLadder()}
                    <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.02em] text-alert tabular-nums">
                      This launch failed.{" "}
                      {hasLocker && stateLoaded
                        ? Number(position?.lockedWeth || 0) > 0
                          ? `Refundable · ${position?.lockedWeth} WETH from your locker`
                          : "No committed WETH in this locker — nothing to refund"
                        : "Committed WETH is refundable from participants' lockers"}
                    </p>
                    {hasWallet && !hasLocker ? (
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                        If you participated, set your locker <span className="xl:hidden">in the participants panel below</span><span className="hidden xl:inline">in the right rail</span> to claim your refund — there is nothing to
                        create on a failed launch.
                      </p>
                    ) : (
                      stageCta(
                        "Withdraw failed-launch refund",
                        () => void refundFailedLaunch(),
                        Boolean(pendingAction) || !canFailedRefund || !hasLocker || Number(position?.lockedWeth || 0) <= 0
                      )
                    )}
                  </>
                )}
                {phase.phaseKind === PHASE.NOT_STARTED && (
                  <>
                    {stageLadder()}
                    <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-dim">
                      Round 1 has not opened yet. Connect a wallet and create your locker now so you can commit the moment it does.
                    </p>
                    {hasWallet && hasLocker ? (
                      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.02em] text-dim">You are ready ✓</p>
                    ) : (
                      stageCta("Waiting for round 1", () => undefined, true)
                    )}
                  </>
                )}
              </div>
            )}

          </section>

          <section id="charts" className="max-sm:order-2 scroll-mt-12 border-b border-hairline px-4 py-5 sm:px-6">
            <SectionHeader title="Charts" meta={indexLoaded ? undefined : "Waiting for index"} />
            <div className="grid gap-8 @2xl:grid-cols-2 @4xl:grid-cols-3">
              <div className="min-w-0">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                  Total committed · all stages
                  {myCommittedSeries.length > 0 && <span className="text-electric"> · — you</span>}
                </p>
                <CommittedChart
                  series={committedSeries}
                  rounds={rounds.slice(0, scheduledRoundCount)}
                  mineSeries={myCommittedSeries}
                />
              </div>
              <div className="min-w-0">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                  Price ladder · discovered per round
                  {latestPricedIndex >= 0 && (
                    <span className="text-dim tabular-nums">
                      {" · "}
                      {formatCryptoPrice(Number(roundMarket[latestPricedIndex].priceWeth))} ETH
                    </span>
                  )}
                </p>
                <PriceChart market={roundMarket.slice(0, scheduledRoundCount)} rounds={rounds.slice(0, scheduledRoundCount)} />
              </div>
              {/* At two-column width this spans the full row — no dead corner. */}
              <div className="min-w-0 @2xl:col-span-2 @4xl:col-span-1">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                  Volume per round · ETH · <span className="text-live">■ commits</span>{" "}
                  <span className="text-alert">□ refunds</span>
                </p>
                <RoundVolumeChart volumes={roundVolumes.slice(0, scheduledRoundCount)} activeRound={activeRound} />
              </div>
            </div>
          </section>

          <section className="max-sm:order-2 border-b border-hairline px-4 py-5 sm:px-6">
            <SectionHeader
              title="Your position"
              meta={isReplay ? "Live locker data — not replayed" : undefined}
              action={tokenAddress ? <ExplorerLink label="Token" address={tokenAddress} /> : undefined}
            />
            {!hasLocker ? (
              <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                Set your locker <span className="xl:hidden">in the participants panel below</span><span className="hidden xl:inline">in the right rail</span> to track your position.
              </p>
            ) : !stateLoaded || lockerSyncedFor.toLowerCase() !== lockerAddress.toLowerCase() ? (
              <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">Loading position…</p>
            ) : positionRows.length === 0 ? (
              <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">No commitments yet.</p>
            ) : (
              <div>
                {positionRows.map((item) => (
                  <div
                    key={item.round}
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-faint py-2 last:border-b-0"
                  >
                    <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-ink">Round {item.round + 1}</span>
                    <span className="flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] text-dim tabular-nums">
                      <span>{item.committedWeth} ETH</span>
                      <span aria-hidden>·</span>
                      <span>
                        ≈ {compactNumber(Number(Number(item.claimedTokens) > 0 ? item.claimedTokens : item.previewTokens))}{" "}
                        {tokenSymbol}
                      </span>
                      {item.refunded && <span className="text-[10px] uppercase text-quiet">Refunded ✓</span>}
                      {item.tokensClaimed && <span className="text-[10px] uppercase text-quiet">Claimed ✓</span>}
                    </span>
                  </div>
                ))}
                {totalCommitted > 0 && (
                  <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.02em] text-dim tabular-nums">
                    Total · {fmtAmount(totalCommitted, currency)} ≈ {trimDecimals(totalPreviewTokens.toFixed(2), 2)}{" "}
                    {tokenSymbol} · Avg {averageWalletPriceLabel} ETH/{tokenSymbol}
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Per-round spec sheet: the center column has the width the
              rail never did, so round data lives here and the rail stays a
              calm stage/time list. */}
          <section id="rounds" className="max-sm:order-1 scroll-mt-12 border-b border-hairline px-4 py-5 sm:px-6">
            <SectionHeader title="Rounds" />
            <RoundTable
              rounds={rounds}
              details={roundDetails}
              phase={phase}
              nowSeconds={nowSeconds}
              loaded={stateLoaded}
              hasLaunch={hasLaunch}
            />
          </section>

          {/* Always visible and mid-page (was: bottom of page behind a
              "Details +" toggle nobody found). Doubles as the Join-launch
              entry, so hiding it hid the way IN. */}
          <section id="contracts" className="max-sm:order-3 scroll-mt-12 border-b border-hairline px-4 py-5 sm:px-6">
            <h2 className="mb-4 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">Launch & contracts</h2>
            <div className="grid gap-8 @3xl:grid-cols-2 @3xl:gap-10">
              <div className="min-w-0">
                <SectionHeader title="Launch" />
                <Label htmlFor="join-launch" className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                  Launch contract
                </Label>
                <Input
                  id="join-launch"
                  value={joinLaunchAddress}
                  onChange={(event) => {
                    setJoinLaunchAddress(event.target.value);
                    if (joinAddressInvalid) setJoinAddressInvalid(false);
                  }}
                  aria-invalid={joinAddressInvalid || undefined}
                  className="mt-2"
                  placeholder="0x…"
                />
                {joinAddressInvalid && (
                  <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.02em] text-alert" role="alert">
                    Not a valid Ethereum address
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={joinLaunch} disabled={Boolean(pendingAction)}>
                    Join launch <span aria-hidden>→</span>
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => Promise.all([refreshState(), refreshActivity({ announce: true })])}
                    disabled={Boolean(pendingAction) || !ethers.isAddress(launchAddress)}
                  >
                    Refresh
                  </Button>
                </div>
                {participantLink && (
                  <div className="mt-4 flex items-center justify-between gap-3 border-t border-faint pt-3">
                    <span className="min-w-0 truncate font-mono text-[9px] tracking-[0.02em] text-quiet" title={participantLink}>
                      <span className="uppercase">Share</span> · {participantLink}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => copyText(`${window.location.origin}${participantLink}`)}>
                      <Copy className="h-3 w-3" aria-hidden />
                      Copy link
                    </Button>
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <SectionHeader title="Contracts" />
                <div>
                  {/* Deployed factory suite — the schema is authoritative for
                      the current network (shows before any launch exists).
                      Factory honours a selected launch's own D17Factory; the
                      rest are network-level, so the schema wins over any
                      legacy env default (e.g. the locker factory). */}
                  <AddressLine label="Factory" value={factoryAddress || schemaContracts.d17Factory || ""} />
                  <AddressLine label="Token factory" value={schemaContracts.tokenFactory || ""} />
                  <AddressLine label="Launch factory" value={schemaContracts.launchFactory || ""} />
                  <AddressLine label="Vault factory" value={schemaContracts.liquidityVaultFactory || ""} />
                  <AddressLine label="Locker factory" value={schemaContracts.lockerFactory || lockerFactoryAddress || ""} />
                  {/* Per-launch — populated once a launch is selected. */}
                  <AddressLine label="Launch" value={launchAddress} />
                  <AddressLine label="Token" value={tokenAddress} />
                  <AddressLine label="Vault" value={liquidityVaultAddress} />
                  <RulesHashRow loadedHash={expectedRulesHash} linkHash={linkRulesHash} stateLoaded={stateLoaded} />
                </div>
              </div>
            </div>
          </section>

        </section>

        <aside id="participants" className="order-3 scroll-mt-12 border-t border-hairline xl:min-h-0 xl:overflow-y-auto xl:border-t-0 xl:border-l xl:border-hairline">
          <div className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3 sm:px-6">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">Participants</h2>
            {/* Testing aid only — public users must not be able to hammer
                the API with manual refreshes. */}
            {TEST_CONTROLS_ENABLED && (
              <Button
                size="sm"
                variant="ghost"
                className="max-xl:min-h-11"
                onClick={() => refreshActivity({ announce: true })}
                disabled={isIndexing || !ethers.isAddress(launchAddress)}
              >
                {manualIndexing && <Loader2 className="h-3 w-3 motion-safe:animate-spin" aria-hidden />}
                Reindex
              </Button>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 border-b border-hairline px-[3px] py-3 sm:px-[11px]">
            <Metric label="Lockers" value={String(lockerSummaries.length)} loaded={indexLoaded} />
            <Metric label="Settled" value={`${settledLockerCount}/${lockerSummaries.length}`} loaded={indexLoaded} />
            <Metric label="Net ETH" value={formatEth(indexedNetCommitted)} loaded={indexLoaded} />
          </div>
          {indexedNetCommitted > 0n && lockerSummaries.length > 0 && (
            <div className="border-b border-hairline px-4 py-3 sm:px-6">
              <HolderBar lockers={lockerSummaries} total={indexedNetCommitted} mine={hasLocker ? lockerAddress : undefined} />
            </div>
          )}
          <p className="border-b border-hairline px-4 py-2.5 font-mono text-[9px] uppercase leading-relaxed tracking-[0.02em] text-quiet tabular-nums sm:px-6">
            {isReplay ? (
              <span className="text-electric">
                Replay · {activityItems.length} events · as of {formatMinute(nowSeconds)}
              </span>
            ) : dataMode() === "api" ? (
              <>
                {indexStatus} ·{" "}
                {sseLive || discoveryWsLive ? (
                  <span className="text-live">● Live WS</span>
                ) : (
                  <span className="text-dim">Reconnecting…</span>
                )}
              </>
            ) : (
              <>
                {indexStatus} · Poll {EVENT_POLL_SECONDS}s{READ_WS_URL ? " · WS on" : ""}
                {sseLive && <span className="text-live"> · ● Live</span>}
              </>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline px-4 py-3 sm:px-6">
            <button
              type="button"
              aria-pressed={activityMode === "activity"}
              onClick={() => setActivityMode("activity")}
              className={chipClass(activityMode === "activity")}
            >
              Activity
            </button>
            <button
              type="button"
              aria-pressed={activityMode === "lockers"}
              onClick={() => setActivityMode("lockers")}
              className={chipClass(activityMode === "lockers")}
            >
              Lockers
            </button>
            <button
              type="button"
              aria-pressed={activityMode === "locker"}
              onClick={() => setActivityMode("locker")}
              className={chipClass(activityMode === "locker")}
            >
              Your locker
            </button>
            {selectedLockerForFeed && (
              <button
                type="button"
                onClick={() => setSelectedLockerForFeed("")}
                aria-label={`Clear locker filter ${selectedLockerForFeed}`}
                title="Clear locker filter"
                className="ml-auto inline-flex items-center gap-1.5 border border-ink px-2.5 py-1 font-mono text-[10px] tracking-[0.02em] text-ink transition-colors hover:text-dim"
              >
                {shortAddress(selectedLockerForFeed)} <span aria-hidden>×</span>
              </button>
            )}
          </div>
          {activityMode === "activity" ? (
            <ActivityFeed items={filteredActivity} flashIds={flashIds} mine={hasLocker ? lockerAddress : undefined} />
          ) : activityMode === "lockers" ? (
            <LockerList
              lockers={lockerSummaries}
              selectedLocker={selectedLockerForFeed}
              launchFailed={phase?.phaseKind === PHASE.FAILED}
              totalNet={indexedNetCommitted}
              mine={hasLocker ? lockerAddress : undefined}
              onSelect={(locker) => {
                setSelectedLockerForFeed(locker);
                setActivityMode("activity");
              }}
            />
          ) : (
            <div className="px-4 py-4 sm:px-6">
              <SectionHeader
                title="Your locker"
                action={
                  <Button size="sm" variant="secondary" onClick={createLocker} disabled={Boolean(pendingAction)}>
                    Create
                  </Button>
                }
              />
              {hasLocker &&
                lockerSummaries.length > 0 &&
                (() => {
                  const index = lockerSummaries.findIndex((entry) => entry.locker.toLowerCase() === lockerAddress.toLowerCase());
                  if (index === -1) return null;
                  const totalNum = Number(ethers.formatEther(indexedNetCommitted));
                  const share = totalNum > 0 ? Number(ethers.formatEther(netCommitted(lockerSummaries[index]))) / totalNum : 0;
                  return (
                    <div className="mb-3">
                      <p className="font-mono text-[11px] uppercase tracking-[0.02em] text-electric tabular-nums">
                        #{index + 1} of {lockerSummaries.length} · {(share * 100).toFixed(1)}% of raise
                      </p>
                      {stateLoaded && totalCommitted > 0 && (
                        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.02em] text-dim tabular-nums">
                          Committed {trimDecimals(totalCommitted.toFixed(4), 4)} ETH → ≈{" "}
                          {compactNumber(totalPreviewTokens)} {tokenSymbol} · Avg {averageWalletPriceLabel}
                        </p>
                      )}
                    </div>
                  );
                })()}
              <TextField label="Locker address" value={lockerAddress} onChange={setLockerAddress} explorerValue={lockerAddress} />
              {ownerLockers.length > 0 && (
                <div className="mt-3">
                  <p className="font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">Wallet lockers</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {ownerLockers.map((locker) => {
                      const selected = lockerAddress.toLowerCase() === locker.toLowerCase();
                      return (
                        <button
                          key={locker}
                          type="button"
                          onClick={() => setLockerAddress(locker)}
                          aria-pressed={selected}
                          className={`${chipClass(selected)} normal-case`}
                        >
                          {shortAddress(locker)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="mt-4">
                <LedgerRow label="Wallet · ETH" value={balances.walletEth} unit="ETH" loaded={stateLoaded} />
                <LedgerRow label="Wallet · WETH" value={balances.walletWeth} unit="WETH" loaded={stateLoaded} />
                <LedgerRow label="Locker · WETH" value={balances.lockerWeth} unit="WETH" loaded={stateLoaded} />
                <LedgerRow label="Locker · Locked" value={balances.lockedWeth} unit="WETH" loaded={stateLoaded} />
                <LedgerRow label="Locker · Withdrawable" value={balances.withdrawableWeth} unit="WETH" loaded={stateLoaded} />
                <LedgerRow
                  label="Locker · Tokens"
                  value={compactNumber(Number(position?.withdrawableTokens || 0))}
                  unit={tokenSymbol}
                  loaded={stateLoaded}
                />
                <LedgerRow label="Settlement" value={formatSettlementStatus(position)} loaded={stateLoaded} />
              </div>
              {/* Withdraw/recover live HERE because this is where the funds
                  live — as a floating center section they read as unrelated
                  to the locker they act on. */}
              <div className="mt-4 border-t border-faint pt-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">Withdrawals & recovery</p>
                <div className="mt-1">
                  <LedgerAction
                    label="Withdraw WETH"
                    value={wethWithdrawAmount}
                    unit="WETH"
                    onChange={setWethWithdrawAmount}
                    onAction={() => void withdrawWeth()}
                    action="Withdraw"
                    disabled={Boolean(pendingAction)}
                    max={stateLoaded ? position?.withdrawableWethExact : undefined}
                  />
                  <LedgerAction
                    label="Withdraw sale tokens"
                    value={tokenWithdrawAmount}
                    unit={tokenSymbol}
                    onChange={setTokenWithdrawAmount}
                    onAction={() => void withdrawTokens()}
                    action="Withdraw"
                    disabled={Boolean(pendingAction) || !canWithdrawTokens}
                    max={stateLoaded ? position?.withdrawableTokensExact : undefined}
                  />
                  <LedgerAction
                    label="Recover excess WETH"
                    value={excessWethAmount}
                    unit="WETH"
                    onChange={setExcessWethAmount}
                    onAction={() => void recoverExcessWeth()}
                    action="Recover"
                    disabled={Boolean(pendingAction)}
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-3">
                <Button size="sm" variant="secondary" onClick={verifyLaunch} disabled={Boolean(pendingAction)}>
                  Check rules
                </Button>
                {launchVerified && (
                  <span className="stamp-in inline-block border-2 border-ink px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-ink">
                    Verified
                  </span>
                )}
              </div>
              <p className="mt-3 font-mono text-[10px] uppercase leading-relaxed tracking-[0.02em] text-quiet">
                The locker is a contract you own — the developer never holds your funds
              </p>
              {txLog.length > 0 && (
                <div className="mt-4 border-t border-faint pt-3">
                  <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">Your transactions</p>
                  <div className="mt-1">
                    {txLog.map((tx) => (
                      <a
                        key={tx.hash}
                        href={`${EXPLORER_BASE}/tx/${tx.hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className={`block border-b border-faint py-2 transition-colors last:border-b-0 hover:bg-faint ${
                          nowSeconds - tx.at < 3 ? "row-flash" : ""
                        }`}
                      >
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-ink">{tx.label}</span>
                          <span className="shrink-0 font-mono text-[10px] text-quiet" aria-hidden>
                            ↗
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                          <span className="text-live">✓ Confirmed</span>
                          <span aria-hidden>·</span>
                          <span className="tabular-nums">{formatRelative(tx.at)}</span>
                          <span aria-hidden>·</span>
                          <span className="normal-case">{shortHash(tx.hash)}</span>
                        </div>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* Mobile action bar: the phase's one primary action, under the thumb,
          only while the real CTA is off-screen. Connect fires directly;
          everything else jumps to the stage CTA (single source of truth for
          transactions — the bar never duplicates tx logic). */}
      {actionBarVisible && mobileAction && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-hairline bg-paper px-4 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] xl:hidden">
          <Button className="w-full" onClick={jumpToStageCta}>
            {mobileAction.label} <span aria-hidden>→</span>
          </Button>
        </div>
      )}
    </main>
    </CurrencyContext.Provider>
  );
}

/** The amount is the hero of a feed row, EoW bid-history style. */
function feedAmount(item: ActivityItem): { text: string; tone: "live" | "alert" | "ink" | "dim" } | null {
  switch (item.event) {
    // Trade-tape direction color: WETH into the raise is green, WETH out is
    // red. Lifecycle amounts (settlements, sweeps) stay in the mono ramp.
    case "RoundCommitted":
      return item.amountWeth ? { text: `+${item.amountWeth} Ξ`, tone: "live" } : null;
    case "RoundRefunded":
    case "LaunchFailedRefunded":
      return item.amountWeth ? { text: `−${item.amountWeth} Ξ`, tone: "alert" } : null;
    case "VaultSettlementClaimed":
      // The row label says what they are; the long ticker stays out of the tape.
      return item.amountToken ? { text: `${compactNumber(Number(item.amountToken))} tokens`, tone: "ink" } : null;
    case "UnsoldSaleTokensBurned":
    case "UnsoldSaleTokensPaid":
      return item.amountToken ? { text: `${compactNumber(Number(item.amountToken))} tokens`, tone: "dim" } : null;
    case "VaultLiquidityTokensClaimed":
    case "OfficialPoolCreated":
    case "LiquidityPoolCreated":
    case "ExcessWethSwept":
    case "UnexpectedEthSwept":
      return item.amountWeth ? { text: `${item.amountWeth} Ξ`, tone: "dim" } : null;
    default:
      return null;
  }
}

/** EoW bid-history style: addresses inside a line render bold white. */
function emphasizeAddresses(text: string): ReactNode {
  const parts = text.split(/(0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})/g);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/.test(part) ? (
      <span key={index} className="font-semibold normal-case text-ink">
        {part}
      </span>
    ) : (
      part
    )
  );
}

function chipClass(active: boolean) {
  return `border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.02em] transition-colors max-xl:inline-flex max-xl:min-h-11 max-xl:items-center ${
    active ? "border-ink text-ink" : "border-hairline text-quiet hover:text-ink"
  }`;
}

/** Discovery list — one shared component used in the desktop rail tab and the
 *  mobile #launches section. Live/open launches pin to the top, then upcoming
 *  by soonest start, then finished newest-first; unknown-start items sink
 *  under a "Start time pending" divider (partial indexer data stays visible,
 *  never NaN-sorts). Start time renders through the local-time formatMinute. */
function launchSortRank(launch: KnownLaunch): number {
  if (launch.phaseKind === PHASE.ROUND_OPEN || launch.phaseKind === PHASE.REFUND_OPEN || launch.phaseLabel === "round" || launch.phaseLabel === "refund") {
    return 0; // live / open now
  }
  if (launch.phaseKind === PHASE.NOT_STARTED || launch.phaseLabel === "not-started") {
    return 1; // upcoming
  }
  return 2; // finished / settling
}

function LaunchList({
  launches,
  selected,
  onSelect,
}: {
  launches: KnownLaunch[];
  selected: string;
  onSelect: (launch: string) => void;
}) {
  if (launches.length === 0) {
    return (
      <p className="px-4 py-6 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet sm:px-6">
        No launches yet · waiting for indexer
      </p>
    );
  }
  // Live/open launches pin to the top; then newest-created first (createdBlock
  // is the only monotonic ordering the list exposes — a stable proxy for
  // "by start time" that also surfaces the freshest launches for discovery).
  const sorted = [...launches].sort((a, b) => {
    const ra = launchSortRank(a);
    const rb = launchSortRank(b);
    if (ra !== rb) return ra - rb;
    return (b.createdBlock ?? -Infinity) - (a.createdBlock ?? -Infinity);
  });

  return (
    <div>
      {sorted.map((launch) => {
        const isSelected = Boolean(selected) && launch.launch.toLowerCase() === selected.toLowerCase();
        const live =
          launch.phaseKind === PHASE.ROUND_OPEN ||
          launch.phaseKind === PHASE.REFUND_OPEN ||
          launch.phaseLabel === "round" ||
          launch.phaseLabel === "refund";
        const upcoming = launch.phaseKind === PHASE.NOT_STARTED || launch.phaseLabel === "not-started";
        return (
          <button
            key={launch.launch}
            type="button"
            onClick={() => onSelect(launch.launch)}
            aria-pressed={isSelected}
            className={`flex w-full items-center justify-between gap-3 border-b border-faint px-4 py-2.5 text-left transition-colors hover:bg-faint sm:px-6 max-xl:min-h-11 ${
              isSelected ? "border-l-2 border-l-ink bg-faint" : ""
            }`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden className={live ? "shrink-0 text-live motion-safe:animate-pulse" : "shrink-0 text-dim"}>
                {live ? "●" : upcoming ? "○" : "✓"}
              </span>
              <span className="truncate font-mono text-[11px] font-semibold uppercase tracking-[0.02em] text-ink">
                {launch.symbol || shortAddress(launch.launch)}
              </span>
            </span>
            {launch.phaseLabel && (
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.02em] text-dim tabular-nums">
                {launch.phaseLabel}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Trust signal — ✓ in ink (green stays reserved for live/now), Unverified
 *  in quiet. Metadata-unavailable is handled by the masthead not rendering. */
function VerifiedBadge({ verified }: { verified: boolean }) {
  if (verified) {
    return (
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.02em] text-dim">
        <span className="text-ink" aria-hidden>
          ✓{" "}
        </span>
        Verified
      </span>
    );
  }
  return (
    <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">Unverified</span>
  );
}

/**
 * Project masthead: hairline logo square, name + symbol + verified on one
 * line, description as prose, typed links as a glyph row. Renders only when
 * launch metadata is available from the active data source.
 */
function LaunchMasthead({
  metadata,
  config,
  tokenAddress,
  poolAddress,
}: {
  metadata: LaunchMetadata;
  config: LaunchConfig | null;
  tokenAddress: string;
  poolAddress: string;
}) {
  const name = metadata.tokenName?.trim();
  const symbol = metadata.tokenSymbol?.trim();
  // Tokenomics chips from the real launch config (token split + the treasury
  // WETH cut). Total supply = sale + LP + deployer + dead-address allocation. Deflection is
  // NOT shown here — it's per-round (early rounds are free), so it lives on
  // the round rows, not as one misleading launch-level number.
  const tokenomics: { label: string; value: string }[] = [];
  if (config) {
    const total = config.saleTokens + config.lpTokens + config.deadTokens + config.manualTokens;
    const pct = (part: bigint) => (total > 0n ? `${Math.round((Number(part) / Number(total)) * 100)}%` : "—");
    if (total > 0n) {
      tokenomics.push({ label: "Supply", value: compactNumber(Number(ethers.formatUnits(total, 18))) });
      tokenomics.push({ label: "Sale", value: pct(config.saleTokens) });
      if (config.lpTokens > 0n) tokenomics.push({ label: "LP", value: pct(config.lpTokens) });
      if (config.manualTokens > 0n) tokenomics.push({ label: "Deployer", value: pct(config.manualTokens) });
      if (config.deadTokens > 0n) tokenomics.push({ label: "Dead address", value: pct(config.deadTokens) });
    }
    if (config.treasuryPct > 0) tokenomics.push({ label: "Treasury", value: `${config.treasuryPct}% ETH` });
    if (config.protocolFeePct > 0) tokenomics.push({ label: "Protocol fee", value: `${config.protocolFeePct}% ETH` });
    if (config.manualTokens > 0n) tokenomics.push({ label: "Deployer vesting", value: "180d linear" });
  }
  // Prefer the served SVG endpoint (relative to the API base) over the inline
  // data URI; fall back to initials so the block never collapses.
  const logoSrc = metadata.logo?.svgUrl
    ? `${apiBase()}${metadata.logo.svgUrl}`
    : metadata.logoSvgUri || "";
  const initials = (symbol || name || "?").slice(0, 3).toUpperCase();
  // Keep arbitrary link types (docs/github/x/website/…), drop anything that
  // isn't a real http(s) URL. Never hardcode a fixed set of socials.
  const links = (metadata.links || []).filter((link) => link.url && /^https?:\/\//i.test(link.url));

  return (
    <section className="border-b border-hairline px-4 py-5 sm:px-6">
      <div className="flex items-start gap-3.5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden border border-hairline bg-panel">
          {logoSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc} alt="" className="h-full w-full object-contain" />
          ) : (
            <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.02em] text-dim">{initials}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <h1 className="font-mono text-[14px] font-semibold uppercase leading-tight tracking-[0.02em] text-ink">
              {name || "Untitled launch"}
            </h1>
            {symbol && (
              <span className="font-mono text-[11px] uppercase tracking-[0.02em] text-dim tabular-nums">{symbol}</span>
            )}
            <VerifiedBadge verified={metadata.verified} />
          </div>
          {metadata.description && (
            <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-dim">{metadata.description}</p>
          )}
          {links.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-0.5">
              {links.map((link) => (
                <a
                  key={`${link.linkType}:${link.url}`}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.02em] text-electric transition-colors hover:text-ink max-xl:min-h-11"
                >
                  <span aria-hidden>↗</span>
                  {link.linkType}
                </a>
              ))}
            </div>
          )}
          {(ethers.isAddress(tokenAddress) || ethers.isAddress(poolAddress)) && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              {ethers.isAddress(tokenAddress) && (
                <button
                  type="button"
                  onClick={() => copyText(tokenAddress)}
                  title={`Copy token contract ${tokenAddress} — add ${symbol || "the token"} to your wallet`}
                  className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink max-xl:min-h-11"
                >
                  <span>Token</span>
                  <span className="font-semibold normal-case text-ink">{shortAddress(tokenAddress)}</span>
                  <Copy className="h-3 w-3" aria-hidden />
                </button>
              )}
              {ethers.isAddress(poolAddress) && (
                <button
                  type="button"
                  onClick={() => copyText(poolAddress)}
                  title={`Copy official pool contract ${poolAddress}`}
                  className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink max-xl:min-h-11"
                >
                  <span>Pool</span>
                  <span className="font-semibold normal-case text-ink">{shortAddress(poolAddress)}</span>
                  <Copy className="h-3 w-3" aria-hidden />
                </button>
              )}
            </div>
          )}
          {tokenomics.length > 0 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet tabular-nums">
              {tokenomics.map((item) => (
                <span key={item.label}>
                  {item.label} <span className="font-semibold text-dim">{item.value}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SectionHeader({ title, meta, action }: { title: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">{title}</h2>
      <div className="flex items-center gap-3">
        {meta && <span className="font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">{meta}</span>}
        {action}
      </div>
    </div>
  );
}

function LedgerRow({ label, value, unit, loaded = true }: { label: string; value: string; unit?: string; loaded?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-faint py-2 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-[12px] text-ink tabular-nums">
        {loaded ? value : "—"}
        {unit && loaded && <span className="ml-1.5 text-[10px] uppercase text-dim">{unit}</span>}
      </span>
    </div>
  );
}

function RulesHashRow({ loadedHash, linkHash, stateLoaded }: { loadedHash: string; linkHash: string; stateLoaded: boolean }) {
  const hasLoaded = Boolean(loadedHash) && loadedHash.startsWith("0x");
  const hasLink = Boolean(linkHash) && linkHash.startsWith("0x");
  const matches = hasLoaded && hasLink && loadedHash.toLowerCase() === linkHash.toLowerCase();
  return (
    <div className="flex items-center justify-between gap-3 border-b border-faint py-2 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">Rules hash</span>
      {hasLoaded ? (
        <span className="flex min-w-0 items-center gap-2.5">
          {hasLink ? (
            matches ? (
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.02em] text-dim">Matches link ✓</span>
            ) : (
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.02em] text-alert">Mismatch ✗</span>
            )
          ) : (
            <span
              className="shrink-0 font-mono text-[9px] uppercase tracking-[0.02em] text-quiet"
              title="No expected hash was provided by the link or environment, so there is nothing to compare against"
            >
              Unverified
            </span>
          )}
          <button
            type="button"
            title={loadedHash}
            aria-label="Copy rules hash"
            className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-ink transition-colors hover:text-dim max-xl:min-h-11"
            onClick={() => copyText(loadedHash)}
          >
            <span className="truncate">{shortHash(loadedHash)}</span>
            <Copy className="h-3 w-3 shrink-0 text-quiet" aria-hidden />
          </button>
        </span>
      ) : (
        <span className="font-mono text-[11px] text-quiet">{stateLoaded ? "Not set" : "—"}</span>
      )}
    </div>
  );
}

/** The rounds SCHEDULE — a visual snapshot of what the rounds are: when
 *  each opens/closes, what leaving costs, what price was discovered. One
 *  row per scheduled round, dynamic to the launch's round count. Activity
 *  detail (commits/refunds counts, sparkline) deliberately lives in the
 *  rail's expandable stage rows instead — one job per surface.
 *  Notation rules: units in headers only; no interpunct compounds; the
 *  refund column always states a cost ("free" / "17% cost"); status is a
 *  word, not a glyph. */
function RoundTable({
  rounds,
  details,
  phase,
  nowSeconds,
  loaded,
  hasLaunch,
}: {
  rounds: RoundTerm[];
  details: RoundDetail[];
  phase: PhaseSnapshot | null;
  nowSeconds: number;
  loaded: boolean;
  hasLaunch: boolean;
}) {
  const currency = useCurrency();
  const scheduled = rounds.filter((round) => round.startAt > 0);
  if (!hasLaunch || !loaded || scheduled.length === 0) {
    return (
      <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
        {!hasLaunch ? "Select a launch to view round data." : loaded ? "No rounds scheduled yet." : "Loading…"}
      </p>
    );
  }
  // One date for the whole launch → it lives in the TIME header, cells stay
  // clock-only. Multi-day launches fall back to full date+time cells.
  const sameDay = scheduled.every(
    (round) => formatDay(round.startAt) === formatDay(scheduled[0].startAt) && (round.endAt === 0 || formatDay(round.endAt) === formatDay(scheduled[0].startAt))
  );
  const clock = (at: number) => (sameDay ? formatClock(at) : formatMinute(at));
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[10px] uppercase tracking-[0.02em]">
        <thead>
          <tr className="border-b border-hairline text-quiet">
            <th className="py-2 pr-3 text-left font-normal">Round</th>
            <th className="py-2 pr-3 text-right font-normal">Allocation</th>
            <th className="py-2 pr-3 text-right font-normal">{sameDay ? `Time (${formatDay(scheduled[0].startAt)})` : "Time"}</th>
            <th className="py-2 pr-3 text-right font-normal">Refund</th>
            <th className="py-2 text-right font-normal">Price ({currency.usd ? "USD" : "ETH"})</th>
          </tr>
        </thead>
        <tbody>
          {scheduled.map((round) => {
              const index = round.id - 1;
              const detail = details[index];
              const isOpen = phase?.phaseKind === PHASE.ROUND_OPEN && phase.index === index;
              const isRefundOpen = phase?.phaseKind === PHASE.REFUND_OPEN && phase.index === index;
              const active = isOpen || isRefundOpen;
              const closesAt = round.refundEndAt > 0 ? round.refundEndAt : round.endAt;
              const done = !active && closesAt > 0 && nowSeconds >= closesAt;
              const hasRefundWindow = round.refundEndAt > 0;
              const tone = active ? "text-ink" : done ? "text-dim" : "text-quiet";
              return (
                <tr key={round.id} className={`border-b border-faint ${tone}`}>
                  <td className="py-2 pr-3 whitespace-nowrap">
                    <span className={active ? "font-semibold text-ink" : undefined}>Round {round.id}</span>
                    {isOpen && <span className="ml-2 text-live">open now</span>}
                    {isRefundOpen && <span className="ml-2 text-live">refund open</span>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{round.allocationPct}%</td>
                  <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                    {round.endAt > 0 ? `${clock(round.startAt)} → ${clock(round.endAt)}` : clock(round.startAt)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                    {hasRefundWindow ? (round.deflectionCostPct > 0 ? `${round.deflectionCostPct}%` : "Free") : "None"}
                  </td>
                  <td className="py-2 text-right tabular-nums whitespace-nowrap">
                    {detail?.price
                      ? currency.usd && currency.rate
                        ? `$${formatCryptoPrice(Number(detail.price) * currency.rate)}`
                        : formatCryptoPrice(Number(detail.price))
                      : "Not discovered"}
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}

/** Event-derived facts for the lifecycle stage expandables (Finalize /
 *  Claim window / Pool ready / Trading): clicking a row shows what
 *  happened, when, and the contracts involved. */
type LifecycleFacts = {
  finalized?: ActivityItem;
  unsoldDisposition?: ActivityItem;
  poolCreated?: ActivityItem;
  vaultLiquidity?: ActivityItem;
  settledCount: number;
  lockerCount: number;
  totalRaisedWeth: bigint;
  poolAddress: string;
  factoryAddress: string;
  liquidityVaultAddress: string;
  tokenAddress: string;
};

type FactRow = { label: string; value: string; href?: string };

/** CREATE POOL is permissionless — the button lives in the rail's POOL
 *  READY row, visible only while creation is actually available, and reads
 *  as completed the moment anyone succeeds. */
type PoolAction = { status: "hidden" | "available" | "created"; busy?: boolean };

function lifecycleRows(id: string, facts: LifecycleFacts, stage: TimelineStage, currency: CurrencyCtx): FactRow[] | null {
  const tx = (item?: ActivityItem) => (item ? `${EXPLORER_BASE}/tx/${item.hash}` : undefined);
  const when = (item?: ActivityItem) => (item?.timestamp ? formatMinute(item.timestamp) : "Not yet");
  const addr = (value: string) => (ethers.isAddress(value) ? shortAddress(value) : "Not set");
  const addrHref = (value: string) => (ethers.isAddress(value) ? `${EXPLORER_BASE}/address/${value}` : undefined);
  switch (id) {
    case "finalize":
      return [
        { label: "Finalized", value: when(facts.finalized), href: tx(facts.finalized) },
        {
          label: "Total raised",
          value: fmtAmount(Number(ethers.formatEther(facts.totalRaisedWeth)), currency),
        },
        {
          label: "Unsold sale tokens",
          value: facts.unsoldDisposition
            ? facts.unsoldDisposition.event === "UnsoldSaleTokensPaid"
              ? `${facts.unsoldDisposition.amountToken || "Tokens"} paid to treasury${
                  facts.unsoldDisposition.recipient ? ` (${shortAddress(facts.unsoldDisposition.recipient)})` : ""
                }`
              : `${facts.unsoldDisposition.amountToken || "Tokens"} burned`
            : facts.finalized
              ? "None"
              : "Not yet",
          href: tx(facts.unsoldDisposition),
        },
      ];
    case "settlement":
      return [
        {
          label: "Window",
          value: stage.startsAt
            ? `${formatMinute(stage.startsAt)} → ${stage.endsAt && isFiniteEnd(stage.endsAt) ? formatMinute(stage.endsAt) : "open"}`
            : "Not yet",
        },
        { label: "Settled", value: `${facts.settledCount} of ${facts.lockerCount} lockers` },
      ];
    case "pool-ready":
      return [
        { label: "Ready since", value: stage.startsAt ? formatMinute(stage.startsAt) : "Not yet" },
        { label: "Unsettled lockers", value: String(Math.max(0, facts.lockerCount - facts.settledCount)) },
        {
          label: "Pool",
          value: ethers.isAddress(facts.poolAddress) ? shortAddress(facts.poolAddress) : "Not created yet",
          href: ethers.isAddress(facts.poolAddress) ? `${EXPLORER_BASE}/address/${facts.poolAddress}` : undefined,
        },
      ];
    case "trading":
      return [
        { label: "Pool created", value: when(facts.poolCreated), href: tx(facts.poolCreated) },
        { label: "Pool", value: addr(facts.poolAddress), href: addrHref(facts.poolAddress) },
        { label: "Token", value: addr(facts.tokenAddress), href: addrHref(facts.tokenAddress) },
        { label: "Liquidity vault", value: addr(facts.liquidityVaultAddress), href: addrHref(facts.liquidityVaultAddress) },
        { label: "Factory", value: addr(facts.factoryAddress), href: addrHref(facts.factoryAddress) },
        { label: "Vault liquidity claimed", value: when(facts.vaultLiquidity), href: tx(facts.vaultLiquidity) },
      ];
    default:
      return null;
  }
}

function roundIndexForStage(id: string): number | null {
  if (id.startsWith("round-")) return Number(id.slice(6)) - 1;
  if (id.startsWith("refund-")) return Number(id.slice(7)) - 1;
  return null;
}

function MiniRaise({ values }: { values: number[] }) {
  const width = 280;
  const height = 32;
  const pad = 2;
  const max = Math.max(...values, 0.0001);
  const x = (index: number) => pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - (value / max) * (height - pad * 2);
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-8 w-full"
      role="img"
      aria-label={`Cumulative committed ETH during this round, ending at ${trimDecimals(last.toFixed(4), 4)}`}
    >
      <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} className="stroke-faint" strokeWidth="1" />
      <polyline points={points} fill="none" className="stroke-ink" strokeWidth="1" />
      <circle cx={x(values.length - 1)} cy={y(last)} r="2" className="fill-dim" />
    </svg>
  );
}

function LaunchTimeline({
  phase,
  rounds,
  nowSeconds,
  loaded,
  hasLaunch,
  details,
  facts,
  poolAction,
  onCreatePool,
}: {
  phase: PhaseSnapshot | null;
  rounds: RoundTerm[];
  nowSeconds: number;
  loaded: boolean;
  hasLaunch: boolean;
  details: RoundDetail[];
  facts: LifecycleFacts;
  poolAction: PoolAction;
  onCreatePool: () => void;
}) {
  const currency = useCurrency();
  const stages = buildTimelineStages(phase, rounds, nowSeconds);
  const activeStage = stages.find((stage) => stage.active);
  const activeStageId = activeStage?.id ?? "";
  const activeRef = useRef<HTMLDivElement | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    if (!activeStageId || !activeRef.current) return;
    if (!window.matchMedia("(min-width: 1280px)").matches) return;
    activeRef.current.scrollIntoView({ block: "nearest" });
  }, [activeStageId]);
  return (
    <div>
      <div className="sticky top-0 z-10 border-b border-hairline bg-paper px-4 py-3 sm:px-6">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">Stages</h2>
        <p className="mt-1.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.02em] text-dim">
          {activeStage ? (
            <>
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  activeStage.failed ? "bg-alert" : "bg-live motion-safe:animate-pulse"
                }`}
                aria-hidden
              />
              <span className={`min-w-0 truncate ${activeStage.failed ? "text-alert" : ""}`}>Now · {activeStage.title}</span>
              {isFiniteEnd(activeStage.endsAt) && (
                <span className="shrink-0 text-quiet tabular-nums">{timeLeft(activeStage.endsAt, nowSeconds)}</span>
              )}
            </>
          ) : (
            <span className="text-quiet">{!hasLaunch ? "No launch selected" : loaded ? "Between stages" : "Loading…"}</span>
          )}
        </p>
      </div>
      <div>
        {stages.map((stage) => {
          const roundIndex = roundIndexForStage(stage.id);
          const detail = roundIndex !== null ? details[roundIndex] : undefined;
          // Lifecycle stages (finalize / claim / pool-ready / trading) expand
          // like round rows do — what happened, when, and the contracts.
          const lifeRows = roundIndex === null ? lifecycleRows(stage.id, facts, stage, currency) : null;
          const expandable = hasLaunch && (roundIndex !== null || lifeRows !== null);
          const isExpanded = expandedId === stage.id;
          const toggle = () => setExpandedId((current) => (current === stage.id ? null : stage.id));
          const isRefundStage = stage.id.startsWith("refund-");

          const lifecyclePanelBody = lifeRows && (
            <div className="grid gap-y-1 font-mono text-[10px] uppercase tracking-[0.02em]">
              {lifeRows.map((row) => (
                <p key={row.label} className="flex justify-between gap-3">
                  <span className="text-quiet">{row.label}</span>
                  {row.href ? (
                    <a
                      href={row.href}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 truncate text-right normal-case text-electric transition-colors hover:text-ink tabular-nums"
                    >
                      {row.value} ↗
                    </a>
                  ) : (
                    <span className="min-w-0 truncate text-right text-dim tabular-nums">{row.value}</span>
                  )}
                </p>
              ))}
            </div>
          );

          const panel = expandable && isExpanded && (
            <div className="border-b border-faint px-4 pb-3 pt-1 sm:px-6">
              {lifecyclePanelBody}
              {stage.id === "pool-ready" && poolAction.status === "available" && (
                <button
                  type="button"
                  onClick={onCreatePool}
                  disabled={poolAction.busy}
                  className="mt-2 w-full border border-ink bg-ink px-3 py-2 text-center font-mono text-[11px] uppercase tracking-[0.04em] text-paper transition-opacity disabled:opacity-40"
                >
                  {poolAction.busy ? "Working…" : "Create pool →"}
                </button>
              )}
              {stage.id === "pool-ready" && poolAction.status === "created" && (
                <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.02em] text-live">Pool created ✓</p>
              )}
              {roundIndex !== null && detail && detail.spark.length > 1 && !isRefundStage && (
                <div className="mb-2">
                  <MiniRaise values={detail.spark} />
                </div>
              )}
              {roundIndex === null ? null : detail && (detail.commits > 0 || detail.refunds > 0) ? (
                <div className="grid gap-y-1 font-mono text-[10px] uppercase tracking-[0.02em]">
                  <p className="flex justify-between gap-3">
                    <span className="text-quiet">Raised</span>
                    <span className="text-dim tabular-nums">{fmtAmount(Number(detail.raised), currency)}</span>
                  </p>
                  <p className="flex justify-between gap-3">
                    <span className="text-quiet">Commits</span>
                    <span className="text-dim tabular-nums">
                      {detail.commits} from {detail.lockers} locker{detail.lockers === 1 ? "" : "s"}
                    </span>
                  </p>
                  <p className="flex justify-between gap-3">
                    <span className="text-quiet">Refunds</span>
                    <span className="text-dim tabular-nums">
                      {detail.refunds > 0
                        ? `${detail.refunds} (${fmtAmount(detail.refundedWeth, currency)} back out)`
                        : "None"}
                    </span>
                  </p>
                </div>
              ) : (
                <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                  {stage.skipped ? "This configured stage did not open." : "No activity in this round yet."}
                </p>
              )}
            </div>
          );

          if (stage.skipped) {
            return (
              <div key={stage.id}>
                <button
                  type="button"
                  onClick={expandable ? toggle : undefined}
                  aria-expanded={expandable ? isExpanded : undefined}
                  disabled={!expandable}
                  className={`block w-full border-b border-faint px-4 py-2 text-left sm:px-6 max-xl:min-h-11 ${
                    expandable ? "transition-colors hover:bg-faint" : "cursor-default"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-3 font-mono uppercase tracking-[0.02em] text-quiet">
                    <span className="flex min-w-0 items-baseline gap-2 text-[10px]">
                      <span aria-hidden>—</span>
                      <span className="truncate">{stage.title}</span>
                    </span>
                    <span className="shrink-0 text-[9px]">Did not open{expandable && <span aria-hidden> {isExpanded ? "−" : "+"}</span>}</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.02em] text-quiet tabular-nums">
                    Configured {stage.startsAt ? formatMinute(stage.startsAt) : "—"} →{" "}
                    {stage.endsAt && isFiniteEnd(stage.endsAt) ? formatMinute(stage.endsAt) : "—"}
                  </span>
                </button>
                {panel}
              </div>
            );
          }

          if (stage.done && !stage.active) {
            return (
              <div key={stage.id}>
                <button
                  type="button"
                  onClick={expandable ? toggle : undefined}
                  aria-expanded={expandable ? isExpanded : undefined}
                  disabled={!expandable}
                  className={`block w-full border-b border-faint px-4 py-2 text-left sm:px-6 max-xl:min-h-11 ${
                    expandable ? "transition-colors hover:bg-faint" : "cursor-default"
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-3 font-mono uppercase tracking-[0.02em] text-quiet">
                    <span className="flex min-w-0 items-baseline gap-2 text-[10px]">
                      <span aria-hidden>✓</span>
                      <span className="truncate">{stage.title}</span>
                    </span>
                    <span className="shrink-0 text-[9px]">Closed{expandable && <span aria-hidden> {isExpanded ? "−" : "+"}</span>}</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[9px] uppercase tracking-[0.02em] text-quiet tabular-nums">
                    {stage.startsAt ? formatMinute(stage.startsAt) : "—"} →{" "}
                    {stage.endsAt && isFiniteEnd(stage.endsAt) ? formatMinute(stage.endsAt) : "—"}
                  </span>
                </button>
                {panel}
              </div>
            );
          }
          return (
            <div key={stage.id} ref={stage.active ? activeRef : undefined}>
              <button
                type="button"
                onClick={expandable ? toggle : undefined}
                aria-expanded={expandable ? isExpanded : undefined}
                disabled={!expandable}
                className={`relative block w-full border-b border-faint px-4 py-3 text-left sm:px-6 ${
                  expandable ? "transition-colors hover:bg-faint" : "cursor-default"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={`flex items-baseline gap-2 font-mono text-[11px] uppercase tracking-[0.02em] ${
                      stage.failed ? "text-alert" : stage.active ? "text-ink" : "text-dim"
                    }`}
                  >
                    <span className={stage.failed ? "text-alert" : stage.active ? "text-live" : "text-quiet"} aria-hidden>
                      {stage.active ? "●" : "○"}
                    </span>
                    <span className="truncate">{stage.title}</span>
                  </span>
                  <span
                    className={`flex shrink-0 items-baseline gap-3 font-mono text-[10px] uppercase tracking-[0.02em] whitespace-nowrap tabular-nums ${
                      stage.active ? "text-ink" : "text-quiet"
                    }`}
                  >
                    <span>
                      {stage.active ? timeLeft(stage.endsAt, nowSeconds) : timeUntil(stage.startsAt, nowSeconds)}
                      {expandable && <span aria-hidden> {isExpanded ? "−" : "+"}</span>}
                    </span>
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[9px] uppercase tracking-[0.02em] text-quiet tabular-nums">
                  {stage.startsAt ? formatMinute(stage.startsAt) : "Start —"} →{" "}
                  {stage.endsAt && isFiniteEnd(stage.endsAt) ? formatMinute(stage.endsAt) : "open"}
                </p>
                {stage.active && isFiniteEnd(stage.endsAt) && stage.startsAt > 0 && (
                  <div className="absolute inset-x-0 bottom-0 h-px bg-faint">
                    <div
                      className="h-full bg-live motion-safe:transition-[width] motion-safe:duration-1000 motion-safe:ease-linear"
                      style={{ width: `${progressPct(stage.startsAt, stage.endsAt, nowSeconds)}%` }}
                    />
                  </div>
                )}
              </button>
              {panel}
            </div>
          );
        })}
      </div>
    </div>
  );
}


function ActivityFeed({ items, flashIds, mine }: { items: ActivityItem[]; flashIds: Set<string>; mine?: string }) {
  const [visible, setVisible] = useState(80);
  if (items.length === 0) {
    return <p className="px-4 py-6 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet sm:px-6">Quiet for now.</p>;
  }

  return (
    <div>
      {items.slice(0, visible).map((item) => {
        const isMine = Boolean(mine && item.locker && item.locker.toLowerCase() === mine.toLowerCase());
        const amount = feedAmount(item);
        return (
        <a
          key={item.id}
          href={`${EXPLORER_BASE}/tx/${item.hash}`}
          target="_blank"
          rel="noreferrer"
          className={`block border-b border-faint px-4 py-3 transition-colors hover:bg-faint sm:px-6 ${
            flashIds.has(item.id) ? "row-flash" : ""
          } ${isMine ? "border-l-2 border-l-electric" : ""}`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0 truncate font-mono text-[11px] font-semibold uppercase tracking-[0.02em] text-ink">{item.label}</p>
            {amount ? (
              <span
                className={`shrink-0 font-mono text-[12px] font-semibold tabular-nums ${
                  { live: "text-live", alert: "text-alert", ink: "text-ink", dim: "text-dim" }[amount.tone]
                }`}
              >
                {amount.text}
              </span>
            ) : (
              <span className="shrink-0 font-mono text-[10px] text-quiet" aria-hidden>
                ↗
              </span>
            )}
          </div>
          {item.detail && (
            <p className="mt-1 font-mono text-[10px] leading-5 text-dim tabular-nums">{emphasizeAddresses(item.detail)}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">
            {isMine && (
              <>
                <span className="text-electric">You</span>
                <span aria-hidden>·</span>
              </>
            )}
            {item.locker && (
              <>
                <span className="font-semibold normal-case text-ink">{shortAddress(item.locker)}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="tabular-nums" title={item.timestamp ? formatMinute(item.timestamp) : undefined}>
              {item.timestamp ? formatRelative(item.timestamp) : `Block ${item.blockNumber}`}
            </span>
          </div>
        </a>
        );
      })}
      {items.length > visible && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="font-mono text-[9px] uppercase tracking-[0.02em] text-quiet tabular-nums">
            Showing {visible} of {items.length}
          </span>
          <button
            type="button"
            onClick={() => setVisible((current) => current + 80)}
            className="border border-hairline px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink max-xl:min-h-11"
          >
            Show more
          </button>
        </div>
      )}
    </div>
  );
}

function LockerList({
  lockers,
  selectedLocker,
  onSelect,
  launchFailed,
  totalNet,
  mine,
}: {
  lockers: LockerSummary[];
  selectedLocker: string;
  onSelect: (locker: string) => void;
  launchFailed: boolean;
  totalNet: bigint;
  mine?: string;
}) {
  if (lockers.length === 0) {
    return <p className="px-4 py-6 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet sm:px-6">No lockers yet.</p>;
  }

  const totalNum = Number(ethers.formatEther(totalNet));
  // Ranks come from the net-committed order; your row is pinned on top
  // but keeps its true rank.
  const ranked = lockers.map((locker, index) => ({ locker, rank: index + 1 }));
  const mineIndex = mine ? ranked.findIndex(({ locker }) => locker.locker.toLowerCase() === mine.toLowerCase()) : -1;
  const ordered = mineIndex > 0 ? [ranked[mineIndex], ...ranked.filter((_, index) => index !== mineIndex)] : ranked;

  return (
    <div>
      {ordered.map(({ locker, rank }) => {
        const selected = selectedLocker.toLowerCase() === locker.locker.toLowerCase();
        const isMine = Boolean(mine && locker.locker.toLowerCase() === mine.toLowerCase());
        const share = totalNum > 0 ? Number(ethers.formatEther(netCommitted(locker))) / totalNum : 0;
        return (
          <button
            key={locker.locker}
            type="button"
            onClick={() => onSelect(locker.locker)}
            aria-pressed={selected}
            aria-label={`Filter activity to locker ${locker.locker}`}
            className={`group w-full border-b border-faint px-4 py-3 text-left transition-colors hover:bg-faint sm:px-6 ${
              selected ? "border-l-2 border-l-ink bg-faint" : isMine ? "border-l-2 border-l-electric" : ""
            }`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <p className="flex min-w-0 items-baseline gap-2 font-mono text-[11px]">
                <span className={`shrink-0 tabular-nums ${isMine ? "text-electric" : "text-quiet"}`}>#{rank}</span>
                <span className="truncate font-semibold text-ink">{shortAddress(locker.locker)}</span>
                {isMine && <span className="shrink-0 text-[9px] uppercase tracking-[0.02em] text-electric">You</span>}
              </p>
              {locker.settled ? (
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">
                  Settled ✓<span className="opacity-0 transition-opacity group-hover:opacity-100"> · Filter ›</span>
                </span>
              ) : launchFailed ? (
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">Refundable</span>
              ) : (
                <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.02em] text-dim">
                  <span className="h-1.5 w-1.5 rounded-full bg-live motion-safe:animate-pulse" aria-hidden />
                  Open
                </span>
              )}
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-3 font-mono uppercase tracking-[0.02em]">
              <span className="text-[10px] text-dim tabular-nums">
                {formatEth(netCommitted(locker))} Ξ · {formatTokenCompact(locker.saleTokens)} · {(share * 100).toFixed(1)}%
              </span>
              <span className="text-[9px] text-quiet">
                <span className="normal-case">{locker.owner ? shortAddress(locker.owner) : "owner unknown"}</span>
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full bg-faint">
              <div
                className={isMine ? "h-full bg-electric" : "h-full bg-dim"}
                style={{ width: `${Math.min(100, share * 100)}%` }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** One shared styled hover card for charts, bars and segments. Imperative
 *  singleton so the same handlers work on HTML divs and SVG shapes; native
 *  title/<title> stays alongside it for touch and screen readers. */
let hoverCardElement: HTMLDivElement | null = null;
function showHoverCard(event: { clientX: number; clientY: number }, text: string) {
  if (typeof document === "undefined") return;
  if (!hoverCardElement) {
    hoverCardElement = document.createElement("div");
    hoverCardElement.className =
      "pointer-events-none fixed z-50 max-w-64 border border-hairline bg-paper px-2 py-1 font-mono text-[10px] tracking-[0.02em] whitespace-nowrap text-ink tabular-nums";
    document.body.appendChild(hoverCardElement);
  }
  hoverCardElement.textContent = text;
  hoverCardElement.style.display = "block";
  const cardWidth = hoverCardElement.offsetWidth;
  hoverCardElement.style.left = `${Math.max(4, Math.min(event.clientX + 12, window.innerWidth - cardWidth - 8))}px`;
  hoverCardElement.style.top = `${event.clientY + 16}px`;
}
function hideHoverCard() {
  if (hoverCardElement) hoverCardElement.style.display = "none";
}
/** Spreadable handlers: `{...hoverCard("R2 · 0.5 Ξ")}`. Mouse follows the
 *  pointer; touch shows the card at the tap point and auto-hides — charts
 *  keep a data readout on phones where hover doesn't exist. */
let hoverCardHideTimer = 0;
function hoverCard(text: string) {
  return {
    onMouseMove: (event: { clientX: number; clientY: number }) => showHoverCard(event, text),
    onMouseLeave: hideHoverCard,
    onTouchStart: (event: { touches: ArrayLike<{ clientX: number; clientY: number }> }) => {
      const touch = event.touches[0];
      if (!touch) return;
      showHoverCard(touch, text);
      window.clearTimeout(hoverCardHideTimer);
      hoverCardHideTimer = window.setTimeout(hideHoverCard, 2500);
    },
  };
}

/** EoW-style ramp — largest holders boldest. CSS vars so the light theme
 *  inverts it (bright-on-black → dark-on-cream); see globals.css. */
const holderRampColor = (index: number) => `var(--holder-${Math.min(index, 10)})`;

function HolderBar({ lockers, total, mine }: { lockers: LockerSummary[]; total: bigint; mine?: string }) {
  const totalNum = Number(ethers.formatEther(total));
  if (!(totalNum > 0)) return null;
  const sorted = [...lockers].sort((a, b) =>
    netCommitted(b) > netCommitted(a) ? 1 : netCommitted(b) < netCommitted(a) ? -1 : 0
  );
  const top = sorted
    .slice(0, 10)
    .map((entry) => ({
      locker: entry.locker,
      share: Number(ethers.formatEther(netCommitted(entry))) / totalNum,
    }))
    .filter((segment) => segment.share > 0.0005);
  // Your slice must always be visible, even outside the top 10.
  if (mine && !top.some((segment) => segment.locker.toLowerCase() === mine.toLowerCase())) {
    const mineEntry = sorted.find((entry) => entry.locker.toLowerCase() === mine.toLowerCase());
    if (mineEntry && netCommitted(mineEntry) > 0n) {
      top.push({ locker: mineEntry.locker, share: Number(ethers.formatEther(netCommitted(mineEntry))) / totalNum });
    }
  }
  if (top.length === 0) return null;
  const topShare = top.reduce((sum, segment) => sum + segment.share, 0);
  const rest = Math.max(0, 1 - topShare);
  return (
    <div>
      <p className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
        <span>Concentration</span>
        <span className="text-dim tabular-nums">
          Top {top.length} hold {Math.round(topShare * 100)}%
        </span>
      </p>
      <div className="mt-2 flex h-2 w-full gap-px overflow-hidden" role="img" aria-label={`Top ${top.length} lockers hold ${Math.round(topShare * 100)} percent of the raise`}>
        {top.map((segment, index) => {
          const isMine = Boolean(mine && segment.locker.toLowerCase() === mine.toLowerCase());
          const label = `${isMine ? "You · " : `#${index + 1} · `}${shortAddress(segment.locker)} · ${(segment.share * 100).toFixed(1)}% of raise`;
          return (
            <div
              key={segment.locker}
              title={label}
              {...hoverCard(label)}
              className={isMine ? "bg-electric" : undefined}
              style={{
                width: `${segment.share * 100}%`,
                ...(isMine ? {} : { backgroundColor: holderRampColor(index) }),
              }}
            />
          );
        })}
        {rest > 0.002 && (
          <div
            className="bg-faint"
            style={{ width: `${rest * 100}%` }}
            title={`Others · ${(rest * 100).toFixed(1)}%`}
            {...hoverCard(`Everyone else · ${(rest * 100).toFixed(1)}% of raise`)}
          />
        )}
      </div>
    </div>
  );
}

/** Value of a step series at time t — the last point at or before t. */
function stepValueAt(points: { t: number; v: number }[], t: number): number {
  let value = 0;
  for (const point of points) {
    if (point.t > t) break;
    value = point.v;
  }
  return value;
}

function stepPath(
  series: { t: number; v: number }[],
  x: (t: number) => number,
  y: (v: number) => number,
  endX: number
): string {
  if (series.length === 0) return "";
  let path = `M ${x(series[0].t).toFixed(1)} ${y(0).toFixed(1)}`;
  let previousY = y(0);
  for (const point of series) {
    path += ` L ${x(point.t).toFixed(1)} ${previousY.toFixed(1)} L ${x(point.t).toFixed(1)} ${y(point.v).toFixed(1)}`;
    previousY = y(point.v);
  }
  path += ` L ${endX.toFixed(1)} ${previousY.toFixed(1)}`;
  return path;
}

function CommittedChart({
  series,
  rounds,
  mineSeries = [],
}: {
  series: { t: number; v: number }[];
  rounds: RoundTerm[];
  mineSeries?: { t: number; v: number }[];
}) {
  const currency = useCurrency();
  if (series.length === 0) {
    return <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">No commits yet.</p>;
  }
  const width = 320;
  const height = 80;
  const pad = 4;
  const t0 = series[0].t;
  const t1 = Math.max(series[series.length - 1].t, t0 + 1);
  const vMax = Math.max(...series.map((point) => point.v), 0.0001);
  const x = (t: number) => pad + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (width - pad * 2);
  const y = (v: number) => height - pad - (v / vMax) * (height - pad * 2);
  const path = stepPath(series, x, y, width - pad);
  const minePath = mineSeries.length > 0 ? stepPath(mineSeries, x, y, width - pad) : "";
  const last = series[series.length - 1];
  const roundMarks = rounds.filter((round) => round.startAt > t0 && round.startAt < t1);
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-20 w-full"
        role="img"
        aria-label={`Total committed over time, currently ${trimDecimals(last.v.toFixed(4), 4)} ETH`}
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={pad}
            x2={width - pad}
            y1={pad + fraction * (height - pad * 2)}
            y2={pad + fraction * (height - pad * 2)}
            className="stroke-faint"
            strokeWidth="1"
          />
        ))}
        {roundMarks.map((round) => (
          <line
            key={round.id}
            x1={x(round.startAt)}
            x2={x(round.startAt)}
            y1={pad}
            y2={height - pad}
            className="stroke-hairline"
            strokeWidth="1"
            strokeDasharray="2 3"
          />
        ))}
        <path d={path} fill="none" className="stroke-ink" strokeWidth="1.5" />
        {minePath && <path d={minePath} fill="none" className="stroke-electric" strokeWidth="1" />}
        <circle cx={x(last.t)} cy={y(last.v)} r="2.5" className="fill-live" />
        {/* Full-width scrub: the card follows the cursor and reads the
            step value (and your overlay) at that moment. */}
        <rect
          x={pad}
          y={0}
          width={width - pad * 2}
          height={height}
          fill="transparent"
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const frac = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
            const t = Math.round(t0 + frac * (t1 - t0));
            const total = stepValueAt(series, t);
            const mineValue = mineSeries.length > 0 ? stepValueAt(mineSeries, t) : null;
            showHoverCard(
              event,
              `${formatMinute(t)} · ${fmtAmount(total, currency)} committed${
                mineValue !== null && mineValue > 0 ? ` · you ${fmtAmount(mineValue, currency)}` : ""
              }`
            );
          }}
          onMouseLeave={hideHoverCard}
        />
      </svg>
      <p className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.02em] text-quiet tabular-nums">
        <span>{formatMinute(t0)}</span>
        <span className="text-dim">{fmtAmount(last.v, currency)}</span>
      </p>
    </div>
  );
}

function RoundVolumeChart({
  volumes,
  activeRound,
}: {
  volumes: { commit: number; refund: number }[];
  activeRound: number | null;
}) {
  const max = Math.max(...volumes.map((volume) => Math.max(volume.commit, volume.refund)), 0.0001);
  const hasAny = volumes.some((volume) => volume.commit > 0 || volume.refund > 0);
  if (!hasAny) {
    return <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">No volume yet.</p>;
  }
  const summary = volumes
    .map((volume, index) => `round ${index + 1}: ${trimDecimals(volume.commit.toFixed(4), 4)} committed, ${trimDecimals(volume.refund.toFixed(4), 4)} refunded`)
    .join("; ");
  return (
    <div
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${volumes.length}, minmax(0, 1fr))` }}
      role="img"
      aria-label={`Volume per round in ETH — ${summary}`}
    >
      {volumes.map((volume, index) => (
        <div key={index} className="min-w-0">
          <div className="flex h-20 items-end justify-center gap-px border-b border-hairline pb-px">
            <div
              className={index === activeRound ? "w-2 bg-live" : "w-2 bg-live/55"}
              style={{ height: `${volume.commit > 0 ? Math.max(2, (volume.commit / max) * 72) : 0}px` }}
              title={`Round ${index + 1} commits · ${trimDecimals(volume.commit.toFixed(4), 4)} ETH`}
              {...hoverCard(`R${index + 1} commits · ${trimDecimals(volume.commit.toFixed(4), 4)} ETH`)}
            />
            <div
              className={volume.refund > 0 ? "w-2 border border-alert/80 bg-transparent" : "w-2"}
              style={{ height: `${volume.refund > 0 ? Math.max(3, (volume.refund / max) * 72) : 0}px` }}
              title={`Round ${index + 1} refunds · ${trimDecimals(volume.refund.toFixed(4), 4)} ETH`}
              {...hoverCard(`R${index + 1} refunds · ${trimDecimals(volume.refund.toFixed(4), 4)} ETH`)}
            />
          </div>
          <p className="mt-1 text-center font-mono text-[9px] text-dim tabular-nums">
            {volume.commit > 0 ? trimDecimals(volume.commit.toFixed(2), 2) : "—"}
          </p>
          <p className="text-center font-mono text-[9px] uppercase text-quiet">R{index + 1}</p>
        </div>
      ))}
    </div>
  );
}

function PriceChart({ market, rounds }: { market: RoundMarket[]; rounds: RoundTerm[] }) {
  const levels = market
    .map((entry, index) => ({
      round: index,
      price: entry.hasPrice ? Number(entry.priceWeth) : 0,
      start: rounds[index]?.startAt ?? 0,
      end: rounds[index]?.endAt ?? 0,
    }))
    .filter((level) => level.price > 0 && level.start > 0 && level.end > level.start);
  if (levels.length === 0) {
    return <p className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">No price discovered yet.</p>;
  }
  const width = 320;
  const height = 80;
  const pad = 4;
  const t0 = levels[0].start;
  const t1 = Math.max(levels[levels.length - 1].end, t0 + 1);
  const vMax = Math.max(...levels.map((level) => level.price)) * 1.08;
  const x = (t: number) => pad + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (width - pad * 2);
  const y = (value: number) => height - pad - (value / vMax) * (height - pad * 2);
  // Ladder: each discovered price holds flat across its round's span, and
  // the vertical step to the next level lands on the next round's start —
  // exchange-style levels instead of a per-event sawtooth.
  const steps = levels.map((level, index) => ({
    ...level,
    x1: x(level.start),
    x2: x(index < levels.length - 1 ? levels[index + 1].start : level.end),
    delta: index > 0 ? ((level.price - levels[index - 1].price) / levels[index - 1].price) * 100 : null,
  }));
  let path = "";
  steps.forEach((step, index) => {
    path += `${index === 0 ? "M" : " L"} ${step.x1.toFixed(1)} ${y(step.price).toFixed(1)}`;
    path += ` L ${step.x2.toFixed(1)} ${y(step.price).toFixed(1)}`;
  });
  const last = steps[steps.length - 1];
  const stepLabel = (step: (typeof steps)[number]) => {
    const deltaText =
      step.delta === null
        ? ""
        : ` · ${step.delta >= 0 ? "+" : "−"}${Math.abs(step.delta) >= 10 ? Math.abs(step.delta).toFixed(0) : Math.abs(step.delta).toFixed(1)}% vs R${step.round}`;
    return `R${step.round + 1} · ${formatCryptoPrice(step.price)} ETH${deltaText}`;
  };
  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-20 w-full"
        role="img"
        aria-label={`Discovered price ladder per round, latest ${formatCryptoPrice(last.price)} ETH`}
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={pad}
            x2={width - pad}
            y1={pad + fraction * (height - pad * 2)}
            y2={pad + fraction * (height - pad * 2)}
            className="stroke-faint"
            strokeWidth="1"
          />
        ))}
        <path d={path} fill="none" className="stroke-live" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        {steps.map((step) => (
          <g key={step.round}>
            {step.round !== last.round && <circle cx={step.x1} cy={y(step.price)} r="2" className="fill-ink" />}
            <rect
              x={step.x1}
              y={pad}
              width={Math.max(step.x2 - step.x1, 6)}
              height={height - pad * 2}
              fill="transparent"
              {...hoverCard(stepLabel(step))}
            >
              <title>{stepLabel(step)}</title>
            </rect>
          </g>
        ))}
        <circle cx={last.x2} cy={y(last.price)} r="3" className="pointer-events-none fill-live" />
      </svg>
      <p className="mt-1 flex justify-between font-mono text-[10px] uppercase tracking-[0.02em] text-quiet tabular-nums">
        <span>{formatMinute(t0)}</span>
        <span className="text-dim">{formatCryptoPrice(last.price)} ETH</span>
      </p>
    </div>
  );
}

function LedgerAction({
  label,
  value,
  unit,
  onChange,
  onAction,
  action,
  disabled,
  max,
}: {
  label: string;
  value: string;
  unit: string;
  onChange: (value: string) => void;
  onAction: () => void;
  action: string;
  disabled: boolean;
  max?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-faint py-2.5 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">{label}</span>
      <span className="grid grid-cols-[auto_6rem_3.75rem_5.5rem] items-center gap-2">
        {max !== undefined && Number(max) > 0 ? (
          <button
            type="button"
            onClick={() => onChange(max)}
            disabled={disabled}
            className="text-right font-mono text-[10px] uppercase tracking-[0.02em] text-dim transition-colors hover:text-ink disabled:text-quiet tabular-nums max-xl:min-h-11"
            title={`Indexed available ≈ ${max} ${unit} — the chain is the source of truth if the indexer lags`}
          >
            Max {trimDecimals(max, 6)}
          </button>
        ) : (
          <span aria-hidden />
        )}
        <Input
          inputMode="decimal"
          pattern="[0-9]*[.]?[0-9]*"
          value={value}
          placeholder="0.0"
          onChange={(event) => onChange(event.target.value)}
          className="w-full tabular-nums"
          aria-label={`${label} amount in ${unit}`}
        />
        <span className="font-mono text-[10px] uppercase text-dim">{unit}</span>
        <Button size="sm" variant="secondary" className="w-full" onClick={onAction} disabled={disabled || !(Number(value) > 0)}>
          {action}
        </Button>
      </span>
    </div>
  );
}

function Metric({
  label,
  value,
  sub,
  loaded = true,
}: {
  label: string;
  value: string;
  sub?: string;
  loaded?: boolean;
}) {
  return (
    <div className="min-w-0 border border-hairline px-3 py-2.5">
      <p className="font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">{label}</p>
      <p
        className="mt-1 font-mono text-[13px] text-ink tabular-nums [overflow-wrap:anywhere] sm:truncate"
        title={loaded ? value : undefined}
      >
        {loaded ? value : "—"}
      </p>
      {loaded && sub ? <p className="mt-0.5 font-mono text-[9px] text-quiet tabular-nums">{sub}</p> : null}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  explorerValue,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  explorerValue?: string;
}) {
  const hasExplorerAddress = explorerValue && ethers.isAddress(explorerValue);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <Label className="font-mono text-[9px] uppercase tracking-[0.02em] text-quiet">{label}</Label>
        {hasExplorerAddress && <ExplorerLink label="Etherscan" address={explorerValue} />}
      </div>
      <Input value={value} onChange={(event) => onChange(event.target.value)} className="mt-2" placeholder="0x…" />
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const displayValue = value.startsWith("0x") && value.length > 18 ? shortHash(value) : value;
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-faint py-2 last:border-b-0">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">{label}</span>
      <button
        type="button"
        title={value}
        aria-label={`Copy ${label}`}
        className="inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-ink transition-colors hover:text-dim max-xl:min-h-11"
        onClick={() => copyText(value)}
      >
        <span className="truncate">{displayValue}</span>
        <Copy className="h-3 w-3 shrink-0 text-quiet" aria-hidden />
      </button>
    </div>
  );
}

function AddressLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-faint py-2 last:border-b-0">
      <span className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">{label}</span>
      {value && ethers.isAddress(value) ? (
        <span className="flex shrink-0 items-center gap-2.5">
          <button
            type="button"
            title={`Copy ${value}`}
            aria-label={`Copy ${label} address ${value}`}
            className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] text-ink transition-colors hover:text-dim max-xl:min-h-11"
            onClick={() => copyText(value)}
          >
            {shortAddress(value)}
            <Copy className="h-3 w-3 text-quiet" aria-hidden />
          </button>
          <a
            className="-my-1 flex h-6 w-6 items-center justify-center font-mono text-[11px] text-quiet transition-colors hover:text-ink max-xl:h-11 max-xl:w-11 max-xl:-my-2.5 max-xl:-mr-2.5"
            title="Open in explorer"
            aria-label={`Open ${label} in explorer`}
            href={`${EXPLORER_BASE}/address/${value}`}
            target="_blank"
            rel="noreferrer"
          >
            ↗
          </a>
        </span>
      ) : (
        <span className="font-mono text-[11px] text-quiet">—</span>
      )}
    </div>
  );
}

function ExplorerLink({ label, address }: { label: string; address: string }) {
  return (
    <a
      aria-label={`Open ${label || "address"} in explorer`}
      title="Open in explorer"
      className="-m-1.5 inline-flex items-center gap-1 p-1.5 font-mono text-[9px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink max-xl:min-h-11"
      href={`${EXPLORER_BASE}/address/${address}`}
      target="_blank"
      rel="noreferrer"
    >
      {label ? <span>{label}</span> : null}
      <span aria-hidden>↗</span>
    </a>
  );
}

async function contractWithProvider(name: string, address: string, provider: ethers.Provider) {
  const abi = await loadAbi(name);
  return new ethers.Contract(ethers.getAddress(address), abi, provider);
}

async function contractWithSigner(name: string, address: string, signer: ethers.Signer) {
  const abi = await loadAbi(name);
  return new ethers.Contract(ethers.getAddress(address), abi, signer);
}

async function loadAbi(name: string) {
  const response = await fetch(`/abi/${name}.abi.json`);
  if (!response.ok) throw new Error(`Missing ${name} ABI in public/abi`);
  return await response.json() as ethers.InterfaceAbi;
}

function readProvider() {
  return new ethers.JsonRpcProvider(READ_RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
}

async function assertChain(provider: ethers.BrowserProvider) {
  const network = await provider.getNetwork();
  if (network.chainId !== CHAIN_ID_BIG) {
    throw new Error(`Switch your wallet to ${CHAIN_NAME} (chain ${CHAIN_ID}).`);
  }
}

async function waitForTx(tx: ethers.ContractTransactionResponse, label: string) {
  toast("Transaction submitted", {
    description: `${label}: ${tx.hash}`,
    icon: <span className="font-mono text-[12px] text-ink">→</span>,
  });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} reverted`);
  return receipt;
}

function parseLockerCreated(factory: ethers.Contract, receipt: ethers.TransactionReceipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "LockerCreated") {
        return ethers.getAddress(parsed.args.locker as string);
      }
    } catch {
      continue;
    }
  }

  throw new Error("LockerCreated event was not found in the transaction receipt.");
}

function toPositionSnapshot(raw: ethers.Result | null, lockedWeth: bigint, withdrawableWeth: bigint): PositionSnapshot {
  if (!raw) {
    return {
      known: false,
      lockedWeth: formatEth(lockedWeth),
      withdrawableWeth: formatEth(withdrawableWeth),
      withdrawableWethExact: ethers.formatEther(withdrawableWeth),
      residualWeth: "0",
      withdrawableTokens: "0",
      withdrawableTokensExact: "0",
      claimedSaleTokens: "0",
      liquiditySettled: false,
      liquidityVault: "",
      wethSentToVault: "0",
      treasuryWeth: "0",
      protocolFeeWeth: "0",
      finalSaleTokensClaimed: false,
    };
  }

  return {
    // Named fields: the V15 locker struct inserted protocolFeeWeth after treasuryWeth.
    known: Boolean(raw.known),
    lockedWeth: formatEth(lockedWeth),
    withdrawableWeth: formatEth(withdrawableWeth),
    withdrawableWethExact: ethers.formatEther(withdrawableWeth),
    residualWeth: formatEth(raw.residualWeth as bigint),
    withdrawableTokens: formatToken(raw.withdrawableTokens as bigint),
    withdrawableTokensExact: ethers.formatUnits(raw.withdrawableTokens as bigint, 18),
    claimedSaleTokens: formatToken(raw.claimedSaleTokens as bigint),
    liquiditySettled: Boolean(raw.liquiditySettled),
    liquidityVault: raw.liquidityVault as string,
    wethSentToVault: formatEth(raw.wethSentToVault as bigint),
    treasuryWeth: formatEth(raw.treasuryWeth as bigint),
    protocolFeeWeth: formatEth(raw.protocolFeeWeth as bigint),
    finalSaleTokensClaimed: Boolean(raw.finalSaleTokensClaimed),
  };
}

function formatSettlementStatus(position: PositionSnapshot | null) {
  if (!position?.known) return "No position";
  if (!position.liquiditySettled) return "Not settled";
  return "Vault settled";
}

function requireAddress(value: string, label: string) {
  if (!ethers.isAddress(value)) throw new Error(`${label} is not a valid address.`);
}

/** The phase the launch was in at a given moment, from the round schedule
 *  alone. Serves replay checkpoints, which never land in odd gaps. */
function phaseAtTime(cutoff: number, rounds: RoundTerm[]): PhaseSnapshot {
  const scheduled = rounds.filter((round) => round.startAt > 0 && round.endAt > round.startAt);
  if (scheduled.length === 0 || cutoff < scheduled[0].startAt) {
    const startsAt = scheduled[0]?.startAt ?? 0;
    return { phaseKind: PHASE.NOT_STARTED, index: 0, startsAt, endsAt: startsAt };
  }
  let lastEnd = scheduled[0].startAt;
  for (let index = 0; index < rounds.length; index++) {
    const round = rounds[index];
    if (!(round.startAt > 0 && round.endAt > round.startAt)) continue;
    if (cutoff < round.endAt) return { phaseKind: PHASE.ROUND_OPEN, index, startsAt: round.startAt, endsAt: round.endAt };
    if (round.refundEndAt > round.refundStartAt && cutoff < round.refundEndAt)
      return { phaseKind: PHASE.REFUND_OPEN, index, startsAt: round.refundStartAt, endsAt: round.refundEndAt };
    lastEnd = Math.max(round.endAt, round.refundEndAt, lastEnd);
  }
  return {
    phaseKind: PHASE.SETTLEMENT_OPEN,
    index: Math.max(0, rounds.length - 1),
    startsAt: lastEnd,
    endsAt: Number.MAX_SAFE_INTEGER,
  };
}

function describePhase(phase: PhaseSnapshot) {
  if (phase.phaseKind === PHASE.NOT_STARTED) return "Not started";
  if (phase.phaseKind === PHASE.ROUND_OPEN) return `Round ${phase.index + 1} open`;
  if (phase.phaseKind === PHASE.REFUND_OPEN) return `Round ${phase.index + 1} refund`;
  if (phase.phaseKind === PHASE.READY_TO_FINALIZE) return "Ready to finalize";
  if (phase.phaseKind === PHASE.SETTLEMENT_OPEN) return "Settlement · claim window open";
  if (phase.phaseKind === PHASE.POOL_READY) return "Pool ready";
  if (phase.phaseKind === PHASE.TRADING_OPEN) return "Trading open";
  if (phase.phaseKind === PHASE.FAILED) return "Launch failed";
  return "Unknown";
}

function phaseMeta(phase: PhaseSnapshot, rounds: RoundTerm[], nowSeconds: number): string[] {
  const parts: string[] = [];
  if (phase.phaseKind === PHASE.ROUND_OPEN || phase.phaseKind === PHASE.REFUND_OPEN) {
    // Terms (allocation, refund cost) live on the round chips — the banner
    // meta carries only the countdown.
    if (isFiniteEnd(phase.endsAt)) parts.push(timeLeft(phase.endsAt, nowSeconds));
  } else if (phase.phaseKind === PHASE.SETTLEMENT_OPEN) {
    if (isFiniteEnd(phase.endsAt)) parts.push(`${timeLeft(phase.endsAt, nowSeconds)} until the pool can open`);
    parts.push("Settle to claim your tokens now");
  } else if (phase.phaseKind === PHASE.TRADING_OPEN) {
    parts.push("Official pool live");
  } else if (phase.phaseKind === PHASE.NOT_STARTED) {
    if (phase.startsAt > 0) {
      parts.push(nowSeconds >= phase.startsAt ? "Round 1 opening" : `Round 1 in ${timeUntil(phase.startsAt, nowSeconds)}`);
    }
  } else if (phase.phaseKind === PHASE.FAILED) {
    parts.push("Committed WETH is refundable");
  } else if (phase.phaseKind === PHASE.READY_TO_FINALIZE) {
    parts.push("Sale rounds complete");
  } else if (phase.phaseKind === PHASE.POOL_READY) {
    parts.push("Settlement window ended — the pool can be created");
  }
  return parts.length > 0 ? parts : ["Live from launch contract"];
}

function phaseActionHint(
  phase: PhaseSnapshot,
  caps: { hasLocker: boolean; canSettleAndClaim: boolean; canWithdrawTokens: boolean; lockerSettled: boolean }
) {
  if (phase.phaseKind === PHASE.NOT_STARTED) return "Waiting for round 1 to open";
  if (phase.phaseKind === PHASE.ROUND_OPEN) return `You can commit ETH to round ${phase.index + 1}`;
  if (phase.phaseKind === PHASE.REFUND_OPEN) return `You can refund round ${phase.index + 1} commitments`;
  if (phase.phaseKind === PHASE.READY_TO_FINALIZE) return "Anyone can finalize the launch";
  if (phase.phaseKind === PHASE.SETTLEMENT_OPEN) {
    if (caps.canSettleAndClaim) return "You can settle and claim sale tokens";
    if (caps.lockerSettled) return "Your locker is already settled";
    if (!caps.hasLocker) return "Set your locker address to settle and claim";
    return "Participants with positions can settle and claim";
  }
  if (phase.phaseKind === PHASE.POOL_READY) {
    return caps.canSettleAndClaim ? "You can settle after the claim window" : "Awaiting official pool creation";
  }
  if (phase.phaseKind === PHASE.TRADING_OPEN) {
    return caps.canWithdrawTokens ? "You can withdraw unlocked sale tokens" : "Trading is live on the official pool";
  }
  if (phase.phaseKind === PHASE.FAILED) return "You can withdraw your failed-launch refund";
  return "";
}

function buildTimelineStages(phase: PhaseSnapshot | null, rounds: RoundTerm[], nowSeconds: number): TimelineStage[] {
  const stages: TimelineStage[] = [];
  for (const round of rounds) {
    const roundIndex = round.id - 1;
    stages.push({
      id: `round-${round.id}`,
      title: `Round ${round.id}`,
      subtitle: `${round.allocationPct}% allocation`,
      startsAt: round.startAt,
      endsAt: round.endAt,
      active: phase?.phaseKind === PHASE.ROUND_OPEN && phase.index === roundIndex,
      done: round.endAt > 0 && nowSeconds >= round.endAt,
    });
    if (roundHasRefundWindow(round, roundIndex)) {
      stages.push({
        id: `refund-${round.id}`,
        title: `Round ${round.id} refund`,
        subtitle: round.deflectionCostPct > 0 ? `${round.deflectionCostPct}% refund cost` : "Free refund",
        startsAt: round.refundStartAt,
        endsAt: round.refundEndAt,
        active: phase?.phaseKind === PHASE.REFUND_OPEN && phase.index === roundIndex,
        done: round.refundEndAt > 0 && nowSeconds >= round.refundEndAt,
      });
    }
  }

  if (phase?.phaseKind === PHASE.FAILED) {
    // The configured schedule remains useful history even when the anchor
    // fails. Keep every round/refund row and mark the stages that never opened.
    const failedAt = phase.startsAt > 0 ? phase.startsAt : nowSeconds;
    const happened = stages.filter((stage) => stage.startsAt > 0 && stage.startsAt < failedAt);
    const skipped = stages
      .filter((stage) => !happened.includes(stage))
      .map((stage) => ({ ...stage, active: false, done: false, skipped: true, subtitle: `${stage.subtitle} · Did not open` }));
    const failedStage: TimelineStage = {
      id: "failed",
      title: "Launch failed",
      subtitle: "Committed WETH is refundable from your locker",
      startsAt: phase.startsAt,
      endsAt: 0,
      active: true,
      done: false,
      failed: true,
    };
    return [...happened, failedStage, ...skipped];
  }

  const finalRound = rounds[ROUND_COUNT - 1];
  stages.push({
    id: "finalize",
    title: "Finalize",
    subtitle: "Anyone can finalize after the sale",
    startsAt: finalRound?.endAt || 0,
    endsAt: phase?.phaseKind === PHASE.READY_TO_FINALIZE ? phase.endsAt : 0,
    active: phase?.phaseKind === PHASE.READY_TO_FINALIZE,
    done: Boolean(phase && phase.phaseKind > PHASE.READY_TO_FINALIZE),
  });
  stages.push({
    id: "settlement",
    title: "Settlement · claim window",
    subtitle: "Settle to claim tokens — the pool can open after this window",
    startsAt: phase?.phaseKind === PHASE.SETTLEMENT_OPEN ? phase.startsAt : 0,
    endsAt: phase?.phaseKind === PHASE.SETTLEMENT_OPEN ? phase.endsAt : 0,
    active: phase?.phaseKind === PHASE.SETTLEMENT_OPEN,
    done: Boolean(phase && phase.phaseKind > PHASE.SETTLEMENT_OPEN),
  });
  stages.push({
    id: "pool-ready",
    title: "Pool ready",
    subtitle: "After grace, public settlement/pool creation can happen",
    startsAt: phase?.phaseKind === PHASE.POOL_READY ? phase.startsAt : 0,
    endsAt: 0,
    active: phase?.phaseKind === PHASE.POOL_READY,
    done: Boolean(phase && phase.phaseKind > PHASE.POOL_READY),
  });
  stages.push({
    id: "trading",
    title: "Trading open",
    subtitle: "Official pool exists",
    startsAt: phase?.phaseKind === PHASE.TRADING_OPEN ? phase.startsAt : 0,
    endsAt: 0,
    active: phase?.phaseKind === PHASE.TRADING_OPEN,
    done: false,
  });
  return stages;
}

async function queryContractLogs(provider: ethers.Provider, contract: ethers.Contract, eventNames: string[], fromBlock: number, toBlock: number) {
  const logs: any[] = [];
  const address = await contract.getAddress();
  const wanted = new Set(eventNames);
  for (let start = fromBlock; start <= toBlock; start += EVENT_CHUNK_SIZE) {
    const end = Math.min(toBlock, start + EVENT_CHUNK_SIZE - 1);
    const chunk = await provider.getLogs({ address, fromBlock: start, toBlock: end });
    for (const log of chunk) {
      try {
        const parsed = contract.interface.parseLog(log);
        if (!parsed || !wanted.has(parsed.name)) continue;
        logs.push({
          ...log,
          args: parsed.args,
          fragment: parsed.fragment,
          eventName: parsed.name,
          transactionHash: log.transactionHash,
          blockNumber: log.blockNumber,
          logIndex: log.index,
        });
      } catch {
        continue;
      }
    }
  }
  return logs;
}

async function loadBlockTimes(provider: ethers.Provider, events: any[]) {
  const uniqueBlocks = Array.from(new Set(events.map((event) => event.blockNumber))).slice(0, 400);
  const entries = await Promise.all(uniqueBlocks.map(async (blockNumber) => {
    const block = await provider.getBlock(blockNumber).catch(() => null);
    return [blockNumber, block ? Number(block.timestamp) : undefined] as const;
  }));
  return new Map(entries.filter(([, timestamp]) => Boolean(timestamp)) as [number, number][]);
}

function toActivityItem(event: any, timestamp?: number): ActivityItem {
  const name = event.fragment?.name || event.eventName || "Event";
  const args = event.args || {};
  const locker = normalizeMaybeAddress(args.locker);
  const round = args.round !== undefined ? Number(args.round) : args.refundRound !== undefined ? Number(args.refundRound) : undefined;
  const base = {
    id: `${event.transactionHash}-${event.logIndex}`,
    event: name,
    locker,
    round,
    hash: event.transactionHash,
    blockNumber: event.blockNumber,
    logIndex: event.logIndex,
    timestamp,
  };

  if (name === "RoundCommitted") {
    return {
      ...base,
      label: `Round ${(round ?? 0) + 1} commit`,
      // No detail line: the footer already carries the bold locker address.
      detail: "",
      amountWeth: formatEth(args.amount as bigint),
    };
  }
  if (name === "RoundRefunded") {
    return {
      ...base,
      label: `Round ${(round ?? 0) + 1} refund`,
      detail: `refund cost ${formatEth(args.penaltyWeth as bigint)} ETH`,
      amountWeth: formatEth(args.refundWeth as bigint),
      penaltyWeth: formatEth(args.penaltyWeth as bigint),
    };
  }
  if (name === "VaultSettlementClaimed") {
    return {
      ...base,
      label: "Locker settled",
      detail: `${formatEth(args.wethForVault as bigint)} ETH sent to vault`,
      amountWeth: formatEth(args.wethForVault as bigint),
      amountToken: formatToken(args.saleTokens as bigint),
    };
  }
  if (name === "LateVaultSettlementClaimed") {
    return {
      ...base,
      label: "Locker settled · late",
      detail: `${formatEth(args.wethForVault as bigint)} ETH sent to vault`,
      amountWeth: formatEth(args.wethForVault as bigint),
      amountToken: formatToken(args.saleTokens as bigint),
    };
  }
  if (name === "LateLiquidityAdded") {
    return {
      ...base,
      label: "Late liquidity added",
      detail: `${formatEth(args.wethUsed as bigint)} ETH added to the pool`,
      amountWeth: formatEth(args.wethUsed as bigint),
      amountToken: formatToken(args.tokenUsed as bigint),
    };
  }
  if (name === "VaultLiquidityTokensClaimed") {
    return {
      ...base,
      label: "Vault liquidity claimed",
      detail: `${formatToken(args.liquidityTokens as bigint)} tokens and ${formatEth(args.wethForPool as bigint)} ETH prepared for pool`,
      amountWeth: formatEth(args.wethForPool as bigint),
      amountToken: formatToken(args.liquidityTokens as bigint),
    };
  }
  if (name === "OfficialPoolCreated" || name === "LiquidityPoolCreated") {
    const pair = normalizeMaybeAddress(args.pair);
    return {
      ...base,
      label: "Official pool created",
      detail: `${pair ? shortAddress(pair) : "Pool"} with ${formatToken(args.tokenUsed || args.tokenUsedForLp || 0n)} tokens and ${formatEth(args.wethUsed || args.wethUsedForLp || 0n)} ETH`,
      locker: undefined,
    };
  }
  if (name === "Finalized") {
    return {
      ...base,
      label: "Launch finalized",
      detail: `Finalized at ${args.finalizedAt ? formatMinute(Number(args.finalizedAt)) : "final sale close"}`,
      locker: undefined,
    };
  }
  if (name === "LaunchFailedRefunded") {
    return {
      ...base,
      label: "Failed launch refund",
      detail: `${formatEth(args.refundWeth as bigint)} ETH refunded`,
      amountWeth: formatEth(args.refundWeth as bigint),
    };
  }
  if (name === "UnsoldSaleTokensBurned") {
    return {
      ...base,
      label: "Unsold tokens burned",
      detail: `${formatToken(args.amount as bigint)} unsold sale tokens burned`,
      amountToken: formatToken(args.amount as bigint),
      locker: undefined,
    };
  }
  if (name === "UnsoldSaleTokensPaid") {
    const recipient = normalizeMaybeAddress(args.recipient);
    return {
      ...base,
      label: "Unsold tokens paid to treasury",
      detail: `${formatToken(args.amount as bigint)} unsold sale tokens paid${recipient ? ` to ${shortAddress(recipient)}` : ""}`,
      amountToken: formatToken(args.amount as bigint),
      recipient,
      locker: undefined,
    };
  }
  return {
    ...base,
    label: humanizeEventName(name),
    detail: `Block ${event.blockNumber}, log ${event.logIndex}`,
  };
}

/**
 * Map an indexed-API activity item to the app's ActivityItem — the same
 * shape toActivityItem produces from an on-chain event, so the feed and the
 * pure aggregateLockerSummaries() work identically in api mode. The backend
 * carries generic amountWeth/amountToken/penaltyWeth in base units (wei);
 * convert to the app's decimal-string convention so parseEther/parseUnits
 * round-trip in aggregation (the never-parse-a-compacted-number rule).
 */
function apiToActivityItem(item: ApiActivityItem): ActivityItem {
  const name = item.eventName;
  const locker = item.locker && ethers.isAddress(item.locker) ? ethers.getAddress(item.locker) : undefined;
  const round =
    item.roundIndex !== null && item.roundIndex !== undefined && item.roundIndex !== ""
      ? Number(item.roundIndex)
      : undefined;
  const weth = item.amountWeth != null && item.amountWeth !== "" ? formatEth(BigInt(item.amountWeth)) : undefined;
  const token = item.amountToken != null && item.amountToken !== "" ? formatToken(BigInt(item.amountToken)) : undefined;
  const penalty = item.penaltyWeth != null && item.penaltyWeth !== "" ? formatEth(BigInt(item.penaltyWeth)) : undefined;
  const genericTokenAmount = item.args?.amount !== undefined && item.args.amount !== null
    ? formatToken(toWei(item.args.amount))
    : undefined;
  const recipient = normalizeMaybeAddress(item.args?.recipient);
  const base = {
    id: item.id,
    event: name,
    sourceKind: item.sourceKind,
    locker,
    round,
    hash: item.txHash,
    blockNumber: item.blockNumber,
    logIndex: item.logIndex,
    timestamp: item.timestamp,
  };
  switch (name) {
    case "RoundCommitted":
      return { ...base, label: `Round ${(round ?? 0) + 1} commit`, detail: "", amountWeth: weth };
    case "RoundRefunded":
      return {
        ...base,
        label: `Round ${(round ?? 0) + 1} refund`,
        detail: penalty ? `refund cost ${penalty} ETH` : "",
        amountWeth: weth,
        penaltyWeth: penalty,
      };
    case "VaultSettlementClaimed":
    case "VaultSettlementCompleted":
      return {
        ...base,
        label: "Locker settled",
        detail: weth ? `${weth} ETH sent to vault` : "",
        amountWeth: weth,
        amountToken: token,
      };
    // V14: settlement after pool creation no longer blocks the lifecycle —
    // late claims top the pool up instead.
    case "LateVaultSettlementClaimed":
      return {
        ...base,
        label: "Locker settled · late",
        detail: weth ? `${weth} ETH sent to vault` : "",
        amountWeth: weth,
        amountToken: token,
      };
    case "LateLiquidityAdded":
      return {
        ...base,
        label: "Late liquidity added",
        detail: weth ? `${weth} ETH added to the pool` : "",
        locker: undefined,
        amountWeth: weth,
        amountToken: token,
      };
    case "LaunchFailedRefunded":
    case "FailedLaunchRefunded":
      return { ...base, label: "Failed launch refund", detail: weth ? `${weth} ETH refunded` : "", amountWeth: weth };
    case "UnsoldSaleTokensBurned": {
      const dispositionToken = token || genericTokenAmount;
      return {
        ...base,
        label: "Unsold tokens burned",
        detail: dispositionToken ? `${dispositionToken} unsold sale tokens burned` : "",
        amountToken: dispositionToken,
        locker: undefined,
      };
    }
    case "UnsoldSaleTokensPaid": {
      const dispositionToken = token || genericTokenAmount;
      return {
        ...base,
        label: "Unsold tokens paid to treasury",
        detail: dispositionToken ? `${dispositionToken} unsold sale tokens paid${recipient ? ` to ${shortAddress(recipient)}` : ""}` : "",
        amountToken: dispositionToken,
        recipient,
        locker: undefined,
      };
    }
    case "ClaimedTokensWithdrawn": {
      const withdrawnToken = token || genericTokenAmount;
      return {
        ...base,
        label: "Claimed tokens withdrawn",
        detail: withdrawnToken ? `${withdrawnToken} sale tokens withdrawn` : "",
        amountToken: withdrawnToken,
      };
    }
    case "Finalized":
      return { ...base, label: "Launch finalized", detail: "", locker: undefined };
    case "OfficialPoolCreated":
    case "LiquidityPoolCreated":
      return { ...base, label: "Official pool created", detail: "", locker: undefined, amountWeth: weth, amountToken: token };
    case "VaultLiquidityTokensClaimed":
      return { ...base, label: "Vault liquidity claimed", detail: "", amountWeth: weth, amountToken: token };
    default:
      return { ...base, label: humanizeEventName(name), detail: "" };
  }
}

function aggregateLockerSummaries(activity: ActivityItem[]): LockerSummary[] {
  const summaries = new Map<string, LockerSummary>();
  for (const item of dedupeActivityActions(activity)) {
    if (!item.locker || !ethers.isAddress(item.locker)) continue;
    const key = ethers.getAddress(item.locker);
    const current = summaries.get(key) || {
      locker: key,
      committedWeth: 0n,
      refundedWeth: 0n,
      penaltyWeth: 0n,
      settledWeth: 0n,
      saleTokens: 0n,
      rounds: Array.from({ length: ROUND_COUNT }, () => 0n),
      settled: false,
      lastBlock: 0,
    };
    current.lastBlock = Math.max(current.lastBlock, item.blockNumber);
    if (item.event === "RoundCommitted" && item.amountWeth && item.round !== undefined) {
      const amount = ethers.parseEther(item.amountWeth);
      current.committedWeth += amount;
      current.rounds[item.round] += amount;
    }
    if (item.event === "RoundRefunded" && item.amountWeth) {
      current.refundedWeth += ethers.parseEther(item.amountWeth);
      if (item.penaltyWeth) current.penaltyWeth += ethers.parseEther(item.penaltyWeth);
    }
    if ((item.event === "LaunchFailedRefunded" || item.event === "FailedLaunchRefunded") && item.amountWeth) {
      current.refundedWeth += ethers.parseEther(item.amountWeth);
    }
    if (item.event === "VaultSettlementClaimed" || item.event === "LateVaultSettlementClaimed" || item.event === "VaultSettlementCompleted") {
      current.settled = true;
      if (item.amountWeth) current.settledWeth += ethers.parseEther(item.amountWeth);
      if (item.amountToken) current.saleTokens += ethers.parseUnits(item.amountToken, 18);
    }
    summaries.set(key, current);
  }
  return Array.from(summaries.values()).sort((a, b) => Number(netCommitted(b) - netCommitted(a)));
}

async function buildLockerSummaries(activity: ActivityItem[], provider: ethers.Provider) {
  const sorted = aggregateLockerSummaries(activity);
  await Promise.all(sorted.slice(0, 120).map(async (summary) => {
    try {
      const locker = await contractWithProvider("D17Locker", summary.locker, provider);
      const owner = await locker.owner() as string;
      summary.owner = ethers.getAddress(owner);
    } catch {
      summary.owner = undefined;
    }
  }));
  return sorted;
}

function netCommitted(locker: LockerSummary) {
  const net = locker.committedWeth - locker.refundedWeth - locker.penaltyWeth;
  return net > 0n ? net : 0n;
}

function formatEth(value: bigint) {
  return trimDecimals(ethers.formatEther(value), 6);
}

/** Display-only USD from an ETH amount × rate. Returns "" when no rate or
 *  a non-positive amount, so callers can render `{usd && <span>…}` cleanly. */
function usdFromEth(ethAmount: number, rate: number | null): string {
  if (!rate || !Number.isFinite(ethAmount) || ethAmount <= 0) return "";
  const value = ethAmount * rate;
  const digits = value >= 1000 ? 0 : value >= 1 ? 2 : 4;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function formatWethPerToken(value: bigint) {
  return trimDecimals(ethers.formatEther(value), 12);
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  return trimDecimals(value.toFixed(2), 2);
}

// Full precision — amountToken fields get parsed back to bigints in
// buildLockerSummaries, so they must never carry display formatting.
function formatToken(value: bigint) {
  return trimDecimals(ethers.formatUnits(value, 18), 2);
}

/** Render-only compact form (1.54M). Never parse this. */
function formatTokenCompact(value: bigint) {
  return compactNumber(Number(ethers.formatUnits(value, 18)));
}

function pricePaidWad(wethPaid: bigint, tokenAmount: bigint) {
  if (wethPaid === 0n || tokenAmount === 0n) return 0n;
  return wethPaid * 10n ** 18n / tokenAmount;
}

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];

/** Crypto-chart price notation: 0.0000000844 → 0.0₇844 */
function formatCryptoPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 0.001) return trimDecimals(value.toFixed(6), 6);
  let zeros = Math.ceil(-Math.log10(value)) - 1;
  let scaled = Math.round(value * 10 ** (zeros + 4));
  // Rounding carry: 9.9999e-8 rounds to 10000, which is really 1 with one
  // fewer leading zero (0.0000001).
  if (scaled >= 10000) {
    zeros -= 1;
    scaled = Math.round(scaled / 10);
  }
  const digits = scaled.toString().replace(/0+$/, "") || "0";
  const subscript = String(zeros)
    .split("")
    .map((digit) => SUBSCRIPT_DIGITS[Number(digit)])
    .join("");
  return `0.0${subscript}${digits}`;
}

function trimDecimals(value: string, places: number) {
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, places).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

function formatPriceNumber(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1) return trimDecimals(value.toFixed(12), 12);
  return trimDecimals(value.toFixed(8), 8);
}

function shortAddress(address: string) {
  if (!address) return "unknown";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function shortHash(hash: string) {
  return `${hash.slice(0, 10)}...${hash.slice(-8)}`;
}

function normalizeMaybeAddress(value: unknown) {
  return typeof value === "string" && ethers.isAddress(value) ? ethers.getAddress(value) : undefined;
}

function humanizeEventName(name: string) {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function isFiniteEnd(value: number) {
  return value > 0 && value < Number.MAX_SAFE_INTEGER && value < 4_000_000_000;
}

function formatRelative(unixSeconds: number) {
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return formatMinute(unixSeconds);
}

function formatMinute(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Time-of-day only — for tables where the date lives in the header. */
function formatClock(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Date only — pairs with formatClock. */
function formatDay(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
  });
}

function timeLeft(endsAt: number, nowSeconds: number) {
  if (!isFiniteEnd(endsAt)) return "Open";
  const seconds = Math.max(0, endsAt - nowSeconds);
  if (seconds === 0) return "Ending";
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m left`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
}

function timeUntil(startsAt: number, nowSeconds: number) {
  if (!startsAt) return "Waiting";
  if (nowSeconds >= startsAt) return "Ready";
  const seconds = startsAt - nowSeconds;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function progressPct(startsAt: number, endsAt: number, nowSeconds: number) {
  if (!startsAt || !isFiniteEnd(endsAt) || endsAt <= startsAt) return 0;
  return Math.max(0, Math.min(100, ((nowSeconds - startsAt) / (endsAt - startsAt)) * 100));
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast("Copied", { description: value.length > 48 ? `${value.slice(0, 48)}...` : value });
  } catch {
    toast("Copy failed");
  }
}

function showError(title: string, error: unknown) {
  const parsed = parseContractError(error);
  toast(title, {
    description: (
      <div className="space-y-2">
        <p>{parsed.message}</p>
        {parsed.raw && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer underline underline-offset-4">More info</summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-hairline bg-paper p-2">{parsed.raw}</pre>
          </details>
        )}
      </div>
    ),
  });
}

function parseContractError(error: unknown) {
  const raw = errorToRawText(error);
  const reason = extractReason(raw);
  const lower = raw.toLowerCase();
  const messages: Record<string, string> = {
    ACTION_REJECTED: "The transaction was rejected in the wallet. Nothing was sent.",
    AMOUNT: "The amount is invalid for this action.",
    AMOUNT_ZERO: "Enter an amount greater than zero.",
    CAP: "This token mint would exceed the maximum supply.",
    ROUND_CLOSED: "This round is not open. The phase timeline updates automatically, or you can press Refresh.",
    NO_REFUND_STAGE: "Refunds are not open right now. Refunds only work during the active refund window.",
    NO_REFUND: "There is no refundable commitment for this locker in the active refund window.",
    NO_ROUND_POSITION: "This locker has no commitment in the active refund round.",
    ROUND_REFUNDED: "This round has already been refunded for this locker.",
    COMMIT_TOO_SMALL: "The contribution is below this launch's minimum commit amount.",
    MIN_COMMIT: "The contribution is below this launch's minimum commit amount.",
    NOT_CANONICAL: "This launch is not registered as canonical by the D17 factory.",
    POOL_NOT_READY: "The official pool is not ready yet.",
    ANCHOR_NOT_READY: "Round 1 has not met the anchor requirement yet, so later rounds cannot accept commitments.",
    BAD_RULES: "The rules hash does not match this launch. Refresh the launch details and try again.",
    UNKNOWN_LAUNCH: "This locker does not recognize that launch. Check the launch address and rules hash.",
    BAD_LAUNCH_ID: "That address is not a compatible D17 launch contract.",
    NOT_APPROVED: "This launch is not approved by the D17 factory for this locker.",
    NOT_D17_FACTORY: "Only the pinned D17 factory can call this function.",
    NOT_OWNER: "Connect the wallet that owns this D17 locker.",
    ONLY_SELF: "A locker can only be created by the wallet that will own it.",
    NOT_D17_LOCKER: "Only an official D17 locker can call this launch function.",
    NOT_LAUNCH_FACTORY: "Only the pinned D17 launch factory can call this function.",
    NOT_LIQUIDITY_VAULT: "Only the launch liquidity vault can call this function.",
    NOT_VAULT_CONFIGURATOR: "Only the vault configurator can call this function.",
    NOT_LOCKER_FACTORY: "Only the pinned D17 locker factory can register lockers.",
    LOCKER_REGISTERED: "This locker is already registered.",
    LOCKER_OWNER_ZERO: "The locker owner address is missing.",
    LOCKER_FACTORY_UNLOCKED: "The locker factory is not pinned yet.",
    LOCKER_FACTORY_PINNED: "The locker factory has already been pinned.",
    LOCKER_FACTORY_ZERO: "Locker factory address is missing.",
    LOCKER_FACTORY_NO_CODE: "The locker factory address has no contract code.",
    LAUNCH_FACTORY_UNLOCKED: "The launch factory is not pinned yet.",
    LAUNCH_FACTORY_PINNED: "The launch factory has already been pinned.",
    LAUNCH_FACTORY_ZERO: "Launch factory address is missing.",
    LAUNCH_FACTORY_NO_CODE: "The launch factory address has no contract code.",
    TOKEN_FACTORY_ZERO: "Token factory address is missing.",
    TOKEN_FACTORY_NO_CODE: "The token factory address has no contract code.",
    VAULT_FACTORY_ZERO: "Vault factory address is missing.",
    VAULT_FACTORY_NO_CODE: "The vault factory address has no contract code.",
    ROUTER_FACTORY_ZERO: "Router factory address is missing.",
    ROUTER_FACTORY_NO_CODE: "The router factory address has no contract code.",
    POSITION_WETH_BALANCE: "The locker does not have enough withdrawable WETH for that action.",
    LOCKED_WETH_BALANCE: "The locker does not have enough locked WETH for that action.",
    ROUND_WETH_BALANCE: "The locker does not have enough WETH committed to that round.",
    EXCESS_WETH_BALANCE: "There is not enough excess WETH in this locker to recover that amount.",
    NO_EXCESS_WETH: "There is no excess WETH to recover from this locker.",
    NO_TOKEN_BALANCE: "There are no unlocked sale tokens available to withdraw.",
    TOKEN_WITHDRAW_LOCKED: "Sale tokens cannot be withdrawn until official trading is open.",
    TOKEN_BALANCE: "The contract does not have enough token balance for that action.",
    WETH_BALANCE: "The contract does not have enough WETH balance for that action.",
    VAULT_WETH_BALANCE: "The vault does not have enough WETH for that action.",
    VAULT_TOKEN_BALANCE: "The vault does not have enough tokens for that action.",
    ETH_BALANCE: "The contract does not have enough ETH for that action.",
    NO_ETH: "No ETH was sent with this action.",
    NO_ETH_BALANCE: "There is no ETH balance to sweep.",
    ETH_SEND: "The ETH transfer failed.",
    ETH_SWEEP_FAILED: "The ETH sweep failed.",
    ETH_TRANSFER_FAILED: "The ETH transfer failed.",
    ALLOWANCE: "Token allowance is too low for this action.",
    BALANCE: "Token balance is too low for this action.",
    SETTLE_AND_CLAIM_REQUIRED: "Use Settle and claim. There is no separate final-claim transaction.",
    FINAL_CLAIM_ONLY: "This action is only available through the final settlement/claim flow.",
    FINAL_CLAIM_MISMATCH: "The final claim amount does not match the launch accounting.",
    FAILED_REFUND_MISMATCH: "The failed-launch refund amount does not match the launch accounting.",
    TRADING_NOT_OPEN: "Sale-token withdrawal is locked until official trading is open.",
    TRADING_CLOSED: "Trading is not open yet.",
    TRADING_OPEN_NOW: "Trading is already open.",
    LIQUIDITY_SETTLED: "This locker is already settled for this launch.",
    LIQUIDITY_CLAIMED: "This locker has already claimed/settled its launch liquidity.",
    SALE_TOKENS_CLAIMED: "This locker has already claimed its sale tokens.",
    NO_POSITION: "This locker has no position for the selected launch.",
    LAUNCH_FAILED: "This launch has failed. Use the failed-launch refund flow instead.",
    LAUNCH_NOT_FAILED: "This launch has not failed, so the failed-launch refund is not available.",
    NOT_OVER: "The sale is not over yet.",
    FINALIZED: "This launch has already been finalized.",
    NOT_FINALIZED: "This launch has not been finalized yet.",
    NO_FINAL_COMMITMENTS: "There are no final commitments to launch with.",
    POOL_CREATION_NOT_OPEN: "The claim window is still open. The official pool can be created after it ends.",
    GRACE_OPEN: "The claim window is still open.",
    UNSETTLED_LOCKERS: "Not all final commitments are settled yet, so the official pool cannot be created.",
    NO_SETTLED_LIQUIDITY: "No settled liquidity has reached the vault yet.",
    NO_LIQUIDITY_TOKENS: "There are no LP-side tokens available for the pool.",
    NO_WETH_FOR_POOL: "No WETH is available for pool creation.",
    POOL_CREATED: "The official pool has already been created.",
    POOL_NOT_CREATED: "The official pool has not been created yet.",
    VAULT_CONFIGURED: "This vault has already been configured.",
    VAULT_NOT_CONFIGURED: "This vault has not been configured yet.",
    VAULT_CONFIG_ZERO: "Vault configuration address is missing.",
    VAULT_LIQUIDITY_CLAIMED: "The vault liquidity has already been claimed for pool creation.",
    VAULT_LIQUIDITY_NOT_CLAIMED: "Vault liquidity has not been claimed yet.",
    PAIR_PRESEEDED_TOKEN: "The Uniswap pair already contains this token. This launch blocks pre-seeded official-pair creation.",
    PAIR_ALREADY_LIVE: "The official pair already appears to be live.",
    PAIR_EXISTS: "The Uniswap pair already exists.",
    PAIR_NO_CODE: "The pair address has no contract code.",
    LP_SLIPPAGE: "The pool transaction would mint too little LP. Refresh and try again with safer limits.",
    LP_ZERO: "The pool transaction did not mint LP tokens.",
    LP_PROTECTED: "LP tokens are protected by the vault and cannot be withdrawn this way.",
    WETH_PROTECTED: "Pool WETH is protected by the vault and cannot be swept this way.",
    TOKEN_MISSING: "The expected token balance is missing.",
    TOKEN_USED_MISMATCH: "The token amount used for the pool does not match launch accounting.",
    WETH_USED_MISMATCH: "The WETH amount used for the pool does not match launch accounting.",
    D17_TOKEN_PROTECTED: "The D17 token is protected and cannot be recovered this way.",
    DIRECT_ETH_REJECTED: "This contract does not accept direct ETH transfers. Use the intended locker action.",
    UNSUPPORTED_CALL: "This contract does not support that direct call.",
    REENTRANT: "The contract blocked a repeated/reentrant call.",
    DEADLINE: "The transaction deadline expired. Refresh and try again.",
    EXPIRED: "The transaction expired. Refresh and try again.",
    BAD_WETH: "The WETH address does not match this launch.",
    A_MIN: "The token A amount is below the required minimum.",
    B_MIN: "The token B amount is below the required minimum.",
    MIN: "The output amount is below the required minimum.",
    NO_OUTPUT: "The swap or router call returned no output.",
    INSUFFICIENT_LIQUIDITY: "The pool does not have enough liquidity for that action.",
    RESERVES: "The pool reserves are not valid for that action.",
    RESERVE_OVERFLOW: "The pool reserves are too large for this calculation.",
    IDENTICAL: "The two token addresses must be different.",
    TOKEN0_OUT: "Token0 output amount is invalid.",
    TOKEN1_OUT: "Token1 output amount is invalid.",
    TOKEN0_SKIM: "Token0 excess recovery failed.",
    TOKEN1_SKIM: "Token1 excess recovery failed.",
    TOKEN_A_TRANSFER: "Token A transfer failed.",
    TOKEN_B_TRANSFER: "Token B transfer failed.",
    TOKEN_IN_TRANSFER: "Input token transfer failed.",
    RECIPIENT_ZERO: "Recipient address is missing.",
    TO_ZERO: "Recipient address is missing.",
    OWNER_ZERO: "Owner address is missing.",
    FACTORY_ZERO: "Factory address is missing.",
    LAUNCH_ZERO: "Launch address is missing.",
    LOCKER_ZERO: "Locker address is missing.",
    TOKEN_ZERO: "Token address is missing.",
    WETH_ZERO: "WETH address is missing.",
    ROUTER_ZERO: "Router address is missing.",
    VAULT_ZERO: "Vault address is missing.",
    PAIR_ZERO: "Pair address is missing.",
    NO_CODE: "That address has no contract code.",
    LAUNCH_NO_CODE: "The launch address has no contract code.",
    LOCKER_NO_CODE: "The locker address has no contract code.",
    TOKEN_NO_CODE: "The token address has no contract code.",
    WETH_NO_CODE: "The WETH address has no contract code.",
    ROUTER_NO_CODE: "The router address has no contract code.",
    VAULT_NO_CODE: "The vault address has no contract code.",
    FACTORY_NO_CODE: "The factory address has no contract code.",
    PAIR: "The pair address is invalid.",
    START_PAST: "The launch start time is in the past.",
    START_TOO_FAR: "The launch start time is too far in the future.",
    TOKEN_NAME: "Token name is missing or too long.",
    TOKEN_SYMBOL: "Token symbol is missing or too long.",
    NAME: "Token name is invalid.",
    SYMBOL: "Token symbol is invalid.",
    SUPPLY_ZERO: "Token supply must be greater than zero.",
    SALE_ZERO: "Sale token amount must be greater than zero.",
    SUPPLY_SPLIT: "Token split does not add up to total supply.",
    MANUAL_RECIPIENT_ZERO: "Manual distribution recipient is missing.",
    DEAD_RECIPIENT: "Dead-token recipient must be the canonical dead address.",
    TREASURY_ZERO: "Treasury address is missing.",
    REFUND_SECONDS: "Refund window length is outside the allowed range.",
    REFUND_SECONDS_ZERO: "Refund window length must be greater than zero.",
    SETTLEMENT_SECONDS: "Settlement window length is outside the allowed range.",
    SETTLEMENT_SECONDS_ZERO: "Settlement window length must be greater than zero.",
    MIN_COMMIT_ZERO: "Minimum commit must be greater than zero.",
    MIN_PHASE1_WETH: "Round 1 minimum WETH must be at least the minimum commit amount.",
    MIN_ANCHOR_PRICE_ZERO: "Minimum anchor price must be greater than zero.",
    TREASURY_BPS: "Treasury fee is above the allowed maximum (10%).",
    REFUND_PENALTY_BPS: "Refund penalty must be between 1% and 25%.",
    START_TOO_SOON: "The launch must start later (mainnet requires at least 24 hours of public notice).",
    PROTOCOL_FEE_ABOVE_MAX: "The protocol fee changed above the rate you accepted. Review it and try again.",
    FACTORY_NOT_RENOUNCED: "This factory still has an owner key; launches are refused until it is renounced.",
    FACTORIES_NOT_RENOUNCED: "A creation-path factory still has an owner key; launches are refused until it is renounced.",
    NOTHING_VESTED: "No creator tokens are vested and unreleased yet.",
    SETTLEMENT_OPEN: "Residual tokens can only be burned once every commitment has settled.",
    FEE_ABOVE_CAP: "The protocol fee cannot exceed 2%.",
    ROUND_SECONDS: "One or more round durations are outside the allowed range.",
    ROUND_SECONDS_ZERO: "Round duration must be greater than zero.",
    ROUND_SHARE_ZERO: "Each round must have a non-zero allocation share.",
    ROUND_ALLOCATION_ZERO: "A round allocation rounds down to zero tokens.",
    ROUND_SHARE_TOTAL: "Round allocation shares must total 100%.",
    ROUND: "Round number is invalid.",
    MINTING_CLOSED: "Token minting is already closed.",
    BINDING_AFTER_FINALIZATION: "Locker binding cannot be changed after finalization.",
    TRADING_GATE_CONFIGURED: "The token trading gate has already been configured.",
    ZERO: "A required value is zero.",
  };

  if (reason && messages[reason]) return { message: messages[reason], raw };
  if (reason) return { message: humanizeReason(reason), raw };
  if (lower.includes("user rejected") || lower.includes("action_rejected")) return { message: messages.ACTION_REJECTED, raw };
  if (raw.includes("Switch your wallet to")) return { message: `Switch your wallet to ${CHAIN_NAME} and try again.`, raw };
  if (raw.includes("No browser wallet found")) return { message: "No browser wallet was found. Open the page in a wallet-enabled browser.", raw };
  if (raw.includes("Multiple wallets detected")) return { message: "More than one wallet extension is installed. Pick one in the wallet chooser, then try again.", raw };
  if (raw.includes("is not a valid address")) return { message: "One of the address fields is not a valid Ethereum address.", raw };
  if (raw.includes("Contribution must be greater than 0")) return { message: "Contribution must be greater than 0 ETH.", raw };
  if (raw.includes("verifyLaunch returned false")) return { message: "This locker does not verify the selected launch/rules hash.", raw };
  if (raw.includes("Missing") && raw.includes("ABI")) return { message: "The UI is missing a contract ABI file. Rebuild or restore the shared ABI files.", raw };
  if (raw.includes("LockerCreated event was not found")) return { message: "The locker transaction confirmed, but the UI could not find the locker address in the receipt. Refresh and check your lockers.", raw };
  if (raw.includes("reverted")) return { message: "The contract rejected this action. Open details for the raw revert response.", raw };
  if (lower.includes("block range extends beyond current head block")) {
    return {
      message: "The RPC node is a little behind the latest block. Wait a few seconds or press Refresh and the activity feed should catch up.",
      raw,
    };
  }
  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("429")) {
    return {
      message: `The ${CHAIN_NAME} RPC is rate limiting requests. Wait a moment, then refresh. A private RPC or WebSocket endpoint will make this smoother.`,
      raw,
    };
  }
  if (lower.includes("batch of more than") || lower.includes("batch") && lower.includes("not allowed")) {
    return {
      message: "The RPC endpoint rejected batched requests. Use a no-batch RPC setting or a paid endpoint for this launch.",
      raw,
    };
  }
  if (lower.includes("eth_getlogs") || lower.includes("getlogs")) {
    return {
      message: `The activity feed could not read logs from the RPC endpoint. The launch state is still onchain; refresh or try a different ${CHAIN_NAME} RPC.`,
      raw,
    };
  }
  if (lower.includes("insufficient funds")) {
    return {
      message: `This wallet does not have enough ${CHAIN_NAME} ETH to pay for the transaction and gas.`,
      raw,
    };
  }
  if (lower.includes("nonce")) {
    return {
      message: "The wallet nonce is out of sync. Wait for pending transactions to confirm, then try again.",
      raw,
    };
  }
  if (lower.includes("network") || lower.includes("failed to fetch") || lower.includes("could not coalesce error")) {
    return {
      message: `The wallet or RPC returned an unreadable network error. Refresh once; if it repeats, switch ${CHAIN_NAME} RPC.`,
      raw,
    };
  }
  return { message: "Something went wrong. Open details for the raw wallet/RPC response.", raw };
}

function errorToRawText(error: unknown) {
  if (!error) return "Unknown wallet or contract error";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, bigintJsonReplacer, 2);
  } catch {
    return String(error);
  }
}

function bigintJsonReplacer(_: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function extractReason(raw: string) {
  const ignored = new Set([
    "CALL_EXCEPTION",
    "UNKNOWN_ERROR",
    "SERVER_ERROR",
    "NETWORK_ERROR",
    "ACTION_REJECTED",
    "INSUFFICIENT_FUNDS",
    "NONCE_EXPIRED",
    "REPLACEMENT_UNDERPRICED",
    "UNPREDICTABLE_GAS_LIMIT",
  ]);
  const patterns = [
    /reason="([A-Z0-9_]+)"/,
    /execution reverted: "([A-Z0-9_]+)"/,
    /reverted with reason string '([A-Z0-9_]+)'/,
    /revert(?:ed)?=\{[^}]*args:\s*\[\s*"([A-Z0-9_]+)"/,
    /"([A-Z0-9_]+)"/g,
  ];
  for (const pattern of patterns) {
    if (pattern.global) {
      for (const match of raw.matchAll(pattern)) {
        if (match[1] && !ignored.has(match[1])) return match[1];
      }
      continue;
    }
    const match = raw.match(pattern);
    if (match?.[1] && !ignored.has(match[1])) return match[1];
  }
  return "";
}

function humanizeReason(reason: string) {
  const readable = reason
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${readable || "Contract error"}. Open details for the raw wallet/RPC response.`;
}
