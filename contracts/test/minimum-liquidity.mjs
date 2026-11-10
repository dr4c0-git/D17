import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { compile, eth, now, setTime, startNode, waitForRpc, wait } from './helpers.mjs';
import { suite } from './release-fixture.mjs';
const report = { status: 'running', checks: [], note: 'Earlier zero-LP hypothesis was rejected by existing MIN_LP_TOKENS=1e18; no production fix or economic rule change is needed.' };
const check = (label, value) => { assert.ok(value, label); report.checks.push(label); };
compile(); const child = startNode(9922); let p;
try {
 p = await waitForRpc(9922, child); const s = await suite(p);
 const extra = { tokenSupply: eth('100000000'), saleTokens: eth('99999999'), lpTokens: eth('1'),
   manualDistributionTokens: 0n, deadTokens: 0n, roundSharesBps: [1, 2499, 2500, 2500, 2500] };
 await assert.rejects(s.launch({ ...extra, lpTokens: eth('1') - 1n, deadTokens: 1n }), /LP_TOO_LOW/);
 check('one wei below actual minimum LP rejected', true);
 const l = await s.launch(extra), k = await s.locker(0);
 await setTime(p, l.cfg.startTime + 1);
 await wait(await k.commitToRound(l.address, 0, l.rules, { value: eth('0.001') }));
 await setTime(p, Number(await l.launch.roundEnd(4)) + 1); await wait(await l.launch.finalizeLaunch());
 check('minimum LP and minimum R1 share preserve positive allocation', await l.launch.effectiveLpTokens() === 100000000000000n);
 await wait(await k.settleAndClaim(l.address, l.rules));
 await setTime(p, Number(await l.launch.poolCreationOpensAt()) + 1);
 await wait(await l.vault.createOfficialPool(0, (await now(p)) + 600));
 check('smallest tested funding and allocation open real V2 pool', await l.launch.tradingOpen());
 check('LP minted exceeds V2 minimum liquidity', await l.vault.lpMinted() > 0n);
 report.status = 'passed';
} catch (e) { report.status = 'failed'; report.error = String(e.stack); throw e; }
finally { mkdirSync('runs/security', { recursive: true }); writeFileSync('runs/security/minimum-liquidity.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2)); p?.destroy(); await child.kill('SIGTERM'); }
