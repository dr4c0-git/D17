// Fee splitter suite: an ownerless D17FeeSplitter set as the protocol fee recipient receives
// the fee of a real launch and splits it 50/25/25, for WETH, plain ETH and any other token.
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

const runDir = path.join(root, "runs", "fee-splitter");
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const D17_BUYBACKS = ethers.getAddress("0x00000000000000000000000000000000000b0001");
const LEGACY_BUYBACKS = ethers.getAddress("0x00000000000000000000000000000000000b0002");
const BUILDERS = ethers.getAddress("0x00000000000000000000000000000000000b0003");
const RECIPIENTS = [D17_BUYBACKS, LEGACY_BUYBACKS, BUILDERS];
const SHARES = [5000, 2500, 2500];

function config(startTime, treasury) {
  return {
    tokenName: "D17 Fee Split",
    tokenSymbol: "SPLIT",
    description: "Fee splitter suite launch.",
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
    maxProtocolFeeBps: 100
  };
}

async function main() {
  compile();
  mkdirSync(runDir, { recursive: true });
  const port = 9990 + Math.floor(Math.random() * 9);
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
    const wethAddress = await weth.getAddress();

    // ---- Constructor rules ----
    const splitterArt = artifact("D17FeeSplitter.sol", "D17FeeSplitter");
    const Splitter = new ethers.ContractFactory(splitterArt.abi, splitterArt.bytecode, deployer);
    const badDeploy = (args) => () => Splitter.getDeployTransaction(...args).then((tx) => deployer.estimateGas(tx));
    await expectRevert("shares must add up to 100%", badDeploy([wethAddress, RECIPIENTS, [5000, 2500, 2499]]), "SHARES_NOT_100_PERCENT");
    await expectRevert("no zero recipient", badDeploy([wethAddress, [D17_BUYBACKS, ethers.ZeroAddress], [5000, 5000]]), "RECIPIENT_ZERO");
    await expectRevert("no duplicate recipient", badDeploy([wethAddress, [D17_BUYBACKS, D17_BUYBACKS], [5000, 5000]]), "RECIPIENT_DUPLICATE");
    await expectRevert("no zero share", badDeploy([wethAddress, [D17_BUYBACKS, BUILDERS], [10000, 0]]), "SHARE_ZERO");
    await expectRevert("shares and recipients line up", badDeploy([wethAddress, RECIPIENTS, [5000, 5000]]), "LENGTH_MISMATCH");
    await expectRevert("at least one recipient", badDeploy([wethAddress, [], []]), "RECIPIENT_COUNT");
    const six = Array.from({ length: 6 }, (_, i) => ethers.getAddress(`0x00000000000000000000000000000000000c000${i + 1}`));
    await expectRevert("at most five recipients", badDeploy([wethAddress, six, [5000, 1000, 1000, 1000, 1000, 1000]]), "RECIPIENT_COUNT");
    await expectRevert("WETH address required", badDeploy([ethers.ZeroAddress, RECIPIENTS, SHARES]), "WETH_ZERO");

    const splitter = await deploy("D17FeeSplitter.sol", "D17FeeSplitter", deployer, [wethAddress, RECIPIENTS, SHARES]);
    const splitterAddress = await splitter.getAddress();
    const [storedRecipients, storedShares] = await splitter.recipients();
    assertOk("recipients readable on-chain", storedRecipients.join() === RECIPIENTS.join());
    assertOk("shares readable on-chain", storedShares.map(Number).join() === SHARES.join());
    const writable = splitterArt.abi.filter((item) => item.type === "function" && !["view", "pure"].includes(item.stateMutability));
    assertOk("only distribute functions can change state", writable.map((item) => item.name).sort().join() === "distribute,distributeEth");
    assertOk("no owner", !splitterArt.abi.some((item) => item.name === "owner"));

    // ---- Suite with the splitter as protocol fee recipient ----
    const feeConfig = await deploy("D17FeeConfig.sol", "D17FeeConfig", deployer, [deployerAddress, splitterAddress, 100]);
    const v2Factory = await deploy("test/TestV2Factory.sol", "TestV2Factory", deployer);
    const router = await deploy("test/TestV2Router.sol", "TestV2Router", deployer, [await v2Factory.getAddress()]);
    const d17Factory = await deploy("D17Factory.sol", "D17Factory", deployer, [
      deployerAddress,
      wethAddress,
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

    const start = (await now(provider)) + 60;
    const receipt = await wait(await d17Factory.createLaunch(config(start, treasuryAddress), { gasLimit: 15_000_000 }), "create launch");
    const created = parseLaunchCreated(d17Factory, receipt);
    const launch = new ethers.Contract(created.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    const launchAddress = created.launch;
    assertOk("launch freezes the splitter as fee recipient", await launch.protocolFeeRecipient() === splitterAddress);

    const lockers = [];
    for (const user of users.slice(0, 2)) {
      const lockerAddress = await lockerFactory.connect(user).createLockerFor.staticCall(await user.getAddress());
      await wait(await lockerFactory.connect(user).createLockerFor(await user.getAddress()), "create locker");
      lockers.push(new ethers.Contract(lockerAddress, artifact("D17Locker.sol", "D17Locker").abi, user));
    }
    await setTime(provider, Number(await launch.roundStart(0)) + 5);
    await wait(await lockers[0].commitToRound(launchAddress, 0, created.rulesHash, { value: eth("1.3") }), "A commits");
    await wait(await lockers[1].commitToRound(launchAddress, 0, created.rulesHash, { value: eth("0.7") }), "B commits");
    await setTime(provider, Number(await launch.roundEnd(4)) + 5);
    await wait(await launch.finalizeLaunch(), "finalize");
    for (const locker of lockers) await wait(await locker.settleAndClaim(launchAddress, created.rulesHash), "settle");

    const feePaid = await launch.protocolFeeWethPaid();
    assertOk("launch paid a 1% protocol fee", feePaid === eth("2") / 100n);
    assertOk("the whole fee landed in the splitter", await weth.balanceOf(splitterAddress) === feePaid);

    // ---- Distribution: anyone can trigger it, shares are exact ----
    const outsider = splitter.connect(users[5]);
    await wait(await outsider.distribute(wethAddress), "outsider distributes WETH");
    assertOk("50% to D17 buybacks", await weth.balanceOf(D17_BUYBACKS) === feePaid / 2n);
    assertOk("25% to 2027/XBT buybacks", await weth.balanceOf(LEGACY_BUYBACKS) === feePaid / 4n);
    assertOk("25% to builders", await weth.balanceOf(BUILDERS) === feePaid - feePaid / 2n - feePaid / 4n);
    assertOk("splitter keeps nothing", await weth.balanceOf(splitterAddress) === 0n);
    assertOk("distributing an empty balance is a no-op", await outsider.distribute.staticCall(wethAddress) === 0n);

    // Rounding: the last recipient receives the remainder, no dust stays behind.
    const before = await Promise.all(RECIPIENTS.map((address) => weth.balanceOf(address)));
    await wait(await weth.connect(users[4]).deposit({ value: 7n }), "wrap 7 wei");
    await wait(await weth.connect(users[4]).transfer(splitterAddress, 7n), "send 7 wei");
    await wait(await outsider.distribute(wethAddress), "distribute 7 wei");
    const after = await Promise.all(RECIPIENTS.map((address) => weth.balanceOf(address)));
    const got = after.map((value, i) => value - before[i]);
    assertOk("odd amounts split with the remainder to the last recipient", got.join() === "3,1,3");
    assertOk("no dust left after an odd amount", await weth.balanceOf(splitterAddress) === 0n);

    // Plain ETH is wrapped and split the same way.
    await wait(await users[4].sendTransaction({ to: splitterAddress, value: eth("0.4") }), "send plain ETH");
    const ethBefore = await Promise.all(RECIPIENTS.map((address) => weth.balanceOf(address)));
    await wait(await outsider.distributeEth(), "distribute ETH");
    const ethGot = (await Promise.all(RECIPIENTS.map((address) => weth.balanceOf(address)))).map((value, i) => value - ethBefore[i]);
    assertOk("plain ETH split 50/25/25 as WETH", ethGot.join() === [eth("0.2"), eth("0.1"), eth("0.1")].join());
    assertOk("no ETH left in the splitter", await provider.getBalance(splitterAddress) === 0n);

    // Any other token sent by mistake is split too, never stuck.
    const other = await deploy("test/TestWETH.sol", "TestWETH", deployer);
    await wait(await other.connect(users[4]).deposit({ value: eth("1") }), "mint other token");
    await wait(await other.connect(users[4]).transfer(splitterAddress, eth("1")), "send other token");
    await wait(await outsider.distribute(await other.getAddress()), "distribute other token");
    assertOk("other tokens split too", await other.balanceOf(D17_BUYBACKS) === eth("0.5") && await other.balanceOf(BUILDERS) === eth("0.25"));

    const passed = rows.assertion.filter((row) => row.passed).length;
    const failed = rows.assertion.length - passed;
    writeFileSync(path.join(runDir, "REPORT.md"), [
      "# D17 Fee Splitter E2E Report",
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
    console.log(`D17 fee splitter E2E passed (${passed} assertions). Report: ${path.join(runDir, "REPORT.md")}`);
  } finally {
    if (provider?.destroy) provider.destroy();
    node.kill("SIGTERM");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
