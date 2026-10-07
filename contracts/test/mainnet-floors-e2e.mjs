// Mainnet-only launch minimums, exercised on a local simulation whose chain id is 1:
// a launch must be announced at least 24 hours ahead and every round, refund and
// settlement window must last at least one hour. Then a full launch runs with exactly
// those minimum durations to show the lifecycle works at the mainnet floors.
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

const runDir = path.join(root, "runs", "mainnet-floors");
const HOUR = 3600;
const DAY = 86400;
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const FEE_RECIPIENT = ethers.getAddress("0x00000000000000000000000000000000000fee03");

function config(startTime, treasury, overrides = {}) {
  return {
    tokenName: "D17 Mainnet Floors",
    tokenSymbol: "D17M",
    description: "Mainnet minimums suite launch.",
    logoSvgUri: "",
    links: [],
    tokenSupply: eth("100000000"),
    saleTokens: eth("50000000"),
    lpTokens: eth("50000000"),
    manualDistributionTokens: 0n,
    deadTokens: 0n,
    deadRecipient: BURN_ADDRESS,
    treasury,
    startTime,
    roundSeconds: [HOUR, HOUR, HOUR, HOUR, HOUR],
    refundSeconds: HOUR,
    settlementSeconds: HOUR,
    minCommitWeth: eth("0.001"),
    minPhase1Weth: eth("1"),
    minAnchorPriceWad: eth("0.000000001"),
    roundSharesBps: [4000, 1500, 1500, 1500, 1500],
    treasuryBps: 500,
    refundPenaltyBps: 1000,
    maxProtocolFeeBps: 100,
    ...overrides
  };
}

async function main() {
  compile();
  mkdirSync(runDir, { recursive: true });
  const port = 9990 + Math.floor(Math.random() * 20);
  const node = startNode(port, "mainnetSim");
  let provider;

  try {
    provider = await waitForRpc(port, node);
    const chainId = Number((await provider.getNetwork()).chainId);
    assertOk("simulation reports chain id 1", chainId === 1);
    if (chainId !== 1) throw new Error(`expected chain id 1, got ${chainId}`);

    const deployer = await provider.getSigner(0);
    const treasury = await provider.getSigner(1);
    const users = [];
    for (let i = 2; i < 6; i++) users.push(await provider.getSigner(i));
    const deployerAddress = await deployer.getAddress();
    const treasuryAddress = await treasury.getAddress();

    const weth = await deploy("test/TestWETH.sol", "TestWETH", deployer);
    const v2Factory = await deploy("test/TestV2Factory.sol", "TestV2Factory", deployer);
    const router = await deploy("test/TestV2Router.sol", "TestV2Router", deployer, [await v2Factory.getAddress()]);
    const feeConfig = await deploy("D17FeeConfig.sol", "D17FeeConfig", deployer, [deployerAddress, FEE_RECIPIENT, 100]);
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

    assertOk("mainnet minimum window is one hour", await d17Factory.MAINNET_MIN_WINDOW_SECONDS() === BigInt(HOUR));
    assertOk("mainnet minimum notice is one day", await d17Factory.MAINNET_MIN_START_DELAY() === BigInt(DAY));

    // ---- Notice: the start must be at least 24 hours after the creating block ----
    // Each probe pins the next block's timestamp so the boundary is exact to the second.
    async function probe(label, startOffset, overrides, reason) {
      const base = (await now(provider)) + 10;
      await provider.send("evm_setNextBlockTimestamp", [base]);
      const cfg = config(base + startOffset, treasuryAddress, overrides);
      if (reason) {
        // The pending block carries the pinned timestamp.
        await expectRevert(label, () => d17Factory.createLaunch.staticCall(cfg, { blockTag: "pending", gasLimit: 15_000_000 }), reason);
      } else {
        const receipt = await wait(await d17Factory.createLaunch(cfg, { gasLimit: 15_000_000 }), label);
        assertOk(label, Boolean(parseLaunchCreated(d17Factory, receipt).launch));
      }
    }

    await probe("start 1 second short of 24 hours rejected", DAY - 1, {}, "START_TOO_SOON");
    await probe("start one hour ahead rejected (allowed on testnets)", HOUR, {}, "START_TOO_SOON");
    await probe("start exactly 24 hours ahead accepted", DAY, {});

    // ---- Windows: rounds, refunds and settlement each last at least one hour ----
    for (let round = 0; round < 5; round++) {
      const roundSeconds = [HOUR, HOUR, HOUR, HOUR, HOUR];
      roundSeconds[round] = HOUR - 1;
      await probe(`round ${round + 1} of 59m59s rejected`, DAY + 60, { roundSeconds }, "ROUND_SECONDS");
    }
    await probe("two-minute rounds rejected (allowed on testnets)", DAY + 60, { roundSeconds: [120, 120, 120, 120, 120] }, "ROUND_SECONDS");
    await probe("refund window of 59m59s rejected", DAY + 60, { refundSeconds: HOUR - 1 }, "REFUND_SECONDS");
    await probe("settlement window of 59m59s rejected", DAY + 60, { settlementSeconds: HOUR - 1 }, "SETTLEMENT_SECONDS");
    await probe("one-minute refund window rejected (allowed on testnets)", DAY + 60, { refundSeconds: 60 }, "REFUND_SECONDS");

    // ---- Full launch at exactly the mainnet minimums ----
    const createdAt = (await now(provider)) + 10;
    await provider.send("evm_setNextBlockTimestamp", [createdAt]);
    const receipt = await wait(await d17Factory.createLaunch(config(createdAt + DAY, treasuryAddress), { gasLimit: 15_000_000 }), "create minimum-duration launch");
    const created = parseLaunchCreated(d17Factory, receipt);
    const launch = new ethers.Contract(created.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    const vault = new ethers.Contract(created.liquidityVault, artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer);
    const token = new ethers.Contract(created.token, artifact("D17Token.sol", "D17Token").abi, deployer);
    const launchAddress = created.launch;
    const rulesHash = created.rulesHash;

    assertOk("round 1 opens 24 hours after creation", await launch.roundStart(0) === BigInt(createdAt + DAY));
    for (let round = 0; round < 5; round++) {
      assertOk(`round ${round + 1} lasts one hour`, await launch.roundEnd(round) - await launch.roundStart(round) === BigInt(HOUR));
    }
    assertOk("round 2 opens after round 1's one-hour refund window", await launch.roundStart(1) === await launch.roundEnd(0) + BigInt(HOUR));

    const lockers = [];
    for (const user of users) {
      const lockerAddress = await lockerFactory.connect(user).createLockerFor.staticCall(await user.getAddress());
      await wait(await lockerFactory.connect(user).createLockerFor(await user.getAddress()), "create locker");
      lockers.push(new ethers.Contract(lockerAddress, artifact("D17Locker.sol", "D17Locker").abi, user));
    }
    const [lockerA, lockerB, lockerC, lockerD] = lockers;

    await expectRevert("no commitment during the 24-hour notice", () => lockerA.commitToRound.staticCall(launchAddress, 0, rulesHash, { value: eth("1") }), "ROUND_CLOSED");

    await setTime(provider, Number(await launch.roundStart(0)) + 5);
    await wait(await lockerA.commitToRound(launchAddress, 0, rulesHash, { value: eth("1") }), "A round 1");
    await wait(await lockerB.commitToRound(launchAddress, 0, rulesHash, { value: eth("1") }), "B round 1");
    await wait(await lockerD.commitToRound(launchAddress, 0, rulesHash, { value: eth("0.5") }), "D round 1 (will refund)");

    // Refund at the last second of the one-hour refund window: still allowed, 1% penalty.
    const refundClose = Number(await launch.roundEnd(0)) + HOUR;
    await setTime(provider, refundClose - 2);
    await wait(await lockerD.refundCurrentRound(launchAddress), "D refunds in the last seconds of the window");
    assertOk("round-1 refund penalty is 1% into the vault", await weth.balanceOf(created.liquidityVault) === eth("0.5") / 100n);

    for (let round = 1; round < 5; round++) {
      await setTime(provider, Number(await launch.roundStart(round)) + 5);
      await wait(await lockerC.commitToRound(launchAddress, round, rulesHash, { value: eth("0.2") }), `C round ${round + 1}`);
    }

    await setTime(provider, Number(await launch.roundEnd(4)) + 5);
    await wait(await launch.finalizeLaunch(), "finalize");
    const finalizedAt = Number(await launch.finalizedAt());
    assertOk("pool creation opens one hour after finalization", await launch.poolCreationOpensAt() === BigInt(finalizedAt + HOUR));

    const feeBefore = await weth.balanceOf(FEE_RECIPIENT);
    for (const locker of [lockerA, lockerB, lockerC]) {
      const preview = await launch.previewVaultSettlement(await locker.getAddress());
      await wait(await locker.settleAndClaim(launchAddress, rulesHash), "settle");
      const position = await locker.positions(launchAddress);
      assertOk("gross = vault + treasury + protocol fee", position.wethSentToVault + position.treasuryWeth + position.protocolFeeWeth === preview[1]);
    }
    assertOk("fee recipient received exactly the protocol fees", await weth.balanceOf(FEE_RECIPIENT) - feeBefore === await launch.protocolFeeWethPaid());

    await expectRevert("pool cannot open before the one-hour settlement window ends", () => vault.createOfficialPool.staticCall(1n, finalizedAt + DAY), "POOL_CREATION_NOT_OPEN");
    await setTime(provider, finalizedAt + HOUR + 1);
    await wait(await vault.createOfficialPool(1n, (await now(provider)) + HOUR), "create pool");
    assertOk("official pair created", (await vault.officialPair()) !== ethers.ZeroAddress);
    assertOk("vault records the pool", await vault.poolCreated());
    assertOk("tokens tradable once the pool exists", await token.tradingOpen());

    const passed = rows.assertion.filter((row) => row.passed).length;
    const failed = rows.assertion.length - passed;
    writeFileSync(path.join(runDir, "REPORT.md"), [
      "# D17 Mainnet Minimums E2E Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      `- Chain id: ${chainId} (local simulation)`,
      `- Assertions: ${rows.assertion.length}`,
      `- Passed: ${passed}`,
      `- Failed: ${failed}`,
      "",
      failures.length ? failures.map((failure) => `- ${failure}`).join("\n") : "- No failures",
      ""
    ].join("\n"));
    if (failures.length) throw new Error(`${failures.length} assertions failed:\n${failures.join("\n")}`);
    console.log(`D17 mainnet minimums E2E passed (${passed} assertions). Report: ${path.join(runDir, "REPORT.md")}`);
  } finally {
    if (provider?.destroy) provider.destroy();
    node.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
