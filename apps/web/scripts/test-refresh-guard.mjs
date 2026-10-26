#!/usr/bin/env node
/**
 * Regression check for the launch-refresh generation guard.
 *
 * Scenario: a slow activity refresh for launch A is still in flight when the
 * user selects launch B. When A's reads finally resolve, none of A's results
 * - pool address, pool composition, activity, caches, or status - may be
 * committed, and A must not clear the loading flags or surface errors that
 * belong to B's in-flight request. Deterministic: promise resolution order
 * is fully controlled, no network, no timers.
 */
import assert from "node:assert/strict";
import { commitIfCurrentGeneration, isCurrentGeneration } from "../lib/refresh-guard.mjs";

// Mirrors the terminal's launch-scoped state and the launchGenRef counter.
const launchGenRef = { current: 1 };
const state = {
  poolAddress: "",
  poolComposition: null,
  activity: [],
  cache: null,
  indexStatus: "",
  isIndexing: false,
  errorsShown: [],
};

/** A refresh exactly shaped like refreshActivity's gated tail. */
function makeRefresh(label, results) {
  const generation = launchGenRef.current;
  state.isIndexing = true;
  let resolveReads;
  let rejectReads;
  const reads = new Promise((resolve, reject) => {
    resolveReads = resolve;
    rejectReads = reject;
  });
  const done = reads
    .then(() => {
      const committed = commitIfCurrentGeneration(generation, launchGenRef.current, () => {
        state.cache = results.cache;
        state.poolAddress = results.poolAddress;
        state.poolComposition = results.poolComposition;
        state.activity = results.activity;
        state.indexStatus = results.status;
      });
      return committed;
    })
    .catch((error) => {
      if (isCurrentGeneration(generation, launchGenRef.current)) {
        state.errorsShown.push(`${label}: ${error.message}`);
        state.indexStatus = "Index refresh failed";
      }
      return false;
    })
    .finally(() => {
      if (isCurrentGeneration(generation, launchGenRef.current)) {
        state.isIndexing = false;
      }
    });
  return { resolveReads, rejectReads, done };
}

const A = {
  cache: { key: "launchA", events: ["a1", "a2"] },
  poolAddress: "0xAAAA000000000000000000000000000000000000",
  poolComposition: { seededToken: 1n },
  activity: ["A-event"],
  status: "2 events · launch A",
};
const B = {
  cache: { key: "launchB", events: ["b1"] },
  poolAddress: "", // launch B has no pool yet
  poolComposition: null,
  activity: ["B-event"],
  status: "1 event · launch B",
};

// 1. Begin delayed refresh for A.
const refreshA = makeRefresh("A", A);

// 2. User selects launch B: generation bumps, launch-scoped state clears
//    (mirrors applyLaunch), and B's refresh begins.
launchGenRef.current += 1;
state.poolAddress = "";
state.poolComposition = null;
state.activity = [];
state.cache = null;
state.indexStatus = "";
const refreshB = makeRefresh("B", B);

// 3. A's reads resolve LATE - after the switch.
refreshA.resolveReads();
const aCommitted = await refreshA.done;

// 4. Nothing of A's may be visible, and B's in-flight loading flag survives.
assert.equal(aCommitted, false, "stale A refresh must not commit");
assert.equal(state.poolAddress, "", "A's pool address must not appear on B");
assert.equal(state.poolComposition, null, "A's composition must not appear on B");
assert.deepEqual(state.activity, [], "A's activity must not appear on B");
assert.equal(state.cache, null, "A's cache must not be installed for B");
assert.equal(state.indexStatus, "", "A's status must not appear on B");
assert.equal(state.isIndexing, true, "stale A must not clear B's loading flag");
assert.deepEqual(state.errorsShown, [], "stale A must stay silent");

// 5. B resolves and commits normally - including B's has-no-pool emptiness.
refreshB.resolveReads();
const bCommitted = await refreshB.done;
assert.equal(bCommitted, true, "current B refresh must commit");
assert.equal(state.poolAddress, "", "B genuinely has no pool");
assert.deepEqual(state.activity, ["B-event"]);
assert.equal(state.cache.key, "launchB");
assert.equal(state.indexStatus, "1 event · launch B");
assert.equal(state.isIndexing, false, "B's own completion clears the flag");

// 6. Stale FAILURE stays silent too: A2 starts, the user switches away,
//    then A2's reads reject.
const failing = makeRefresh("A2", A);
launchGenRef.current += 1;
state.isIndexing = true; // the new selection's refresh is in flight
const statusBefore = state.indexStatus;
failing.rejectReads(new Error("boom"));
await failing.done;
assert.deepEqual(state.errorsShown, [], "stale failure must not surface an error");
assert.equal(state.indexStatus, statusBefore, "stale failure must not change status");
assert.equal(state.isIndexing, true, "stale failure must not clear the active loading flag");

console.log("refresh-guard regression: PASS (stale A committed nothing onto B; stale errors stay silent)");
