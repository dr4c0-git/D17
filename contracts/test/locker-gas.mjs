// Gas report for the Locker: what a wallet pays to create one and to use it.
// Run: npm run gas:locker            (prints a table)
//      npm run gas:locker -- out.json (also writes the numbers to a file)
import { writeFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { artifact, compile, eth, now, setTime, startNode, waitForRpc, wait } from './helpers.mjs';
import { suite } from './release-fixture.mjs';

const out = process.argv[2];
const gas = {};
const use = async (label, tx) => { gas[label] = Number((await wait(await tx, label)).gasUsed); };

compile(); const child = startNode(9941); let p;
try {
  p = await waitForRpc(9941, child); const s = await suite(p);
  const outsider = await p.getSigner(15);
  const users = await Promise.all([2, 3, 4, 5].map(i => p.getSigner(i)));
  const abi = artifact('D17Locker.sol', 'D17Locker').abi;
  const lockers = [];
  for (const [i, user] of users.entries()) {
    const owner = await user.getAddress();
    const address = await s.lockerFactory.connect(user).createLockerFor.staticCall(owner);
    const tx = s.lockerFactory.connect(user).createLockerFor(owner);
    if (i === 0) await use('createLockerFor', tx); else await wait(await tx);
    lockers.push(new ethers.Contract(address, abi, user));
  }
  await use('createLockerFor (same wallet again)', s.lockerFactory.connect(users[0]).createLockerFor(await users[0].getAddress()));
  gas['deploy D17LockerFactory (once)'] = Number((await s.lockerFactory.deploymentTransaction().wait()).gasUsed);
  const [a, b, c, d] = lockers;

  const l = await s.launch(); await setTime(p, l.cfg.startTime + 1);
  await use('commitToRound (first)', a.commitToRound(l.address, 0, l.rules, { value: eth('1') }));
  await use('commitToRound (again)', a.commitToRound(l.address, 0, l.rules, { value: eth('1') }));
  await wait(await b.commitToRound(l.address, 0, l.rules, { value: eth('3') }));
  await wait(await c.commitToRound(l.address, 0, l.rules, { value: eth('2') }));
  await setTime(p, Number(await l.launch.roundEnd(0)) + 1);
  await use('refundCurrentRound', a.refundCurrentRound(l.address));
  await use('withdrawUnlockedWeth', a.withdrawUnlockedWeth(l.address, (await a.positions(l.address)).residualWeth));
  await setTime(p, Number(await l.launch.roundEnd(4)) + 1);
  await wait(await l.launch.finalizeLaunch());
  await use('settleAndClaim', b.settleAndClaim(l.address, l.rules));
  await setTime(p, Number(await l.launch.poolCreationOpensAt()) + 1);
  await use('settleAfterGrace', c.connect(outsider).settleAfterGrace(l.address));
  await wait(await l.vault.createOfficialPool(0, (await now(p)) + 600));
  await use('withdrawUnlockedTokens', b.withdrawUnlockedTokens(l.address, (await b.positions(l.address)).withdrawableTokens));

  const failed = await s.launch({ minPhase1Weth: eth('20') }); await setTime(p, failed.cfg.startTime + 1);
  await wait(await d.commitToRound(failed.address, 0, failed.rules, { value: eth('1') }));
  await setTime(p, Number(await failed.launch.roundEnd(0)) + Number(await failed.launch.refundSeconds()) + 1);
  await use('refundFailedLaunch', d.refundFailedLaunch(failed.address, failed.rules));

  const size = hex => (hex.length - 2) / 2;
  const bytes = {
    'code at each locker address': size(await p.getCode(await a.getAddress())),
    'D17Locker runtime': size(artifact('D17Locker.sol', 'D17Locker').deployedBytecode),
    'D17LockerFactory runtime': size(await p.getCode(await s.lockerFactory.getAddress())),
  };
  console.table(gas); console.table(bytes);
  if (out) writeFileSync(out, JSON.stringify({ gas, bytes }, null, 2));
} finally {
  child.kill();
}
