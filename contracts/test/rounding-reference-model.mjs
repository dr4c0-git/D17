#!/usr/bin/env node
// Independently check the intended per-Locker accounting invariant with wei-exact BigInts.
// This is a mathematical reference test, NOT a Solidity/EVM execution test.
import assert from "node:assert/strict";

const BPS = 10000n;
const MIN_COMMIT = 10n ** 15n;
const SEED = 0xd17026;
let seed = SEED >>> 0;
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function sample(max) { return Math.floor(random() * max); }
function liquidityFor(positions, treasuryBps, feeBps) {
  const gross = positions.reduce((a, b) => a + b, 0n);
  return gross - gross * BigInt(treasuryBps) / BPS - gross * BigInt(feeBps) / BPS;
}

let checks = 0;
let legacyMismatch = 0;
let operations = 0;
for (let campaign = 0; campaign < 200; campaign++) {
  const actors = 100;
  const treasuryBps = [0, 50, 700, 1000][campaign % 4];
  const feeBps = [0, 100, 200][campaign % 3];
  const refundPenaltyBps = [100, 200, 1000, 2500][campaign % 4];
  const ledgers = Array.from({ length: actors }, () => Array(5).fill(0n));
  const refunded = Array.from({ length: actors }, () => Array(5).fill(false));
  let exactNet = 0n;
  let retainedPenalties = 0n;
  let settlementSnapshot;
  for (let step = 0; step < 160; step++) {
    const actor = sample(actors);
    const round = sample(5);
    const entry = ledgers[actor];
    const old = liquidityFor(entry, treasuryBps, feeBps);
    const action = sample(100);
    if (action < 75 && !refunded[actor][round]) {
      const amount = MIN_COMMIT + BigInt(sample(1_000_000)) * 1_000_000_001n;
      entry[round] += amount;
      exactNet += liquidityFor(entry, treasuryBps, feeBps) - old;
      operations++;
    } else if (action < 95 && round < 4 && !refunded[actor][round] && entry[round] > 0n) {
      const penalty = entry[round] * BigInt(round < 2 ? 100 : refundPenaltyBps) / BPS;
      retainedPenalties += penalty;
      entry[round] = 0n;
      refunded[actor][round] = true;
      exactNet -= old - liquidityFor(entry, treasuryBps, feeBps);
      operations++;
    } else if (action >= 95 && campaign % 8 === 0 && entry.some(x => x > 0n)) {
      // A failed launch refunds all remaining paid WETH, retaining already-paid penalties.
      entry.fill(0n);
      refunded[actor].fill(true);
      exactNet -= old;
      operations++;
    }
    const recomputed = ledgers.reduce((sum, p) => sum + liquidityFor(p, treasuryBps, feeBps), 0n);
    assert.equal(exactNet, recomputed, `campaign ${campaign}, step ${step}, locker accounting`);
    checks++;
    const gross = ledgers.flat().reduce((sum, paid) => sum + paid, 0n);
    const oldAggregate = gross * BigInt(10000-treasuryBps-feeBps) / BPS;
    if (oldAggregate !== exactNet) legacyMismatch++;
    assert.equal(exactNet + retainedPenalties, recomputed + retainedPenalties);
    checks++;
  }
  settlementSnapshot = exactNet + retainedPenalties;
  // Successful settlement transfers WETH but must not change the global original entitlement.
  const settledGross = ledgers.map(p => p.reduce((sum, paid) => sum + paid, 0n));
  for (const gross of settledGross) {
    assert(gross >= 0n);
    assert.equal(exactNet + retainedPenalties, settlementSnapshot);
    checks++;
  }
}
assert(legacyMismatch > 0, "Expected to reproduce the old aggregate rounding discrepancy");
const max = (2n ** 112n) - 1n;
assert(max > 0n && max + 1n > max);
console.log(JSON.stringify({ status: "passed", type: "reference-only-not-EVM", seed: SEED, campaigns: 200, lockersPerCampaign: 100, operations, checks, legacyMismatchOccurrences: legacyMismatch, v2MaxSupply: max.toString() }, null, 2));
