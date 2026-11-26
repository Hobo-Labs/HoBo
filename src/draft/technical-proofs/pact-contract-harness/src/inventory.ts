import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const INVENTORY_TABLE_HEADER =
  /\|\s*Boundary\s*\|\s*Consumer\s*\|\s*Provider\s*\|\s*Protocol\s*\|\s*Pact file\/test\s*\|\s*Provider verification\s*\|\s*Mock used(?: in simulation)?\s*\|\s*Status\s*\|/i;

export async function checkPactInventory(
  contractsDir: string,
): Promise<{ readonly ok: boolean; readonly problems: readonly string[] }> {
  const problems: string[] = [];
  const pactsDir = path.join(contractsDir, "pacts");
  const inventoryPath = path.join(contractsDir, "pact-inventory.md");

  let pactFiles: string[] = [];
  try {
    const entries = await readdir(pactsDir, { withFileTypes: true });
    pactFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".pact.json"))
      .map((entry) => `pacts/${entry.name}`)
      .sort();
  } catch {
    problems.push(`missing pacts directory: ${pactsDir}`);
    return { ok: false, problems };
  }

  let inventoryText: string;
  try {
    inventoryText = await readFile(inventoryPath, "utf8");
  } catch {
    problems.push(`missing pact inventory: ${inventoryPath}`);
    return { ok: false, problems };
  }

  if (!INVENTORY_TABLE_HEADER.test(inventoryText)) {
    problems.push("pact-inventory.md is missing the required inventory table header");
  }

  const inventoryPaths = extractInventoryPactPaths(inventoryText);

  for (const pactPath of pactFiles) {
    if (!inventoryPaths.has(pactPath)) {
      problems.push(`pact file not listed in inventory: ${pactPath}`);
    }
  }

  for (const inventoryPath of inventoryPaths) {
    const absolute = path.join(contractsDir, inventoryPath);
    try {
      await access(absolute);
    } catch {
      problems.push(`inventory references missing pact file: ${inventoryPath}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

function extractInventoryPactPaths(markdown: string): Set<string> {
  const paths = new Set<string>();

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || line.includes("---")) {
      continue;
    }

    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);

    if (cells.length < 5) {
      continue;
    }

    const pactCell = cells[4];
    if (!pactCell || pactCell.toLowerCase() === "pact file/test") {
      continue;
    }

    for (const match of pactCell.matchAll(/pacts\/[\w.-]+\.pact\.json/g)) {
      paths.add(match[0]);
    }
  }

  return paths;
}
