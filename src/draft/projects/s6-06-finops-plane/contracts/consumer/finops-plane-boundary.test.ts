import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

describe("FinOps plane boundary pact fixtures", () => {
  it("names the plan estimate, deploy gate, and showback reconcile interactions", () => {
    const pact = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../pacts/finops_plane_boundary.pact.json"), "utf8"),
    );

    assert.equal(pact.consumer.name, "FinOpsPlaneProject");
    assert.equal(pact.provider.name, "FinOpsPlaneBoundary");
    assert.equal(pact.interactions.length, 3);
    assert.deepEqual(
      pact.interactions.map((interaction) => interaction.request.body.operation),
      ["estimatePlanCost", "evaluateFinOpsDeployGate", "reconcileShowback"],
    );
  });
});
