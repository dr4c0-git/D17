// ND-003 approved by the user, 2026-10-31; no live chain or funded wallet.
// Historical mismatch witness remains in failed-refund-spec.mjs at 8eb7fd7.
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {ethers} from 'ethers';
import {artifact, compile, deploy, eth, now, setTime, startNode, wait, waitForRpc} from './helpers.mjs';
import {suite, BURN, net} from './release-fixture.mjs';

const report = {scope:'ND-003 failed R1 full principal refund; caller-funded gas', checks:[], gas:[]};
const eq = (actual, expected, label) => {assert.equal(actual,expected,label);report.checks.push(label);};
const rejects = async (action, reason) => {await assert.rejects(action,new RegExp(reason));report.checks.push(`reject ${reason}`);};
const gas = (label,receipt) => report.gas.push({label,gasUsed:receipt.gasUsed.toString(),gasPrice:receipt.gasPrice.toString(),payer:receipt.from});
compile(); const child=startNode(9932); let p;
try {
  p=await waitForRpc(9932,child); const s=await suite(p);
  const a=await s.locker(0), b=await s.locker(1), c=await s.locker(2), outsider=await p.getSigner(10);
  const aa=await a.getAddress(), ba=await b.getAddress(), ca=await c.getAddress();
  const ao=await a.owner(), bo=await b.owner(), co=await c.owner();
  const starts=await Promise.all([ao,bo,co].map(x=>s.weth.balanceOf(x)));
  const deadBefore=await s.weth.balanceOf(BURN);
  const l=await s.launch({minPhase1Weth:eth('20')}); const va=await l.vault.getAddress();
  await setTime(p,l.cfg.startTime+1);
  const amounts=[eth('1'),eth('2.000000000000000199'),eth('9')];
  for(const [i,locker] of [a,b,c].entries()) await wait(await locker.commitToRound(l.address,0,l.rules,{value:amounts[i]}));
  await rejects(()=>a.refundFailedLaunch.staticCall(l.address,l.rules),'LAUNCH_NOT_FAILED');
  await setTime(p,Number(await l.launch.roundEnd(0))+1);
  await wait(await a.refundCurrentRound(l.address)); await wait(await b.refundCurrentRound(l.address));
  const pa=amounts[0]/100n,pb=amounts[1]/100n;
  await wait(await a.withdrawUnlockedWeth(l.address,amounts[0]-pa));
  eq(await a.accountedWeth(),0n,'early net withdrawal is valid before failure');
  // A donation must not become a participant's entitlement or go to dead.
  await wait(await s.weth.deposit({value:eth('0.25')})); await wait(await s.weth.transfer(va,eth('0.25')));
  await setTime(p,Number(await l.launch.roundEnd(0))+Number(await l.launch.refundSeconds())+1);
  eq(await l.launch.launchFailed(),true,'R1 failed');
  eq(await a.failedRefundDue(l.address),pa,'penalty-only owner has a visible claim');
  eq(await b.failedRefundDue(l.address),pb,'unwithdrawn net refund is not claimed twice');
  eq(await c.failedRefundDue(l.address),amounts[2],'retained principal visible');
  await rejects(()=>a.connect(outsider).refundFailedLaunch.staticCall(l.address,l.rules),'NOT_OWNER');
  await rejects(()=>a.refundFailedLaunch.staticCall(l.address,ethers.ZeroHash),'BAD_RULES');
  await rejects(()=>l.launch.connect(outsider).releaseFailedRefund.staticCall(),'NOT_D17_LOCKER');
  await rejects(()=>l.vault.connect(outsider).returnFailedPenalty.staticCall(ao,pa),'NOT_LAUNCH');
  await rejects(()=>l.vault.burnFailedLaunchPenalties.staticCall(),'FAILED_PENALTIES_REFUND_ONLY');
  await rejects(()=>l.vault.sweepExcessWethToTreasury.staticCall(),'POOL_NOT_CREATED');
  for(const [i,locker] of [a,b,c].entries()) {
    const owner=await locker.owner();
    const beforeEth=await p.send('eth_getBalance',[owner,'latest']);
    const receipt=await wait(await locker.refundFailedLaunch(l.address,l.rules));gas(`refund-${i}`,receipt);
    eq(BigInt(beforeEth)-BigInt(await p.send('eth_getBalance',[owner,'latest'])),receipt.gasUsed*receipt.gasPrice,'claim caller pays its own gas, separately');
    const pos=await locker.positions(l.address), returned=i===0?pa:i===1?pb:0n;
    eq(pos.wethCommitted,0n,'all active commitments released');
    eq(pos.wethRefunded,amounts[i],'cumulative principal refund is exact');
    eq(pos.penaltyPaid,returned,'historical paid penalty preserved');
    eq(await locker.failedPenaltyWethRefunded(l.address),returned,'Locker records returned penalty');
    eq(await l.launch.failedPenaltyWethRefunded(await locker.getAddress()),returned,'Launch records same returned penalty');
    eq(await locker.accountedWeth(),pos.residualWeth,'returned WETH accounted');
    eq(await s.weth.balanceOf(await locker.getAddress()),pos.residualWeth,'physical escrow equals liability');
    await rejects(()=>locker.refundFailedLaunch.staticCall(l.address,l.rules),'NO_POSITION');
    eq(await locker.failedRefundDue(l.address),0n,'claim preview is consumed');
    gas(`withdraw-${i}`,await wait(await locker.withdrawUnlockedWeth(l.address,pos.residualWeth)));
    eq(await s.weth.balanceOf(owner)-starts[i],amounts[i],'owner receives every contributed wei exactly once');
    eq(await locker.accountedWeth(),0n,'escrow liability cleared');
    await rejects(()=>locker.withdrawUnlockedWeth.staticCall(l.address,1n),'POSITION_WETH_BALANCE');
  }
  eq(await l.launch.penaltyWethPaid(),pa+pb,'historical aggregate paid');
  eq(await l.launch.penaltyWethRefunded(),pa+pb,'aggregate returned');
  eq(await l.vault.failedLaunchPenaltyWethRefunded(),pa+pb,'vault returned exact rights');
  eq(await l.launch.retainedPenaltyWeth(),0n,'no claimant penalty stranded');
  eq(await s.weth.balanceOf(va),eth('0.25'),'unsolicited donation separate from refund claims');
  eq(await s.weth.balanceOf(BURN),deadBefore,'no failed-launch WETH sent to dead');
  eq(await l.vault.failedLaunchPenaltyWethBurned(),0n,'legacy burn counter stays zero');
  eq(await s.weth.balanceOf(await s.splitter.getAddress()),0n,'D17 receives no success fee');
  eq(await s.weth.balanceOf(s.treasury),0n,'treasury receives no failed-launch funds');
  eq(await l.launch.totalCommittedWeth(),0n,'all live commitments reconciled');

  // Zero-penalty principal, unknown position, and multiple launches sharing a Locker.
  const control=await s.launch({minPhase1Weth:eth('10')});
  await setTime(p,control.cfg.startTime+1); await wait(await c.commitToRound(control.address,0,control.rules,{value:eth('9')}));
  await setTime(p,Number(await control.launch.roundEnd(0))+Number(await control.launch.refundSeconds())+1);
  await rejects(()=>a.refundFailedLaunch.staticCall(control.address,control.rules),'UNKNOWN_LAUNCH');
  await wait(await c.refundFailedLaunch(control.address,control.rules));
  eq((await c.positions(control.address)).residualWeth,eth('9'),'ordinary failed principal unchanged');
  eq(await c.failedPenaltyWethRefunded(control.address),0n,'other launch cannot reuse paid penalties');
  await wait(await c.withdrawUnlockedWeth(control.address,eth('9')));

  // Successful launch still contributes every penalty to the real V2 pool.
  const ok=await s.launch(); await setTime(p,ok.cfg.startTime+1);
  await wait(await a.commitToRound(ok.address,0,ok.rules,{value:eth('1')}));
  await wait(await b.commitToRound(ok.address,0,ok.rules,{value:eth('9')}));
  await setTime(p,Number(await ok.launch.roundEnd(0))+1); await wait(await a.refundCurrentRound(ok.address));
  await setTime(p,Number(await ok.launch.roundEnd(4))+1);
  await rejects(()=>a.refundFailedLaunch.staticCall(ok.address,ok.rules),'LAUNCH_NOT_FAILED');
  await wait(await ok.launch.finalizeLaunch()); await wait(await b.settleAndClaim(ok.address,ok.rules));
  await setTime(p,Number(await ok.launch.poolCreationOpensAt())+1); await wait(await ok.vault.createOfficialPool(0,(await now(p))+600));
  eq(await ok.vault.wethUsedForPool(),net(eth('9'))+eth('0.01'),'successful pool gets unchanged penalty');
  eq(await ok.launch.penaltyWethRefunded(),0n,'successful launch returns no penalty');
  eq(await s.weth.balanceOf(await s.splitter.getAddress()),eth('0.18'),'success fee remains 2 percent');
  await rejects(()=>ok.vault.burnFailedLaunchPenalties.staticCall(),'FAILED_PENALTIES_REFUND_ONLY');

  // Hostile WETH owns the Locker: NOT_OWNER cannot hide a callback vulnerability.
  const h=await deploy('test/CallbackWETH.sol','CallbackWETH',s.signer); const hs=await suite(p,{weth:h});
  const create=hs.lockerFactory.interface.encodeFunctionData('createLockerFor',[await h.getAddress()]);
  const [ha]=ethers.AbiCoder.defaultAbiCoder().decode(['address'],await h.execute.staticCall(await hs.lockerFactory.getAddress(),create,0));
  await wait(await h.execute(await hs.lockerFactory.getAddress(),create,0));
  const hl=new ethers.Contract(ha,artifact('D17Locker.sol','D17Locker').abi,s.signer);
  const fail=await hs.launch({minPhase1Weth:eth('10')});await setTime(p,fail.cfg.startTime+1);
  await wait(await h.execute(ha,hl.interface.encodeFunctionData('commitToRound',[fail.address,0,fail.rules]),eth('1'),{value:eth('1')}));
  await setTime(p,Number(await fail.launch.roundEnd(0))+1);
  await wait(await h.execute(ha,hl.interface.encodeFunctionData('refundCurrentRound',[fail.address]),0));
  await setTime(p,Number(await fail.launch.roundEnd(0))+Number(await fail.launch.refundSeconds())+1);
  const claim=hl.interface.encodeFunctionData('refundFailedLaunch',[fail.address,fail.rules]);
  // Temporarily corrupt ONLY this hostile fixture's vault balance to test atomic rollback.
  const slot=ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address','uint256'],[await fail.vault.getAddress(),0]));
  await p.send('hardhat_setStorageAt',[await h.getAddress(),slot,ethers.ZeroHash]);
  await assert.rejects(()=>h.execute.staticCall(ha,claim,0),e=>e.data===ethers.id('TransferFailed()').slice(0,10));
  report.checks.push('exact TransferFailed selector on insufficient vault balance');
  await assert.rejects(async()=>wait(await h.execute(ha,claim,0,{gasLimit:1_000_000})));
  report.checks.push('state-changing claim transaction also rejects insufficient balance');
  eq(await hl.failedPenaltyWethRefunded(fail.address),0n,'failed transfer does not consume Locker right');
  eq(await fail.launch.penaltyWethRefunded(),0n,'failed transfer does not consume Launch right');
  eq((await hl.positions(fail.address)).residualWeth,eth('0.99'),'failed transfer leaves previous net refund intact');
  await p.send('hardhat_setStorageAt',[await h.getAddress(),slot,ethers.toBeHex(eth('0.01'),32)]);
  const snapshot=await p.send('evm_snapshot',[]);
  await wait(await h.arm(ha,claim,0,false,true));await wait(await h.execute(ha,claim,0));
  eq(await h.lastSuccess(),false,'same claim callback denied');
  eq(ethers.AbiCoder.defaultAbiCoder().decode(['string'],'0x'+(await h.lastResult()).slice(10))[0],'REENTRANT','same claim guard');
  eq(await hl.accountedWeth(),eth('1'),'callback cannot duplicate funds');
  await p.send('evm_revert',[snapshot]);
  await wait(await h.arm(ha,hl.interface.encodeFunctionData('withdrawUnlockedWeth',[fail.address,eth('1')]),0,false,true));
  await wait(await h.execute(ha,claim,0));
  eq(await h.lastSuccess(),false,'withdraw during returned-penalty transfer denied');
  eq(await h.balanceOf(ha),eth('1'),'retry after failed transfer pays exact principal');
  eq(await fail.launch.retainedPenaltyWeth(),0n,'callback-safe aggregate reconciles');
  report.status='PASS';
} catch(e) {report.status='FAIL';report.error=String(e.stack);throw e;}
finally {await p?.destroy();await child.kill();mkdirSync('runs/security',{recursive:true});writeFileSync('runs/security/failed-refund-remediation.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
