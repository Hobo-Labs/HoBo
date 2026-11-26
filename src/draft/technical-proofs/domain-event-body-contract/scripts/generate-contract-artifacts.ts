import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generatedArtifacts } from "../src/domain-event-body-contract.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const artifacts = generatedArtifacts();
const mismatches = [];

for (const [relativePath, content] of Object.entries(artifacts)) {
  const target = path.join(packageRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true });

  let existing = null;
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (existing === content) continue;

  if (checkOnly) {
    mismatches.push(relativePath);
    continue;
  }

  await writeFile(target, content);
}

if (mismatches.length > 0) {
  throw new Error(`generated artifacts are stale:\n${mismatches.join("\n")}`);
}
