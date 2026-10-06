import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  record,
  rows,
  setTime,
  startNode,
  wait,
  waitForRpc
} from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const runDir = path.join(root, "runs", "local");
const fixture = JSON.parse(readFileSync(path.join(root, "test", "fixtures", "local-launch.json"), "utf8"));
const ROUND_COUNT = 5;
const REFUND_STAGE_COUNT = 4;
const LOGO_PREFIX = "data:image/svg+xml;base64,";
const BPS = 10000n;
const PROTOCOL_FEE_BPS = 100;
const EARLY_REFUND_PENALTY_BPS = 100n;
const BURN_ADDRESS = "0x000000000000000000000000000000000000dEaD";

function metadataHash(config) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "string", "tuple(string linkType,string url)[]"],
      [
        config.tokenName || "",
        config.tokenSymbol || "",
        config.description || "",
        config.logoSvgUri || "",
        config.links || []
      ]
    )
  );
}

function parseContractUri(uri) {
  const prefixes = ["data:application/json;charset=utf-8,", "data:application/json;utf8,"];
  const prefix = prefixes.find((candidate) => uri.startsWith(candidate));
  if (!prefix) throw new Error("bad contractURI prefix");
  return JSON.parse(uri.slice(prefix.length));
}

function logoUriOfByteLength(totalBytes) {
  if (totalBytes < LOGO_PREFIX.length) throw new Error("logo byte length below prefix length");
  return `${LOGO_PREFIX}${"A".repeat(totalBytes - LOGO_PREFIX.length)}`;
}

function parseManualDistributionConfigured(factory, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "ManualDistributionConfigured") {
        return {
          launch: parsed.args.launch,
          recipient: parsed.args.recipient,
          amount: parsed.args.amount
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error("ManualDistributionConfigured event not found");
}

function parseLaunchMetadataPublished(factory, receipt) {
  for (const log of receipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed?.name === "LaunchMetadataPublished") {
        return {
          launch: parsed.args.launch,
          metadataHash: parsed.args.metadataHash,
          description: parsed.args.description,
          logoSvgUri: parsed.args.logoSvgUri,
          linkTypes: Array.from(parsed.args.linkTypes),
          linkUrls: Array.from(parsed.args.linkUrls)
        };
      }
    } catch {
      continue;
    }
  }
  throw new Error("LaunchMetadataPublished event not found");
}

function launchConfig(startTime, treasuryAddress) {
  return {
    tokenName: fixture.tokenName,
    tokenSymbol: fixture.tokenSymbol,
    description: fixture.description || "",
    logoSvgUri: fixture.logoSvgUri || "",
    links: fixture.links || [],
    tokenSupply: eth(fixture.tokenSupply),
    saleTokens: eth(fixture.saleTokens),
    lpTokens: eth(fixture.lpTokens),
    manualDistributionTokens: eth(fixture.manualDistributionTokens || "0"),
    deadTokens: eth(fixture.deadTokens),
    deadRecipient: fixture.deadRecipient,
    treasury: treasuryAddress,
    startTime,
    roundSeconds: fixture.roundSeconds,
    refundSeconds: fixture.refundSeconds,
    settlementSeconds: fixture.settlementSeconds,
    minCommitWeth: eth(fixture.minCommitWeth),
    minPhase1Weth: eth(fixture.minPhase1Weth),
    minAnchorPriceWad: eth(fixture.minAnchorPriceWethPerToken),
    roundSharesBps: fixture.roundSharesBps,
    treasuryBps: fixture.treasuryBps,
    refundPenaltyBps: fixture.refundPenaltyBps,
    maxProtocolFeeBps: PROTOCOL_FEE_BPS
  };
}

function amountFor(round, index) {
  const base = ["0.500", "0.170", "0.145", "0.130", "0.250"][round];
  const step = round === 4 ? 0.002 : 0.001;
  return eth((Number(base) + index * step).toFixed(3));
}

function includes(set, value) {
  return set.includes(value);
}

async function main() {
  compile();
  mkdirSync(runDir, { recursive: true });
  const port = 9770 + Math.floor(Math.random() * 200);
  const node = startNode(port);
  let provider;

  try {
    provider = await waitForRpc(port, node);
    const deployer = await provider.getSigner(0);
    const treasury = await provider.getSigner(1);
    const owners = [];
    for (let i = 2; i < 20; i++) owners.push(await provider.getSigner(i));

    const weth = await deploy("test/TestWETH.sol", "TestWETH", deployer);
    const v2Factory = await deploy("test/TestV2Factory.sol", "TestV2Factory", deployer);
    const router = await deploy("test/TestV2Router.sol", "TestV2Router", deployer, [await v2Factory.getAddress()]);
    const protocolFeeRecipientAddress = ethers.getAddress("0x00000000000000000000000000000000000fee01");
    const feeConfig = await deploy("D17FeeConfig.sol", "D17FeeConfig", deployer, [
      await deployer.getAddress(),
      protocolFeeRecipientAddress,
      PROTOCOL_FEE_BPS
    ]);
    const d17Factory = await deploy("D17Factory.sol", "D17Factory", deployer, [
      await deployer.getAddress(),
      await weth.getAddress(),
      await router.getAddress(),
      await feeConfig.getAddress()
    ]);
    const tokenFactory = await deploy("D17TokenFactory.sol", "D17TokenFactory", deployer, [
      await deployer.getAddress()
    ]);
    const vaultFactory = await deploy("D17LiquidityVaultFactory.sol", "D17LiquidityVaultFactory", deployer, [
      await deployer.getAddress()
    ]);
    const launchDeployer = await deploy("D17LaunchDeployer.sol", "D17LaunchDeployer", deployer, [
      await deployer.getAddress()
    ]);
    const launchFactory = await deploy("D17LaunchFactory.sol", "D17LaunchFactory", deployer, [
      await d17Factory.getAddress(),
      await tokenFactory.getAddress(),
      await vaultFactory.getAddress(),
      await launchDeployer.getAddress()
    ]);
    await expectRevert(
      "launch deployer rejects callers before pin",
      async () => launchDeployer.deployLaunch.staticCall("0x"),
      "NOT_LAUNCH_FACTORY"
    );
    await wait(await launchDeployer.pinLaunchFactory(await launchFactory.getAddress()), "pin launch deployer launch factory");
    await expectRevert(
      "launch deployer rejects non launch factory callers",
      async () => launchDeployer.deployLaunch.staticCall("0x"),
      "NOT_LAUNCH_FACTORY"
    );
    await wait(await tokenFactory.pinLaunchFactory(await launchFactory.getAddress()), "pin token factory launch factory");
    await wait(await vaultFactory.pinLaunchFactory(await launchFactory.getAddress()), "pin vault factory launch factory");
    await wait(await d17Factory.pinLaunchFactory(await launchFactory.getAddress()), "pin launch factory");
    await expectRevert(
      "launch factory can only be pinned once",
      async () => d17Factory.pinLaunchFactory.staticCall(await launchFactory.getAddress()),
      "LAUNCH_FACTORY_PINNED"
    );
    await expectRevert(
      "launch creation waits for locker factory pin",
      async () => d17Factory.createLaunch.staticCall(launchConfig((await now(provider)) + 60, await treasury.getAddress())),
      "LOCKER_FACTORY_UNLOCKED"
    );

    const lockerFactory = await deploy("D17LockerFactory.sol", "D17LockerFactory", deployer, [
      await d17Factory.getAddress()
    ]);
    await wait(await d17Factory.pinLockerFactory(await lockerFactory.getAddress()), "pin locker factory");
    await expectRevert(
      "locker factory can only be pinned once",
      async () => d17Factory.pinLockerFactory.staticCall(await lockerFactory.getAddress()),
      "LOCKER_FACTORY_PINNED"
    );
    await expectRevert(
      "non locker factory cannot register lockers",
      async () => d17Factory.registerLockerFor.staticCall(await owners[0].getAddress(), await owners[0].getAddress()),
      "NOT_LOCKER_FACTORY"
    );
    await expectRevert(
      "no launch while the factory owner key exists",
      async () => d17Factory.createLaunch.staticCall(launchConfig((await now(provider)) + 60, await treasury.getAddress())),
      "FACTORY_NOT_RENOUNCED"
    );
    await wait(await d17Factory.renounceOwnership(), "renounce D17Factory");
    await expectRevert(
      "no launch while creation-path factory owner keys exist",
      async () => d17Factory.createLaunch.staticCall(launchConfig((await now(provider)) + 60, await treasury.getAddress())),
      "FACTORIES_NOT_RENOUNCED"
    );
    await wait(await tokenFactory.renounceOwnership(), "renounce token factory");
    await wait(await vaultFactory.renounceOwnership(), "renounce vault factory");
    await wait(await launchDeployer.renounceOwnership(), "renounce launch deployer");

    const weakConfig = launchConfig((await now(provider)) + 60, await treasury.getAddress());
    weakConfig.minPhase1Weth = eth("10");
    weakConfig.minAnchorPriceWad = eth("0.000001");
    const weakReceipt = await wait(await d17Factory.createLaunch(weakConfig, { gasLimit: 15_000_000 }), "create weak-anchor launch");
    const weakCreated = parseLaunchCreated(d17Factory, weakReceipt);
    const weakLaunch = new ethers.Contract(weakCreated.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    const weakRulesHash = await weakLaunch.rulesHash();
    const weakOwner = owners[17];
    const weakOwnerAddress = await weakOwner.getAddress();
    const weakLockerAddress = await lockerFactory.connect(weakOwner).createLockerFor.staticCall(weakOwnerAddress);
    await wait(await lockerFactory.connect(weakOwner).createLockerFor(weakOwnerAddress), "create weak-anchor locker");
    const weakLocker = new ethers.Contract(weakLockerAddress, artifact("D17Locker.sol", "D17Locker").abi, weakOwner);

    await setTime(provider, Number(await weakLaunch.roundStart(0)) + 10);
    await expectRevert(
      "dust commit below minimum rejected",
      async () => weakLocker.commitToRound.staticCall(await weakLaunch.getAddress(), 0, weakRulesHash, { value: 1n }),
      "COMMIT_TOO_SMALL"
    );
    await wait(await weakLocker.commitToRound(await weakLaunch.getAddress(), 0, weakRulesHash, { value: eth("0.5") }), "weak-anchor phase one commit");
    // Anchor-griefing cost: a phase-one commitment refunded in the phase-one window pays the
    // fixed early penalty into the vault.
    const griefOwner = owners[16];
    const griefLockerAddress = await lockerFactory.connect(griefOwner).createLockerFor.staticCall(await griefOwner.getAddress());
    await wait(await lockerFactory.connect(griefOwner).createLockerFor(await griefOwner.getAddress()), "create grief locker");
    const griefLocker = new ethers.Contract(griefLockerAddress, artifact("D17Locker.sol", "D17Locker").abi, griefOwner);
    await wait(await griefLocker.commitToRound(await weakLaunch.getAddress(), 0, weakRulesHash, { value: eth("20") }), "grief commit");
    assertOk("large phase-one commit makes the anchor look ready", await weakLaunch.anchorReady());
    await setTime(provider, Number(await weakLaunch.roundEnd(0)) + Number(await weakLaunch.refundSeconds()) - 5);
    await wait(await griefLocker.refundCurrentRound(await weakLaunch.getAddress()), "grief refund at the last second");
    const weakVaultAddress = await weakLaunch.liquidityVault();
    const griefPenalty = eth("20") * EARLY_REFUND_PENALTY_BPS / BPS;
    assertOk("last-second phase-one refund pays early penalty into the vault", await weth.balanceOf(weakVaultAddress) === griefPenalty);
    assertOk("griefer recovers gross minus penalty", (await griefLocker.positions(await weakLaunch.getAddress())).residualWeth === eth("20") - griefPenalty);
    await setTime(provider, Number(await weakLaunch.roundEnd(0)) + Number(await weakLaunch.refundSeconds()) + 10);
    const failedPhase = await weakLaunch.launchPhase();
    assertOk("weak phase one moves launch to failed phase", Number(failedPhase[0]) === 7);
    await expectRevert(
      "weak-anchor launch blocks later commitments",
      async () => weakLocker.commitToRound.staticCall(await weakLaunch.getAddress(), 1, weakRulesHash, { value: eth("0.5") }),
      "ROUND_CLOSED"
    );
    await expectRevert(
      "weak-anchor launch cannot finalize",
      async () => weakLaunch.finalizeLaunch.staticCall(),
      "LAUNCH_FAILED"
    );
    await wait(await weakLocker.refundFailedLaunch(await weakLaunch.getAddress(), weakRulesHash), "failed launch refund");
    const weakPosition = await weakLocker.positions(await weakLaunch.getAddress());
    assertOk("failed launch refund unlocks committed WETH", weakPosition.residualWeth === eth("0.5"));
    assertOk("failed launch WETH never left the locker", await weth.balanceOf(weakLockerAddress) === eth("0.5"));
    const weakVault = new ethers.Contract(weakVaultAddress, artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer);
    const deadBeforeFailedBurn = await weth.balanceOf(BURN_ADDRESS);
    await wait(await weakVault.connect(owners[5]).burnFailedLaunchPenalties(), "burn failed-launch penalties");
    assertOk("failed-launch penalties burned, not paid to anyone", await weth.balanceOf(BURN_ADDRESS) - deadBeforeFailedBurn === griefPenalty);
    assertOk("failed-launch vault holds no WETH", await weth.balanceOf(weakVaultAddress) === 0n);

    const config = launchConfig((await now(provider)) + 60, await treasury.getAddress());
    const invalidUrlConfig = { ...config, links: [{ linkType: "website", url: "javascript:alert(1)" }] };
    await expectRevert(
      "metadata urls must be https",
      async () => d17Factory.createLaunch.staticCall(invalidUrlConfig),
      "LINK_URL_SCHEME"
    );
    const invalidLogoConfig = { ...config, logoSvgUri: "data:image/png;base64,aaaa" };
    await expectRevert(
      "metadata logo must be base64 svg data uri",
      async () => d17Factory.createLaunch.staticCall(invalidLogoConfig),
      "LOGO_PREFIX"
    );
    const invalidBase64LogoConfig = { ...config, logoSvgUri: "data:image/svg+xml;base64,AA\"}" };
    await expectRevert(
      "metadata logo base64 payload rejects quote injection",
      async () => d17Factory.createLaunch.staticCall(invalidBase64LogoConfig),
      "LOGO_BASE64"
    );
    const oversizedLogoConfig = { ...config, logoSvgUri: logoUriOfByteLength(8193) };
    await expectRevert(
      "metadata logo rejects 8193 bytes",
      async () => d17Factory.createLaunch.staticCall(oversizedLogoConfig),
      "LOGO_BYTES"
    );
    const oversizedDescriptionConfig = { ...config, description: "x".repeat(513) };
    await expectRevert(
      "metadata description size capped",
      async () => d17Factory.createLaunch.staticCall(oversizedDescriptionConfig),
      "DESCRIPTION_BYTES"
    );
    const quotedDescriptionConfig = { ...config, description: "bad \" description" };
    await expectRevert(
      "metadata description rejects json-breaking quote",
      async () => d17Factory.createLaunch.staticCall(quotedDescriptionConfig),
      "DESCRIPTION_JSON"
    );
    const uppercaseLinkTypeConfig = { ...config, links: [{ linkType: "Web3", url: "https://ethereum.org" }] };
    await expectRevert(
      "metadata link type rejects uppercase",
      async () => d17Factory.createLaunch.staticCall(uppercaseLinkTypeConfig),
      "LINK_TYPE_CHARS"
    );
    const oversizedLinkTypeConfig = { ...config, links: [{ linkType: "a".repeat(33), url: "https://ethereum.org" }] };
    await expectRevert(
      "metadata link type size capped",
      async () => d17Factory.createLaunch.staticCall(oversizedLinkTypeConfig),
      "LINK_TYPE"
    );
    const ninthLinkConfig = {
      ...config,
      links: Array.from({ length: 9 }, (_, i) => ({ linkType: `link-${i}`, url: "https://ethereum.org" }))
    };
    await expectRevert(
      "metadata links capped at eight",
      async () => d17Factory.createLaunch.staticCall(ninthLinkConfig),
      "LINKS"
    );

    const maxLogoConfig = { ...config, logoSvgUri: logoUriOfByteLength(8192) };
    const maxLogoReceipt = await wait(
      await d17Factory.createLaunch(maxLogoConfig, { gasLimit: 30_000_000 }),
      "create exact max-logo metadata launch"
    );
    const maxLogoCreated = parseLaunchCreated(d17Factory, maxLogoReceipt);
    const maxLogoToken = new ethers.Contract(maxLogoCreated.token, artifact("D17Token.sol", "D17Token").abi, deployer);
    const maxLogoJson = parseContractUri(await maxLogoToken.contractURI());
    assertOk("8192-byte logo deploys", Buffer.byteLength(maxLogoJson.image, "utf8") === 8192);

    const createdReceipt = await wait(await d17Factory.createLaunch(config, { gasLimit: 15_000_000 }), "create launch");
    const createdLaunch = parseLaunchCreated(d17Factory, createdReceipt);
    const createdMetadata = parseLaunchMetadataPublished(d17Factory, createdReceipt);

    const token = new ethers.Contract(createdLaunch.token, artifact("D17Token.sol", "D17Token").abi, deployer);
    const launch = new ethers.Contract(createdLaunch.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    const vault = new ethers.Contract(createdLaunch.liquidityVault, artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer);
    const pairAbi = artifact("test/TestV2Pair.sol", "TestV2Pair").abi;
    const rulesHash = await launch.rulesHash();
    const expectedMetadataHash = metadataHash(config);

    assertOk("factory canonical launch", await d17Factory.isCanonicalLaunch(await launch.getAddress(), rulesHash));
    assertOk("metadata hash stored on launch", await launch.metadataHash() === expectedMetadataHash);
    assertOk("metadata event launch matches", createdMetadata.launch === await launch.getAddress());
    assertOk("metadata event hash matches launch", createdMetadata.metadataHash === await launch.metadataHash());
    assertOk("metadata event description indexed", createdMetadata.description === fixture.description);
    assertOk("metadata event logo indexed", createdMetadata.logoSvgUri === fixture.logoSvgUri);
    assertOk("metadata event link types indexed", JSON.stringify(createdMetadata.linkTypes) === JSON.stringify(fixture.links.map((link) => link.linkType)));
    assertOk("metadata event link urls indexed", JSON.stringify(createdMetadata.linkUrls) === JSON.stringify(fixture.links.map((link) => link.url)));
    assertOk("token metadata hash stored", await token.metadataHash() === expectedMetadataHash);
    assertOk("token metadata configured once", await token.metadataConfigured());
    assertOk("token link count stored", Number(await token.linkCount()) === fixture.links.length);
    const firstStoredLink = await token.links(0);
    assertOk("token first metadata link stored", firstStoredLink[0] === fixture.links[0].linkType && firstStoredLink[1] === fixture.links[0].url);
    await expectRevert(
      "token link getter has friendly bounds error",
      async () => token.links.staticCall(fixture.links.length),
      "LINK_INDEX"
    );
    const contractUriUpdatedCount = createdReceipt.logs.reduce((count, log) => {
      try {
        const parsed = token.interface.parseLog(log);
        return parsed?.name === "ContractURIUpdated" ? count + 1 : count;
      } catch {
        return count;
      }
    }, 0);
    assertOk("contractURI update emitted exactly once", contractUriUpdatedCount === 1);
    await expectRevert(
      "token metadata cannot be configured twice",
      async () => token.configureMetadata.staticCall(config.description, config.logoSvgUri, config.links),
      "NOT_OWNER"
    );
    const parsedContractUri = parseContractUri(await token.contractURI());
    assertOk("contractURI json parses", parsedContractUri.name === fixture.tokenName);
    assertOk("contractURI uses charset=utf-8 prefix", (await token.contractURI()).startsWith("data:application/json;charset=utf-8,"));
    assertOk("contractURI symbol parses", parsedContractUri.symbol === fixture.tokenSymbol);
    assertOk("contractURI image matches logo", parsedContractUri.image === fixture.logoSvgUri);
    assertOk("contractURI links round-trip", JSON.stringify(parsedContractUri.links) === JSON.stringify(fixture.links.map((link) => ({ type: link.linkType, url: link.url }))));
    const metadataLogs = await d17Factory.queryFilter(
      d17Factory.filters.LaunchMetadataPublished(await launch.getAddress()),
      0,
      "latest"
    );
    assertOk("metadata event readable through RPC logs", metadataLogs.length === 1);
    const rpcMetadata = metadataLogs[0].args;
    assertOk("RPC metadata hash verifies", rpcMetadata.metadataHash === expectedMetadataHash);
    writeFileSync(path.join(runDir, "METADATA_RPC_READ.json"), `${JSON.stringify({
      schema: "d17-local-token-metadata-rpc-read-v1",
      launch: await launch.getAddress(),
      factory: await launch.factory(),
      token: await launch.token(),
      metadataHash: await launch.metadataHash(),
      eventMetadataHash: rpcMetadata.metadataHash,
      hashMatchesLaunch: rpcMetadata.metadataHash === await launch.metadataHash(),
      metadata: {
        description: rpcMetadata.description,
        logoSvgUri: rpcMetadata.logoSvgUri,
        links: Array.from(rpcMetadata.linkTypes).map((linkType, index) => ({ linkType, url: rpcMetadata.linkUrls[index] })),
        logoBytes: Buffer.byteLength(rpcMetadata.logoSvgUri, "utf8")
      },
      event: {
        blockNumber: metadataLogs[0].blockNumber,
        transactionHash: metadataLogs[0].transactionHash
      }
    }, null, 2)}\n`);
    const changedMetadataConfig = { ...config, description: `${config.description}!` };
    const changedReceipt = await wait(
      await d17Factory.createLaunch(changedMetadataConfig, { gasLimit: 15_000_000 }),
      "create metadata-variant launch"
    );
    const changedCreated = parseLaunchCreated(d17Factory, changedReceipt);
    const changedLaunch = new ethers.Contract(changedCreated.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    const changedMetadata = parseLaunchMetadataPublished(d17Factory, changedReceipt);
    assertOk("metadata changes rules hash", await changedLaunch.rulesHash() !== rulesHash);
    assertOk("metadata changes metadata hash", changedMetadata.metadataHash !== expectedMetadataHash);
    const changedNameConfig = { ...config, tokenName: `${config.tokenName} Name Hash` };
    const changedNameReceipt = await wait(
      await d17Factory.createLaunch(changedNameConfig, { gasLimit: 15_000_000 }),
      "create token-name-variant launch"
    );
    const changedNameCreated = parseLaunchCreated(d17Factory, changedNameReceipt);
    const changedNameLaunch = new ethers.Contract(changedNameCreated.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    assertOk("token name changes metadata hash directly", await changedNameLaunch.metadataHash() !== expectedMetadataHash);
    assertOk("token name changes rules hash directly", await changedNameLaunch.rulesHash() !== rulesHash);
    await expectRevert(
      "locker rejects rules hash from name-variant launch",
      async () => weakLocker.verifyLaunch.staticCall(await changedNameLaunch.getAddress(), rulesHash),
      "BAD_RULES"
    );
    const emptyLogoConfig = { ...config, logoSvgUri: "", links: [] };
    const emptyLogoReceipt = await wait(
      await d17Factory.createLaunch(emptyLogoConfig, { gasLimit: 15_000_000 }),
      "create empty-logo metadata launch"
    );
    const emptyLogoCreated = parseLaunchCreated(d17Factory, emptyLogoReceipt);
    const emptyLogoToken = new ethers.Contract(emptyLogoCreated.token, artifact("D17Token.sol", "D17Token").abi, deployer);
    const emptyLogoJson = parseContractUri(await emptyLogoToken.contractURI());
    assertOk("empty logo contractURI keeps blank image for frontend fallback", emptyLogoJson.image === "");
    assertOk("empty links contractURI returns an array", Array.isArray(emptyLogoJson.links) && emptyLogoJson.links.length === 0);
    assertOk("five-round launch id", Number(await launch.ROUND_COUNT()) === ROUND_COUNT);
    assertOk("token trading gate configured", await token.tradingGateConfigured());
    assertOk("launch records liquidity vault", await launch.liquidityVault() === await vault.getAddress());
    assertOk("token records liquidity vault", await token.liquidityVault() === await vault.getAddress());
    assertOk("trading opens after final round plus settlement window", await token.tradingOpenAt() === await launch.tradingOpenAt());
    assertOk("trading starts closed", !(await token.tradingOpen()));
    assertOk("token supply minted", await token.totalSupply() === eth(fixture.tokenSupply));
    assertOk("launch holds sale and lp pools", await token.balanceOf(await launch.getAddress()) === eth(fixture.saleTokens) + eth(fixture.lpTokens));
    assertOk("dead allocation minted to dead wallet", await token.balanceOf(fixture.deadRecipient) === eth(fixture.deadTokens));
    assertOk("launch starts with zero WETH", await weth.balanceOf(await launch.getAddress()) === 0n);

    const deployerAddress = await deployer.getAddress();
    const manualTokens = eth(fixture.manualDistributionTokens);
    assertOk("25/10/10/55 split accepted", manualTokens > 0n && eth(fixture.saleTokens) + eth(fixture.lpTokens) + manualTokens + eth(fixture.deadTokens) === eth(fixture.tokenSupply));
    assertOk("manual allocation getter exact", await launch.manualDistributionTokens() === manualTokens);
    assertOk("manual recipient is launch creator", await launch.manualDistributionRecipient() === deployerAddress);
    assertOk("creator allocation minted into the vault for vesting", await token.balanceOf(await vault.getAddress()) === manualTokens);
    assertOk("creator wallet holds no tokens before vesting", await token.balanceOf(deployerAddress) === 0n);
    assertOk("vault reports full creator allocation locked", await vault.lockedCreatorTokens() === manualTokens);
    assertOk("nothing vested before pool creation", await vault.vestedCreatorTokens() === 0n);
    await expectRevert("creator tokens cannot be released before pool", async () => vault.releaseCreatorTokens.staticCall(), "NOTHING_VESTED");
    assertOk("launch snapshots protocol fee rate", Number(await launch.protocolFeeBps()) === PROTOCOL_FEE_BPS);
    assertOk("launch snapshots protocol fee recipient", await launch.protocolFeeRecipient() === protocolFeeRecipientAddress);
    assertOk("factory holds no manual tokens", await token.balanceOf(await d17Factory.getAddress()) === 0n);
    assertOk("launch factory holds no manual tokens", await token.balanceOf(await launchFactory.getAddress()) === 0n);
    assertOk("treasury holds no manual tokens", await token.balanceOf(await treasury.getAddress()) === 0n);
    assertOk("token minting closed after deploy", await token.mintingClosed());
    assertOk("token ownership renounced after deploy", await token.owner() === ethers.ZeroAddress);
    const manualEvent = parseManualDistributionConfigured(d17Factory, createdReceipt);
    assertOk("manual event launch matches", manualEvent.launch === await launch.getAddress());
    assertOk("manual event recipient is creator", manualEvent.recipient === deployerAddress);
    assertOk("manual event amount exact", manualEvent.amount === manualTokens);
    await expectRevert(
      "creator wallet has nothing to transfer before trading opens",
      async () => token.connect(deployer).transfer.staticCall(await owners[1].getAddress(), 1n),
      "TRADING_CLOSED"
    );

    const badSplitConfig = { ...config, deadTokens: eth("56000000") };
    await expectRevert(
      "four-way split mismatch reverts",
      async () => d17Factory.createLaunch.staticCall(badSplitConfig),
      "SUPPLY_SPLIT"
    );
    const overCapConfig = { ...config, manualDistributionTokens: eth("10000001"), deadTokens: eth("54999999") };
    await expectRevert(
      "manual allocation above 10% cap reverts",
      async () => d17Factory.createLaunch.staticCall(overCapConfig),
      "MANUAL_ABOVE_CAP"
    );

    const manualVariantConfig = { ...config, manualDistributionTokens: eth("5000000"), deadTokens: eth("60000000") };
    const manualVariantReceipt = await wait(
      await d17Factory.createLaunch(manualVariantConfig, { gasLimit: 15_000_000 }),
      "create manual-variant launch"
    );
    const manualVariantCreated = parseLaunchCreated(d17Factory, manualVariantReceipt);
    const manualVariantLaunch = new ethers.Contract(manualVariantCreated.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    assertOk("manual amount changes rules hash", await manualVariantLaunch.rulesHash() !== rulesHash);
    assertOk("manual variant getter exact", await manualVariantLaunch.manualDistributionTokens() === eth("5000000"));
    await expectRevert(
      "locker rejects stale rules hash from manual-variant launch",
      async () => weakLocker.verifyLaunch.staticCall(await manualVariantLaunch.getAddress(), rulesHash),
      "BAD_RULES"
    );

    const zeroManualConfig = { ...config, manualDistributionTokens: 0n, deadTokens: eth("65000000") };
    const zeroManualReceipt = await wait(
      await d17Factory.createLaunch(zeroManualConfig, { gasLimit: 15_000_000 }),
      "create zero-manual launch"
    );
    const zeroManualEvent = parseManualDistributionConfigured(d17Factory, zeroManualReceipt);
    assertOk("zero manual allocation allowed and evented", zeroManualEvent.amount === 0n);
    await expectRevert("direct contribution record rejected", () => launch.recordRoundCommitment(0, eth("0.1")), "NOT_D17_LOCKER");
    await expectRevert("direct launch eth rejected", async () => deployer.sendTransaction({ to: await launch.getAddress(), value: eth("0.001") }));

    const lockers = [];
    const roundParticipants = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      [2, 3, 4, 5, 9, 10, 11, 12],
      [1, 3, 5, 7, 9, 11, 13, 14, 15],
      [0, 3, 4, 6, 9, 13, 16, 17],
      [0, 1, 2, 5, 8, 10, 12, 15, 16, 17]
    ];
    const refunders = [
      [6],
      [10, 12],
      [7, 14],
      [16]
    ];
    const created = new Set();

    async function ensureLocker(index) {
      if (created.has(index)) return lockers[index];
      const ownerAddress = await owners[index].getAddress();
      const lockerForOwner = lockerFactory.connect(owners[index]);
      const lockerAddress = await lockerForOwner.createLockerFor.staticCall(ownerAddress);
      await wait(await lockerForOwner.createLockerFor(ownerAddress), "create locker");
      const locker = new ethers.Contract(lockerAddress, artifact("D17Locker.sol", "D17Locker").abi, owners[index]);
      lockers[index] = locker;
      created.add(index);
      record("locker", { index, owner: ownerAddress, locker: lockerAddress });
      assertOk(`locker ${index} registered`, await d17Factory.isLocker(lockerAddress));
      return locker;
    }

    const firstLocker = await ensureLocker(0);
    await expectRevert(
      "locker rejects sentinel round before array panic",
      async () => firstLocker.commitToRound.staticCall(await launch.getAddress(), 255, rulesHash, { value: eth("0.01") }),
      "ROUND"
    );
    await expectRevert(
      "zero-value token transfer remains gated before open",
      async () => token.connect(owners[0]).transfer.staticCall(await owners[1].getAddress(), 0),
      "TRADING_CLOSED"
    );
    await expectRevert(
      "pre-open burn blocked for non-launch callers",
      async () => token.connect(owners[0]).burn.staticCall(1n),
      "BURN_BEFORE_OPEN"
    );
    await expectRevert(
      "creator cannot burn manual allocation before trading opens",
      async () => token.connect(deployer).burn.staticCall(1n),
      "BURN_BEFORE_OPEN"
    );

    for (let round = 0; round < ROUND_COUNT; round++) {
      await setTime(provider, Number(await launch.roundStart(round)) + 10);
      assertOk(`round ${round + 1} active`, Number(await launch.activeRound()) === round);

      if (round === 1) {
        assertOk("phase one anchor established before anchor-target phases", await launch.anchorPriceWad() > 0n);
      }

      for (const index of roundParticipants[round]) {
        const locker = await ensureLocker(index);
        const lockerAddress = await locker.getAddress();
        const amount = amountFor(round, index);
        const launchWethBefore = await weth.balanceOf(await launch.getAddress());
        const lockerWethBefore = await weth.balanceOf(lockerAddress);
        await wait(await locker.commitToRound(await launch.getAddress(), round, rulesHash, { value: amount }), "commit to round");
        const lockerWethAfter = await weth.balanceOf(lockerAddress);
        assertOk(`locker ${index} WETH stayed in locker r${round + 1}`, lockerWethAfter - lockerWethBefore === amount);
        assertOk(`launch WETH stayed zero r${round + 1}`, await weth.balanceOf(await launch.getAddress()) === launchWethBefore);
        assertOk(`locker ${index} locked WETH r${round + 1}`, await locker.lockedWeth(await launch.getAddress()) >= amount);
        record("action", { locker: index, action: "commit", round: round + 1, amount: amount.toString() });
      }

      if (round === 1) {
        const target = await launch.roundAnchorTargetWeth(round);
        const raised = await launch.roundRaised(round);
        const overfillAmount = raised > target ? eth("0.25") : target - raised + eth("0.25");
        const overfillLocker = await ensureLocker(0);
        await wait(
          await overfillLocker.commitToRound(await launch.getAddress(), round, rulesHash, { value: overfillAmount }),
          "overfill round 2 without cap"
        );
        assertOk("round 2 can exceed anchor target", await launch.roundRaised(round) > target);
        assertOk("overfilled round 2 sells full allocation", await launch.roundSoldTokens(round) === await launch.roundBaseTokenAllocation(round));
        assertOk("overfilled round 2 has zero rollover", await launch.roundAnchorUnderfillRemainingWeth(round) === 0n);
        assertOk("round 2 price worsens above anchor", await launch.roundDiscoveredPriceWad(round) > await launch.anchorPriceWad());
        record("action", { locker: 0, action: "overfill", round: round + 1, amount: overfillAmount.toString() });
      }

      if (round < REFUND_STAGE_COUNT) {
        await setTime(provider, Number(await launch.roundEnd(round)) + 10);
        assertOk(`refund window ${round + 1} active`, Number(await launch.activeRefundWindow()) === round);
        await expectRevert(
          `settlement blocked before phase ${ROUND_COUNT} closes`,
          async () => lockers[roundParticipants[round][0]].settleAndClaim.staticCall(await launch.getAddress(), rulesHash),
          "NOT_OVER"
        );

        for (const index of refunders[round]) {
          const locker = lockers[index];
          const lockerAddress = await locker.getAddress();
          const treasuryBefore = await weth.balanceOf(await treasury.getAddress());
          const vaultWethBefore = await weth.balanceOf(await vault.getAddress());
          const lockerWethBefore = await weth.balanceOf(lockerAddress);
          const positionBefore = await locker.positions(await launch.getAddress());
          await wait(await locker.refundCurrentRound(await launch.getAddress()), "refund current round");
          const vaultDelta = await weth.balanceOf(await vault.getAddress()) - vaultWethBefore;
          const lockerDelta = lockerWethBefore - await weth.balanceOf(lockerAddress);
          const position = await locker.positions(await launch.getAddress());
          assertOk(`locker ${index} only penalty leaves locker r${round + 1}`, lockerDelta === vaultDelta);
          assertOk(`locker ${index} treasury receives no refund penalty r${round + 1}`, await weth.balanceOf(await treasury.getAddress()) === treasuryBefore);
          // Refund schedule: contract rounds 0-1 pay the fixed early penalty, rounds 2-3 the
          // launch's refundPenaltyBps. Every penalty goes to the liquidity vault.
          const grossRefunded = (position.wethRefunded + position.penaltyPaid) - (positionBefore.wethRefunded + positionBefore.penaltyPaid);
          const expectedPenaltyBps = round < 2 ? EARLY_REFUND_PENALTY_BPS : BigInt(fixture.refundPenaltyBps);
          assertOk(`locker ${index} display round ${round + 1} penalty charged`, vaultDelta > 0n);
          assertOk(
            `locker ${index} display round ${round + 1} penalty is exact`,
            vaultDelta === grossRefunded * expectedPenaltyBps / BPS
          );
          assertOk(`locker ${index} refund became withdrawable r${round + 1}`, position.residualWeth >= position.wethRefunded);
          record("action", { locker: index, action: "refund", round: round + 1 });
        }

        await setTime(provider, Number(await launch.roundEnd(round)) + Number(await launch.refundSeconds()) + 10);
        if (round === 0) {
          assertOk(
            "anchor invariant holds after phase-one refund closes",
            await launch.anchorReady() && await launch.totalCommittedWeth() >= await launch.minPhase1Weth()
          );
        }
      }
    }

    const baseFinalAllocation = await launch.roundBaseTokenAllocation(4);
    const rolloverBeforeFinalize = await launch.rolloverToFinalRound();
    assertOk(
      "anchor invariant still holds before finalization",
      await launch.anchorReady() && await launch.totalCommittedWeth() >= await launch.minPhase1Weth()
    );
    assertOk("rollover accumulated before finalization", rolloverBeforeFinalize > 0n);
    assertOk("phase five preview includes rollover", await launch.roundTokenAllocation(4) === baseFinalAllocation + rolloverBeforeFinalize);
    assertOk(
      "unsupported per-round claim ABI absent",
      !lockers[0].interface.fragments.some((fragment) => fragment.type === "function" && fragment.name === "claimRoundTokens")
    );
    assertOk(
      "unsupported final claim ABI absent",
      !lockers[0].interface.fragments.some((fragment) => fragment.type === "function" && fragment.name === "claimFinalTokens")
    );

    await setTime(provider, Number(await launch.roundEnd(4)) + 10);
    const treasuryWethBeforeFinalize = await weth.balanceOf(await treasury.getAddress());
    const treasuryTokenBeforeFinalize = await token.balanceOf(await treasury.getAddress());
    const totalSupplyBeforeFinalize = await token.totalSupply();
    await wait(await launch.finalizeLaunch(), "finalize");
    assertOk("launch finalized", await launch.finalized());
    const settlementPhase = await launch.launchPhase();
    assertOk("finalized launch enters settlement window", Number(settlementPhase[0]) === 4);
    const graceOpensAt = await launch.poolCreationOpensAt();
    const finalizedAtTs = await launch.finalizedAt();
    const settlementWindow = await launch.settlementSeconds();
    const tradingOpenAtTs = await launch.tradingOpenAt();
    const expectedGraceOpensAt = finalizedAtTs + settlementWindow > tradingOpenAtTs
      ? finalizedAtTs + settlementWindow
      : tradingOpenAtTs;
    assertOk("grace window fixed at finalization plus settlement window", graceOpensAt === expectedGraceOpensAt);
    assertOk("final token pool locked at rollover amount", await launch.finalRoundTokenPool() === baseFinalAllocation + rolloverBeforeFinalize);
    assertOk("finalize did not custody-transfer WETH", await weth.balanceOf(await treasury.getAddress()) === treasuryWethBeforeFinalize);
    assertOk("launch holds no WETH at finalization", await weth.balanceOf(await launch.getAddress()) === 0n);

    const treasuryTokenAfterFinalize = await token.balanceOf(await treasury.getAddress());
    const totalSupplyAfterFinalize = await token.totalSupply();
    const unsoldSettled = await launch.unsoldSaleTokensSettled();
    const unusedLpBurned = await launch.unusedLpTokensBurned();
    const effectiveLp = await launch.effectiveLpTokens();
    assertOk("unsold and unused LP tokens burned at finalization", totalSupplyBeforeFinalize - totalSupplyAfterFinalize === unsoldSettled + unusedLpBurned);
    assertOk("treasury never receives sale tokens", treasuryTokenAfterFinalize === treasuryTokenBeforeFinalize);
    assertOk("effective LP scales with sold share", effectiveLp === eth(fixture.lpTokens) * (eth(fixture.saleTokens) - unsoldSettled) / eth(fixture.saleTokens));
    assertOk("effective plus burned LP equals LP allocation", effectiveLp + unusedLpBurned === eth(fixture.lpTokens));
    assertOk("final round never sells below anchor", await launch.roundDiscoveredPriceWad(4) >= await launch.anchorPriceWad());

    const excessLocker = lockers[0];
    const excessOwner = owners[0];
    const excessOwnerAddress = await excessOwner.getAddress();
    const excessAmount = eth("0.25");
    await wait(await weth.connect(excessOwner).deposit({ value: excessAmount }), "owner wraps excess WETH");
    await wait(await weth.connect(excessOwner).transfer(await excessLocker.getAddress(), excessAmount), "send excess WETH");
    const excessOwnerBefore = await weth.balanceOf(excessOwnerAddress);
    await wait(await excessLocker.recoverExcessWeth(excessOwnerAddress, excessAmount), "recover excess WETH");
    assertOk("direct excess WETH can be recovered", await weth.balanceOf(excessOwnerAddress) - excessOwnerBefore === excessAmount);

    let pairAddress = ethers.ZeroAddress;
    let pair;
    let totalLp = 0n;
    const treasuryWethBeforeSettlement = await weth.balanceOf(await treasury.getAddress());
    const finalLockers = [...created];
    await expectRevert(
      "sale token withdrawal requires trading-open settlement path",
      async () => lockers[0].withdrawUnlockedTokens.staticCall(await launch.getAddress(), 1n),
      "TOKEN_WITHDRAW_LOCKED"
    );

    await wait(await v2Factory.createPair(await token.getAddress(), await weth.getAddress()), "pre-create canonical pair");
    pairAddress = await v2Factory.getPair(await token.getAddress(), await weth.getAddress());
    pair = new ethers.Contract(pairAddress, pairAbi, deployer);
    await expectRevert(
      "pre-open D17 token dust to canonical pair is blocked",
      async () => token.connect(treasury).transfer.staticCall(pairAddress, 1n),
      "TRADING_CLOSED"
    );
    await wait(await weth.deposit({ value: eth("0.11") }), "wrap over-cap WETH dust");
    await wait(await weth.transfer(pairAddress, eth("0.11")), "send over-cap WETH dust to pair");
    assertOk("canonical pair can receive WETH dust before official pool creation", await weth.balanceOf(pairAddress) === eth("0.11"));

    // Late cohort: lockers deliberately left unsettled at pool creation.
    // 15: multi-round participant. 16: refunded round 4 window plus final-round commit.
    // 17: settles late through the owner path. 13 is settled-for pre-pool by a third party.
    const lateLockerIndices = [15, 16, 17];
    const lateOwnerSettleIndex = 17;
    const latePublicSettleIndices = [15, 16];
    const publicSettlementIndex = 13;
    const ownerSettledLockers = finalLockers.filter(
      (index) => index !== publicSettlementIndex && !lateLockerIndices.includes(index)
    );

    await expectRevert(
      "third party cannot settle during user grace window",
      async () => lockers[publicSettlementIndex].connect(deployer).settleAfterGrace.staticCall(await launch.getAddress()),
      "GRACE_OPEN"
    );

    const feeRecipientBeforeSettlement = await weth.balanceOf(protocolFeeRecipientAddress);
    assertOk("refunds paid no protocol fee", feeRecipientBeforeSettlement === 0n);
    for (const index of ownerSettledLockers) {
      const locker = lockers[index];
      const preview = await launch.previewVaultSettlement(await locker.getAddress());
      if (preview[1] === 0n && preview[2] === 0n) continue;
      const salePreview = await launch.previewFinalSaleTokens(await locker.getAddress());
      await wait(await locker.settleAndClaim(await launch.getAddress(), rulesHash), "owner settles and claims");
      const position = await locker.positions(await launch.getAddress());
      assertOk(`locker ${index} sale tokens matched vault preview`, salePreview === preview[0]);
      assertOk(`locker ${index} gross WETH matched preview`, position.wethSentToVault + position.treasuryWeth + position.protocolFeeWeth === preview[1]);
      assertOk(`locker ${index} WETH sent to vault matched preview`, position.wethSentToVault === preview[2]);
      assertOk(`locker ${index} treasury WETH matched preview`, position.treasuryWeth === preview[3]);
      assertOk(`locker ${index} protocol fee matched preview`, position.protocolFeeWeth === preview[4]);
      assertOk(`locker ${index} protocol fee is exact rate`, preview[4] === preview[1] * BigInt(PROTOCOL_FEE_BPS) / BPS);
      assertOk(`locker ${index} committed WETH emptied`, await locker.lockedWeth(await launch.getAddress()) === 0n);
      assertOk(`locker ${index} final sale tokens matched preview`, position.claimedSaleTokens === salePreview);
      assertOk(`locker ${index} sale tokens remain withdrawable`, position.withdrawableTokens === salePreview);
      assertOk(`locker ${index} token balance kept in locker`, await token.balanceOf(await locker.getAddress()) >= salePreview);
      record("action", {
        locker: index,
        action: "settle-to-vault-and-claim",
        wethSentToVault: position.wethSentToVault.toString(),
        saleTokens: salePreview.toString()
      });
    }

    assertOk("launch still holds zero WETH after settlements", await weth.balanceOf(await launch.getAddress()) === 0n);
    assertOk("treasury received per-locker settlement WETH", await weth.balanceOf(await treasury.getAddress()) > treasuryWethBeforeSettlement);
    assertOk(
      "vault holds settled WETH plus refund penalties",
      await weth.balanceOf(await vault.getAddress()) === await launch.settledLiquidityWeth() + await launch.retainedPenaltyWeth()
    );
    assertOk("protocol fee recipient received settlement fees", await weth.balanceOf(protocolFeeRecipientAddress) === await launch.protocolFeeWethPaid());
    assertOk("official pool not live before vault creation", !(await launch.liquidityPoolCreated()));
    assertOk(
      "locker exposes no token burn path",
      !lockers[0].interface.fragments.some((fragment) => fragment.type === "function" && fragment.name === "burn")
    );
    await expectRevert(
      "settled owner cannot burn before trading opens",
      async () => token.connect(owners[0]).burn.staticCall(1n),
      "BURN_BEFORE_OPEN"
    );
    await expectRevert(
      "sale token withdrawal blocked before trading opens",
      async () => lockers[0].withdrawUnlockedTokens.staticCall(await launch.getAddress(), 1n),
      "TOKEN_WITHDRAW_LOCKED"
    );

    const trader = treasury;
    const traderAddress = await trader.getAddress();
    await wait(await weth.connect(trader).deposit({ value: eth("0.2") }), "trader wraps WETH");
    await wait(await weth.connect(trader).approve(await router.getAddress(), eth("0.2")), "trader approves WETH");
    await setTime(provider, Number(await launch.poolCreationOpensAt()) + 1);
    const poolReadyPhase = await launch.launchPhase();
    assertOk("launch reports pool-ready before vault creates pool", Number(poolReadyPhase[0]) === 5);

    const publicPreview = await launch.previewVaultSettlement(await lockers[publicSettlementIndex].getAddress());
    await wait(
      await lockers[publicSettlementIndex].connect(deployer).settleAfterGrace(await launch.getAddress()),
      "public after-grace claim-for cleanup"
    );
    const publicPosition = await lockers[publicSettlementIndex].positions(await launch.getAddress());
    assertOk("public claim-for credited exact sale tokens", publicPosition.claimedSaleTokens === publicPreview[0]);
    assertOk("public claim-for tokens stay locker-owned", publicPosition.withdrawableTokens === publicPreview[0]);

    assertOk("late lockers remain unsettled before pool creation", !(await launch.allFinalCommitmentsSettled()));
    const finalCommitted = await launch.finalCommittedWeth();
    const totalLiquidity = await launch.totalLiquidityWeth();
    const settledLiquidityAtPool = await launch.settledLiquidityWeth();
    const settledCommittedAtPool = await launch.settledCommittedWeth();
    assertOk("settled below final committed before pool creation", settledCommittedAtPool < finalCommitted);
    const lpTokensTotal = effectiveLp;
    const penaltyWeth = await launch.retainedPenaltyWeth();
    const poolWethAtCreation = settledLiquidityAtPool + penaltyWeth;
    const expectedInitialLpTokens = lpTokensTotal * poolWethAtCreation / totalLiquidity;
    const launchTokenBeforePool = await token.balanceOf(await launch.getAddress());

    await wait(await vault.createOfficialPool(1n, Number((await provider.getBlock("latest")).timestamp) + 3600), "vault creates official pool with unsettled lockers");
    pairAddress = await vault.officialPair();
    pair = new ethers.Contract(pairAddress, pairAbi, provider);
    totalLp = await pair.balanceOf(await vault.getAddress());
    assertOk("official pool created despite unsettled lockers", await launch.liquidityPoolCreated());
    assertOk("token trading opens only after vault-created pool", await token.tradingOpen());
    assertOk("trading open while lockers remain unsettled", await launch.tradingOpen() && !(await launch.allFinalCommitmentsSettled()));
    assertOk("vault owns official LP", totalLp > 0n);
    assertOk("vault records WETH dust donation", await vault.preseededWethReserve() >= eth("0.11"));
    const tradingPhase = await launch.launchPhase();
    assertOk("launch phase reports trading open", Number(tradingPhase[0]) === 6);

    assertOk("initial pool uses proportional lp token share", await launch.officialTokenUsedForLp() === expectedInitialLpTokens);
    assertOk("initial pool uses settled WETH plus penalties", await launch.officialWethUsedForLp() === poolWethAtCreation);
    assertOk("pool snapshot liquidity equals settled WETH at creation", await launch.poolSettledLiquidityWeth() === settledLiquidityAtPool);
    assertOk("pool snapshot committed equals settled committed at creation", await launch.poolSettledCommittedWeth() === settledCommittedAtPool);
    assertOk("vault pool WETH matches snapshot", await vault.wethUsedForPool() === poolWethAtCreation);
    const initialRatioError = lpTokensTotal * poolWethAtCreation - expectedInitialLpTokens * totalLiquidity;
    assertOk("initial pool opens at canonical launch ratio", initialRatioError >= 0n && initialRatioError < totalLiquidity);
    assertOk(
      "reserved lp tokens held back in launch",
      await token.balanceOf(await launch.getAddress()) === launchTokenBeforePool - expectedInitialLpTokens
    );
    assertOk("reserve exists for unsettled lockers", lpTokensTotal - expectedInitialLpTokens > 0n);
    assertOk("vault retains no WETH after pool creation", await weth.balanceOf(await vault.getAddress()) === 0n);

    // Late settlements: identical user outcome to on-time settlement, and the LP-share WETH
    // still enters the official pool — paired with the position's reserved LP-token share at
    // the canonical launch ratio, LP minted to the permanently locked vault.
    const officialPairBefore = await launch.officialPair();
    const officialWethBefore = await launch.officialWethUsedForLp();
    const officialTokenBefore = await launch.officialTokenUsedForLp();
    const officialLpBefore = await launch.officialLpMinted();
    const poolCreatedAtBefore = await launch.poolCreatedAt();
    const tokenIsToken0 = (await pair.token0()) === (await token.getAddress());

    async function settleLate(index, viaPublic, label) {
      const locker = lockers[index];
      const lockerAddress = await locker.getAddress();
      const preview = await launch.previewVaultSettlement(lockerAddress);
      const remainingReserve = lpTokensTotal - await launch.vaultLiquidityTokensClaimed() - await launch.lateLpTokensReleased();
      let expectedLateLp = lpTokensTotal * preview[2] / totalLiquidity;
      if (expectedLateLp > remainingReserve) expectedLateLp = remainingReserve;
      const treasuryBefore = await weth.balanceOf(await treasury.getAddress());
      const feeBefore = await weth.balanceOf(protocolFeeRecipientAddress);
      const lockerWethBefore = await weth.balanceOf(lockerAddress);
      const tokenBefore = await token.balanceOf(lockerAddress);
      const launchTokenBefore = await token.balanceOf(await launch.getAddress());
      const vaultLpBefore = await pair.balanceOf(await vault.getAddress());
      const reservesBefore = await pair.getReserves();
      const releasedBefore = await launch.lateLpTokensReleased();
      const tokensBurnedBefore = await vault.lateTokensBurned();
      const wethBurnedBefore = await vault.lateWethBurned();
      const deadWethBefore = await weth.balanceOf(BURN_ADDRESS);
      if (viaPublic) {
        await wait(await locker.connect(deployer).settleAfterGrace(await launch.getAddress()), `public late settlement locker ${index} ${label}`);
      } else {
        await wait(await locker.settleAndClaim(await launch.getAddress(), rulesHash), `owner late settlement locker ${index} ${label}`);
      }
      const position = await locker.positions(await launch.getAddress());
      const reservesAfter = await pair.getReserves();
      const tokenReserveBefore = tokenIsToken0 ? reservesBefore[0] : reservesBefore[1];
      const wethReserveBefore = tokenIsToken0 ? reservesBefore[1] : reservesBefore[0];
      const tokenReserveDelta = (tokenIsToken0 ? reservesAfter[0] : reservesAfter[1]) - tokenReserveBefore;
      const wethReserveDelta = (tokenIsToken0 ? reservesAfter[1] : reservesAfter[0]) - wethReserveBefore;
      const tokensBurned = await vault.lateTokensBurned() - tokensBurnedBefore;
      const wethBurned = await vault.lateWethBurned() - wethBurnedBefore;
      assertOk(`late locker ${index} sale tokens match preview ${label}`, position.claimedSaleTokens === preview[0]);
      assertOk(`late locker ${index} received sale tokens ${label}`, await token.balanceOf(lockerAddress) - tokenBefore === preview[0]);
      assertOk(`late locker ${index} tokens withdrawable ${label}`, position.withdrawableTokens === preview[0]);
      assertOk(`late locker ${index} lp-share WETH fully pooled or burned ${label}`, wethReserveDelta + wethBurned === preview[2]);
      assertOk(`late locker ${index} reserved lp tokens fully pooled or burned ${label}`, tokenReserveDelta + tokensBurned === expectedLateLp);
      assertOk(`late locker ${index} burned WETH reached burn address ${label}`, await weth.balanceOf(BURN_ADDRESS) - deadWethBefore === wethBurned);
      assertOk(`late locker ${index} burns at most one side ${label}`, tokensBurned === 0n || wethBurned === 0n);
      // Balanced at the live reserve ratio: deposit ratio equals reserve ratio within 1 wei rounding.
      const crossDiff = tokenReserveDelta * wethReserveBefore - wethReserveDelta * tokenReserveBefore;
      const crossAbs = crossDiff < 0n ? -crossDiff : crossDiff;
      assertOk(`late locker ${index} deposit matches pair ratio ${label}`, crossAbs <= (tokenReserveBefore > wethReserveBefore ? tokenReserveBefore : wethReserveBefore));
      assertOk(
        `late locker ${index} launch released reserved lp plus sale tokens ${label}`,
        launchTokenBefore - await token.balanceOf(await launch.getAddress()) === expectedLateLp + preview[0]
      );
      assertOk(`late locker ${index} treasury gets only the on-time fee ${label}`, await weth.balanceOf(await treasury.getAddress()) - treasuryBefore === preview[3]);
      assertOk(`late locker ${index} protocol gets only the on-time fee ${label}`, await weth.balanceOf(protocolFeeRecipientAddress) - feeBefore === preview[4]);
      assertOk(`late locker ${index} paid exactly final commitment ${label}`, lockerWethBefore - await weth.balanceOf(lockerAddress) === preview[1]);
      assertOk(`late locker ${index} fees plus pool share equal gross ${label}`, preview[2] + preview[3] + preview[4] === preview[1]);
      assertOk(`late locker ${index} committed WETH emptied ${label}`, await locker.lockedWeth(await launch.getAddress()) === 0n);
      assertOk(`late locker ${index} vault received locked late LP ${label}`, await pair.balanceOf(await vault.getAddress()) - vaultLpBefore > 0n);
      assertOk(`late locker ${index} launch release counter advances ${label}`, await launch.lateLpTokensReleased() - releasedBefore === expectedLateLp);
      assertOk(`late locker ${index} vault holds no loose WETH ${label}`, await weth.balanceOf(await vault.getAddress()) === 0n);
      record("action", {
        locker: index,
        action: viaPublic ? "late-settle-topup-public" : "late-settle-topup-owner",
        wethToPool: wethReserveDelta.toString(),
        lateLpTokens: expectedLateLp.toString(),
        tokensBurned: tokensBurned.toString(),
        wethBurned: wethBurned.toString(),
        saleTokens: preview[0].toString()
      });
    }

    // First late top-up while the pair still sits at the launch ratio.
    await settleLate(lateOwnerSettleIndex, false, "at launch ratio");

    // Move the market price, then prove late top-ups pair at the live ratio: nothing is
    // donated one-sided (sandwich-proof) and the unpairable remainder is burned.
    const reservesBeforePriceMove = await pair.getReserves();
    await wait(await router.connect(trader).swapExactTokensForTokens(
      await weth.getAddress(),
      await token.getAddress(),
      eth("0.01"),
      1n,
      traderAddress
    ), "price-moving buy before remaining late top-ups");
    const reservesAfterPriceMove = await pair.getReserves();
    assertOk(
      "pair price moved before remaining late top-ups",
      reservesBeforePriceMove[0] !== reservesAfterPriceMove[0] && reservesBeforePriceMove[1] !== reservesAfterPriceMove[1]
    );
    for (const index of latePublicSettleIndices) await settleLate(index, true, "after price move");

    await expectRevert(
      "repeated late settlement cannot double-claim",
      async () => lockers[lateOwnerSettleIndex].settleAndClaim.staticCall(await launch.getAddress(), rulesHash),
      "LIQUIDITY_SETTLED"
    );
    await expectRevert(
      "fully refunded locker has no late claim",
      async () => lockers[14].connect(deployer).settleAfterGrace.staticCall(await launch.getAddress()),
      "NO_POSITION"
    );
    await expectRevert(
      "non-locker cannot call late settlement directly",
      async () => launch.claimLateSettlement.staticCall(),
      "NOT_D17_LOCKER"
    );
    await expectRevert(
      "non-locker cannot mint late liquidity directly",
      async () => vault.mintLateLiquidity.staticCall(1n, 1n),
      "NOT_D17_LOCKER"
    );

    assertOk("all final commitments settled after late top-ups", await launch.allFinalCommitmentsSettled());
    assertOk("settled committed WETH reaches final committed", await launch.settledCommittedWeth() === finalCommitted);
    assertOk("late settlement did not change official pair", await launch.officialPair() === officialPairBefore);
    assertOk("initial pool WETH record unchanged", await launch.officialWethUsedForLp() === officialWethBefore);
    assertOk("initial pool token record unchanged", await launch.officialTokenUsedForLp() === officialTokenBefore);
    assertOk("initial pool LP record unchanged", await launch.officialLpMinted() === officialLpBefore && await vault.lpMinted() === officialLpBefore);
    assertOk("pool creation time unchanged", await launch.poolCreatedAt() === poolCreatedAtBefore);
    assertOk(
      "late lp releases never exceed the reserve",
      await launch.vaultLiquidityTokensClaimed() + await launch.lateLpTokensReleased() <= lpTokensTotal
    );
    assertOk(
      "vault late totals plus burns equal per-locker sums",
      await vault.lateWethUsedForLp() + await vault.lateWethBurned() === await launch.lateSettledLiquidityWeth()
        && await vault.lateTokenUsedForLp() + await vault.lateTokensBurned() === await launch.lateLpTokensReleased()
    );
    assertOk("grace boundary unchanged after pool creation and late top-ups", await launch.poolCreationOpensAt() === graceOpensAt);

    const latePosition = await lockers[lateOwnerSettleIndex].positions(await launch.getAddress());
    const lateWithdraw = latePosition.withdrawableTokens;
    await wait(
      await lockers[lateOwnerSettleIndex].withdrawUnlockedTokens(await launch.getAddress(), lateWithdraw),
      "late locker withdraws claimed tokens"
    );
    assertOk(
      "late locker owner received withdrawn tokens",
      await token.balanceOf(await owners[lateOwnerSettleIndex].getAddress()) >= lateWithdraw
    );

    let totalClaimedSaleTokens = 0n;
    for (const index of finalLockers) {
      const position = await lockers[index].positions(await launch.getAddress());
      totalClaimedSaleTokens += position.claimedSaleTokens;
    }
    assertOk(
      "sale claims plus unsold never exceed sale allocation",
      totalClaimedSaleTokens + unsoldSettled <= eth(fixture.saleTokens)
    );
    const reservedLpDust = lpTokensTotal - await launch.vaultLiquidityTokensClaimed() - await launch.lateLpTokensReleased();
    assertOk(
      "launch retains only sale and reserved-lp rounding dust",
      await token.balanceOf(await launch.getAddress())
        === eth(fixture.saleTokens) - unsoldSettled - totalClaimedSaleTokens + reservedLpDust
    );
    assertOk("reserved lp dust is negligible", reservedLpDust < eth("1"));
    const residual = await token.balanceOf(await launch.getAddress());
    const supplyBeforeResidualBurn = await token.totalSupply();
    await wait(await launch.connect(owners[3]).burnResidualTokens(), "anyone burns residual launch dust");
    assertOk("residual launch dust burned", await token.balanceOf(await launch.getAddress()) === 0n);
    assertOk("residual burn reduced supply", supplyBeforeResidualBurn - await token.totalSupply() === residual);

    // Creator allocation vests linearly from pool creation.
    const poolCreatedAtTs = await vault.poolCreatedAt();
    const vestingSeconds = await vault.CREATOR_VESTING_SECONDS();
    await setTime(provider, Number(poolCreatedAtTs + vestingSeconds / 2n));
    await wait(await vault.connect(owners[4]).releaseCreatorTokens(), "release half-vested creator tokens");
    const releasedHalf = await token.balanceOf(deployerAddress);
    const halfNow = BigInt(await now(provider)) - poolCreatedAtTs;
    assertOk("creator receives linear vested share", releasedHalf === manualTokens * halfNow / vestingSeconds);
    assertOk("creator half vested is about half", releasedHalf > manualTokens * 49n / 100n && releasedHalf < manualTokens * 51n / 100n);
    await setTime(provider, Number(poolCreatedAtTs + vestingSeconds) + 1);
    await wait(await vault.releaseCreatorTokens(), "release fully vested creator tokens");
    assertOk("creator receives full allocation after vesting", await token.balanceOf(deployerAddress) === manualTokens);
    assertOk("vault holds no creator tokens after vesting", await vault.lockedCreatorTokens() === 0n);
    await expectRevert("nothing left to vest", async () => vault.releaseCreatorTokens.staticCall(), "NOTHING_VESTED");

    await wait(await token.connect(deployer).transfer(await owners[1].getAddress(), eth("1")), "manual tokens transferable after trading opens");
    assertOk("manual tokens moved after trading opened", await token.balanceOf(await owners[1].getAddress()) >= eth("1"));
    const supplyBeforePostOpenBurn = await token.totalSupply();
    await wait(await token.connect(deployer).burn(eth("1")), "holder burn allowed after trading opens");
    assertOk("post-open holder burn reduces supply", supplyBeforePostOpenBurn - await token.totalSupply() === eth("1"));

    const owner0 = owners[0];
    const owner0Address = await owner0.getAddress();
    const position0 = await lockers[0].positions(await launch.getAddress());
    const withdrawAmount = position0.withdrawableTokens / 10n;
    await wait(await lockers[0].withdrawUnlockedTokens(await launch.getAddress(), withdrawAmount), "withdraw sale tokens after trading opens");
    assertOk("owner received withdrawn sale tokens", await token.balanceOf(owner0Address) >= withdrawAmount);
    await wait(await token.connect(owner0).approve(await router.getAddress(), withdrawAmount), "owner approves sale token");
    await wait(await router.connect(owner0).swapExactTokensForTokens(
      await token.getAddress(),
      await weth.getAddress(),
      withdrawAmount / 10n,
      1n,
      owner0Address
    ), "post-open sell into pool");
    await wait(await router.connect(trader).swapExactTokensForTokens(
      await weth.getAddress(),
      await token.getAddress(),
      eth("0.01"),
      1n,
      traderAddress
    ), "post-open buy from pool");
    assertOk("trader bought sale token after trading opened", await token.balanceOf(traderAddress) > 0n);

    // Launch B: control flow with zero late lockers. Everyone settles before pool
    // creation, so the initial pool takes (nearly) the full LP allocation and no
    // late top-ups occur.
    const configB = launchConfig((await now(provider)) + 60, await treasury.getAddress());
    const createdBReceipt = await wait(await d17Factory.createLaunch(configB, { gasLimit: 15_000_000 }), "create launch B");
    const createdB = parseLaunchCreated(d17Factory, createdBReceipt);
    const launchB = new ethers.Contract(createdB.launch, artifact("D17Launch.sol", "D17Launch").abi, deployer);
    const vaultB = new ethers.Contract(createdB.liquidityVault, artifact("D17LiquidityVault.sol", "D17LiquidityVault").abi, deployer);
    const rulesHashB = await launchB.rulesHash();
    const launchBAddress = await launchB.getAddress();
    const bLockerIndices = [0, 1, 2];

    await setTime(provider, Number(await launchB.roundStart(0)) + 5);
    for (const index of bLockerIndices) {
      await wait(await lockers[index].commitToRound(launchBAddress, 0, rulesHashB, { value: eth("0.5") }), `launch B phase one commit ${index}`);
    }
    await setTime(provider, Number(await launchB.roundStart(4)) + 5);
    await wait(await lockers[0].commitToRound(launchBAddress, 4, rulesHashB, { value: eth("0.3") }), "launch B final round commit");
    await setTime(provider, Number(await launchB.roundEnd(4)) + 5);
    await wait(await launchB.finalizeLaunch(), "finalize launch B");
    for (const index of bLockerIndices) {
      await wait(await lockers[index].settleAndClaim(launchBAddress, rulesHashB), `launch B on-time settlement ${index}`);
    }
    assertOk("launch B fully settled before pool creation", await launchB.allFinalCommitmentsSettled());
    await setTime(provider, Number(await launchB.poolCreationOpensAt()) + 1);
    await wait(
      await vaultB.createOfficialPool(1n, Number((await provider.getBlock("latest")).timestamp) + 3600),
      "launch B pool creation with zero late lockers"
    );
    const settledLwB = await launchB.settledLiquidityWeth();
    const totalLwB = await launchB.totalLiquidityWeth();
    const effectiveLpB = await launchB.effectiveLpTokens();
    const expectedLpB = effectiveLpB * settledLwB / totalLwB;
    assertOk("launch B initial pool takes near-full lp allocation", await launchB.officialTokenUsedForLp() === expectedLpB);
    assertOk("launch B near-full share within rounding dust", effectiveLpB - expectedLpB < eth("1"));
    assertOk("launch B pool WETH equals settled snapshot", await launchB.officialWethUsedForLp() === settledLwB && await launchB.poolSettledLiquidityWeth() === settledLwB);
    assertOk("launch B underfilled final round burned unsold sale and LP tokens", await launchB.unsoldSaleTokensSettled() > 0n && effectiveLpB < eth(fixture.lpTokens));
    assertOk("launch B final round priced at or above anchor", await launchB.roundDiscoveredPriceWad(4) >= await launchB.anchorPriceWad());
    assertOk("launch B trading open", await launchB.tradingOpen());
    assertOk("launch B released no late lp", await launchB.lateLpTokensReleased() === 0n && await launchB.lateSettledCommittedWeth() === 0n);

    await recordWalletPriceReport(finalLockers, lockers, launch);
    const passed = rows.assertion.filter((row) => row.passed).length;
    const failed = rows.assertion.length - passed;
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "results.json"), `${JSON.stringify({ rows, failures, passed, failed }, null, 2)}\n`);
    writeFileSync(path.join(runDir, "REPORT.md"), [
      "# D17 Contract Local E2E Report",
      "",
      `Generated: ${new Date().toISOString()}`,
      "",
      `- Lockers created lazily: ${rows.locker.length}`,
      `- Actions: ${rows.action.length}`,
      `- Assertions: ${rows.assertion.length}`,
      `- Passed: ${passed}`,
      `- Failed: ${failed}`,
      `- Wallet price rows: ${rows.walletPrice.length}`,
      `- Rollover to final phase: ${rolloverBeforeFinalize.toString()}`,
      `- Unsold sale tokens settled: ${unsoldSettled.toString()}`,
      "",
      failures.length ? failures.map((failure) => `- ${failure}`).join("\n") : "- No failures",
      ""
    ].join("\n"));

    if (failures.length) throw new Error(`${failures.length} assertions failed`);
    console.log(`D17 contract local E2E passed. Report: ${path.join(runDir, "REPORT.md")}`);
  } finally {
    if (provider?.destroy) provider.destroy();
    node.kill("SIGTERM");
  }
}

async function recordWalletPriceReport(indices, lockers, launch) {
  for (const index of indices) {
    const locker = lockers[index];
    if (!locker) continue;
    const lockerAddress = await locker.getAddress();
    let totalWeth = 0n;
    let totalTokens = 0n;
    for (let round = 0; round < ROUND_COUNT; round++) {
      const [roundWeth, roundSaleTokens, refunded, tokensClaimed] = await locker.roundPosition(await launch.getAddress(), round);
      const priceWad = roundSaleTokens > 0n ? roundWeth * eth("1") / roundSaleTokens : 0n;
      rows.walletPrice.push({
        locker: index,
        lockerAddress,
        round: round + 1,
        wethPaid: roundWeth.toString(),
        saleTokens: roundSaleTokens.toString(),
        priceWad: priceWad.toString(),
        discoveredRoundPriceWad: (await launch.roundDiscoveredPriceWad(round)).toString(),
        refunded: Boolean(refunded),
        tokensClaimed: Boolean(tokensClaimed)
      });
      totalWeth += roundWeth;
      totalTokens += roundSaleTokens;
    }
    rows.walletPrice.push({
      locker: index,
      lockerAddress,
      round: "total",
      wethPaid: totalWeth.toString(),
      saleTokens: totalTokens.toString(),
      priceWad: totalTokens > 0n ? (totalWeth * eth("1") / totalTokens).toString() : "0"
    });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
