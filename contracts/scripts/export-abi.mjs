#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import path from "node:path";
import { EXPLORER_CONTRACTS } from "./contract-list.mjs";
import { artifact, root, writeJson } from "./lib.mjs";

const outDir = path.resolve(root, "abi");
mkdirSync(outDir, { recursive: true });

const entries = EXPLORER_CONTRACTS.map((name) => [`${name}.sol`, name]);

for (const [file, name] of entries) {
  const art = artifact(file, name);
  writeJson(path.join(outDir, `${name}.abi.json`), art.abi);
  writeJson(path.join(outDir, `${name}.artifact.json`), {
    contractName: name,
    abi: art.abi,
    bytecode: art.bytecode
  });
}

console.log(`Exported ABI and artifact files to ${outDir}`);
