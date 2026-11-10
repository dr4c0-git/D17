// V15.1 regressions, each reproduced on V15 before its fix:
// 1. Per-position fee rounding made the settled WETH a few wei larger than the aggregate
//    totalLiquidityWeth(). When every position settled before the pool opened, the pool
//    asked for more LP tokens than reserved and pool creation reverted forever (tokens
//    cannot move before the pool exists). Anyone could trigger it with odd wei amounts.
//    V15.1 keeps the exact per-buyer sum (exactCommittedLiquidityWeth).
// 3. Late settlement added liquidity at the moved market price and burned the unmatched
//    part. V15.1 opens the pool only once every buyer is settled; anyone can settle absent
//    buyers after the grace period, one by one or in batches of up to 8.
// 2. Token supplies above Uniswap V2's uint112 reserve limit were accepted, so the pool
//    could never be created after participants had committed.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import {
  artifact,
  assertOk,
  compile,
  deploy,
  eth,
  expectRevert,
  failures,
  now,
  parseLaunchCreated,
  root,
  rows,
  setTime,
  startNode,
  wait,
  waitForRpc
} from "./helpers.mjs";

const runDir = path.join(root, "runs", "v15-1");
const UINT112_MAX = (1n << 112n) - 1n;
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const FEE_RECIPIENT = ethers.getAddress("0x00000000000000000000000000000000000b0001");

function config(startTime, treasury, supply = eth("100000000")) {
  // 50% sale, 40% pool, 5% creator, 5% dead, from any supply.
  const sale = supply / 2n;
  const lp = (supply * 2n) / 5n;
  const manual = supply / 20n;
  return {
    tokenName: "D17 V15.1",
    tokenSymbol: "V151",
    description: "V15.1 regression launch.",
    logoSvgUri: "",
    links: [],
    tokenSupply: supply,
    saleTokens: sale,
    lpTokens: lp,
    manualDistributionTokens: manual,
    deadTokens: supply - sale - lp - manual,
    deadRecipient: BURN_ADDRESS,
    treasury,
    startTime,
    roundSeconds: [120, 120, 120, 120, 120],
    refundSeconds: 60,
    settlementSeconds: 300,
    minCommitWeth: eth("0.001"),
    minPhase1Weth: eth("1"),
    minAnchorPriceWad: 1_000_000n, // the contract minimum (MIN_ANCHOR_PRICE_WAD)
    roundSharesBps: [4000, 1500, 1500, 1500, 1500],
    treasuryBps: 500,
    refundPenaltyBps: 1000,
    maxProtocolFeeBps: 100
  };
}

async function main() {
  compile();
  mkdirSync(runDir, { recursive: true });
  const port = 9980 + Math.floor(Math.random() * 9);
  const node = startNode(port);
  let provider;

  try {
    provider = await waitForRpc(port, node);
    const deployer = await provider.getSigner(0);
    const treasury = await provider.getSigner(1);
    const users = [];
    for (let i = 2; i < 8; i++) users.push(await provider.getSigner(i));
    const deployerAddress = await deployer.getAddress();
    const treasuryAddress = await treasury.getAddress();

    const weth = await deploy("test/TestWETH.sol", "TestWETH", deployer);
    const feeConfig = await deploy("D17FeeConfig.sol", "D17FeeConfig", deployer, [deployerAddress, FEE_RECIPIENT, 100]);
    const v2Factory = await deploy("test/TestV2Factory.sol", "TestV2Factory", deployer);
    const router = await deploy("test/TestV2Router.sol", "TestV2Router", deployer, [await v2Factory.getAddress()]);
    const d17Factory = await deploy("D17Factory.sol", "D17Factory", deployer, [
      deployerAddress,
      await weth.getAddress(),
      await router.getAddress(),
      await feeConfig.getAddress()
    ]);
    const tokenFactory = await deploy("D17TokenFactory.sol", "D17TokenFactory", deployer, [deployerAddress]);
    const vaultFactory = await deploy("D17LiquidityVaultFactory.sol", "D17LiquidityVaultFactory", deployer, [deployerAddress]);
    const launchDeployer = await deploy("D17LaunchDeployer.sol", "D17LaunchDeployer", deployer, [deployerAddress]);
    const launchFactory = await deploy("D17LaunchFactory.sol", "D17LaunchFactory", deployer, [
      await d17Factory.getAddress(),
      await tokenFactory.getAddress(),
      await vaultFactory.getAddress(),
      await launchDeployer.getAddress()
    ]);
    const lockerFactory = await deploy("D17LockerFactory.sol", "D17LockerFactory", deployer, [await d17Factory.getAddress()]);
    for (const pinned of [tokenFactory, vaultFactory, launchDeployer]) {
      await wait(await pinned.pinLaunchFactory(await launchFactory.getAddress()), "pin launch factory");
    }
    await wait(await d17Factory.pinLaunchFactory(await launchFactory.getAddress()), "pin d17 launch factory");
    await wait(await d17Factory.pinLockerFactory(await lockerFactory.getAddress()), "pin locker factory");
    for (const owned of [d17Factory, tokenFactory, vaultFactory, launchDeployer]) {
      await wait(await owned.renounceOwnership(), "renounce");
    }

    const lockerOf = new Map();
    async function lockerFor(user) {
      const owner = await user.getAddress();
      if (lockerOf.has(owner)) return lockerOf.get(owner);
      const lockerAddress = await lockerFactory.connect(user).createLockerFor.staticCall(owner);
      await wait(await lockerFactory.connect(user).createLockerFor(owner), "create locker");
      const locker = new ethers.Contract(lockerAddress, artifact("D17Locker.sol", "D17Locker").abi, user);
      lockerOf.set(owner, locker);
      return locker;
    }
    async function createLaunch(supply) {
      const start = (await now(provider)) + 60;
      const receipt = await wait(await d17Factory.createLaunch(config(start, treasuryAddress, supply), { gasLimit: 15_000_000 }), "create launch");
      const created = parseLaunchCreated(d17Factory, receipt);
      const launch = new ethers.Contract(created.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
      const vault = new ethers.Contract(await launch.liquidityVault(), artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer);
      const token = new ethers.Contract(await launch.token(), artifact("D17Token.sol", "D17Token").abi, deployer);
      return { ...created, launch, vault, token };
    }

    // ---- 1. Odd wei amounts, a take-back fee, every position settled before the pool ----
    const l1 = await createLaunch(eth("100000000"));
    await setTime(provider, Number(await l1.launch.roundStart(0)) + 5);
    const odd = [eth("1") + 33n, eth("0.7") + 7n, eth("0.25") + 19n];
    const lockers = [];
    for (let i = 0; i < odd.length; i++) {
      const locker = await lockerFor(users[i]);
      lockers.push(locker);
      await wait(await locker.commitToRound(l1.launch.target, 0, l1.rulesHash, { value: odd[i] }), `commit ${i}`);
    }
    // A fourth buyer takes everything back in round 1's window: a penalty enters the pool.
    const leaver = await lockerFor(users[3]);
    await wait(await leaver.commitToRound(l1.launch.target, 0, l1.rulesHash, { value: eth("0.1") + 3n }), "leaver commits");
    await setTime(provider, Number(await l1.launch.roundEnd(0)) + 5);
    await wait(await leaver.refundCurrentRound(l1.launch.target), "leaver takes back");
    assertOk("take-back penalty retained for the pool", (await l1.launch.retainedPenaltyWeth()) > 0n);

    await setTime(provider, Number(await l1.launch.roundEnd(4)) + 5);
    await wait(await l1.launch.finalizeLaunch(), "finalize 1");
    // Only the first buyer collects; the two others stay away.
    await wait(await lockers[0].settleAndClaim(l1.launch.target, l1.rulesHash), "settle 0");
    await setTime(provider, Number(await l1.launch.poolCreationOpensAt()) + 1);
    await expectRevert(
      "the pool cannot open while a buyer is unsettled",
      async () => l1.vault.createOfficialPool.staticCall(1n, (await now(provider)) + 3600),
      "UNSETTLED_COMMITMENTS"
    );
    // Anyone settles the absent buyers in one batch; junk entries do not block it.
    const outsider = lockerFactory.connect(users[5]);
    const batch = [lockers[1].target, lockers[2].target, lockers[1].target, leaver.target, users[5].address, lockers[0].target];
    const completed = await outsider.settleAfterGraceBatch.staticCall(l1.launch.target, batch);
    await wait(await outsider.settleAfterGraceBatch(l1.launch.target, batch), "batch settle absent buyers");
    assertOk("batch settles exactly the two absent buyers", completed === 2n, String(completed));
    assertOk("every buyer is settled", await l1.launch.allFinalCommitmentsSettled());
    for (const [index, locker] of lockers.entries()) {
      assertOk(`buyer ${index} received their sale tokens in their own vault`, (await locker.positions(l1.launch.target)).claimedSaleTokens > 0n);
    }
    const aggregate = await l1.launch.totalLiquidityWeth();
    const settled = (await l1.launch.settledLiquidityWeth()) + (await l1.launch.retainedPenaltyWeth());
    // V15 computed the pool's WETH as one percentage of the total, which this scenario
    // puts below what the buyers actually settled; V15.1 tracks the exact per-buyer sum.
    const liquidityBps = await l1.launch.liquidityBps();
    const v15Formula = (await l1.launch.finalCommittedWeth()) * liquidityBps / 10000n + (await l1.launch.retainedPenaltyWeth());
    assertOk("scenario reproduces the V15 rounding gap", settled > v15Formula, `${settled - v15Formula} wei`);
    assertOk("expected pool WETH is the exact per-buyer sum", aggregate === settled);

    await wait(await l1.vault.createOfficialPool(1n, (await now(provider)) + 3600), "create pool 1");
    const effective = await l1.launch.effectiveLpTokens();
    assertOk("pool opens although every position settled first", await l1.launch.liquidityPoolCreated());
    assertOk("pool uses exactly the reserved LP tokens, never more", (await l1.launch.vaultLiquidityTokensClaimed()) === effective);
    assertOk("pool receives every settled WETH and the penalty", (await l1.launch.officialWethUsedForLp()) === settled);
    const holder = users[0];
    const balance = await l1.token.balanceOf(await holder.getAddress());
    if (balance === 0n) {
      await wait(await lockers[0].withdrawUnlockedTokens(l1.launch.target, await l1.token.balanceOf(lockers[0].target)), "withdraw tokens");
    }
    const held = await l1.token.balanceOf(await holder.getAddress());
    await wait(await l1.token.connect(holder).transfer(await users[5].getAddress(), held / 2n), "transfer after pool");
    assertOk("tokens move once the pool exists", (await l1.token.balanceOf(await users[5].getAddress())) === held / 2n);
    await wait(await l1.launch.burnResidualTokens(), "burn residual dust");
    assertOk("no LP token left behind after the burn", (await l1.token.balanceOf(l1.launch.target)) === 0n);

    // ---- 2. Supply bound: Uniswap V2 reserves are uint112 ----
    const start = (await now(provider)) + 120;
    await expectRevert(
      "supply above 2^112 - 1 is rejected at creation",
      () => d17Factory.createLaunch.staticCall(config(start, treasuryAddress, UINT112_MAX + 1n), { gasLimit: 15_000_000 }),
      "SUPPLY_ABOVE_V2_RESERVE"
    );
    await expectRevert(
      "far larger supplies are rejected too",
      () => d17Factory.createLaunch.staticCall(config(start, treasuryAddress, UINT112_MAX * 4n), { gasLimit: 15_000_000 }),
      "SUPPLY_ABOVE_V2_RESERVE"
    );
    // The largest allowed supply still goes all the way to a live pool. Round 1 then sells
    // about 1e15 tokens, so it needs over 1,000 ETH to clear the minimum anchor price.
    const l2 = await createLaunch(UINT112_MAX);
    await setTime(provider, Number(await l2.launch.roundStart(0)) + 5);
    const big = await lockerFor(users[4]);
    await wait(await big.commitToRound(l2.launch.target, 0, l2.rulesHash, { value: eth("1100") }), "commit max supply");
    await setTime(provider, Number(await l2.launch.roundEnd(4)) + 5);
    await wait(await l2.launch.finalizeLaunch(), "finalize 2");
    await wait(await big.settleAndClaim(l2.launch.target, l2.rulesHash), "settle max supply");
    await setTime(provider, Number(await l2.launch.poolCreationOpensAt()) + 1);
    await wait(await l2.vault.createOfficialPool(1n, (await now(provider)) + 3600), "create pool 2");
    assertOk("max supply launch opens its pool", await l2.launch.liquidityPoolCreated());

    const passed = rows.assertion.filter((row) => row.passed).length;
    const failed = rows.assertion.length - passed;
    writeFileSync(path.join(runDir, "REPORT.md"), [
      "# D17 V15.1 Regressions E2E Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      `- Assertions: ${rows.assertion.length}`,
      `- Passed: ${passed}`,
      `- Failed: ${failed}`,
      "",
      failures.length ? failures.map((failure) => `- ${failure}`).join("\n") : "- No failures",
      ""
    ].join("\n"));
    if (failures.length) throw new Error(`${failures.length} assertions failed:\n${failures.join("\n")}`);
    console.log(`D17 V15.1 regressions E2E passed (${passed} assertions). Report: ${path.join(runDir, "REPORT.md")}`);
  } finally {
    if (provider?.destroy) provider.destroy();
    node.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
