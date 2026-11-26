import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACT_DIR = path.resolve(MODULE_DIR, "../contracts/pacts");

export async function loadPactContracts(pactDir = DEFAULT_PACT_DIR) {
  const entries = await readdir(pactDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(path.join(pactDir, file), "utf8"))),
  );
}

export function validatePactInventoryCoverage(boundaries, contracts) {
  const expected = boundaries.map((boundary) => boundary.boundary).sort();
  const actual = contracts.map((contract) => contract.metadata?.boundary).filter(Boolean).sort();
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((boundary) => !actualSet.has(boundary));
  const extra = actual.filter((boundary) => !expectedSet.has(boundary));

  return {
    ok: missing.length === 0 && extra.length === 0,
    missing,
    extra,
  };
}
