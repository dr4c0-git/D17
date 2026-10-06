import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const here = path.dirname(fileURLToPath(import.meta.url));
const abiDir = path.resolve(here, "../abi");

const args = parseArgs(process.argv.slice(2));
const API_BASE = stripTrailingSlash(args.apiBase || process.env.API_BASE || "http://127.0.0.1:8789");
const LAUNCH_ADDRESS = args.launch || process.env.LAUNCH_ADDRESS || "";
const RPC_URL = args.rpcUrl || process.env.RPC_URL || "";
const CHAIN_ID = Number(args.chainId || process.env.CHAIN_ID || 11155111);

if (!LAUNCH_ADDRESS) {
  console.error("Usage: API_BASE=http://127.0.0.1:8789 LAUNCH_ADDRESS=0x... [RPC_URL=...] node scripts/verify-launch-api.mjs");
  process.exit(2);
}

const launchAddress = ethers.getAddress(LAUNCH_ADDRESS);
const api = await fetchJson(`${API_BASE}/api/launches/${launchAddress}`);
const launch = api.data;
const checks = [];

check(Boolean(launch?.phase), "api exposes phase");
check(Boolean(launch?.config), "api exposes config");
check(Boolean(launch?.tokenomics), "api exposes tokenomics");
check(Array.isArray(launch?.rounds) && launch.rounds.length === 5, "api exposes 5 rounds");
check(launch?.tokenomics?.manualDistributionTokens != null, "api exposes manualDistributionTokens");
check(launch?.tokenomics?.deployerAirdropTokens != null, "api exposes deployerAirdropTokens");
check(Boolean(launch?.poolComposition), "api exposes poolComposition");
check(launch?.poolComposition?.initial?.tokenUsedForLp != null, "poolComposition exposes initial tokenUsedForLp");
check(launch?.poolComposition?.lateTopUp?.tokenUsedForLp != null, "poolComposition exposes late top-up tokenUsedForLp");
check(launch?.poolComposition?.reserved?.remainingLpTokens != null, "poolComposition exposes reserved LP-token remainder");
check(launch?.rounds?.every((round) => round.refundPolicy), "api exposes per-round refund policy");
// V15: rounds 1-2 pay the fixed 1% early penalty, rounds 3-4 pay refundPenaltyBps.
check(launch?.rounds?.[0]?.refundPolicy?.deflectionCostBps === 100, "round 1 deflection is the 1% early penalty");
if (launch?.config?.version === "D17_CURRENT") {
  check(launch?.rounds?.[1]?.refundPolicy?.deflectionCostBps === 100, "round 2 deflection is the 1% early penalty");
  check(launch?.rounds?.[2]?.refundPolicy?.deflectionCostBps === Number(launch.config.refundPenaltyBps || 0), "round 3 deflection equals refundPenaltyBps");
  check(launch?.config?.refundPenaltySchedule?.[1]?.appliesPenalty === true, "config marks round 2 costed");
  check(launch?.config?.refundPenaltySchedule?.[2]?.appliesPenalty === true, "config marks round 3 costed");
}
check(launch?.rounds?.[4]?.refundPolicy?.refundable === false, "round 5 has no normal refund window");

if (RPC_URL) {
  const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
  const launchAbi = JSON.parse(readFileSync(path.join(abiDir, "D17Launch.abi.json"), "utf8"));
  const vaultAbi = JSON.parse(readFileSync(path.join(abiDir, "D17LiquidityVault.abi.json"), "utf8"));
  const contract = new ethers.Contract(launchAddress, launchAbi, provider);
  const [
    phase,
    launchId,
    refundPenaltyBps,
    refundSeconds,
    saleTokens,
    lpTokens,
    manualDistributionTokens,
    manualDistributionRecipient,
    deadTokens,
    treasuryBps,
    minCommitWeth,
    officialPair,
    officialTokenUsedForLp,
    officialWethUsedForLp,
    officialLpMinted,
    finalCommittedWeth,
    settledCommittedWeth,
    totalLiquidityWeth,
    settledLiquidityWeth,
    lateSettledCommittedWeth,
    lateSettledLiquidityWeth,
    lateLpTokensReleased,
    vaultLiquidityTokensClaimed,
    roundSharesBps,
    roundStart,
    roundEnd,
    roundDiscoveredPriceWad
  ] = await Promise.all([
    contract.launchPhase(),
    contract.D17_LAUNCH_ID(),
    contract.refundPenaltyBps(),
    contract.refundSeconds(),
    contract.saleTokens(),
    contract.lpTokens(),
    contract.manualDistributionTokens().catch(() => 0n),
    contract.manualDistributionRecipient().catch(() => ethers.ZeroAddress),
    contract.deadTokens(),
    contract.treasuryBps(),
    contract.minCommitWeth(),
    contract.officialPair(),
    contract.officialTokenUsedForLp().catch(() => 0n),
    contract.officialWethUsedForLp().catch(() => 0n),
    contract.officialLpMinted().catch(() => 0n),
    contract.finalCommittedWeth().catch(() => 0n),
    contract.settledCommittedWeth().catch(() => 0n),
    contract.totalLiquidityWeth().catch(() => 0n),
    contract.settledLiquidityWeth().catch(() => 0n),
    contract.lateSettledCommittedWeth().catch(() => 0n),
    contract.lateSettledLiquidityWeth().catch(() => 0n),
    contract.lateLpTokensReleased().catch(() => 0n),
    contract.vaultLiquidityTokensClaimed().catch(() => 0n),
    Promise.all(Array.from({ length: 5 }, (_, round) => contract.roundSharesBps(round))),
    Promise.all(Array.from({ length: 5 }, (_, round) => contract.roundStart(round))),
    Promise.all(Array.from({ length: 5 }, (_, round) => contract.roundEnd(round))),
    Promise.all(Array.from({ length: 5 }, (_, round) => contract.roundDiscoveredPriceWad(round)))
  ]);
  const vaultAddress = launch.liquidityVault || await contract.liquidityVault();
  const vault = new ethers.Contract(vaultAddress, vaultAbi, provider);
  const [lateTokenUsedForLp, lateWethUsedForLp, lateLpMinted] = await Promise.all([
    vault.lateTokenUsedForLp().catch(() => 0n),
    vault.lateWethUsedForLp().catch(() => 0n),
    vault.lateLpMinted().catch(() => 0n)
  ]);

  check(String(launch.config.launchId || launch.launchId) === String(launchId), "launchId matches contract");
  check(String(launch.phase.kind) === String(phase[0]), "phase kind matches contract");
  check(String(launch.phase.roundIndex) === String(phase[1]), "phase round index matches contract");
  check(String(launch.config.refundPenaltyBps) === String(refundPenaltyBps), "refundPenaltyBps matches contract");
  check(String(launch.config.refundSeconds) === String(refundSeconds), "refundSeconds matches contract");
  check(String(launch.tokenomics.saleTokens) === String(saleTokens), "saleTokens matches contract");
  check(String(launch.tokenomics.lpTokens) === String(lpTokens), "lpTokens matches contract");
  check(String(launch.tokenomics.manualDistributionTokens) === String(manualDistributionTokens), "manualDistributionTokens matches contract");
  check((launch.tokenomics.manualDistributionRecipient || "").toLowerCase() === zeroAsEmpty(manualDistributionRecipient).toLowerCase(), "manualDistributionRecipient matches contract");
  check(String(launch.tokenomics.deadTokens) === String(deadTokens), "deadTokens matches contract");
  check(String(launch.config.treasuryBps) === String(treasuryBps), "treasuryBps matches contract");
  check(String(launch.config.minCommitWeth) === String(minCommitWeth), "minCommitWeth matches contract");
  check((launch.config.officialPair || "").toLowerCase() === zeroAsEmpty(officialPair).toLowerCase(), "officialPair matches contract");
  check(arrayEqual(launch.config.roundSharesBps, roundSharesBps.map(String)), "roundSharesBps matches contract");
  check(arrayEqual(launch.config.roundStart.map(String), roundStart.map(String)), "roundStart matches contract");
  check(arrayEqual(launch.config.roundEnd.map(String), roundEnd.map(String)), "roundEnd matches contract");
  check(arrayEqual(launch.config.roundDiscoveredPriceWad, roundDiscoveredPriceWad.map(String)), "roundDiscoveredPriceWad matches contract");
  check(String(launch.poolComposition.initial.tokenUsedForLp) === String(officialTokenUsedForLp), "initial tokenUsedForLp matches contract");
  check(String(launch.poolComposition.initial.wethUsedForLp) === String(officialWethUsedForLp), "initial wethUsedForLp matches contract");
  check(String(launch.poolComposition.initial.lpMinted) === String(officialLpMinted), "initial lpMinted matches contract");
  check(String(launch.poolComposition.finalCommittedWeth) === String(finalCommittedWeth), "finalCommittedWeth matches contract");
  check(String(launch.poolComposition.settledCommittedWeth) === String(settledCommittedWeth), "settledCommittedWeth matches contract");
  check(String(launch.poolComposition.totalLiquidityWeth) === String(totalLiquidityWeth), "totalLiquidityWeth matches contract");
  check(String(launch.poolComposition.settledLiquidityWeth) === String(settledLiquidityWeth), "settledLiquidityWeth matches contract");
  check(String(launch.poolComposition.lateTopUp.settledCommittedWeth) === String(lateSettledCommittedWeth), "late settled committed WETH matches contract");
  check(String(launch.poolComposition.lateTopUp.settledLiquidityWeth) === String(lateSettledLiquidityWeth), "late settled liquidity WETH matches contract");
  check(String(launch.poolComposition.lateTopUp.lpTokensReleased) === String(lateLpTokensReleased), "late LP tokens released matches contract");
  check(String(launch.poolComposition.lateTopUp.tokenUsedForLp) === String(lateTokenUsedForLp), "late tokenUsedForLp matches vault");
  check(String(launch.poolComposition.lateTopUp.wethUsedForLp) === String(lateWethUsedForLp), "late wethUsedForLp matches vault");
  check(String(launch.poolComposition.lateTopUp.lpMinted) === String(lateLpMinted), "late lpMinted matches vault");
  check(String(launch.poolComposition.reserved.vaultLiquidityTokensClaimed) === String(vaultLiquidityTokensClaimed), "reserved vaultLiquidityTokensClaimed matches contract");
  check(
    String(launch.poolComposition.reserved.remainingLpTokens) === String(nonNegative(lpTokens - vaultLiquidityTokensClaimed - lateLpTokensReleased)),
    "reserved remaining LP tokens matches contract arithmetic"
  );
  provider.destroy?.();
}

const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  apiBase: API_BASE,
  launch: launchAddress,
  rpcChecked: Boolean(RPC_URL),
  checks
}, null, 2));

process.exit(failed.length === 0 ? 0 : 1);

function check(ok, name) {
  checks.push({ ok: Boolean(ok), name });
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`API request failed ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--api-base") out.apiBase = argv[++index];
    else if (arg === "--launch") out.launch = argv[++index];
    else if (arg === "--rpc-url") out.rpcUrl = argv[++index];
    else if (arg === "--chain-id") out.chainId = argv[++index];
  }
  return out;
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function zeroAsEmpty(value) {
  const address = ethers.getAddress(value);
  return address === "0x0000000000000000000000000000000000000000" ? "" : address;
}

function arrayEqual(left, right) {
  return left.length === right.length && left.every((value, index) => String(value) === String(right[index]));
}

function nonNegative(value) {
  return value > 0n ? value : 0n;
}
