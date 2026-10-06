#!/usr/bin/env node
// Regenerates docs/contract-explorer.html from abi/*.abi.json. The page header and
// stylesheet (everything before <body>) are kept from the existing file.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root } from "./lib.mjs";
import { EXPLORER_CONTRACTS } from "./contract-list.mjs";

const explorerPath = path.join(root, "docs", "contract-explorer.html");
const entryTypes = ["constructor", "error", "event", "fallback", "function", "receive"];

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("\"", "&quot;");

function canonicalType(param) {
  if (!param.type.startsWith("tuple")) return param.type;
  return `(${param.components.map(canonicalType).join(",")})${param.type.slice("tuple".length)}`;
}

function componentLabel(param) {
  return `${canonicalType(param)} ${param.name}`;
}

function paramCell(params, fallbackPrefix) {
  if (!params || params.length === 0) return `<span class="sig">none</span>`;
  return params.map((param, index) => {
    const name = escapeHtml(param.name || `${fallbackPrefix}${index}`);
    const type = `${param.type}${param.indexed ? " indexed" : ""}`;
    const components = param.components
      ? `<br><span class="sig">components: ${escapeHtml(param.components.map(componentLabel).join(", "))}</span>`
      : "";
    return `<div><span class="sig">${escapeHtml(type)}</span> ${name}${components}</div>`;
  }).join("");
}

function signature(entry) {
  if (entry.type === "fallback" || entry.type === "receive") return entry.type;
  const name = entry.type === "constructor" ? "constructor" : entry.name;
  return `${name}(${(entry.inputs || []).map(canonicalType).join(",")})`;
}

function row(entry, index) {
  const name = entry.name || entry.type;
  const mutability = entry.stateMutability ? `<br><code>${entry.stateMutability}</code>` : entry.anonymous ? "<br><code>anonymous</code>" : "";
  const outputs = entry.type === "function" ? paramCell(entry.outputs, "arg") : `<span class="sig">none</span>`;
  return `        <tr>
    <td>${index}</td>
    <td><span class="type-${entry.type}">${entry.type}</span>${mutability}</td>
    <td>${escapeHtml(name)}</td>
    <td class="sig">${escapeHtml(signature(entry))}</td>
    <td>${paramCell(entry.inputs, "arg")}</td>
    <td>${outputs}</td>
  </tr>`;
}

const abis = EXPLORER_CONTRACTS.map((name) => [name, JSON.parse(readFileSync(path.join(root, "abi", `${name}.abi.json`), "utf8"))]);
const totals = Object.fromEntries(entryTypes.map((type) => [type, 0]));
let totalEntries = 0;
for (const [, abi] of abis) {
  for (const entry of abi) totals[entry.type] += 1;
  totalEntries += abi.length;
}

const sections = abis.map(([name, abi]) => {
  const counts = Object.fromEntries(entryTypes.map((type) => [type, abi.filter((entry) => entry.type === type).length]));
  const pills = entryTypes.filter((type) => counts[type] > 0).map((type) => `<span class="pill">${type}: ${counts[type]}</span>`).join("");
  return `<section id="${name.toLowerCase()}">
    <h2>${name}</h2>
    <p>Source: <code>abi/${name}.abi.json</code></p>
    <p>${pills}</p>
    <table>
      <thead>
        <tr>
          <th style="width: 52px;">#</th>
          <th style="width: 120px;">Type</th>
          <th style="width: 190px;">Name</th>
          <th>Signature</th>
          <th>Inputs</th>
          <th>Outputs</th>
        </tr>
      </thead>
      <tbody>
${abi.map(row).join("\n")}
      </tbody>
    </table>
  </section>`;
});

const existing = readFileSync(explorerPath, "utf8");
const head = existing.slice(0, existing.indexOf("<body>"));
const html = `${head}<body>
  <header>
    <h1>D17 Contract Explorer</h1>
    <p>Generated from the production ABI JSON files included in this repository.</p>
    <p>Public Sepolia and Ethereum mainnet factory addresses are recorded in <code>deployments/</code>.</p>
    <div class="notice">Coverage is ABI-derived: every ABI entry in the listed source files is rendered below. Hand curation is deliberately avoided so functions, events, constructors, and errors are not silently missed.</div>
    <div class="grid">
      <div class="stat"><strong>${abis.length}</strong>contracts</div>
      <div class="stat"><strong>${totalEntries}</strong>ABI entries</div>
${entryTypes.map((type) => `      <div class="stat"><strong>${totals[type]}</strong>${type}</div>`).join("\n")}
    </div>
    <nav>
${abis.map(([name]) => `      <a href="#${name.toLowerCase()}">${name}</a>`).join("\n")}
    </nav>
  </header>
  <main>
    <h2>Deployment Note</h2>
    <p>This explorer covers every ABI entry in the D17 contract set. Verify network, addresses and bytecode independently before interacting.</p>
    ${sections.join("\n")}
  </main>
</body>
</html>
`;

writeFileSync(explorerPath, html);
console.log(`Wrote ${path.relative(root, explorerPath)} (${abis.length} contracts, ${totalEntries} ABI entries)`);
