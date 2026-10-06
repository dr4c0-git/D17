// Stateful fuzzer for the V15 contract suite.
//
// Each campaign draws a random launch configuration inside the factory bounds and plays a
// random sequence of valid actions through the whole lifecycle: commits of every size,
// refunds in every window, failed launches, on-time / third-party / late settlements,
// price moves in both directions, WETH donations to the pair and creator vesting. After
// every action it checks the global invariants below, and it probes adversarial calls that
// must revert. Any unexpected revert of a valid action is a liveness failure.
//
// Reproduce a run with FUZZ_SEED=<seed>; scale it with FUZZ_CAMPAIGNS=<n>.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { artifact, compile, deploy, eth, expectRevert, failures, now, parseLaunchCreated, root, rows, setTime, startNode, wait, waitForRpc } from "./helpers.mjs";

const SEED = Number(process.env.FUZZ_SEED ?? 0xd17);
const CAMPAIGNS = Number(process.env.FUZZ_CAMPAIGNS ?? 6);
const runDir = path.join(root, "runs", "fuzz");
const BPS = 10000n;
const WAD = eth("1");
const BURN = "0x000000000000000000000000000000000000dEaD";
const SUPPLY = eth("100000000");
const PARTICIPANTS = 10;

// ---- deterministic randomness (mulberry32) ----
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = rng(SEED);
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p) => rand() < p;
const pick = (list) => list[Math.floor(rand() * list.length)];
const shuffle = (list) => list.map((v) => [rand(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);
// Campaign style: "mixed" draws log-uniform amounts with occasional whales; "dust" commits
// only near the 0.001 WETH minimum (stresses rounding, zero-LP late positions); "whales"
// commits only large amounts (stresses overfilled rounds and price moves).
let style = "mixed";
/** WETH amount for one commitment, according to the campaign style. */
function amount() {
  if (style === "dust") return eth("0.001") + BigInt(int(0, 999)) * 1_000_000_000n;
  if (style === "whales" || chance(0.08)) return eth((int(5, 40) + rand()).toFixed(6));
  const exp = -3 + rand() * 3.3; // 0.001 .. ~2 ETH
  return eth((10 ** exp).toFixed(6));
}

// ---- invariant bookkeeping ----
let checks = 0;
let context = "";
function invariant(name, condition, detail = "") {
  checks += 1;
  if (!condition) {
    const message = `INVARIANT BROKEN [seed ${SEED}] ${context}: ${name}${detail ? ` — ${detail}` : ""}`;
    rows.assertion.push({ name, passed: 0, detail: message });
    failures.push(message);
    throw new Error(message);
  }
}
const abs = (x) => (x < 0n ? -x : x);

async function main() {
  compile();
  mkdirSync(runDir, { recursive: true });
  const port = 9940 + Math.floor(Math.random() * 20);
  const node = startNode(port);
  let provider;
  try {
    provider = await waitForRpc(port, node);
    const deployer = await provider.getSigner(0);
    const creator = await provider.getSigner(1);
    const users = [];
    for (let i = 2; i < 2 + PARTICIPANTS; i++) users.push(await provider.getSigner(i));
    const trader = await provider.getSigner(14);
    const stranger = await provider.getSigner(15);
    const D = await deployer.getAddress();

    // ---- suite ----
    const weth = await deploy("test/TestWETH.sol", "TestWETH", deployer);
    const v2 = await deploy("test/TestV2Factory.sol", "TestV2Factory", deployer);
    const router = await deploy("test/TestV2Router.sol", "TestV2Router", deployer, [await v2.getAddress()]);
    const feeConfig = await deploy("D17FeeConfig.sol", "D17FeeConfig", deployer, [D, ethers.ZeroAddress, 0]);
    const factory = await deploy("D17Factory.sol", "D17Factory", deployer, [D, await weth.getAddress(), await router.getAddress(), await feeConfig.getAddress()]);
    const tokenFactory = await deploy("D17TokenFactory.sol", "D17TokenFactory", deployer, [D]);
    const vaultFactory = await deploy("D17LiquidityVaultFactory.sol", "D17LiquidityVaultFactory", deployer, [D]);
    const launchDeployer = await deploy("D17LaunchDeployer.sol", "D17LaunchDeployer", deployer, [D]);
    const launchFactory = await deploy("D17LaunchFactory.sol", "D17LaunchFactory", deployer, [
      await factory.getAddress(), await tokenFactory.getAddress(), await vaultFactory.getAddress(), await launchDeployer.getAddress()
    ]);
    const lockerFactory = await deploy("D17LockerFactory.sol", "D17LockerFactory", deployer, [await factory.getAddress()]);
    for (const c of [tokenFactory, vaultFactory, launchDeployer]) await wait(await c.pinLaunchFactory(await launchFactory.getAddress()));
    await wait(await factory.pinLaunchFactory(await launchFactory.getAddress()));
    await wait(await factory.pinLockerFactory(await lockerFactory.getAddress()));
    for (const c of [factory, tokenFactory, vaultFactory, launchDeployer]) await wait(await c.renounceOwnership());

    const lockerAbi = artifact("D17Locker.sol", "D17Locker").abi;
    const lockers = [];
    for (const user of users) {
      const owner = await user.getAddress();
      const address = await lockerFactory.connect(user).createLockerFor.staticCall(owner);
      await wait(await lockerFactory.connect(user).createLockerFor(owner));
      lockers.push({ user, owner, address, contract: new ethers.Contract(address, lockerAbi, user) });
    }
    const pairAbi = artifact("test/TestV2Pair.sol", "TestV2Pair").abi;
    const summary = [];

    for (let campaign = 0; campaign < CAMPAIGNS; campaign++) {
      rand = rng(SEED + campaign * 7919);
      style = ["mixed", "mixed", "dust", "whales"][campaign % 4];
      context = `campaign ${campaign} (${style})`;
      const result = await runCampaign(campaign);
      summary.push(result);
      console.log(`campaign ${campaign} (${style}): ${result.outcome} · ${result.actions} actions · fee ${result.feeBps} bps · treasury ${result.treasuryBps} bps · penalty ${result.penaltyBps} bps · ${result.lockers} lockers`);
    }

    // ---- campaign ----
    async function runCampaign(campaign) {
      const treasury = ethers.Wallet.createRandom().address;
      const feeRecipient = ethers.Wallet.createRandom().address;
      const feeBps = pick([0, int(1, 200), 200]);
      await wait(await feeConfig.setProtocolFee(feeBps > 0 ? feeRecipient : ethers.ZeroAddress, feeBps));

      const salePct = int(20, 60);
      const lpPct = int(5, Math.min(40, 95 - salePct));
      const manualPct = int(0, Math.min(10, 100 - salePct - lpPct));
      const saleTokens = SUPPLY * BigInt(salePct) / 100n;
      const lpTokens = SUPPLY * BigInt(lpPct) / 100n;
      const manualTokens = SUPPLY * BigInt(manualPct) / 100n;
      const deadTokens = SUPPLY - saleTokens - lpTokens - manualTokens;
      const shares = [int(500, 4000)];
      let left = 10000 - shares[0];
      for (let i = 0; i < 3; i++) {
        const max = left - 500 * (3 - i);
        const s = int(500, Math.min(4000, max));
        shares.push(s);
        left -= s;
      }
      shares.push(left);
      const treasuryBps = pick([0, int(1, 1000), 1000]);
      const penaltyBps = pick([100, int(100, 2500), 2500]);
      const cfg = {
        tokenName: `Fuzz ${campaign}`, tokenSymbol: `FZ${campaign}`, description: "", logoSvgUri: "", links: [],
        tokenSupply: SUPPLY, saleTokens, lpTokens, manualDistributionTokens: manualTokens, deadTokens, deadRecipient: BURN,
        treasury, startTime: (await now(provider)) + 60,
        roundSeconds: Array.from({ length: 5 }, () => int(120, 600)),
        refundSeconds: int(60, 300), settlementSeconds: int(120, 600),
        minCommitWeth: eth("0.001"),
        minPhase1Weth: style === "dust" ? eth("0.001") : eth(pick(["0.5", "1", "2", "3"])),
        minAnchorPriceWad: style === "dust" ? 1_000_000n : eth("0.000000001"),
        roundSharesBps: shares, treasuryBps, refundPenaltyBps: penaltyBps, maxProtocolFeeBps: feeBps
      };
      const receipt = await wait(await factory.connect(creator).createLaunch(cfg, { gasLimit: 15_000_000 }));
      const created = parseLaunchCreated(factory, receipt);
      const launch = new ethers.Contract(created.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
      const vault = new ethers.Contract(created.liquidityVault, artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer);
      const token = new ethers.Contract(created.token, artifact("D17Token.sol", "D17Token").abi, deployer);
      const L = created.launch;
      const rules = created.rulesHash;
      const vaultAddress = created.liquidityVault;
      const creatorAddress = await creator.getAddress();
      let actions = 0;
      let residualBurned = 0n;
      const participants = new Set();

      invariant("fee snapshot frozen into the launch", (await launch.protocolFeeBps()) === BigInt(feeBps));
      invariant("creator allocation minted into the vault", (await token.balanceOf(vaultAddress)) === manualTokens);
      invariant("creator wallet holds no launch tokens", (await token.balanceOf(creatorAddress)) === 0n);

      // ---- global invariants, checked after every action ----
      async function checkAll(label) {
        context = `campaign ${campaign} (${style}) · ${label}`;
        const [finalized, poolCreated, failed] = await Promise.all([launch.finalized(), launch.liquidityPoolCreated(), launch.launchFailed()]);
        invariant("launch never holds WETH", (await weth.balanceOf(L)) === 0n);

        let contributed = 0n;
        let claimedSale = 0n;
        for (const l of lockers) {
          const [bal, accounted] = await Promise.all([weth.balanceOf(l.address), l.contract.accountedWeth()]);
          invariant("locker WETH equals its accounted WETH", bal === accounted, `${l.address} ${bal} vs ${accounted}`);
          for (let r = 0; r < 5; r++) contributed += await launch.contributedBy(l.address, r);
          const p = await l.contract.positions(L);
          claimedSale += p.claimedSaleTokens;
          // Per-position WETH conservation: everything committed is accounted for exactly once.
          invariant(
            "position WETH conservation",
            p.ethCommitted === p.wethRefunded + p.penaltyPaid + p.wethSentToVault + p.treasuryWeth + p.protocolFeeWeth + p.wethCommitted,
            `${l.address}`
          );
          invariant("locker committed WETH equals launch ledger", p.liquiditySettled || p.wethCommitted === await sumPaid(l.address));
        }
        if (!finalized) invariant("launch round totals equal locker contributions", contributed === await launch.totalCommittedWeth());

        const [settledLw, penalties, vaultWeth] = await Promise.all([launch.settledLiquidityWeth(), launch.retainedPenaltyWeth(), weth.balanceOf(vaultAddress)]);
        if (!poolCreated && !failed) invariant("vault WETH = settled liquidity + penalties before the pool", vaultWeth === settledLw + penalties, `${vaultWeth} vs ${settledLw}+${penalties}`);
        if (poolCreated) invariant("vault holds no loose WETH after the pool", vaultWeth === 0n);
        invariant("treasury receives exactly the treasury fees", (await weth.balanceOf(treasury)) === await launch.treasuryWethPaid());
        invariant("fee recipient receives exactly the protocol fees", feeBps === 0 || (await weth.balanceOf(feeRecipient)) === await launch.protocolFeeWethPaid());
        invariant("no protocol fee when the rate is zero", feeBps !== 0 || (await launch.protocolFeeWethPaid()) === 0n);

        // Token conservation inside the launch.
        let expectedLaunchTokens = saleTokens + lpTokens - claimedSale - (await launch.vaultLiquidityTokensClaimed()) - (await launch.lateLpTokensReleased()) - residualBurned;
        if (finalized) expectedLaunchTokens -= (await launch.unsoldSaleTokensSettled()) + (await launch.unusedLpTokensBurned());
        invariant("launch token balance matches its ledger", (await token.balanceOf(L)) === expectedLaunchTokens, `${await token.balanceOf(L)} vs ${expectedLaunchTokens}`);
        invariant("vault tokens = locked creator allocation (+ claimed LP before the pool)",
          (await token.balanceOf(vaultAddress)) === (await vault.lockedCreatorTokens()) + (poolCreated ? 0n : await launch.vaultLiquidityTokensClaimed()));
        invariant("creator tokens never leave except by vesting", (await token.balanceOf(creatorAddress)) === await vault.creatorTokensReleased());

        // Sale and price invariants.
        const anchor = await launch.anchorPriceWad();
        let sold = 0n;
        for (let r = 0; r < 5; r++) {
          const s = await launch.roundSoldTokens(r);
          sold += s;
          if (r > 0 && s > 0n && anchor > 0n) {
            const price = await launch.roundDiscoveredPriceWad(r);
            // Prices are integers in WAD (1e-18 ETH per token). Both the anchor and the
            // discovered price are floored, so at very low prices (anchor ~1e8 WAD) one WAD unit
            // is a large relative step. Allow exactly that: one WAD unit plus 1e-12 relative.
            invariant(`round ${r} never sells below the anchor`, price + 1n + anchor / 1_000_000_000_000n >= anchor, `${price} < ${anchor}`);
          }
        }
        if (!failed) invariant("sold tokens never exceed the sale allocation", sold <= saleTokens);
        if (finalized) {
          const eff = await launch.effectiveLpTokens();
          const soldCapped = sold > saleTokens ? saleTokens : sold;
          invariant("sold + unsold = sale allocation", soldCapped + (await launch.unsoldSaleTokensSettled()) === saleTokens);
          invariant("effective + unused LP = LP allocation", eff + (await launch.unusedLpTokensBurned()) === lpTokens);
          invariant("LP releases never exceed the effective LP", (await launch.vaultLiquidityTokensClaimed()) + (await launch.lateLpTokensReleased()) <= eff);
          let owed = claimedSale;
          for (const l of lockers) owed += await launch.previewFinalSaleTokens(l.address);
          invariant("claimed + claimable sale tokens never exceed what was sold", owed <= saleTokens - (await launch.unsoldSaleTokensSettled()), `${owed}`);
        }
      }
      async function sumPaid(address) {
        let s = 0n;
        for (let r = 0; r < 5; r++) s += await launch.contributedBy(address, r);
        return s;
      }
      async function act(label, fn) {
        context = `campaign ${campaign} (${style}) · ${label}`;
        // The node's clock follows wall time, and invariant checks take real seconds (more
        // so with parallel runs). Pin the next block to latest + 1 so chain time only moves
        // when the fuzzer decides, never because the checks were slow.
        await provider.send("evm_setNextBlockTimestamp", [(await now(provider)) + 1]);
        try {
          await fn();
        } catch (error) {
          if (String(error.message).startsWith("INVARIANT BROKEN")) throw error;
          invariant(`valid action must not revert: ${label}`, false, String(error.shortMessage || error.message).slice(0, 200));
        }
        actions += 1;
        await checkAll(label);
      }

      await checkAll("created");
      // Adversarial probes that must always revert.
      await expectRevert(`[${campaign}] EOA cannot record commitments`, () => launch.connect(stranger).recordRoundCommitment.staticCall(0, eth("1")), "NOT_D17_LOCKER");
      await expectRevert(`[${campaign}] EOA cannot claim vault liquidity`, () => launch.connect(stranger).claimVaultLiquidityTokens.staticCall(), "NOT_LIQUIDITY_VAULT");
      await expectRevert(`[${campaign}] non-owner cannot commit through a locker`, () => lockers[0].contract.connect(stranger).commitToRound.staticCall(L, 0, rules, { value: eth("1") }), "NOT_OWNER");

      // ---- rounds ----
      let failedLaunch = false;
      for (let round = 0; round < 5; round++) {
        await setTime(provider, Number(await launch.roundStart(round)) + 1);
        if (round > 0 && !(await launch.anchorReady())) { failedLaunch = true; break; }
        const committers = shuffle(lockers).slice(0, int(round === 0 ? 2 : 0, PARTICIPANTS));
        // Three campaigns out of four get one phase-one commitment big enough for the anchor,
        // so the traded path is covered as often as the failed one is.
        const anchorCommit = round === 0 && chance(0.75);
        for (const [index, l] of committers.entries()) {
          const value = anchorCommit && index === 0 ? cfg.minPhase1Weth + amount() : amount();
          await act(`commit r${round} ${ethers.formatEther(value)}`, async () => {
            await wait(await l.contract.commitToRound(L, round, rules, { value }));
          });
          participants.add(l);
        }
        if (round < 4) {
          await setTime(provider, Number(await launch.roundEnd(round)) + 1);
          for (const l of lockers) {
            const paid = await launch.contributedBy(l.address, round);
            if (paid === 0n || !chance(round === 0 ? 0.3 : 0.2)) continue;
            const before = await l.contract.positions(L);
            const vaultBefore = await weth.balanceOf(vaultAddress);
            await act(`refund r${round}`, async () => { await wait(await l.contract.refundCurrentRound(L)); });
            const after = await l.contract.positions(L);
            const bps = round < 2 ? 100n : BigInt(penaltyBps);
            invariant("refund penalty is exact", after.penaltyPaid - before.penaltyPaid === paid * bps / BPS);
            invariant("refund penalty goes into the vault", (await weth.balanceOf(vaultAddress)) - vaultBefore === paid * bps / BPS);
            invariant("refund credits the rest to the participant", after.wethRefunded - before.wethRefunded === paid - paid * bps / BPS);
          }
          if (round === 0) {
            await setTime(provider, Number(await launch.roundEnd(0)) + Number(await launch.refundSeconds()) + 1);
            if (!(await launch.anchorReady())) { failedLaunch = true; break; }
          }
        }
      }

      if (failedLaunch || (await launch.launchFailed())) {
        context = `campaign ${campaign} (${style}) · failed launch`;
        invariant("failed launch is reported as failed", await launch.launchFailed());
        await expectRevert(`[${campaign}] failed launch cannot finalize`, () => launch.finalizeLaunch.staticCall(), "LAUNCH_FAILED");
        for (const l of lockers) {
          const owed = await sumPaid(l.address);
          if (owed === 0n) continue;
          const before = await l.contract.positions(L);
          await act("failed-launch refund", async () => { await wait(await l.contract.refundFailedLaunch(L, rules)); });
          const after = await l.contract.positions(L);
          invariant("failed-launch refund returns every remaining wei", after.wethRefunded - before.wethRefunded === owed);
          const residual = after.residualWeth;
          await act("withdraw refunded WETH", async () => { await wait(await l.contract.withdrawUnlockedWeth(L, residual)); });
        }
        const penalties = await weth.balanceOf(vaultAddress);
        invariant("vault holds exactly the phase-one penalties", penalties === await launch.retainedPenaltyWeth());
        if (penalties > 0n) {
          const deadBefore = await weth.balanceOf(BURN);
          await act("burn failed-launch penalties", async () => { await wait(await vault.connect(stranger).burnFailedLaunchPenalties()); });
          invariant("failed-launch penalties are burned, not paid", (await weth.balanceOf(BURN)) - deadBefore === penalties);
        }
        for (const l of participants) {
          const p = await l.contract.positions(L);
          invariant("failed launch: committed = refunded + penalties", p.ethCommitted === p.wethRefunded + p.penaltyPaid);
        }
        invariant("treasury got nothing from a failed launch", (await weth.balanceOf(treasury)) === 0n);
        return { outcome: "failed", actions, feeBps, treasuryBps, penaltyBps, lockers: participants.size };
      }

      // ---- finalization & on-time settlement ----
      await setTime(provider, Number(await launch.roundEnd(4)) + 1);
      if (chance(0.5)) await act("finalize (explicit)", async () => { await wait(await launch.connect(stranger).finalizeLaunch()); });
      const holders = shuffle(lockers.filter((l) => participants.has(l)));
      const funded = [];
      for (const l of holders) if ((await sumPaid(l.address)) > 0n) funded.push(l);
      const onTime = funded.slice(0, int(0, funded.length));
      const liquidityShare = BPS - BigInt(treasuryBps) - BigInt(feeBps);
      async function settle(l, how) {
        const preview = await launch.previewVaultSettlement(l.address);
        const gross = preview[1];
        invariant("settlement split adds up", preview[2] + preview[3] + preview[4] === gross);
        invariant("treasury fee is exact", preview[3] === gross * BigInt(treasuryBps) / BPS);
        invariant("protocol fee is exact", preview[4] === gross * BigInt(feeBps) / BPS);
        invariant("pool share is at least its published share", preview[2] * BPS >= gross * liquidityShare);
        await act(`${how} settlement`, async () => {
          const tx = how === "owner" ? await l.contract.settleAndClaim(L, rules) : await l.contract.connect(stranger).settleAfterGrace(L);
          await wait(tx);
        });
        const p = await l.contract.positions(L);
        invariant("settled sale tokens match the preview", p.claimedSaleTokens === preview[0]);
        await expectRevert(`[${campaign}] settlement cannot repeat`, () => l.contract.settleAndClaim.staticCall(L, rules), "LIQUIDITY_SETTLED");
        return preview;
      }
      for (const l of onTime) await settle(l, "owner");

      // ---- pool creation ----
      const pending = funded.filter((l) => !onTime.includes(l));
      if (pending.length > 0 && (await launch.finalized())) {
        await expectRevert(`[${campaign}] third party waits for the grace boundary`, () => pending[0].contract.connect(stranger).settleAfterGrace.staticCall(L), "GRACE_OPEN");
      }
      // settleAfterGrace needs a finalized launch; finalization itself is permissionless.
      // Finalize first: the grace boundary is fixed at finalization (finalizedAt +
      // settlementSeconds), so a late finalization pushes it back on purpose.
      if (!(await launch.finalized())) await act("finalize (permissionless)", async () => { await wait(await launch.connect(stranger).finalizeLaunch()); });
      invariant("grace boundary leaves owners a full settlement window",
        (await launch.poolCreationOpensAt()) >= (await launch.finalizedAt()) + (await launch.settlementSeconds()));
      await setTime(provider, Number(await launch.poolCreationOpensAt()) + 1);
      if ((await launch.settledLiquidityWeth()) === 0n) await settle(pending.shift(), "third-party");
      while (pending.length > 0 && chance(0.3)) await settle(pending.shift(), "third-party");

      const pairAddress0 = await v2.getPair(created.token, await weth.getAddress());
      if (chance(0.3)) {
        await act("donate WETH to the future pair", async () => {
          if (pairAddress0 === ethers.ZeroAddress) await wait(await v2.createPair(created.token, await weth.getAddress()));
          const pairAddress = await v2.getPair(created.token, await weth.getAddress());
          const gift = eth("0.05");
          await wait(await weth.connect(trader).deposit({ value: gift }));
          await wait(await weth.connect(trader).transfer(pairAddress, gift));
        });
      }
      const T = await launch.totalLiquidityWeth();
      const eff = await launch.effectiveLpTokens();
      await act("create official pool", async () => { await wait(await vault.connect(stranger).createOfficialPool(1n, (await now(provider)) + 3600)); });
      const tokUsed = await launch.officialTokenUsedForLp();
      const wethUsed = await launch.officialWethUsedForLp();
      invariant("pool opens at the canonical ratio", abs(tokUsed * T - eff * wethUsed) <= T);
      invariant("pool includes every refund penalty", wethUsed === (await launch.poolSettledLiquidityWeth()) + (await launch.retainedPenaltyWeth()));
      const pair = new ethers.Contract(await vault.officialPair(), pairAbi, provider);
      const tokenIs0 = (await pair.token0()) === created.token;
      const reserves = async () => {
        const [r0, r1] = await pair.getReserves();
        return tokenIs0 ? { token: r0, weth: r1 } : { token: r1, weth: r0 };
      };

      // ---- trading, late settlements, vesting ----
      let traderTokens = 0n;
      async function swap(buy) {
        const r = await reserves();
        if (buy) {
          const amountIn = r.weth / BigInt(int(5, 40));
          const out = r.token * amountIn / (r.weth + amountIn);
          await wait(await weth.connect(trader).deposit({ value: amountIn }));
          await wait(await weth.connect(trader).approve(await router.getAddress(), amountIn));
          await wait(await router.connect(trader).swapExactTokensForTokens(await weth.getAddress(), created.token, amountIn, out, await trader.getAddress()));
          traderTokens += out;
        } else if (traderTokens > 0n) {
          const amountIn = traderTokens / BigInt(int(1, 3));
          const out = r.weth * amountIn / (r.token + amountIn);
          await wait(await token.connect(trader).approve(await router.getAddress(), amountIn));
          await wait(await router.connect(trader).swapExactTokensForTokens(created.token, await weth.getAddress(), amountIn, out, await trader.getAddress()));
          traderTokens -= amountIn;
        }
      }
      while (pending.length > 0) {
        if (chance(0.6)) await act("price move", async () => { await swap(chance(0.55)); });
        const l = pending.shift();
        const before = await reserves();
        const burnedBefore = [await vault.lateTokensBurned(), await vault.lateWethBurned()];
        const reserveLeft = eff - (await launch.vaultLiquidityTokensClaimed()) - (await launch.lateLpTokensReleased());
        const preview = await settle(l, chance(0.5) ? "owner" : "third-party");
        let lateLp = eff * preview[2] / T;
        if (lateLp > reserveLeft) lateLp = reserveLeft;
        const after = await reserves();
        const tokensBurned = (await vault.lateTokensBurned()) - burnedBefore[0];
        const wethBurned = (await vault.lateWethBurned()) - burnedBefore[1];
        invariant("late WETH is pooled or burned, never kept", after.weth - before.weth + wethBurned === preview[2]);
        invariant("late LP tokens are pooled or burned, never kept", after.token - before.token + tokensBurned === lateLp);
        invariant("late settlement burns at most one side", tokensBurned === 0n || wethBurned === 0n);
        const dToken = after.token - before.token;
        const dWeth = after.weth - before.weth;
        invariant("late deposit is balanced at the live ratio", abs(dToken * before.weth - dWeth * before.token) <= (before.token > before.weth ? before.token : before.weth));
      }
      invariant("every final commitment settled", await launch.allFinalCommitmentsSettled());
      const residual = await token.balanceOf(L);
      if (residual > 0n) {
        await act("burn residual dust", async () => {
          await wait(await launch.connect(stranger).burnResidualTokens());
          residualBurned = residual;
        });
        invariant("residual dust is tiny", residual < eth("10"), `${residual}`);
      }
      invariant("launch holds no tokens at the end", (await token.balanceOf(L)) === 0n);

      // Vault-side WETH conservation.
      let sentToVault = 0n;
      for (const l of participants) sentToVault += (await l.contract.positions(L)).wethSentToVault;
      invariant(
        "every WETH sent to the vault ended in the pair or the burn address",
        sentToVault + (await launch.retainedPenaltyWeth()) === wethUsed + (await vault.lateWethUsedForLp()) + (await vault.lateWethBurned())
      );

      // Creator vesting.
      const start = Number(await vault.poolCreatedAt());
      const period = Number(await vault.CREATOR_VESTING_SECONDS());
      for (const fraction of [rand() * 0.5, 0.5 + rand() * 0.5, 1.2]) {
        await setTime(provider, start + Math.floor(period * fraction));
        if (manualTokens === 0n) break;
        await act(`release creator tokens @${fraction.toFixed(2)}`, async () => {
          const due = (await vault.vestedCreatorTokens()) - (await vault.creatorTokensReleased());
          if (due > 0n) await wait(await vault.connect(stranger).releaseCreatorTokens());
        });
        const elapsed = BigInt(Math.min((await now(provider)) - start, period));
        invariant("creator vesting is linear and capped", (await vault.creatorTokensReleased()) <= manualTokens * elapsed / BigInt(period) + 1n);
      }
      if (manualTokens > 0n) invariant("creator fully vested at the end", (await token.balanceOf(creatorAddress)) === manualTokens);

      // Everyone withdraws.
      for (const l of participants) {
        const p = await l.contract.positions(L);
        if (p.withdrawableTokens > 0n) await act("withdraw tokens", async () => { await wait(await l.contract.withdrawUnlockedTokens(L, p.withdrawableTokens)); });
        if (p.residualWeth > 0n) await act("withdraw WETH", async () => { await wait(await l.contract.withdrawUnlockedWeth(L, p.residualWeth)); });
      }
      return { outcome: "traded", actions, feeBps, treasuryBps, penaltyBps, lockers: participants.size };
    }

    const passed = rows.assertion.filter((row) => row.passed).length;
    writeFileSync(path.join(runDir, "REPORT.md"), [
      "# D17 Fuzz & Invariant Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      `Seed: ${SEED} · Campaigns: ${CAMPAIGNS}`,
      "",
      `- Invariant checks: ${checks}`,
      `- Adversarial probes passed: ${passed}/${rows.assertion.length}`,
      "",
      ...summary.map((s, i) => `- campaign ${i} (${["mixed", "mixed", "dust", "whales"][i % 4]}): ${s.outcome}, ${s.actions} actions, fee ${s.feeBps} bps, treasury ${s.treasuryBps} bps, penalty ${s.penaltyBps} bps, ${s.lockers} lockers`),
      "",
      failures.length ? failures.map((f) => `- ${f}`).join("\n") : "- No failures",
      ""
    ].join("\n"));
    if (failures.length) throw new Error(`${failures.length} failures`);
    console.log(`D17 fuzz passed: seed ${SEED}, ${CAMPAIGNS} campaigns, ${checks} invariant checks, ${passed} adversarial probes.`);
  } finally {
    if (provider?.destroy) provider.destroy();
    node.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
