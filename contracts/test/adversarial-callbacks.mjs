import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { artifact, compile, deploy, eth, now, setTime, startNode, waitForRpc, wait } from './helpers.mjs';
import { suite, net, v2Artifact } from './release-fixture.mjs';

const report = { status: 'running', checks: [], limitations: 'Hostile WETH fixture is outside mainnet trust assumptions; donation tests use real V2 pair bytecode.' };
const check = (label, condition) => { report.checks.push({ label, ok: Boolean(condition) }); assert.ok(condition, label); };
const reason = bytes => ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + bytes.slice(10))[0];
compile(); const child = startNode(9921); let p;
try {
  p = await waitForRpc(9921, child); const signer = await p.getSigner(0);
  const hostile = await deploy('test/CallbackWETH.sol', 'CallbackWETH', signer);
  const s = await suite(p, { weth: hostile });
  const owner = await hostile.getAddress();
  const create = s.lockerFactory.interface.encodeFunctionData('createLockerFor', [owner]);
  const raw = await hostile.execute.staticCall(await s.lockerFactory.getAddress(), create, 0);
  const [lockerAddress] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], raw);
  await wait(await hostile.execute(await s.lockerFactory.getAddress(), create, 0));
  const locker = new ethers.Contract(lockerAddress, artifact('D17Locker.sol', 'D17Locker').abi, signer);
  const l = await s.launch(); await setTime(p, l.cfg.startTime + 1);
  const commit = locker.interface.encodeFunctionData('commitToRound', [l.address, 0, l.rules]);
  await wait(await hostile.arm(lockerAddress, commit, 1, true, false));
  await wait(await hostile.execute(lockerAddress, commit, eth('1'), { value: eth('1') }));
  check('owner-authorized deposit callback attempted', await hostile.attempts() === 1n);
  check('same-function commit reentry denied by guard', !(await hostile.lastSuccess()) && reason(await hostile.lastResult()) === 'REENTRANT');
  check('commit WETH accounting exact', await locker.accountedWeth() === eth('1') && await hostile.balanceOf(lockerAddress) === eth('1'));
  check('launch exact liquidity unchanged by callback', await l.launch.totalLiquidityWeth() === net(eth('1')));
  await setTime(p, Number(await l.launch.roundEnd(4)) + 1); await wait(await l.launch.finalizeLaunch());
  await setTime(p, Number(await l.launch.poolCreationOpensAt()) + 1);
  await wait(await hostile.arm(lockerAddress, locker.interface.encodeFunctionData('settleAfterGrace', [l.address]), 0, false, true));
  await wait(await locker.settleAfterGrace(l.address));
  check('settlement transfer callbacks denied by guard', !(await hostile.lastSuccess()) && reason(await hostile.lastResult()) === 'REENTRANT');
  check('settlement commits once', await l.launch.allFinalCommitmentsSettled() && await locker.accountedWeth() === 0n);
  check('vault receives exact net; fee and treasury preserved', await hostile.balanceOf(await l.vault.getAddress()) === net(eth('1')) && await hostile.balanceOf(await s.splitter.getAddress()) === eth('0.02'));
  await wait(await hostile.arm(await s.splitter.getAddress(), s.splitter.interface.encodeFunctionData('distribute', [owner]), 0, false, true));
  await wait(await s.splitter.distribute(owner));
  check('splitter token-transfer reentry denied', !(await hostile.lastSuccess()) && reason(await hostile.lastResult()) === 'REENTRANT');
  check('splitter fee balance drained exactly once', await hostile.balanceOf(await s.splitter.getAddress()) === 0n);
  await wait(await hostile.arm(await s.splitter.getAddress(), s.splitter.interface.encodeFunctionData('distributeEth'), 0, true, false));
  await wait(await signer.sendTransaction({ to: await s.splitter.getAddress(), value: eth('1') }));
  const before = await Promise.all(s.recipients.map(a => hostile.balanceOf(a)));
  await wait(await s.splitter.distributeEth());
  const after = await Promise.all(s.recipients.map(a => hostile.balanceOf(a)));
  check('ETH wrapper deposit callback denied by the shared guard', !(await hostile.lastSuccess()) && reason(await hostile.lastResult()) === 'REENTRANT');
  check('guarded ETH wrapper distributes available WETH exactly once', after.reduce((sum, n, i) => sum + n - before[i], 0n) === eth('1') && await hostile.balanceOf(await s.splitter.getAddress()) === 0n);

  // Explicit cross-function and read-only witnesses for the Slither high.
  // Hostile WETH is also owner, so NOT_OWNER cannot mask the reentrancy guard.
  const probeRaw = await hostile.execute.staticCall(await s.lockerFactory.getAddress(), create, 0);
  const [probeAddress] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], probeRaw);
  await wait(await hostile.execute(await s.lockerFactory.getAddress(), create, 0));
  const probe = new ethers.Contract(probeAddress, artifact('D17Locker.sol', 'D17Locker').abi, signer);
  const probeLaunch = await s.launch(); await setTime(p, probeLaunch.cfg.startTime + 1);
  const probeCommit = probe.interface.encodeFunctionData('commitToRound', [probeLaunch.address, 0, probeLaunch.rules]);
  for (const [method, args] of [
    ['refundCurrentRound', [probeLaunch.address]],
    ['withdrawUnlockedWeth', [probeLaunch.address, 1n]],
    ['settleAfterGrace', [probeLaunch.address]],
  ]) {
    await wait(await hostile.arm(probeAddress, probe.interface.encodeFunctionData(method, args), 0, true, false));
    await wait(await hostile.execute(probeAddress, probeCommit, eth('0.1'), {value: eth('0.1')}));
    check(`deposit callback cross-function ${method} rejected by guard`, !(await hostile.lastSuccess()) && reason(await hostile.lastResult()) === 'REENTRANT');
  }
  await wait(await hostile.arm(probeAddress, probe.interface.encodeFunctionData('accountedWeth'), 0, true, false));
  await wait(await hostile.execute(probeAddress, probeCommit, eth('0.1'), {value: eth('0.1')}));
  check('read-only callback sees updated commitment accounting', await hostile.lastSuccess() && ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], await hostile.lastResult())[0] === eth('0.4'));
  check('after callback accounted WETH equals actual escrow', await probe.accountedWeth() === eth('0.4') && await hostile.balanceOf(probeAddress) === eth('0.4'));
  check('after callback launch liquidity matches exact net funding', await probeLaunch.launch.totalLiquidityWeth() === net(eth('0.4')));

  await wait(await hostile.arm(probeLaunch.address, probeLaunch.launch.interface.encodeFunctionData('contributedBy', [probeAddress, 0]), 0, true, false));
  await wait(await hostile.execute(probeAddress, probeCommit, eth('0.1'), {value: eth('0.1')}));
  check('deposit callback sees updated launch ledger too', await hostile.lastSuccess() && ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], await hostile.lastResult())[0] === eth('0.5'));
  const beforeFailure = await probe.positions(probeLaunch.address);
  const beforeLiquidity = await probeLaunch.launch.totalLiquidityWeth();
  const beforeAttempts = await hostile.attempts();
  await wait(await hostile.setRejectDeposit(true));
  await assert.rejects(async () => wait(await hostile.execute(probeAddress, probeCommit, eth('0.1'), {value: eth('0.1'), gasLimit: 1500000})));
  check('failed WETH deposit rolls back the complete Locker position', JSON.stringify(await probe.positions(probeLaunch.address), (_, v) => typeof v === 'bigint' ? String(v) : v) === JSON.stringify(beforeFailure, (_, v) => typeof v === 'bigint' ? String(v) : v));
  check('failed deposit rolls back both accounting ledgers', await probe.accountedWeth() === eth('0.5') && await probeLaunch.launch.totalLiquidityWeth() === beforeLiquidity && await probeLaunch.launch.contributedBy(probeAddress, 0) === eth('0.5'));
  check('failed deposit changes no escrow balance or callback count', await hostile.balanceOf(probeAddress) === eth('0.5') && await hostile.attempts() === beforeAttempts);
  await wait(await hostile.setRejectDeposit(false));
  await wait(await hostile.execute(probeAddress, probeCommit, eth('0.1'), {value: eth('0.1')}));
  check('commit retries once after deposit failure', await probe.accountedWeth() === eth('0.6') && await probeLaunch.launch.contributedBy(probeAddress, 0) === eth('0.6'));

  // Synced vs unsynced unsolicited WETH must not divert any accounted contribution.
  const normal = await suite(p); const user = await normal.locker(0);
  for (const synced of [false, true]) {
    const launch = await normal.launch(); await setTime(p, launch.cfg.startTime + 1);
    await wait(await user.commitToRound(launch.address, 0, launch.rules, { value: eth('1') }));
    await setTime(p, Number(await launch.launch.roundEnd(4)) + 1); await wait(await launch.launch.finalizeLaunch());
    await wait(await user.settleAndClaim(launch.address, launch.rules));
    await setTime(p, Number(await launch.launch.poolCreationOpensAt()) + 1);
    await wait(await normal.v2.createPair(await launch.token.getAddress(), await normal.weth.getAddress()));
    const pairAddress = await normal.v2.getPair(await launch.token.getAddress(), await normal.weth.getAddress());
    const pair = new ethers.Contract(pairAddress, v2Artifact('UniswapV2Pair').abi, signer);
    await wait(await normal.weth.deposit({ value: eth('0.5') }));
    await wait(await normal.weth.transfer(pairAddress, eth('0.5')));
    if (synced) await wait(await pair.sync());
    await wait(await launch.vault.createOfficialPool(0, (await now(p)) + 600));
    check(`real V2 pool opens with ${synced ? 'synced' : 'unsynced'} donation`, await launch.vault.poolCreated());
    check('donation is additional to exact net funding', await normal.weth.balanceOf(pairAddress) === net(eth('1')) + eth('0.5'));
    check('donor cannot claim any LP', await pair.balanceOf(await signer.getAddress()) === 0n);
    check('all non-minimum LP permanently in vault', await pair.balanceOf(await launch.vault.getAddress()) === await pair.totalSupply() - 1000n);
    const reserves = await pair.getReserves();
    check('pool reserves cover exact token and WETH balances', reserves[0] > 0n && reserves[1] > 0n);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack); throw error; }
finally { mkdirSync('runs/security', { recursive: true }); writeFileSync('runs/security/adversarial-callbacks.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); p?.destroy(); await child.kill('SIGTERM'); }
