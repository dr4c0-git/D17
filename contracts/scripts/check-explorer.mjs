#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { EXPLORER_CONTRACTS as contractNames } from "./contract-list.mjs";

const html = readFileSync("docs/contract-explorer.html", "utf8");
const entryTypes = ["constructor", "error", "event", "fallback", "function", "receive"];
const failures = [];

for (const name of contractNames) {
  const abi = JSON.parse(readFileSync(`abi/${name}.abi.json`, "utf8"));
  const counts = Object.fromEntries(entryTypes.map((type) => [type, 0]));
  for (const entry of abi) counts[entry.type] = (counts[entry.type] || 0) + 1;

  const start = html.indexOf(`<h2>${name}</h2>`);
  const next = html.indexOf("<section id=", start + 1);
  const section = html.slice(start, next < 0 ? html.length : next);
  if (start < 0) {
    failures.push(`${name}: missing section`);
    continue;
  }

  for (const type of entryTypes) {
    const shown = Number(section.match(new RegExp(`${type}: (\\d+)`))?.[1] || 0);
    if (shown !== counts[type]) failures.push(`${name}: ${type} ${shown} != ${counts[type]}`);
  }
  const rows = (section.match(/<tr>/g) || []).length - 1;
  if (rows !== abi.length) failures.push(`${name}: ${rows} rows != ${abi.length} ABI entries`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Contract explorer ABI coverage: PASS (all ${contractNames.length} contracts, all ABI entry types)`);
