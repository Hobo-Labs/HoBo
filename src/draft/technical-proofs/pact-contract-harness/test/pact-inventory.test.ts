import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPactInventory } from "../src/inventory.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }))),
  );
});

async function makeContractsDir(contents: {
  inventory: string;
  pacts?: Record<string, string>;
}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pact-inventory-"));
  tempDirs.push(dir);
  await mkdir(path.join(dir, "pacts"), { recursive: true });
  await writeFile(path.join(dir, "pact-inventory.md"), contents.inventory, "utf8");

  for (const [fileName, body] of Object.entries(contents.pacts ?? {})) {
    await writeFile(path.join(dir, "pacts", fileName), body, "utf8");
  }

  return dir;
}

const tableHeader =
  "| Boundary | Consumer | Provider | Protocol | Pact file/test | Provider verification | Mock used | Status |";

describe("checkPactInventory", () => {
  it("passes when inventory and pact files agree", async () => {
    const dir = await makeContractsDir({
      inventory: `${tableHeader}
| core | CoreReferenceConsumer | CoreContractSurface | in-process | pacts/core-contract-surface.pact.json | provider/core-contract-surface.provider.test.ts | core-contract-surface.stub.ts | provider_verified |`,
      pacts: {
        "core-contract-surface.pact.json": "{}",
      },
    });

    const result = await checkPactInventory(dir);
    expect(result.ok).toBe(true);
    expect(result.problems).toHaveLength(0);
  });

  it("fails when a pact file is missing from inventory", async () => {
    const dir = await makeContractsDir({
      inventory: `${tableHeader}
| core | CoreReferenceConsumer | CoreContractSurface | in-process |  | provider/core-contract-surface.provider.test.ts | core-contract-surface.stub.ts | provider_verified |`,
      pacts: {
        "orphan.pact.json": "{}",
      },
    });

    const result = await checkPactInventory(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.includes("orphan.pact.json"))).toBe(true);
  });

  it("fails when inventory references a missing pact file", async () => {
    const dir = await makeContractsDir({
      inventory: `${tableHeader}
| core | CoreReferenceConsumer | CoreContractSurface | in-process | pacts/missing.pact.json | provider/core-contract-surface.provider.test.ts | core-contract-surface.stub.ts | provider_verified |`,
      pacts: {},
    });

    const result = await checkPactInventory(dir);
    expect(result.ok).toBe(false);
    expect(result.problems.some((problem) => problem.includes("missing.pact.json"))).toBe(true);
  });
});
