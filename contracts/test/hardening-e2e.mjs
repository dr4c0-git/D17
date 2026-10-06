// V15 hardening suite: protocol fee, creator guards, anti-griefing, final-round floor,
// proportional LP, late liquidity at the live ratio, residual burns and sweeps.
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

const runDir = path.join(root, "runs", "hardening");
const BPS = 10000n;
const WAD = eth("1");
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const FEE_RECIPIENT = ethers.getAddress("0x00000000000000000000000000000000000fee02");

function config(startTime, treasury, overrides = {}) {
  return {
    tokenName: "D17 Hardening",
    tokenSymbol: "D17H",
    description: "Hardening suite launch.",
    logoSvgUri: "",
    links: [],
    tokenSupply: eth("100000000"),
    saleTokens: eth("50000000"),
    lpTokens: eth("40000000"),
    manualDistributionTokens: eth("5000000"),
    deadTokens: eth("5000000"),
    deadRecipient: BURN_ADDRESS,
    treasury,
    startTime,
    roundSeconds: [120, 120, 120, 120, 120],
    refundSeconds: 60,
    settlementSeconds: 300,
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
  const port = 9970 + Math.floor(Math.random() * 20);
  const node = startNode(port);
  let provider;

  try {
    provider = await waitForRpc(port, node);
    const deployer = await provider.getSigner(0);
    const treasury = await provider.getSigner(1);
    const users = [];
    for (let i = 2; i < 10; i++) users.push(await provider.getSigner(i));
    const treasuryAddress = await treasury.getAddress();
    const deployerAddress = await deployer.getAddress();

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

    // ---- Fee configuration: hard cap, recipient rule, owner-only, two-step handover ----
    await expectRevert("fee above 2% hard cap rejected", () => feeConfig.setProtocolFee.staticCall(FEE_RECIPIENT, 201), "FEE_ABOVE_CAP");
    await expectRevert("nonzero fee needs a recipient", () => feeConfig.setProtocolFee.staticCall(ethers.ZeroAddress, 50), "FEE_RECIPIENT_ZERO");
    await expectRevert("only fee owner sets fees", () => feeConfig.connect(users[0]).setProtocolFee.staticCall(FEE_RECIPIENT, 50), "NOT_OWNER");
    await wait(await feeConfig.transferOwnership(await users[1].getAddress()), "start fee ownership transfer");
    await expectRevert("fee ownership needs the pending owner", () => feeConfig.connect(users[2]).acceptOwnership.staticCall(), "NOT_PENDING_OWNER");
    assertOk("fee owner unchanged until accepted", await feeConfig.owner() === deployerAddress);
    await wait(await feeConfig.connect(users[1]).acceptOwnership(), "accept fee ownership");
    assertOk("fee ownership handed over", await feeConfig.owner() === await users[1].getAddress());
    const feeAdmin = users[1];

    // ---- Factory caps ----
    const start = (await now(provider)) + 60;
    await expectRevert("treasury fee above 10% rejected", () => d17Factory.createLaunch.staticCall(config(start, treasuryAddress, { treasuryBps: 1001 })), "TREASURY_BPS");
    await expectRevert("refund penalty below early penalty rejected", () => d17Factory.createLaunch.staticCall(config(start, treasuryAddress, { refundPenaltyBps: 99 })), "REFUND_PENALTY_BPS");
    await expectRevert("refund penalty above 25% rejected", () => d17Factory.createLaunch.staticCall(config(start, treasuryAddress, { refundPenaltyBps: 2501 })), "REFUND_PENALTY_BPS");
    await expectRevert("creator must consent to the current protocol fee", () => d17Factory.createLaunch.staticCall(config(start, treasuryAddress, { maxProtocolFeeBps: 99 })), "PROTOCOL_FEE_ABOVE_MAX");
    await expectRevert("start in the past rejected", () => d17Factory.createLaunch.staticCall(config(start - 3600, treasuryAddress)), "START_TOO_SOON");
    assertOk("10% treasury fee accepted", Boolean(await d17Factory.createLaunch.staticCall(config(start, treasuryAddress, { treasuryBps: 1000 }))));

    async function createLaunch(cfg, label) {
      const receipt = await wait(await d17Factory.createLaunch(cfg, { gasLimit: 15_000_000 }), label);
      const created = parseLaunchCreated(d17Factory, receipt);
      return {
        launch: new ethers.Contract(created.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer),
        vault: new ethers.Contract(created.liquidityVault, artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer),
        token: new ethers.Contract(created.token, artifact("D17Token.sol", "D17Token").abi, deployer),
        rulesHash: created.rulesHash
      };
    }

    // ---- Fee snapshot: later fee changes never touch an existing launch ----
    const l1 = await createLaunch(config(start, treasuryAddress), "create launch 1");
    await wait(await feeConfig.connect(feeAdmin).setProtocolFee(FEE_RECIPIENT, 200), "raise fee to 2%");
    assertOk("existing launch keeps its fee rate", await l1.launch.protocolFeeBps() === 100n);
    assertOk("existing launch keeps its rules hash", await l1.launch.rulesHash() === l1.rulesHash);
    assertOk("existing launch stays canonical", await d17Factory.isCanonicalLaunch(await l1.launch.getAddress(), l1.rulesHash));
    await expectRevert("creator consent bound blocks the raised fee", () => d17Factory.createLaunch.staticCall(config(start, treasuryAddress)), "PROTOCOL_FEE_ABOVE_MAX");
    const l2 = await createLaunch(config(start, treasuryAddress, { maxProtocolFeeBps: 200 }), "create launch 2");
    assertOk("new launch snapshots the new fee", await l2.launch.protocolFeeBps() === 200n);
    await wait(await feeConfig.connect(feeAdmin).setProtocolFee(ethers.ZeroAddress, 0), "set fee to zero");
    const l3 = await createLaunch(config(start, treasuryAddress), "create zero-fee launch");
    assertOk("zero-fee launch snapshots zero", await l3.launch.protocolFeeBps() === 0n);
    assertOk("fee rates differ only through rules hash", l1.rulesHash !== l2.rulesHash && l2.rulesHash !== l3.rulesHash);

    const lockers = [];
    for (const user of users.slice(0, 4)) {
      const lockerAddress = await lockerFactory.connect(user).createLockerFor.staticCall(await user.getAddress());
      await wait(await lockerFactory.connect(user).createLockerFor(await user.getAddress()), "create locker");
      lockers.push(new ethers.Contract(lockerAddress, artifact("D17Locker.sol", "D17Locker").abi, user));
    }
    const [lockerA, lockerB, lockerC, lockerD] = lockers;
    const l1Address = await l1.launch.getAddress();
    const l3Address = await l3.launch.getAddress();

    // ---- Phase one ----
    await setTime(provider, Number(await l1.launch.roundStart(0)) + 5);
    await wait(await lockerA.commitToRound(l1Address, 0, l1.rulesHash, { value: eth("1") }), "A phase one");
    await wait(await lockerB.commitToRound(l1Address, 0, l1.rulesHash, { value: eth("1") }), "B phase one");
    await wait(await lockerC.commitToRound(l1Address, 0, l1.rulesHash, { value: eth("0.5") }), "C phase one");
    await wait(await lockerD.commitToRound(l1Address, 0, l1.rulesHash, { value: eth("0.4") }), "D phase one (will refund)");
    await wait(await lockerA.commitToRound(l3Address, 0, l3.rulesHash, { value: eth("2") }), "A phase one zero-fee launch");
    await setTime(provider, Number(await l1.launch.roundEnd(0)) + 5);
    const vault1Address = await l1.vault.getAddress();
    await wait(await lockerD.refundCurrentRound(l1Address), "D early refund");
    assertOk("early refund penalty is 1% into the vault", await weth.balanceOf(vault1Address) === eth("0.4") / 100n);
    assertOk("early refund penalty never reaches treasury", await weth.balanceOf(treasuryAddress) === 0n);

    // ---- Final round underfilled: priced at the anchor, remainder burned ----
    await setTime(provider, Number(await l1.launch.roundStart(4)) + 5);
    await wait(await lockerA.commitToRound(l1Address, 4, l1.rulesHash, { value: eth("0.01") }), "A small final commit");
    const anchor = await l1.launch.anchorPriceWad();
    const finalPool = await l1.launch.roundTokenAllocation(4);
    const finalSold = await l1.launch.roundSoldTokens(4);
    assertOk("underfilled final round sells at the anchor price", finalSold === finalPool * eth("0.01") / (finalPool * anchor / WAD));
    assertOk("underfilled final round does not hand out its whole pool", finalSold < finalPool);
    assertOk("final round price never below anchor", await l1.launch.roundDiscoveredPriceWad(4) >= anchor - 1n);

    await setTime(provider, Number(await l1.launch.roundEnd(4)) + 5);
    const supplyBefore = await l1.token.totalSupply();
    await wait(await l1.launch.finalizeLaunch(), "finalize launch 1");
    const unsold = await l1.launch.unsoldSaleTokensSettled();
    const effectiveLp = await l1.launch.effectiveLpTokens();
    const sold = eth("50000000") - unsold;
    assertOk("effective LP proportional to sold share", effectiveLp === eth("40000000") * sold / eth("50000000"));
    assertOk("unsold sale and unused LP burned", supplyBefore - await l1.token.totalSupply() === unsold + eth("40000000") - effectiveLp);

    // Canonical opening price is the average sale price net of fees, plus penalties.
    const totalLiquidityWeth = await l1.launch.totalLiquidityWeth();
    const finalCommitted = await l1.launch.finalCommittedWeth();
    assertOk(
      "liquidity WETH = final commitments x liquidity share + penalties",
      totalLiquidityWeth === finalCommitted * (BPS - 500n - 100n) / BPS + eth("0.4") / 100n
    );

    // ---- Settlement: A and B on time, C late ----
    const feeBefore = await weth.balanceOf(FEE_RECIPIENT);
    for (const locker of [lockerA, lockerB]) {
      const preview = await l1.launch.previewVaultSettlement(await locker.getAddress());
      await wait(await locker.settleAndClaim(l1Address, l1.rulesHash), "on-time settle");
      const position = await locker.positions(l1Address);
      assertOk("gross = vault + treasury + protocol fee", position.wethSentToVault + position.treasuryWeth + position.protocolFeeWeth === preview[1]);
      assertOk("protocol fee is 1% of gross", position.protocolFeeWeth === preview[1] / 100n);
      assertOk("treasury fee is 5% of gross", position.treasuryWeth === preview[1] * 500n / BPS);
    }
    assertOk("fee recipient received exactly the protocol fees", await weth.balanceOf(FEE_RECIPIENT) - feeBefore === await l1.launch.protocolFeeWethPaid());
    await expectRevert("residual burn waits for every settlement", () => l1.launch.burnResidualTokens.staticCall(), "SETTLEMENT_OPEN");

    await setTime(provider, Number(await l1.launch.poolCreationOpensAt()) + 1);
    await wait(await l1.vault.createOfficialPool(1n, (await now(provider)) + 3600), "create pool 1");
    const pairAddress = await l1.vault.officialPair();
    const pair = new ethers.Contract(pairAddress, artifact("test/TestV2Pair.sol", "TestV2Pair").abi, provider);
    const tokenIsToken0 = (await pair.token0()) === await l1.token.getAddress();
    const reserves = async () => {
      const [r0, r1] = await pair.getReserves();
      return tokenIsToken0 ? { token: r0, weth: r1 } : { token: r1, weth: r0 };
    };
    const opening = await reserves();
    // opening.weth / opening.token == totalLiquidityWeth / effectiveLp (integer rounding only)
    const ratioError = opening.weth * effectiveLp - opening.token * totalLiquidityWeth;
    assertOk("pool opens at the canonical ratio", (ratioError < 0n ? -ratioError : ratioError) <= totalLiquidityWeth);
    assertOk("pool includes the refund penalty", await l1.launch.officialWethUsedForLp() === await l1.launch.settledLiquidityWeth() + eth("0.4") / 100n);

    // Price falls: A dumps part of its tokens.
    const aPosition = await lockerA.positions(l1Address);
    await wait(await lockerA.withdrawUnlockedTokens(l1Address, aPosition.withdrawableTokens), "A withdraws tokens");
    const dump = aPosition.withdrawableTokens / 2n;
    await wait(await l1.token.connect(users[0]).approve(await router.getAddress(), dump), "approve dump");
    await wait(await router.connect(users[0]).swapExactTokensForTokens(await l1.token.getAddress(), await weth.getAddress(), dump, opening.weth / 4n, await users[0].getAddress()), "A dumps");
    const afterDump = await reserves();
    assertOk("price fell below launch ratio", afterDump.weth * effectiveLp < afterDump.token * totalLiquidityWeth);

    const cPreview = await l1.launch.previewVaultSettlement(await lockerC.getAddress());
    const deadBefore = await weth.balanceOf(BURN_ADDRESS);
    await wait(await lockerC.connect(users[3]).settleAfterGrace(l1Address), "third party settles C late");
    const afterLate = await reserves();
    const wethBurned = await l1.vault.lateWethBurned();
    assertOk("late settlement after a price drop burns surplus WETH", wethBurned > 0n);
    assertOk("late settlement after a price drop burns no tokens", await l1.vault.lateTokensBurned() === 0n);
    assertOk("burned WETH sits at the burn address", await weth.balanceOf(BURN_ADDRESS) - deadBefore === wethBurned);
    assertOk("late WETH pooled plus burned equals LP share", afterLate.weth - afterDump.weth + wethBurned === cPreview[2]);
    const crossDiff = (afterLate.token - afterDump.token) * afterDump.weth - (afterLate.weth - afterDump.weth) * afterDump.token;
    assertOk("late deposit balanced at the live ratio", (crossDiff < 0n ? -crossDiff : crossDiff) <= afterDump.token);
    assertOk("late settler still gets exact sale tokens", (await lockerC.positions(l1Address)).claimedSaleTokens === cPreview[0]);

    assertOk("every final commitment settled", await l1.launch.allFinalCommitmentsSettled());
    await wait(await l1.launch.burnResidualTokens(), "burn residual dust");
    assertOk("launch holds no tokens after residual burn", await l1.token.balanceOf(l1Address) === 0n);
    assertOk("vault holds only unvested creator tokens", await l1.token.balanceOf(vault1Address) === await l1.vault.lockedCreatorTokens());
    assertOk("vault holds no loose WETH", await weth.balanceOf(vault1Address) === 0n);

    // ---- Forced ETH is swept as WETH ----
    // Simulates ETH forced in by selfdestruct or a coinbase reward.
    await provider.send("hardhat_setBalance", [l1Address, ethers.toQuantity(eth("0.3"))]);
    const treasuryWethBefore = await weth.balanceOf(treasuryAddress);
    const forcedAmount = await provider.getBalance(l1Address);
    assertOk("forced ETH reached the launch", forcedAmount > 0n);
    await wait(await l1.launch.sweepUnexpectedEthToTreasury(), "sweep forced ETH");
    assertOk("forced ETH swept to treasury as WETH", await weth.balanceOf(treasuryAddress) - treasuryWethBefore === forcedAmount);

    // ---- Zero-fee launch pays no protocol fee ----
    await setTime(provider, Number(await l3.launch.roundEnd(4)) + 5);
    const zeroPreview = await l3.launch.previewVaultSettlement(await lockerA.getAddress());
    assertOk("zero-fee launch previews zero protocol fee", zeroPreview[4] === 0n && zeroPreview[1] === eth("2"));
    const zeroFeeBefore = await weth.balanceOf(FEE_RECIPIENT);
    await wait(await lockerA.settleAndClaim(l3Address, l3.rulesHash), "settle zero-fee launch");
    assertOk("zero-fee launch paid nothing to the fee recipient", await weth.balanceOf(FEE_RECIPIENT) === zeroFeeBefore);

    const passed = rows.assertion.filter((row) => row.passed).length;
    const failed = rows.assertion.length - passed;
    writeFileSync(path.join(runDir, "REPORT.md"), [
      "# D17 Hardening E2E Report",
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
    console.log(`D17 hardening E2E passed (${passed} assertions). Report: ${path.join(runDir, "REPORT.md")}`);
  } finally {
    if (provider?.destroy) provider.destroy();
    node.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
