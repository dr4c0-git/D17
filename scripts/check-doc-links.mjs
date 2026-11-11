import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "out",
  "artifacts",
  "cache",
  "node_modules",
  "runs",
]);
const markdownFiles = collectMarkdown(root);
const failures = [];
let checkedLinks = 0;

for (const file of markdownFiles) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, "");
    if (!rawTarget || /^(?:https?:|mailto:|data:|#)/i.test(rawTarget)) continue;
    const targetWithoutAnchor = rawTarget.split("#", 1)[0].split("?", 1)[0];
    if (!targetWithoutAnchor) continue;
    checkedLinks += 1;
    if (path.isAbsolute(targetWithoutAnchor)) {
      failures.push(`${relative(file)}: absolute local link ${rawTarget}`);
      continue;
    }
    let decodedTarget;
    try {
      decodedTarget = decodeURIComponent(targetWithoutAnchor);
    } catch {
      failures.push(`${relative(file)}: malformed link ${rawTarget}`);
      continue;
    }
    const resolved = path.resolve(path.dirname(file), decodedTarget);
    if (!existsSync(resolved)) failures.push(`${relative(file)}: missing ${rawTarget}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Documentation links passed: ${checkedLinks} local links across ${markdownFiles.length} files`);

function collectMarkdown(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    if (ignoredDirectories.has(name)) continue;
    const absolute = path.join(directory, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) files.push(...collectMarkdown(absolute));
    else if (name.endsWith(".md")) files.push(absolute);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file);
}
