// Bundles the public documentation into apps/web/content/site-content.json, which the
// web app renders at /docs, /blog and /progress. The web app is built from apps/web
// alone (Vercel's root directory), so it cannot read docs/ at build time: it reads this
// copy instead.
//
//   npm run content:sync            rewrite the bundle
//   npm run content:sync -- --check fail if the bundle is out of date (check:release runs it)
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SITE_CONTENT_PATH = "apps/web/content/site-content.json";

const files = [
  "docs/README.md",
  "docs/GUIDE.md",
  "docs/CONTRACTS.md",
  "docs/CONTRACTS_TECHNICAL.md",
  "docs/V15_HARDENING.md",
  "docs/SELF_HOSTING.md",
  "docs/PROGRESS.md",
  "CHANGELOG.md",
  "docs/blog/README.md",
  ...readdirSync(path.join(root, "docs/blog"))
    .filter((name) => /^\d\d-.+\.md$/.test(name))
    .sort()
    .map((name) => `docs/blog/${name}`),
];

export function buildSiteContent() {
  const content = {};
  for (const file of files) content[file] = readFileSync(path.join(root, file), "utf8");
  return `${JSON.stringify({ files: content }, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const target = path.join(root, SITE_CONTENT_PATH);
  const next = buildSiteContent();
  if (process.argv.includes("--check")) {
    if (!existsSync(target) || readFileSync(target, "utf8") !== next) {
      console.error(`${SITE_CONTENT_PATH} is out of date: run npm run content:sync`);
      process.exit(1);
    }
    console.log(`${SITE_CONTENT_PATH} is up to date (${files.length} files)`);
  } else {
    writeFileSync(target, next);
    console.log(`Wrote ${SITE_CONTENT_PATH} (${files.length} files)`);
  }
}
