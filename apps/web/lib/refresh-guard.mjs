/**
 * Generation guard for launch-scoped refreshes.
 *
 * Every launch selection bumps a generation counter. A refresh captures the
 * generation when it starts; by the time its awaited reads resolve, the user
 * may have selected another launch. Results, caches, status lines and
 * loading-flag clears belonging to a stale generation must never be
 * committed - otherwise a slow refresh for launch A can write A's data onto
 * launch B.
 *
 * All launch-scoped commits go through commitIfCurrentGeneration so the
 * gating behavior is testable in isolation.
 */

/** True when a refresh that started at `generation` is still the active one. */
export function isCurrentGeneration(generation, currentGeneration) {
  return generation === currentGeneration;
}

/**
 * Run `commit` only when the generation is still current. Returns true when
 * the commit ran, false when the result was stale and discarded.
 */
export function commitIfCurrentGeneration(generation, currentGeneration, commit) {
  if (!isCurrentGeneration(generation, currentGeneration)) return false;
  commit();
  return true;
}
