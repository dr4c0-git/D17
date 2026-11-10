import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { artifact, deploy, eth, now, parseLaunchCreated, wait } from './helpers.mjs';
const require = createRequire(import.meta.url);
export const BURN = '0x000000000000000000000000000000000000dEaD';
export const v2Artifact = name => require(`@uniswap/v2-core/build/${name}.json`);
export function config(startTime, treasury, extra = {}) {
  return {
    tokenName: 'D17 Release Test', tokenSymbol: 'D17R', description: 'Local EVM release regression', logoSvgUri: '', links: [],
    tokenSupply: eth('100000000'), saleTokens: eth('50000000'), lpTokens: eth('40000000'),
    manualDistributionTokens: eth('5000000'), deadTokens: eth('5000000'), deadRecipient: BURN, treasury, startTime,
    roundSeconds: [600,600,600,600,600], refundSeconds: 600, settlementSeconds: 600,
    minCommitWeth: eth('0.001'), minPhase1Weth: eth('0.001'), minAnchorPriceWad: 1000000n,
    roundSharesBps: [4000,1500,1500,1500,1500], treasuryBps: 733, refundPenaltyBps: 1703, maxProtocolFeeBps: 200,
    ...extra
  };
}
export async function suite(provider, options = {}) {
  provider.pollingInterval = 10;
  const signer = await provider.getSigner(0), treasury = await (await provider.getSigner(1)).getAddress();
  const owner = await signer.getAddress();
  const weth = options.weth || await deploy('test/TestWETH.sol', 'TestWETH', signer);
  const v2a = v2Artifact('UniswapV2Factory');
  const v2 = await new ethers.ContractFactory(v2a.abi, v2a.bytecode, signer).deploy(owner);
  await v2.waitForDeployment();
  // D17 only reads router.factory(); liquidity is minted directly through the REAL V2 pair.
  const router = await deploy('test/TestV2Router.sol', 'TestV2Router', signer, [await v2.getAddress()]);
  const recipients = await Promise.all([16,17,18,19].map(async i => (await provider.getSigner(i)).getAddress()));
  const splitter = await deploy('D17FeeSplitter.sol','D17FeeSplitter',signer,[await weth.getAddress(),recipients,[5000,1250,1250,2500]]);
  const feeConfig = await deploy('D17FeeConfig.sol','D17FeeConfig',signer,[owner,await splitter.getAddress(),200]);
  const factory = await deploy('D17Factory.sol','D17Factory',signer,[owner,await weth.getAddress(),await router.getAddress(),await feeConfig.getAddress()]);
  const tf = await deploy('D17TokenFactory.sol','D17TokenFactory',signer,[owner]);
  const vf = await deploy('D17LiquidityVaultFactory.sol','D17LiquidityVaultFactory',signer,[owner]);
  const ld = await deploy('D17LaunchDeployer.sol','D17LaunchDeployer',signer,[owner]);
  const lf = await deploy('D17LaunchFactory.sol','D17LaunchFactory',signer,[await factory.getAddress(),await tf.getAddress(),await vf.getAddress(),await ld.getAddress()]);
  const lockers = await deploy('D17LockerFactory.sol','D17LockerFactory',signer,[await factory.getAddress()]);
  for (const c of [tf,vf,ld,factory]) await wait(await c.pinLaunchFactory(await lf.getAddress()));
  await wait(await factory.pinLockerFactory(await lockers.getAddress()));
  for (const c of [tf,vf,ld,factory,feeConfig]) await wait(await c.renounceOwnership());
  async function launch(extra={}) {
    const cfg = config((await now(provider))+120,treasury,extra);
    const ev = parseLaunchCreated(factory,await wait(await factory.createLaunch(cfg,{gasLimit:15_000_000})));
    return { cfg, address: ev.launch, rules: ev.rulesHash,
      launch: new ethers.Contract(ev.launch,artifact('D17Launch.sol','D17Launch').abi,signer),
      token: new ethers.Contract(ev.token,artifact('D17Token.sol','D17Token').abi,signer),
      vault: new ethers.Contract(ev.liquidityVault,artifact('D17LiquidityVault.sol','D17LiquidityVault').abi,signer) };
  }
  async function locker(i) {
    let user;
    if (i<14) user=await provider.getSigner(i+2);
    else {
      const address=ethers.getAddress(ethers.toBeHex(0xD17000+i,20));
      await provider.send('hardhat_setBalance',[address,ethers.toBeHex(eth('1000'))]);
      await provider.send('hardhat_impersonateAccount',[address]);
      user=new ethers.JsonRpcSigner(provider,address);
    }
    const address=await lockers.connect(user).createLockerFor.staticCall(await user.getAddress());
    await wait(await lockers.connect(user).createLockerFor(await user.getAddress()));
    return new ethers.Contract(address,artifact('D17Locker.sol','D17Locker').abi,user);
  }
  return {provider,signer,treasury,weth,v2,router,factory,feeConfig,splitter,recipients,lockerFactory:lockers,launch,locker};
}
export const net = (gross,t=733n,f=200n) => gross-gross*t/10000n-gross*f/10000n;
export async function swap(s,l,inputToken,amount,trader) {
  const pairAddress=await s.v2.getPair(await l.token.getAddress(),await s.weth.getAddress());
  const pair=new ethers.Contract(pairAddress,v2Artifact('UniswapV2Pair').abi,trader);
  const [r0,r1]=await pair.getReserves(); const zero=(await inputToken.getAddress()).toLowerCase()===(await pair.token0()).toLowerCase();
  const rin=zero?r0:r1, rout=zero?r1:r0;
  const out=amount*997n*rout/(rin*1000n+amount*997n);
  await wait(await inputToken.connect(trader).transfer(pairAddress,amount));
  await wait(await pair.swap(zero?0:out,zero?out:0,await trader.getAddress(),'0x'));
  return out;
}
