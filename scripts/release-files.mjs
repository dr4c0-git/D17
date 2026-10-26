import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The single definition of which files belong to the release manifest.
 * generate-release-checksums.mjs writes RELEASE_SHA256SUMS.txt from this
 * collection; check-release.mjs re-collects with the same rules and verifies
 * the manifest matches the tree byte-for-byte - so a manifest generated
 * before a later build/tooling step can no longer pass the release gate.
 */

export const RELEASE_MANIFEST_NAME = "RELEASE_SHA256SUMS.txt";

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".vercel",
  "artifacts",
  "cache",
  "node_modules",
  "runs",
]);

const ignoredFiles = new Set([RELEASE_MANIFEST_NAME, ".DS_Store"]);

export function collectReleaseFiles(directory, relative = "") {
  const files = [];
  for (const name of readdirSync(directory)) {
    if (ignoredDirectories.has(name) || ignoredFiles.has(name) || name.endsWith(".tsbuildinfo")) continue;
    const absolute = path.join(directory, name);
    const nextRelative = path.join(relative, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) files.push(...collectReleaseFiles(absolute, nextRelative));
    else files.push(nextRelative);
  }
  return files.sort((left, right) => left.localeCompare(right));
}
