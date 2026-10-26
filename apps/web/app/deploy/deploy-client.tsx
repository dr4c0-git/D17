"use client";

/**
 * /deploy - create a D17 launch directly through the connected wallet. The
 * selected chain uses the bundled manifest, ABI, and
 * validation schema. The optional participant API never controls deployment.
 * The form is one page with four sections and a live participant preview.
 */

import { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { NetworkSwitch } from "@/components/network-switch";
import {
  CHAIN_ID,
  EXPLORER_BASE,
  CHAIN_NAME,
  DEPLOY_ENABLED,
  IS_MAINNET,
  NETWORK_LABEL,
  READ_RPC_URL,
  SITE_MODE,
} from "@/lib/d17Api";
import { LOCAL_DEPLOYER_SCHEMA, PROTOCOL_DEPLOYED, PUBLIC_DEPLOYMENT } from "@/lib/d17Manifest";
import { d17Href } from "@/lib/d17Network";
import { ensureWalletChain } from "@/lib/walletChain";
import { createReadProvider } from "@/lib/readProvider";

declare global {
  interface Window {
    ethereum?: ethers.Eip1193Provider;
  }
}

// Chain identity comes from the selected public deployment manifest.
const CHAIN_ID_BIG = BigInt(CHAIN_ID);
// Writes are pinned to the public deployment manifest bundled with this build.
const DEFAULT_FACTORY = PUBLIC_DEPLOYMENT?.contracts.d17Factory || "";
const DEAD_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
const EXPECTED_FACTORY_ID = ethers.keccak256(ethers.toUtf8Bytes("D17_FACTORY_V15_HARDENED"));
const MAX_START_DELAY_SECONDS = 365 * 24 * 60 * 60;
const MAX_REFUND_SECONDS = 30 * 24 * 60 * 60;
const MAX_SETTLEMENT_SECONDS = 30 * 24 * 60 * 60;
const MIN_COMMIT_WEI = 1_000_000_000_000_000n;
// The start must still be in the future when the transaction is mined, after the wallet
// prompts and the block wait: keep at least this much lead time.
const MIN_START_LEAD_SECONDS = 5 * 60;
// createLaunch uses about 8.2M gas, and about 17M with a maximum-size (8 KB) logo stored
// on-chain; simulations get a budget well above that, still under a block's gas limit.
const SIMULATION_GAS_LIMIT = 30_000_000n;

/** Gas for a real createLaunch when no node could simulate it: measured 8.2M for a launch
 *  without logo and 16.9M with an 8 KB logo (about 1,070 gas per stored metadata byte),
 *  plus a safety margin. Only the gas actually used is paid. */
function creationGasLimit(config: { description: string; logoSvgUri: string; links: { linkType: string; url: string }[] }) {
  const metadataBytes =
    new TextEncoder().encode(config.description).length +
    new TextEncoder().encode(config.logoSvgUri).length +
    config.links.reduce((total, link) => total + link.linkType.length + link.url.length, 0);
  return 9_500_000n + 1_400n * BigInt(metadataBytes);
}

/** A launch contract that fails to deploy inside a simulation, or a revert with no reason,
 *  is what a node's gas cap on simulated calls looks like; real rule violations have names. */
function isSimulationGasCap(error: unknown) {
  const issue = error as { code?: string; reason?: string | null; data?: string | null; message?: string };
  if (issue.reason === "LAUNCH_DEPLOY_FAILED" || /LAUNCH_DEPLOY_FAILED/.test(issue.message ?? "")) return true;
  return issue.code === "CALL_EXCEPTION" && (!issue.data || issue.data === "0x");
}
const MIN_LP_TOKENS = 1n;
const MIN_ROUND_ALLOCATION_TOKENS = 1n;
const MIN_ANCHOR_PRICE_WAD = 1_000_000n;
// Fixed by the deployed contract (uint16[5]/uint32[5] config arrays).
const ROUND_COUNT = 5;
const FEE_CONFIG_ABI = ["function currentFee() view returns (address recipient, uint16 bps)"];

type LinkRow = { linkType: string; url: string };

type DurationPreset = "quick" | "standard" | "long" | "custom";
/** Ready-made schedules (minutes). Mainnet requires every round and window to last at
 *  least one hour, so "quick" is testnet/local only. */
const DURATION_PRESETS: Record<Exclude<DurationPreset, "custom">, { round: number; refund: number; settlement: number; label: string; detail: string }> = {
  quick: { round: 10, refund: 5, settlement: 10, label: "Quick", detail: "5 rounds of 10 minutes · about 1 hour in total" },
  standard: { round: 60, refund: 60, settlement: 60, label: "Standard", detail: "5 rounds of 1 hour · about 9 hours in total" },
  long: { round: 1440, refund: 720, settlement: 1440, label: "Long", detail: "5 rounds of 1 day · about 7 days in total" },
};

/** The bundled deploy contract: factory addresses, createLaunch ABI and
 * validation limits. */
type DeployerSchema = {
  hostedPublicDeployEnabled?: boolean;
  profile?: string;
  mainnetHostedDeployEnabled?: boolean;
  manualDistribution?: { maxBpsOfSupply?: number; vestingDays?: number };
  contracts?: { d17Factory?: string };
  createLaunch?: { abi?: ethers.InterfaceAbi };
  validation?: {
    tokenNameBytes?: { min?: number; max?: number };
    tokenSymbolBytes?: { min?: number; max?: number };
    descriptionBytes?: { max?: number };
    links?: { max?: number; linkTypeBytes?: { max?: number; pattern?: string }; urlBytes?: { max?: number } };
    earlyRefundPenaltyBps?: number;
    refundPenaltyBps?: { min?: number; max?: number };
    treasuryBps?: { min?: number; max?: number };
    roundSeconds?: { length?: number; min?: number; max?: number };
    windowSeconds?: { min?: number };
    startDelaySeconds?: { min?: number };
  };
  knownContractGaps?: { id?: string }[];
};

type DeployResult = {
  token: string;
  launch: string;
  rulesHash: string;
  txHash: string;
};

// Environment kill switch. It defaults on for local use.

const LABEL = "font-mono text-[10px] uppercase tracking-[0.02em] text-quiet";
const FIELD =
  "w-full border border-hairline bg-paper px-2 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-quiet focus-visible:border-dim";
const HINT = "mt-1 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet";
const H2 = "font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink";

export default function DeployPage() {
  // Participant-only site: deploys live on the dedicated deploy site.
  if (SITE_MODE === "participant") return <DeployElsewhere />;
  if (!DEPLOY_ENABLED) return <DeployPaused />;
  return <DeployForm />;
}

function DeployElsewhere() {
  return (
    <main className="flex min-h-dvh flex-col bg-paper text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3 sm:px-6">
        <p className="font-mono text-[12px] uppercase tracking-[0.04em]">
          <a href={d17Href("/")} className="font-semibold text-ink hover:underline">
            D17
          </a>{" "}
          <span className="text-dim">Launch terminal</span> <span className="text-quiet">· Deploy</span>{" "}
          <span className="text-quiet">{NETWORK_LABEL}</span>
        </p>
        <div className="flex items-center gap-3">
          <NetworkSwitch />
          <a href={d17Href("/")} className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink">
            Terminal
          </a>
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="max-w-md border border-hairline px-5 py-4">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">Deploys live on the deploy site</p>
          <p className="mt-2 font-mono text-[11px] uppercase leading-relaxed tracking-[0.02em] text-dim">
            This site is the participant terminal. Launch deployment runs on the dedicated deploy site.
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase leading-relaxed tracking-[0.02em] text-quiet">
            <a href={d17Href("/")} className="text-electric hover:text-ink">
              Back to the terminal →
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}

function DeployPaused() {
  return (
    <main className="flex min-h-dvh flex-col bg-paper text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3 sm:px-6">
        <p className="font-mono text-[12px] uppercase tracking-[0.04em]">
          <a href={d17Href("/")} className="font-semibold text-ink hover:underline">
            D17
          </a>{" "}
          <span className="text-dim">Launch terminal</span> <span className="text-alert">· Deploy paused</span>{" "}
          <span className="text-quiet">{NETWORK_LABEL}</span>
        </p>
        <div className="flex items-center gap-3">
          <NetworkSwitch />
          <a href={d17Href("/")} className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink">
            Terminal
          </a>
        </div>
      </header>
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="max-w-md border border-hairline px-5 py-4">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-ink">Deploys are paused</p>
          <p className="mt-2 font-mono text-[11px] uppercase leading-relaxed tracking-[0.02em] text-dim">
            New deploys are switched off for this site. Existing launches remain available in the terminal.
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase leading-relaxed tracking-[0.02em] text-quiet">
            Live launches are unaffected -{" "}
            <a href={d17Href("/")} className="text-electric hover:text-ink">
              back to the terminal →
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}

function DeployForm() {
  const [tokenName, setTokenName] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("");
  const [supply, setSupply] = useState("100000000");
  const [description, setDescription] = useState("");
  const [links, setLinks] = useState<LinkRow[]>([
    { linkType: "website", url: "" },
    { linkType: "x", url: "" },
  ]);
  const [logoSvgUri, setLogoSvgUri] = useState("");
  const [logoError, setLogoError] = useState("");

  const [salePct, setSalePct] = useState(45);
  const [lpPct, setLpPct] = useState(45);
  // Optional manual allocation is sent to the launch creator.
  const [depPct, setDepPct] = useState(5);
  const [treasuryPct, setTreasuryPct] = useState(5);
  const [treasury, setTreasury] = useState("");
  const [minCommit, setMinCommit] = useState("0.01");

  // The deployed contract fixes the schedule at five rounds.
  const [sharesPct, setSharesPct] = useState<number[]>([40, 15, 15, 15, 15]);
  const defaultPreset: DurationPreset = IS_MAINNET ? "standard" : "quick";
  const [durationPreset, setDurationPreset] = useState<DurationPreset>(defaultPreset);
  const [roundMinutes, setRoundMinutes] = useState<number[]>(Array(ROUND_COUNT).fill(DURATION_PRESETS[defaultPreset].round));
  const [refundMinutes, setRefundMinutes] = useState(DURATION_PRESETS[defaultPreset].refund);
  const [refundCostPct, setRefundCostPct] = useState(10);
  const [settlementMinutes, setSettlementMinutes] = useState(DURATION_PRESETS[defaultPreset].settlement);
  const [opensIn, setOpensIn] = useState(IS_MAINNET ? "1500" : "30");
  // Guided (plain-language) form by default; "Advanced settings" shows every field.
  const [advanced, setAdvanced] = useState(false);
  const [customStart, setCustomStart] = useState("");

  const [minPhase1Weth, setMinPhase1Weth] = useState("1");
  const [minAnchorPrice, setMinAnchorPrice] = useState("0.00000005");
  // Protocol fee read from D17FeeConfig; the creator consents to exactly this rate
  // (maxProtocolFeeBps), so a fee raised before the transaction lands reverts it.
  const [protocolFeeBps, setProtocolFeeBps] = useState<number | null>(null);
  const [factoryAddress] = useState(DEFAULT_FACTORY);

  const [walletAddress, setWalletAddress] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<DeployResult | null>(null);
  // Clock text is locale + Date.now() dependent - rendering it during SSR
  // hydrates against different text in the browser. Render placeholders
  // until mounted, then tick every 30s so "opens in" stays honest.
  const [mounted, setMounted] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!PROTOCOL_DEPLOYED || !READ_RPC_URL) return;
    let cancelled = false;
    const provider = createReadProvider(READ_RPC_URL, CHAIN_ID);
    const feeConfig = new ethers.Contract(PUBLIC_DEPLOYMENT.contracts.feeConfig, FEE_CONFIG_ABI, provider);
    (feeConfig.currentFee() as Promise<[string, bigint]>)
      .then(([, bps]) => {
        if (!cancelled) setProtocolFeeBps(Number(bps));
      })
      .catch(() => undefined)
      .finally(() => provider.destroy());
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get("mode");
      if (requested === "advanced" || (requested !== "guided" && window.localStorage.getItem("d17-deploy-mode") === "advanced")) {
        setAdvanced(true);
      }
    } catch {}
  }, []);

  useEffect(() => {
    setMounted(true);
    const timer = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Deployment is deliberately independent of the optional data API. The
  // deployment manifest and validation limits ship with this repository.
  const schema = LOCAL_DEPLOYER_SCHEMA as unknown as DeployerSchema;

  const supplyTokens = useMemo(() => {
    const parsed = Number(supply.replace(/[,_\s]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  }, [supply]);
  // Manual-distribution tokens are minted to the creator.
  const supportsManualDistribution = true;
  const saleTokens = Math.trunc((supplyTokens * salePct) / 100);
  const lpTokens = Math.trunc((supplyTokens * lpPct) / 100);
  const depTokens = supportsManualDistribution ? Math.trunc((supplyTokens * depPct) / 100) : 0;
  const deadAddressTokens = supplyTokens - saleTokens - lpTokens - depTokens;
  const deadAddressPct = supplyTokens > 0 ? Math.round((deadAddressTokens / supplyTokens) * 100) : 0;
  const overAllocated = salePct + lpPct + (supportsManualDistribution ? depPct : 0) > 100;

  const earlyRefundPct = (LOCAL_DEPLOYER_SCHEMA.validation.earlyRefundPenaltyBps ?? 100) / 100;
  // Recomputed on every render: a relative start ("in 15 minutes") must never go stale while
  // the page stays open, and a chosen date is checked against the current time.
  const startTime = (() => {
    if (customStart) {
      const at = new Date(customStart).getTime();
      return Number.isFinite(at) ? Math.floor(at / 1000) : 0;
    }
    return Math.floor(Date.now() / 1000) + Number(opensIn) * 60;
  })();

  const sharesSum = sharesPct.reduce((total, pct) => total + pct, 0);

  const roundOneAllocationWei = (() => {
    if (!Number.isSafeInteger(saleTokens) || saleTokens <= 0) return 0n;
    return (ethers.parseUnits(String(saleTokens), 18) * BigInt(Math.round((sharesPct[0] ?? 0) * 100))) / 10_000n;
  })();
  const autoAnchorWei = (() => {
    if (roundOneAllocationWei <= 0n) return MIN_ANCHOR_PRICE_WAD;
    const floor = (decimalToWei(minPhase1Weth) * 1_000_000_000_000_000_000n) / roundOneAllocationWei;
    return floor > MIN_ANCHOR_PRICE_WAD ? floor : MIN_ANCHOR_PRICE_WAD;
  })();
  const anchorFloorWei = advanced ? decimalToWei(minAnchorPrice) : autoAnchorWei;

  const applyDuration = (preset: DurationPreset) => {
    setDurationPreset(preset);
    if (preset === "custom") return;
    const values = DURATION_PRESETS[preset];
    setRoundMinutes(Array(ROUND_COUNT).fill(values.round));
    setRefundMinutes(values.refund);
    setSettlementMinutes(values.settlement);
  };
  const changeMode = (next: boolean) => {
    setAdvanced(next);
    if (next) setDurationPreset("custom");
    try {
      window.localStorage.setItem("d17-deploy-mode", next ? "advanced" : "guided");
    } catch {}
  };

  // Preview schedule: same shape the participant Rounds table renders.
  const schedule = useMemo(() => {
    let at = startTime;
    return sharesPct.map((pct, index) => {
      const opens = at;
      const closes = opens + roundMinutes[index] * 60;
      const hasRefund = index < ROUND_COUNT - 1;
      at = hasRefund ? closes + refundMinutes * 60 : closes;
      // Contract policy: rounds 1-2 pay the fixed early penalty, rounds 3-4 the
      // configured penalty, the final round has no normal refund window. Every
      // penalty deepens the official pool; none goes to the creator.
      return {
        id: index + 1,
        pct,
        opens,
        closes,
        refund: hasRefund ? (index >= 2 ? `${refundCostPct}%` : `${earlyRefundPct}%`) : "None",
      };
    });
  }, [sharesPct, roundMinutes, refundMinutes, refundCostPct, startTime, earlyRefundPct]);

  const validLinks = links.filter((link) => link.url.trim());
  // Limits come from the bundled schema; literals remain defensive fallbacks.
  const rules = schema?.validation;
  const nameMax = rules?.tokenNameBytes?.max ?? 64;
  const symbolMax = rules?.tokenSymbolBytes?.max ?? 16;
  const descriptionMax = rules?.descriptionBytes?.max ?? 512;
  const linksMax = rules?.links?.max ?? 8;
  const linkTypeMax = rules?.links?.linkTypeBytes?.max ?? 32;
  const linkTypePattern = useMemo(() => {
    try {
      return new RegExp(rules?.links?.linkTypeBytes?.pattern ?? "^[a-z0-9-]+$");
    } catch {
      return /^[a-z0-9-]+$/;
    }
  }, [rules?.links?.linkTypeBytes?.pattern]);
  const urlMax = rules?.links?.urlBytes?.max ?? 128;
  const linkProblems = validLinks.filter(
    (link) => !/^https:\/\//.test(link.url.trim()) || byteLength(link.url.trim()) > urlMax
  );
  const linkTypeProblems = validLinks.filter(
    (link) => !linkTypePattern.test(link.linkType.trim()) || byteLength(link.linkType.trim()) > linkTypeMax
  );

  const manualMaxBps = schema?.manualDistribution?.maxBpsOfSupply ?? 1000;
  const refundPenaltyMinBps = rules?.refundPenaltyBps?.min ?? 100;
  const refundPenaltyMaxBps = rules?.refundPenaltyBps?.max ?? 2500;
  const treasuryMaxBps = rules?.treasuryBps?.max ?? 1000;
  const roundSecondsMin = rules?.roundSeconds?.min ?? 60;
  const windowSecondsMin = rules?.windowSeconds?.min ?? 1;
  const startDelayMin = rules?.startDelaySeconds?.min ?? 0;
  const vestingDays = schema?.manualDistribution?.vestingDays ?? 180;
  const roundSecondsMax = rules?.roundSeconds?.max ?? 7776000; // 90 days

  const problems: string[] = [];
  if (!tokenName.trim()) problems.push("token name");
  else if (byteLength(tokenName.trim()) > nameMax) problems.push(`token name over ${nameMax} bytes`);
  if (!tokenSymbol.trim()) problems.push("token symbol");
  else if (byteLength(tokenSymbol.trim()) > symbolMax) problems.push(`token symbol over ${symbolMax} bytes`);
  if (supplyTokens <= 0 || !Number.isSafeInteger(supplyTokens)) problems.push("supply must be a whole, safely-sized token count");
  if (saleTokens <= 0) problems.push("sale allocation");
  if (lpTokens < Number(MIN_LP_TOKENS)) problems.push("LP allocation below 1 token");
  if (overAllocated) problems.push("allocation over 100%");
  if (sharesSum !== 100) problems.push(`round shares sum ${sharesSum}% (need 100%)`);
  if (byteLength(description) > descriptionMax) problems.push(`description over ${descriptionMax} bytes`);
  if (validLinks.length > linksMax) problems.push(`more than ${linksMax} links`);
  if (linkProblems.length > 0) problems.push(`links must be https:// and ≤${urlMax} bytes`);
  if (linkTypeProblems.length > 0) problems.push("link types must be lowercase a–z, 0–9, dashes");
  if (logoSvgUri && byteLength(logoSvgUri) > 8192) problems.push("logo over 8 KB");
  // This local deployer does not ask a hosted service for permission. The
  // env kill switch above is the only UI gate; the wallet and factory enforce
  // the actual transaction rules.
  if (decimalToWei(minCommit) < MIN_COMMIT_WEI) problems.push("min commit below 0.001 ETH");
  if (decimalToWei(minPhase1Weth) < decimalToWei(minCommit)) problems.push("phase-1 minimum below min commit");
  if (anchorFloorWei < MIN_ANCHOR_PRICE_WAD) problems.push("anchor price below contract minimum");
  if (!ethers.isAddress(factoryAddress) || ethers.getAddress(factoryAddress) !== ethers.getAddress(DEFAULT_FACTORY)) problems.push("factory address mismatch");
  if (treasury && !ethers.isAddress(treasury)) problems.push("treasury address");
  if (!PROTOCOL_DEPLOYED) problems.push(`protocol not deployed on ${CHAIN_NAME} yet`);
  if (protocolFeeBps === null && PROTOCOL_DEPLOYED) problems.push("protocol fee not loaded");
  if (startTime <= Math.floor(Date.now() / 1000)) problems.push("start time is in the past");
  else if (startTime < Math.floor(Date.now() / 1000) + MIN_START_LEAD_SECONDS) problems.push("start time too close");
  else if (startTime < Math.floor(Date.now() / 1000) + startDelayMin)
    problems.push(`start must be announced at least ${Math.round(startDelayMin / 3600)}h ahead`);
  if (startTime > Math.floor(Date.now() / 1000) + MAX_START_DELAY_SECONDS) problems.push("start time is over 365 days away");
  if (supportsManualDistribution && depPct * 100 > manualMaxBps) problems.push(`deployer allocation over ${manualMaxBps / 100}% of supply`);
  if (refundCostPct * 100 > refundPenaltyMaxBps || refundCostPct * 100 < refundPenaltyMinBps)
    problems.push(`refund cost outside ${refundPenaltyMinBps / 100}%–${refundPenaltyMaxBps / 100}%`);
  if (Math.round(refundMinutes * 60) < windowSecondsMin || Math.round(settlementMinutes * 60) < windowSecondsMin)
    problems.push(`refund and claim windows need at least ${Math.round(windowSecondsMin / 60)}m`);
  if (treasuryPct * 100 > treasuryMaxBps) problems.push(`treasury share over ${treasuryMaxBps / 100}%`);
  if (roundMinutes.some((minutes) => Math.round(minutes * 60) < roundSecondsMin || Math.round(minutes * 60) > roundSecondsMax))
    problems.push(`round length outside ${Math.ceil(roundSecondsMin / 60)}m–${Math.round(roundSecondsMax / 86400)}d`);
  if (Math.round(refundMinutes * 60) > MAX_REFUND_SECONDS) problems.push("refund window over 30 days");
  if (Math.round(settlementMinutes * 60) > MAX_SETTLEMENT_SECONDS) problems.push("claim window over 30 days");
  if (sharesPct.some((pct) => Math.trunc((saleTokens * pct) / 100) < Number(MIN_ROUND_ALLOCATION_TOKENS)))
    problems.push("each round needs at least 1 sale token");
  // The factory requires the canonical dead recipient when deadTokens > 0;
  // the constant IS that address - this guards against the constant drifting.
  if (DEAD_RECIPIENT.toLowerCase() !== "0x000000000000000000000000000000000000dead")
    problems.push("dead recipient is not the canonical dead address");
  const ready = problems.length === 0;

  const buildConfig = (treasuryResolved: string, abiHasManualAllocation: boolean, resolvedStartTime = startTime) => ({
    // manualDistributionTokens has no separate recipient field: the launch
    // creator receives it.
    ...(abiHasManualAllocation ? { manualDistributionTokens: ethers.parseUnits(String(depTokens), 18) } : {}),
    tokenName: tokenName.trim(),
    tokenSymbol: tokenSymbol.trim(),
    description: description.trim(),
    logoSvgUri: logoSvgUri.trim(),
    links: validLinks.map((link) => ({ linkType: link.linkType.trim() || "website", url: link.url.trim() })),
    tokenSupply: ethers.parseUnits(String(supplyTokens), 18),
    saleTokens: ethers.parseUnits(String(saleTokens), 18),
    lpTokens: ethers.parseUnits(String(lpTokens), 18),
    deadTokens: ethers.parseUnits(String(deadAddressTokens), 18),
    deadRecipient: DEAD_RECIPIENT,
    treasury: treasuryResolved,
    startTime: resolvedStartTime,
    roundSeconds: roundMinutes.map((minutes) => Math.round(minutes * 60)) as [number, number, number, number, number],
    refundSeconds: Math.round(refundMinutes * 60),
    settlementSeconds: Math.round(settlementMinutes * 60),
    minCommitWeth: decimalToWei(minCommit),
    minPhase1Weth: decimalToWei(minPhase1Weth),
    minAnchorPriceWad: anchorFloorWei,
    roundSharesBps: sharesPct.map((pct) => Math.round(pct * 100)) as [number, number, number, number, number],
    treasuryBps: Math.round(treasuryPct * 100),
    refundPenaltyBps: Math.round(refundCostPct * 100),
    maxProtocolFeeBps: protocolFeeBps ?? 0,
  });

  const connectWallet = async () => {
    setError("");
    try {
      if (!window.ethereum) throw new Error("No browser wallet found.");
      await window.ethereum.request({ method: "eth_requestAccounts" });
      await ensureWalletChain(window.ethereum);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const network = await provider.getNetwork();
      if (network.chainId !== CHAIN_ID_BIG) throw new Error(`Switch your wallet to ${CHAIN_NAME} - this deployer serves ${CHAIN_NAME} only.`);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();
      setWalletAddress(address);
      if (!treasury) setTreasury(address);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Wallet connection failed");
    }
  };

  const deploy = async () => {
    setError("");
    setBusy("Simulating…");
    try {
      if (!window.ethereum) throw new Error("No browser wallet found.");
      await ensureWalletChain(window.ethereum);
      const provider = new ethers.BrowserProvider(window.ethereum);
      const network = await provider.getNetwork();
      if (network.chainId !== CHAIN_ID_BIG) throw new Error(`Switch your wallet to ${CHAIN_NAME} first.`);
      const signer = await provider.getSigner();
      const signerAddress = ethers.getAddress(await signer.getAddress());
      const treasuryResolved = ethers.getAddress(treasury || signerAddress);
      const abiResponse = await fetch("/abi/D17Factory.abi.json");
      if (!abiResponse.ok) throw new Error("The bundled D17 factory ABI could not be loaded.");
      const bundled = (await abiResponse.json()) as { type?: string; name?: string }[];
      const abi = bundled as ethers.InterfaceAbi;
      const canonicalFactoryAddress = ethers.getAddress(DEFAULT_FACTORY);
      const resolvedStartTime = customStart
        ? startTime
        : Math.floor(Date.now() / 1000) + Math.max(1, Number(opensIn) || 1) * 60;
      if (resolvedStartTime < Math.floor(Date.now() / 1000) + MIN_START_LEAD_SECONDS) {
        throw new Error("Round 1 must open at least 5 minutes from now, so the transaction has time to confirm. Pick a later time (step 4).");
      }
      const config = buildConfig(treasuryResolved, JSON.stringify(abi).includes('"manualDistributionTokens"'), resolvedStartTime);

      // Simulate through the configured read RPC before opening the wallet
      // signature prompt. `from` matters because the factory sends the manual
      // allocation to msg.sender.
      if (!READ_RPC_URL) throw new Error(`Configure an HTTP RPC endpoint for ${CHAIN_NAME} before deploying.`);
      const simulationProvider = createReadProvider(READ_RPC_URL, CHAIN_ID);
      let simulationGasCapped = false;
      try {
        const simulationNetwork = await simulationProvider.getNetwork();
        if (simulationNetwork.chainId !== CHAIN_ID_BIG) {
          throw new Error(`The configured simulation RPC is not ${CHAIN_NAME}.`);
        }
        const simFactory = new ethers.Contract(canonicalFactoryAddress, abi, simulationProvider);
        await assertDeployFactorySuite(simFactory);
        // createLaunch deploys three contracts: give the simulation an explicit gas budget,
        // since public RPCs cap calls that do not set one well below what it needs.
        const simulate = (factory: ethers.Contract) =>
          withTimeout(
            factory.createLaunch.staticCall(config, { from: signerAddress, gasLimit: SIMULATION_GAS_LIMIT }),
            30_000,
            "Simulation timed out - the RPC is slow right now. Nothing was sent; try again."
          );
        try {
          await simulate(simFactory);
        } catch {
          // Public RPCs cap the gas of simulated calls (PublicNode: around 8-10M, while a
          // launch with a logo needs about 17M), which makes the creation fail inside the
          // simulation with or without a reason. Ask the wallet's own node; its answer is
          // the one that counts.
          try {
            await simulate(new ethers.Contract(canonicalFactoryAddress, abi, provider));
          } catch (walletError) {
            // Every rule of the factory is checked before the launch contract is deployed and
            // fails with its own reason; only a gas cap is left here. Send the real
            // transaction with an explicit gas limit (blocks allow far more than needed).
            if (!isSimulationGasCap(walletError)) throw walletError;
            simulationGasCapped = true;
          }
        }
      } finally {
        simulationProvider.destroy();
      }

      const finalNetwork = await provider.getNetwork();
      if (finalNetwork.chainId !== CHAIN_ID_BIG) throw new Error(`Wallet network changed during simulation; switch back to ${CHAIN_NAME}.`);
      const finalSigner = await provider.getSigner();
      const finalSignerAddress = ethers.getAddress(await finalSigner.getAddress());
      if (finalSignerAddress !== signerAddress) throw new Error("Wallet account changed during simulation; review the form and try again.");
      const walletFactory = new ethers.Contract(canonicalFactoryAddress, abi, finalSigner);
      await assertDeployFactorySuite(walletFactory);
      setBusy("Waiting for your signature…");
      const tx = (await walletFactory.createLaunch(
        config,
        simulationGasCapped ? { gasLimit: creationGasLimit(config) } : {}
      )) as ethers.ContractTransactionResponse;
      setBusy("Deploying - waiting for the block…");
      const confirmed = await waitForDeployment(tx);
      const receipt = confirmed.receipt;

      let created = { token: "", launch: "", rulesHash: "" };
      for (const log of receipt.logs) {
        try {
          const parsed = walletFactory.interface.parseLog(log);
          if (parsed?.name === "LaunchCreated") {
            created = {
              token: ethers.getAddress(parsed.args.token as string),
              launch: ethers.getAddress(parsed.args.launch as string),
              rulesHash: parsed.args.rulesHash as string,
            };
            break;
          }
        } catch {
          continue;
        }
      }
      if (!created.launch) throw new Error("LaunchCreated event not found in the receipt.");

      const deployed: DeployResult = { ...created, txHash: confirmed.hash };
      setResult(deployed);
      setBusy("");
    } catch (issue) {
      setBusy("");
      const message = issue instanceof Error ? issue.message : "Deploy failed";
      setError(message.length > 220 ? `${message.slice(0, 220)}…` : message);
    }
  };

  const onLogoFile = async (file: File | undefined) => {
    setLogoError("");
    if (!file) return;
    if (!file.type.includes("svg")) {
      setLogoError("Only SVG files are supported.");
      return;
    }
    const text = await file.text();
    const uri = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(text)))}`;
    if (byteLength(uri) > 8192) {
      setLogoError(`Logo is ${byteLength(uri)} bytes - the contract caps it at 8192. Simplify the SVG.`);
      return;
    }
    setLogoSvgUri(uri);
  };

  const initials = (tokenSymbol || tokenName || "?").slice(0, 3).toUpperCase();
  const clock = (at: number) => (mounted ? formatClock(at) : "--:--");
  const day = (at: number) => (mounted ? formatDay(at) : "--/--");
  const startClock = clock(startTime);

  const symbolLabel = tokenSymbol.trim() || "tokens";
  const poolEthPct = protocolFeeBps === null ? null : Math.max(0, 100 - treasuryPct - protocolFeeBps / 100);
  const startOptions = IS_MAINNET
    ? [{ value: "1500", label: "In about a day (25 h)" }]
    : [
        { value: "15", label: "In 15 minutes" },
        { value: "30", label: "In 30 minutes" },
        { value: "60", label: "In 1 hour" },
        { value: "1500", label: "In about a day (25 h)" },
      ];
  const linkValue = (type: string) => links.find((link) => link.linkType === type)?.url ?? "";
  const setLinkValue = (type: string, url: string) =>
    setLinks((current) =>
      current.some((link) => link.linkType === type)
        ? current.map((link) => (link.linkType === type ? { ...link, url } : link))
        : [...current, { linkType: type, url }]
    );
  const friendlyProblems = problems.map((problem) => {
    if (problem === "token name") return "Give your token a name (step 1).";
    if (problem === "token symbol") return "Give your token a short ticker (step 1).";
    if (problem.startsWith("links must")) return "Links must start with https:// (step 1).";
    if (problem === "allocation over 100%") return "The token split adds up to more than 100% (step 2).";
    if (problem.startsWith("deployer allocation over")) return "Your own share of the tokens can be at most 10% (step 2).";
    if (problem.startsWith("treasury share over")) return "Your share of the ETH can be at most 10% (step 3).";
    if (problem === "treasury address") return "The address that receives your ETH share is not valid (step 3).";
    if (problem.startsWith("refund cost outside")) return "The take-back fee for rounds 3 and 4 must be between 1% and 25% (step 4).";
    if (problem.startsWith("start must be announced")) return "On mainnet a launch must be announced at least 24 hours ahead (step 4).";
    if (problem === "start time is in the past") return "The start time is in the past (step 4).";
    if (problem === "start time too close")
      return "Round 1 must open at least 5 minutes from now, so the transaction has time to confirm (step 4).";
    if (problem.startsWith("round length outside") || problem.startsWith("refund and claim windows"))
      return IS_MAINNET ? "On mainnet every round and window must last at least 1 hour (step 4)." : "Round lengths are out of range (step 4).";
    if (problem === "min commit below 0.001 ETH") return "The smallest amount must be at least 0.001 ETH (step 5).";
    if (problem === "phase-1 minimum below min commit") return "The round 1 minimum must be at least the smallest amount (step 5).";
    if (problem.startsWith("protocol not deployed")) return `D17 is not open on ${CHAIN_NAME} yet.`;
    if (problem === "protocol fee not loaded") return "Loading the D17 fee…";
    return problem;
  }).sort((left, right) => stepOf(left) - stepOf(right));

  const card = "border border-hairline bg-panel/40 px-5 py-5 sm:px-6";
  const stepTitle = "text-[18px] font-semibold text-ink";
  const help = "mt-1 text-[14px] leading-relaxed text-dim";
  const fieldLabel = "block text-[14px] font-semibold text-ink";
  const input =
    "mt-1.5 w-full border border-hairline bg-paper px-3 py-2.5 text-[16px] text-ink outline-none placeholder:text-quiet focus-visible:border-dim";
  const choice = (active: boolean) =>
    `w-full border px-4 py-3 text-left transition-colors ${active ? "border-ink bg-panel" : "border-hairline hover:border-dim"}`;
  const pctInput = (value: number, onChange: (value: number) => void, label: string) => (
    <span className="inline-flex items-center gap-1">
      <input
        type="number"
        min={0}
        max={100}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(clampPct(event.target.value))}
        className="w-20 border border-hairline bg-paper px-2 py-1.5 text-right text-[16px] tabular-nums text-ink outline-none focus-visible:border-dim"
      />
      <span className="text-[15px] text-dim">%</span>
    </span>
  );

  const guidedForm = (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-[26px] font-semibold leading-tight text-ink">Create a launch</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-dim">
          Answer six short steps. The rules you choose are locked into your launch forever: nobody, not you and not D17,
          can change them later. That is what lets people trust it.
        </p>
      </div>

      <section className={card}>
        <h2 className={stepTitle}>1. Your token</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label>
            <span className={fieldLabel}>Name</span>
            <input className={input} value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="My Token" />
          </label>
          <label>
            <span className={fieldLabel}>Ticker</span>
            <input className={input} value={tokenSymbol} onChange={(event) => setTokenSymbol(event.target.value.toUpperCase())} placeholder="MYTKN" />
            <span className="mt-1 block text-[13px] text-quiet">A short name, like ETH or PEPE.</span>
          </label>
        </div>
        <label className="mt-4 block">
          <span className={fieldLabel}>Description</span>
          <textarea
            className={`${input} h-24 resize-none`}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="One or two sentences people will read first."
          />
        </label>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label>
            <span className={fieldLabel}>Website (optional)</span>
            <input className={input} value={linkValue("website")} onChange={(event) => setLinkValue("website", event.target.value)} placeholder="https://…" />
          </label>
          <label>
            <span className={fieldLabel}>X / Twitter (optional)</span>
            <input className={input} value={linkValue("x")} onChange={(event) => setLinkValue("x", event.target.value)} placeholder="https://x.com/…" />
          </label>
        </div>
        <label className="mt-4 block">
          <span className={fieldLabel}>Logo (optional, SVG file up to 8 KB)</span>
          <input
            type="file"
            accept=".svg,image/svg+xml"
            onChange={(event) => void onLogoFile(event.target.files?.[0])}
            className="mt-1.5 block w-full text-[14px] text-dim file:mr-3 file:border file:border-hairline file:bg-paper file:px-3 file:py-1.5 file:text-[14px] file:text-ink"
          />
        </label>
        {logoError && <p className="mt-1 text-[14px] text-alert">{logoError}</p>}
      </section>

      <section className={card}>
        <h2 className={stepTitle}>2. How the tokens are shared</h2>
        <label className="mt-4 block">
          <span className={fieldLabel}>Total number of tokens</span>
          <input className={input} value={supply} onChange={(event) => setSupply(event.target.value)} inputMode="numeric" />
        </label>
        <div className="mt-4 flex h-3 w-full overflow-hidden border border-hairline" aria-hidden>
          <div style={{ width: `${Math.min(salePct, 100)}%` }} className="bg-ink" />
          <div style={{ width: `${Math.min(lpPct, Math.max(0, 100 - salePct))}%` }} className="bg-live" />
          <div style={{ width: `${Math.min(depPct, Math.max(0, 100 - salePct - lpPct))}%` }} className="bg-electric" />
        </div>
        <ul className="mt-4 flex flex-col gap-3 text-[15px]">
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="mr-2 inline-block h-2.5 w-2.5 bg-ink align-middle" aria-hidden />
              For buyers, sold in the 5 rounds
            </span>
            {pctInput(salePct, setSalePct, "Share for buyers")}
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="mr-2 inline-block h-2.5 w-2.5 bg-live align-middle" aria-hidden />
              Locked forever in the trading pool
            </span>
            {pctInput(lpPct, setLpPct, "Share locked in the trading pool")}
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="mr-2 inline-block h-2.5 w-2.5 bg-electric align-middle" aria-hidden />
              For you, unlocked little by little over 6 months (max 10%)
            </span>
            {pctInput(depPct, setDepPct, "Your share of the tokens")}
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2 text-dim">
            <span>
              <span className="mr-2 inline-block h-2.5 w-2.5 border border-hairline align-middle" aria-hidden />
              Destroyed (the rest)
            </span>
            <span className={`text-[16px] tabular-nums ${overAllocated ? "font-semibold text-alert" : "text-ink"}`}>
              {overAllocated ? "Over 100%" : `${deadAddressPct}%`}
            </span>
          </li>
        </ul>
        <p className={help}>
          {salePct === lpPct
            ? "Same share for buyers and for the pool: trading opens at the price buyers paid. "
            : "Tip: give the pool the same share as buyers, so trading opens at the price buyers paid. "}
          Tokens nobody buys are destroyed at the end of the sale.
        </p>
      </section>

      <section className={card}>
        <h2 className={stepTitle}>3. What you earn</h2>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[15px]">
          <span className="font-semibold text-ink">Your share of the ETH raised (0 to 10%)</span>
          {pctInput(treasuryPct, setTreasuryPct, "Your share of the ETH raised")}
        </div>
        <label className="mt-4 block">
          <span className={fieldLabel}>Sent to this address</span>
          <input className={input} value={treasury} onChange={(event) => setTreasury(event.target.value)} placeholder="Your wallet (filled in when you connect)" />
        </label>
        <p className={help}>
          Out of every 1 ETH that stays in the sale:{" "}
          <span className="font-semibold text-ink">{poolEthPct === null ? "…" : `${poolEthPct}%`}</span> is locked forever in
          the trading pool, <span className="font-semibold text-ink">{treasuryPct}%</span> goes to you
          {protocolFeeBps !== null && protocolFeeBps > 0 ? (
            <>
              {" "}
              and <span className="font-semibold text-ink">{protocolFeeBps / 100}%</span> is the D17 fee
            </>
          ) : null}
          . You never receive ETH from refunds or from a cancelled launch.
        </p>
      </section>

      <section className={card}>
        <h2 className={stepTitle}>4. When and how long</h2>
        <label className="mt-4 block">
          <span className={fieldLabel}>Round 1 opens</span>
          <select
            value={customStart ? "custom" : opensIn}
            onChange={(event) =>
              event.target.value === "custom"
                ? setCustomStart(toDateTimeLocal(new Date(Date.now() + (IS_MAINNET ? 26 : 1) * 3_600_000)))
                : (setCustomStart(""), setOpensIn(event.target.value))
            }
            className={input}
          >
            {startOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value="custom">At a date and time I choose</option>
          </select>
        </label>
        {customStart && (
          <input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} className={input} />
        )}
        <p className="mt-1 text-[13px] text-quiet">
          {mounted ? `Opens ${new Date(startTime * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.` : ""}
          {IS_MAINNET ? " On mainnet, launches are announced at least 24 hours ahead." : ""}
        </p>
        <p className={`${fieldLabel} mt-5`}>Length of the sale</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {(Object.keys(DURATION_PRESETS) as Exclude<DurationPreset, "custom">[]).map((key) => {
            const preset = DURATION_PRESETS[key];
            const unavailable = IS_MAINNET && key === "quick";
            return (
              <button
                key={key}
                type="button"
                disabled={unavailable}
                onClick={() => applyDuration(key)}
                aria-pressed={durationPreset === key}
                className={`${choice(durationPreset === key)} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                <span className="block text-[15px] font-semibold text-ink">{preset.label}</span>
                <span className="mt-0.5 block text-[13px] text-dim">{unavailable ? "Not allowed on mainnet" : preset.detail}</span>
              </button>
            );
          })}
        </div>
        {durationPreset === "custom" && (
          <p className="mt-2 text-[13px] text-quiet">Custom durations set in Advanced settings.</p>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-[15px]">
          <span className="font-semibold text-ink">Fee to take ETH back after rounds 3 and 4 (1 to 25%)</span>
          {pctInput(refundCostPct, setRefundCostPct, "Take-back fee after rounds 3 and 4")}
        </div>
        <p className={help}>
          After each of the first 4 rounds, buyers get a short window to take their ETH back: 1% after rounds 1 and 2, the
          fee above after rounds 3 and 4. These fees go into the trading pool, never to you.
        </p>
      </section>

      <section className={card}>
        <h2 className={stepTitle}>5. Safety net</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label>
            <span className={fieldLabel}>Minimum to raise in round 1 (ETH)</span>
            <input className={input} value={minPhase1Weth} onChange={(event) => setMinPhase1Weth(event.target.value)} inputMode="decimal" />
          </label>
          <label>
            <span className={fieldLabel}>Smallest amount per person (ETH)</span>
            <input className={input} value={minCommit} onChange={(event) => setMinCommit(event.target.value)} inputMode="decimal" />
          </label>
        </div>
        <p className={help}>
          If round 1 raises less than the minimum, the launch is cancelled and everyone gets all of their ETH back. Round 1
          also sets the lowest price: no later round can sell cheaper.
        </p>
      </section>

      <section className={card}>
        <h2 className={stepTitle}>6. Check and create</h2>
        <div className="mt-4 flex items-center gap-3">
          {logoSvgUri ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={logoSvgUri} alt="" className="h-12 w-12 border border-hairline" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center border border-hairline text-[13px] font-semibold text-dim">{initials}</div>
          )}
          <div className="min-w-0">
            <p className="text-[18px] font-semibold text-ink">
              {tokenName.trim() || "Your token"} <span className="text-[15px] font-normal text-dim">({tokenSymbol.trim() || "TICKER"})</span>
            </p>
            <p className="truncate text-[14px] text-dim">{description.trim() || "Your description shows here."}</p>
          </div>
        </div>
        <ul className="mt-4 flex list-disc flex-col gap-1.5 pl-5 text-[15px] leading-relaxed text-dim">
          <li>
            {compact(supplyTokens)} {symbolLabel}: {salePct}% for buyers, {lpPct}% locked in the pool
            {depPct > 0 ? `, ${depPct}% for you over 6 months` : ""}
            {!overAllocated && deadAddressPct > 0 ? `, ${deadAddressPct}% destroyed` : ""}.
          </li>
          <li>
            Opens {mounted ? new Date(startTime * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "…"}:{" "}
            {durationPreset !== "custom" ? DURATION_PRESETS[durationPreset].detail.split(" · ")[0] : "5 rounds"}.
          </li>
          <li>
            Round 1 must raise at least {minPhase1Weth || "0"} ETH, or everyone is refunded.
          </li>
          <li>
            You receive {treasuryPct}% of the ETH raised{depPct > 0 ? ` and ${depPct}% of the tokens over 6 months` : ""}.
          </li>
        </ul>
        {!ready && (
          <ul className="mt-4 flex flex-col gap-1 border-l-2 border-alert pl-3 text-[14px] text-dim">
            {friendlyProblems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {error && (
          <p className="mt-4 text-[14px] text-alert" role="alert">
            {error}
          </p>
        )}
        {result ? (
          <div className="mt-5">
            <p className="text-[18px] font-semibold text-live">Your launch is created ✓</p>
            <p className={help}>Share the link of your launch page so people can join when round 1 opens.</p>
            <a
              href={d17Href("/", { launch: result.launch })}
              className="mt-3 block w-full bg-ink px-4 py-3 text-center text-[15px] font-semibold text-paper hover:opacity-90"
            >
              Open my launch page
            </a>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={walletAddress ? () => void deploy() : () => void connectWallet()}
              disabled={Boolean(busy) || (Boolean(walletAddress) && !ready)}
              className="mt-5 h-12 w-full bg-ink px-4 text-[15px] font-semibold text-paper transition-opacity disabled:opacity-40"
            >
              {busy ? plainBusy(busy) : walletAddress ? "Create my launch" : "Connect my wallet"}
            </button>
            <p className="mt-2 text-[13px] leading-relaxed text-quiet">
              We first test your launch for free. Your wallet then asks you to confirm one transaction (you only pay the network
              fee).{" "}
              {IS_MAINNET ? "This is mainnet: real ETH." : `This is ${CHAIN_NAME}: test ETH only.`}
            </p>
          </>
        )}
      </section>

      <p className="pt-1 text-center text-[14px] text-dim">
        Need every setting (round shares, exact durations, price floor)?{" "}
        <button type="button" onClick={() => changeMode(true)} className="text-electric underline underline-offset-2 hover:text-ink">
          Advanced settings
        </button>
      </p>
    </div>
  );

  return (
    <main className="min-h-dvh bg-paper text-ink">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-3 sm:px-6">
        <p className="font-mono text-[12px] uppercase tracking-[0.04em]">
          <a href={d17Href("/")} className="font-semibold text-ink hover:underline">
            D17
          </a>{" "}
          {advanced && <span className="text-dim">Launch terminal</span>}{" "}
          <span className="text-live">· {advanced ? "Deploy" : "Create a launch"}</span> <span className="text-quiet">{NETWORK_LABEL}</span>
        </p>
        <div className="flex items-center gap-3">
          <NetworkSwitch disabled={Boolean(busy)} />
          <button
            type="button"
            onClick={() => changeMode(!advanced)}
            className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink"
          >
            {advanced ? "Guided form" : "Advanced settings"}
          </button>
          <a href={d17Href("/")} className="font-mono text-[10px] uppercase tracking-[0.02em] text-quiet transition-colors hover:text-ink">
            {advanced ? "Terminal" : "All launches"}
          </a>
          <button type="button" onClick={connectWallet} className="border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.02em] text-paper">
            {walletAddress ? shortAddress(walletAddress) : "Connect wallet"}
          </button>
        </div>
      </header>

      {!advanced ? (
        guidedForm
      ) : (
      <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-hairline px-4 py-2 font-mono text-[10px] uppercase tracking-[0.02em] sm:px-6">
        <span className="text-quiet">How a launch runs</span>
        <span className="text-dim">
          Rounds raise ETH <span className="text-quiet">→</span> refunds let people leave <span className="text-quiet">→</span> finalize{" "}
          <span className="text-quiet">→</span> claim <span className="text-quiet">→</span> trading
        </span>
      </div>

      <div className="mx-auto grid max-w-6xl gap-0 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="border-hairline px-4 py-5 sm:px-6 xl:border-r">
          <section>
            <h2 className={H2}>01 · Token</h2>
            <p className={HINT}>The identity participants verify - it gets hashed on-chain.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className={LABEL}>Name</span>
                <input className={FIELD} value={tokenName} onChange={(event) => setTokenName(event.target.value)} placeholder="Example Token" />
              </label>
              <label className="block">
                <span className={LABEL}>Symbol</span>
                <input className={FIELD} value={tokenSymbol} onChange={(event) => setTokenSymbol(event.target.value)} placeholder="EXAMPLE" />
              </label>
              <label className="block">
                <span className={LABEL}>Total supply</span>
                <input className={FIELD} value={supply} onChange={(event) => setSupply(event.target.value)} inputMode="numeric" />
              </label>
              <label className="block">
                <span className={LABEL}>Logo (SVG, ≤8 KB on-chain)</span>
                <input type="file" accept=".svg,image/svg+xml" onChange={(event) => void onLogoFile(event.target.files?.[0])} className="mt-1 block w-full font-mono text-[10px] text-dim file:mr-2 file:border file:border-hairline file:bg-paper file:px-2 file:py-1 file:font-mono file:text-[10px] file:uppercase file:text-dim" />
              </label>
            </div>
            {logoError && <p className="mt-1 font-mono text-[10px] uppercase text-alert">{logoError}</p>}
            <label className="mt-2 block">
              <span className={LABEL}>Description (≤512 bytes)</span>
              <textarea className={`${FIELD} h-16 resize-none`} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="One or two sentences participants will read first." />
            </label>
            <div className="mt-2 grid gap-2">
              {links.map((link, index) => (
                <div key={index} className="grid grid-cols-[7rem_1fr] gap-2">
                  <input className={FIELD} value={link.linkType} onChange={(event) => setLinks((current) => current.map((row, i) => (i === index ? { ...row, linkType: event.target.value } : row)))} placeholder="website" />
                  <input className={FIELD} value={link.url} onChange={(event) => setLinks((current) => current.map((row, i) => (i === index ? { ...row, url: event.target.value } : row)))} placeholder="https://…" />
                </div>
              ))}
              <button type="button" onClick={() => setLinks((current) => [...current, { linkType: "", url: "" }])} className="justify-self-start font-mono text-[10px] uppercase tracking-[0.02em] text-electric hover:text-ink">
                + Link
              </button>
            </div>
          </section>

          <section className="mt-6 border-t border-hairline pt-5">
            <h2 className={H2}>02 · Economics</h2>
            <p className={HINT}>
              Set sale, LP, and deployer - the remainder goes to the canonical dead address. Deployer tokens vest to your
              wallet linearly over {vestingDays} days once trading opens.
            </p>
            <div className="mt-3 flex h-4 border border-hairline" aria-hidden>
              <div style={{ width: `${Math.min(salePct, 100)}%` }} className="bg-ink" />
              <div style={{ width: `${Math.min(lpPct, Math.max(0, 100 - salePct))}%` }} className="bg-dim" />
              {supportsManualDistribution && <div style={{ width: `${Math.min(depPct, Math.max(0, 100 - salePct - lpPct))}%` }} className="bg-electric" />}
              <div style={{ width: `${Math.max(0, 100 - salePct - lpPct - (supportsManualDistribution ? depPct : 0))}%` }} className="bg-faint" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-[0.02em]">
              <label className="flex items-center gap-2 text-quiet">
                Sale
                <input type="number" min={0} max={100} value={salePct} onChange={(event) => setSalePct(clampPct(event.target.value))} className={`${FIELD} w-16 py-1`} />%
              </label>
              <label className="flex items-center gap-2 text-quiet">
                LP
                <input type="number" min={0} max={100} value={lpPct} onChange={(event) => setLpPct(clampPct(event.target.value))} className={`${FIELD} w-16 py-1`} />%
              </label>
              {supportsManualDistribution && (
                <label className="flex items-center gap-2 text-quiet">
                  Deployer
                  <input type="number" min={0} max={100} value={depPct} onChange={(event) => setDepPct(clampPct(event.target.value))} className={`${FIELD} w-16 py-1`} />%
                </label>
              )}
              <span className="text-quiet">
                Dead address (auto) <span className={overAllocated ? "font-semibold text-alert" : "font-semibold text-ink"}>{overAllocated ? "Over 100%" : `${deadAddressPct}%`}</span>
              </span>
            </div>
            {supportsManualDistribution && depPct > 0 && !overAllocated && (
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                Deployer airdrop ·{" "}
                <span className="font-semibold text-ink tabular-nums">
                  {depTokens.toLocaleString("en-US")} {tokenSymbol.trim() || "tokens"}
                </span>{" "}
                vest to your wallet over {vestingDays} days after trading opens
              </p>
            )}
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <label className="block">
                <span className={LABEL}>Treasury % (ETH, max {treasuryMaxBps / 100}%)</span>
                <input type="number" min={0} max={100} step="0.5" value={treasuryPct} onChange={(event) => setTreasuryPct(clampPct(event.target.value))} className={FIELD} />
              </label>
              <label className="block">
                <span className={LABEL}>Treasury address</span>
                <input className={FIELD} value={treasury} onChange={(event) => setTreasury(event.target.value)} placeholder="defaults to your wallet" />
              </label>
              <label className="block">
                <span className={LABEL}>Min commit (WETH)</span>
                <input className={FIELD} value={minCommit} onChange={(event) => setMinCommit(event.target.value)} inputMode="decimal" />
              </label>
            </div>
            <p className={HINT}>
              Protocol fee:{" "}
              <span className="font-semibold text-ink">
                {protocolFeeBps === null ? "-" : `${protocolFeeBps / 100}%`}
              </span>{" "}
              of each successful commitment (hard cap 2%, fixed into your launch&apos;s rules). Never charged on refunds or a
              failed launch. With your treasury share, participants see{" "}
              <span className="font-semibold text-ink">
                {protocolFeeBps === null ? "-" : `${100 - treasuryPct - protocolFeeBps / 100}%`}
              </span>{" "}
              of every successful commitment locked in the official pool.
            </p>
          </section>

          <section className="mt-6 border-t border-hairline pt-5">
            <h2 className={H2}>03 · Rounds &amp; schedule</h2>
            <p className={HINT}>Five rounds, fixed by the contract - the preset covers most launches.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.02em] text-quiet">
              Round 1 opens
              <select value={customStart ? "custom" : opensIn} onChange={(event) => (event.target.value === "custom" ? setCustomStart(toDateTimeLocal(new Date(Date.now() + 3_600_000))) : (setCustomStart(""), setOpensIn(event.target.value)))} className={`${FIELD} w-auto py-1`}>
                <option value="15">in 15 min</option>
                <option value="30">in 30 min</option>
                <option value="60">in 1 hour</option>
                <option value="1500">in 25 hours</option>
                <option value="custom">at a set time</option>
              </select>
              {customStart ? (
                <input type="datetime-local" value={customStart} onChange={(event) => setCustomStart(event.target.value)} className={`${FIELD} w-auto py-1`} />
              ) : (
                <span>
                  = <span className="text-ink">{startClock}</span> local
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-[1fr_.9fr_1.3fr_.7fr] gap-x-3 border-b border-hairline pb-1 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
              <span>Round</span>
              <span className="text-right">Allocation</span>
              <span className="text-right">Length · minutes</span>
              <span className="text-right">Refund</span>
            </div>
            {sharesPct.map((pct, index) => (
              <div key={index} className="grid grid-cols-[1fr_.9fr_1.3fr_.7fr] items-center gap-x-3 border-b border-faint py-1 font-mono text-[11px] uppercase tracking-[0.02em] text-dim">
                <span>Round {index + 1}</span>
                <span className="flex items-center justify-end gap-1">
                  <input type="number" min={0} max={100} value={pct} onChange={(event) => setSharesPct((current) => current.map((value, i) => (i === index ? clampPct(event.target.value) : value)))} className={`${FIELD} w-16 py-0.5 text-right`} />%
                </span>
                <span className="flex items-center justify-end gap-1.5">
                  <input type="number" min={1} value={roundMinutes[index]} onChange={(event) => setRoundMinutes((current) => current.map((value, i) => (i === index ? Math.max(1, Number(event.target.value) || 1) : value)))} className={`${FIELD} w-16 py-0.5 text-right`} />
                  {roundMinutes[index] >= 60 && <span className="text-quiet whitespace-nowrap">= {humanMinutes(roundMinutes[index])}</span>}
                </span>
                <span className={`text-right ${index >= ROUND_COUNT - 1 ? "text-quiet" : index >= 2 ? "" : "text-live"}`}>
                  {index >= ROUND_COUNT - 1 ? "None" : index >= 2 ? `${refundCostPct}%` : `${earlyRefundPct}%`}
                </span>
              </div>
            ))}
            <p className={`mt-1 font-mono text-[10px] uppercase tracking-[0.02em] ${sharesSum === 100 ? "text-quiet" : "text-alert"}`}>
              Shares total {sharesSum}% {sharesSum === 100 ? "✓" : "- must be 100%"}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <label className="block">
                <span className={LABEL}>Refund window · minutes{refundMinutes >= 60 ? ` = ${humanMinutes(refundMinutes)}` : ""}</span>
                <input type="number" min={1} value={refundMinutes} onChange={(event) => setRefundMinutes(Math.max(1, Number(event.target.value) || 1))} className={FIELD} />
              </label>
              <label className="block">
                <span className={LABEL}>Refund cost % (rounds 3–4, {refundPenaltyMinBps / 100}–{refundPenaltyMaxBps / 100}%)</span>
                <input type="number" min={refundPenaltyMinBps / 100} max={refundPenaltyMaxBps / 100} value={refundCostPct} onChange={(event) => setRefundCostPct(clampPct(event.target.value))} className={FIELD} />
              </label>
              <label className="block">
                <span className={LABEL}>Claim window · minutes{settlementMinutes >= 60 ? ` = ${humanMinutes(settlementMinutes)}` : ""}</span>
                <input type="number" min={1} value={settlementMinutes} onChange={(event) => setSettlementMinutes(Math.max(1, Number(event.target.value) || 1))} className={FIELD} />
              </label>
            </div>
          </section>

          <section className="mt-6 border-t border-hairline pt-5">
            <h2 className={H2}>04 · Deploy</h2>
            <p className={HINT}>Simulated first - you only sign what already passed.</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <label className="block">
                <span className={LABEL}>Round 1 floor (WETH)</span>
                <input className={FIELD} value={minPhase1Weth} onChange={(event) => setMinPhase1Weth(event.target.value)} inputMode="decimal" />
              </label>
              <label className="block">
                <span className={LABEL}>Anchor price floor (ETH/token)</span>
                <input className={FIELD} value={minAnchorPrice} onChange={(event) => setMinAnchorPrice(event.target.value)} inputMode="decimal" />
              </label>
              <label className="block">
                <span className={LABEL}>Factory</span>
                <input className={FIELD} value={factoryAddress} readOnly aria-readonly="true" />
              </label>
            </div>
            <p className={HINT}>
              Round 1 sets the anchor price (raised ÷ its allocation). If it raises less than the floor - or the price lands
              below the anchor floor - the launch fails and every remaining commitment refunds in full. No round, including the
              final one, sells below the anchor price.
            </p>
            <p className={HINT}>
              Unsold sale tokens and the matching share of the LP allocation are always burned at finalization. Refund
              penalties deepen the official pool. Your treasury only receives its published ETH share.
            </p>
            {!ready && (
              <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                Missing: <span className="text-dim">{problems.join(" · ")}</span>
              </p>
            )}
            {error && (
              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.02em] text-alert" role="alert">
                {error}
              </p>
            )}
            {/* Success replaces the CTA in place so confirmation appears where
                the user's eyes already are, not in the preview column. */}
            {result ? (
              <>
                <a
                  href={d17Href("/", { launch: result.launch })}
                  className="mt-3 block w-full border border-live px-3 py-2.5 text-center font-mono text-[12px] uppercase tracking-[0.04em] text-live transition-colors hover:bg-faint"
                >
                  Launch deployed ✓ - open your launch page →
                </a>
                <p className="mt-2 text-center font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                  <span className="normal-case text-dim">{shortAddress(result.launch)}</span> ·{" "}
                  <a href={`${EXPLORER_BASE}/tx/${result.txHash}`} target="_blank" rel="noreferrer" className="text-electric hover:text-ink">
                    Deployment transaction ↗
                  </a>{" "}
                  · Deploy in the top bar brings you back here
                </p>
              </>
            ) : (
              <button
                type="button"
                onClick={walletAddress ? () => void deploy() : () => void connectWallet()}
                disabled={Boolean(busy) || (Boolean(walletAddress) && !ready)}
                className="mt-3 w-full border border-ink bg-ink px-3 py-2.5 font-mono text-[12px] uppercase tracking-[0.04em] text-paper transition-opacity disabled:opacity-40"
              >
                {busy || (walletAddress ? "Deploy launch →" : "Connect wallet →")}
              </button>
            )}
            {/* Known contract limits are driven by the bundled schema. */}
            {(() => {
              const ids = (schema?.knownContractGaps ?? [])
                .map((gap) => gap.id)
                .filter((id): id is string => Boolean(id));
              const lines = ids.map((id) => id.replace(/-/g, " "));
              if (lines.length === 0) return null;
              return (
                <div className="mt-3 border border-hairline px-3 py-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.02em] text-dim">
                  <p className="text-quiet">Known contract limits</p>
                  <div className="mt-1">
                    {lines.map((line) => (
                      <p key={line}>· {line}</p>
                    ))}
                  </div>
                </div>
              );
            })()}
            <p className="mt-2 border border-hairline px-3 py-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.02em] text-quiet">
              {IS_MAINNET
                ? "Mainnet uses real assets. Review every field and wallet transaction before signing."
                : "Sepolia uses test assets. Switch to Mainnet only when you intend to use real ETH."}
            </p>
          </section>
        </div>

        <div className="px-4 py-5 sm:px-6">
          <p className={LABEL}>Live preview - what participants see</p>
          <div className="mt-2 border border-hairline p-3">
            <div className="flex items-center gap-3">
              {logoSvgUri ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={logoSvgUri} alt="" className="h-9 w-9 border border-hairline" />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center border border-hairline font-mono text-[10px] uppercase text-quiet">{initials}</div>
              )}
              <div className="min-w-0">
                <p className="font-mono text-[13px] font-semibold text-ink">
                  {tokenName || "Your token"} <span className="font-normal text-dim">{tokenSymbol || "TKN"}</span>{" "}
                  <span className="text-live">✓ verified</span>
                </p>
                <p className="truncate font-mono text-[11px] text-dim">{description || "Your description shows here."}</p>
              </div>
            </div>
            <p className="mt-2.5 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet tabular-nums">
              Supply <span className="font-semibold text-dim">{compact(supplyTokens)}</span> · Sale{" "}
              <span className="font-semibold text-dim">{salePct}%</span> · LP <span className="font-semibold text-dim">{lpPct}%</span>
              {supportsManualDistribution && depPct > 0 && (
                <>
                  {" "}
                  · Deployer <span className="font-semibold text-dim">{depPct}%</span>
                </>
              )}{" "}
              · Dead address <span className="font-semibold text-dim">{overAllocated ? "-" : `${deadAddressPct}%`}</span> · Treasury{" "}
              <span className="font-semibold text-dim">{treasuryPct}% ETH</span> · Protocol{" "}
              <span className="font-semibold text-dim">{protocolFeeBps === null ? "-" : `${protocolFeeBps / 100}%`} ETH</span>
            </p>
          </div>

          <div className="border-x border-b border-hairline p-3">
            <p className={LABEL}>Rounds · {day(startTime)}</p>
            <div className="mt-1 grid grid-cols-[1fr_.7fr_1.3fr_.7fr] gap-x-2 border-b border-hairline pb-1 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
              <span>Round</span>
              <span className="text-right">Alloc</span>
              <span className="text-right">Time</span>
              <span className="text-right">Refund</span>
            </div>
            {schedule.map((round) => (
              <div key={round.id} className="grid grid-cols-[1fr_.7fr_1.3fr_.7fr] gap-x-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.02em] text-dim tabular-nums">
                <span>Round {round.id}</span>
                <span className="text-right">{round.pct}%</span>
                <span className="text-right">
                  {clock(round.opens)} → {clock(round.closes)}
                </span>
                <span className={`text-right ${round.id <= 2 ? "text-live" : ""}`}>{round.refund}</span>
              </div>
            ))}
          </div>

          <div className="border-x border-b border-hairline p-3">
            <p className={LABEL}>After you deploy</p>
            <ol className="mt-1.5 grid gap-1 font-mono text-[11px] uppercase tracking-[0.02em] text-dim">
              <li>
                <span className="text-live">1</span> Sign once - token, launch, and vault deploy together
              </li>
              <li>
                <span className="text-live">2</span>{" "}
                {result ? <span className="text-live">Confirmed on-chain ✓</span> : "The receipt reveals the launch address"}
              </li>
              <li>
                <span className="text-live">3</span>{" "}
                {result ? (
                  <a href={d17Href("/", { launch: result.launch })} className="text-electric hover:text-ink">
                    Open your launch page →
                  </a>
                ) : (
                  "Your launch page goes live - share the link"
                )}
              </li>
              <li>
                <span className="text-live">4</span> Round 1 opens at <span className="text-ink">{startClock}</span>
              </li>
            </ol>
            {result && (
              <div className="mt-2 border-t border-faint pt-2 font-mono text-[10px] uppercase tracking-[0.02em] text-quiet">
                <p>
                  Launch <span className="normal-case text-dim">{shortAddress(result.launch)}</span> · Token{" "}
                  <span className="normal-case text-dim">{shortAddress(result.token)}</span>
                </p>
                <p className="mt-0.5">
                  <a href={`${EXPLORER_BASE}/tx/${result.txHash}`} target="_blank" rel="noreferrer" className="text-electric hover:text-ink">
                    Deployment transaction ↗
                  </a>{" "}
                  · Rules <span className="normal-case text-dim">{result.rulesHash.slice(0, 10)}…</span>
                </p>
              </div>
            )}
          </div>

          <p className="mt-3 border border-hairline px-3 py-2 font-mono text-[10px] uppercase leading-relaxed tracking-[0.02em] text-quiet">
            The ✓ is earned, not granted - publish exactly this and the rules hash verifies on-chain automatically.
          </p>
        </div>
      </div>
      </>
      )}
    </main>
  );
}

/** Step number quoted in a guided-form message ("(step 3)"), for ordering; 9 when none. */
function stepOf(message: string) {
  const match = /\(step (\d)\)/.exec(message);
  return match ? Number(match[1]) : 9;
}

/** The deploy steps in plain words for the guided form. */
function plainBusy(busy: string) {
  if (busy.startsWith("Simulating")) return "Testing your launch…";
  if (busy.startsWith("Waiting for your signature")) return "Confirm in your wallet…";
  if (busy.startsWith("Deploying")) return "Creating your launch…";
  return busy;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

async function assertDeployFactorySuite(factory: ethers.Contract) {
  const [factoryId, weth, router, launchFactory, lockerFactory, owner, launchPinned, lockerPinned, feeConfig] = await Promise.all([
    factory.D17_FACTORY_ID(),
    factory.weth(),
    factory.router(),
    factory.launchFactory(),
    factory.lockerFactory(),
    factory.owner(),
    factory.launchFactoryPinned(),
    factory.lockerFactoryPinned(),
    factory.feeConfig(),
  ]);
  if (factoryId !== EXPECTED_FACTORY_ID) throw new Error("The bundled address is not the expected D17 factory.");
  if (!sameAddress(weth, PUBLIC_DEPLOYMENT.weth) || !sameAddress(router, PUBLIC_DEPLOYMENT.router)) {
    throw new Error("The D17 factory has unexpected WETH or router wiring.");
  }
  if (
    !sameAddress(launchFactory, PUBLIC_DEPLOYMENT.contracts.launchFactory)
    || !sameAddress(lockerFactory, PUBLIC_DEPLOYMENT.contracts.lockerFactory)
    || !sameAddress(feeConfig, PUBLIC_DEPLOYMENT.contracts.feeConfig)
  ) {
    throw new Error("The D17 factory-suite wiring does not match the bundled deployment manifest.");
  }
  if (!launchPinned || !lockerPinned || !sameAddress(owner, ethers.ZeroAddress)) {
    throw new Error("The D17 factory is not pinned and ownership-renounced as expected.");
  }
}

async function waitForDeployment(tx: ethers.ContractTransactionResponse) {
  try {
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error("createLaunch reverted");
    return { receipt, hash: tx.hash };
  } catch (error) {
    const replacement = error as {
      code?: string;
      cancelled?: boolean;
      receipt?: ethers.TransactionReceipt | null;
      replacement?: { hash?: string };
    };
    if (replacement.code !== "TRANSACTION_REPLACED" || replacement.cancelled) throw error;
    if (!replacement.receipt || replacement.receipt.status !== 1) throw new Error("Replacement deployment reverted");
    return { receipt: replacement.receipt, hash: replacement.replacement?.hash || replacement.receipt.hash };
  }
}

function sameAddress(left: string, right: string) {
  return ethers.isAddress(left) && ethers.isAddress(right) && ethers.getAddress(left) === ethers.getAddress(right);
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function decimalToWei(value: string) {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return 0n;
  try {
    return ethers.parseUnits(trimmed, 18);
  } catch {
    return 0n;
  }
}

function clampPct(raw: string) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function compact(value: number) {
  if (value >= 1_000_000_000) return `${trimZeros((value / 1_000_000_000).toFixed(2))}B`;
  if (value >= 1_000_000) return `${trimZeros((value / 1_000_000).toFixed(2))}M`;
  if (value >= 1_000) return `${trimZeros((value / 1_000).toFixed(2))}K`;
  return String(value);
}

function trimZeros(value: string) {
  return value.replace(/\.?0+$/, "");
}

/** 90 → "1h 30m", 2880 → "2d" - so long rounds never read as raw minutes. */
function humanMinutes(minutes: number) {
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    const hours = Math.round((minutes % 1440) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatClock(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDay(unixSeconds: number) {
  return new Date(unixSeconds * 1000).toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}

function toDateTimeLocal(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
