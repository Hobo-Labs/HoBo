import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX,
  REQUIRED_DESIGN_TERMS,
  REQUIRED_ROLES,
  REQUIRED_SCENARIO_PATHS,
  classifyDxScenarioScope,
  parseDxResourceLifecycleScenarioMatrix,
  summarizeMatrixByRole,
} from "../src/dx-resource-lifecycle-scenario-matrix.ts";

describe("DX resource lifecycle scenario matrix", () => {
  it("covers the required operator journeys with executable touchpoints", () => {
    const matrix = parseDxResourceLifecycleScenarioMatrix(
      DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX,
    );

    assert.equal(matrix.issue, "HOBO-567");
    assert.equal(matrix.targetPackage, "src/draft/exp-proofs/dx/dx-resource-lifecycle-scenario-matrix");
    assert.equal(matrix.proofNote, "docs/design/proofs/dx-resource-lifecycle-scenario-matrix/README.md");
    assert.deepEqual(
      matrix.journeys.map((journey) => journey.role),
      REQUIRED_ROLES,
    );

    for (const journey of matrix.journeys) {
      assert.ok(journey.commands.length > 0, `${journey.role} has CLI commands`);
      assert.ok(journey.sdkCalls.length > 0, `${journey.role} has SDK calls`);
      assert.ok(journey.apiCalls.length > 0, `${journey.role} has API calls`);
      assert.ok(journey.mcpTools.length > 0, `${journey.role} has MCP tools`);
      assert.ok(journey.expectedArtifacts.length > 0, `${journey.role} has artifacts`);
      assert.ok(journey.fixtureRequirements.length > 0, `${journey.role} has fixtures`);
      assert.ok(journey.proofMode.length > 0, `${journey.role} has proof mode`);
    }
  });

  it("pins happy, blocked, stale evidence, migration or rollback, and support handoff paths", () => {
    const matrix = parseDxResourceLifecycleScenarioMatrix(
      DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX,
    );

    for (const journey of matrix.journeys) {
      assert.deepEqual(journey.scenarioPaths, REQUIRED_SCENARIO_PATHS);
    }
  });

  it("references the existing HoBo resource lifecycle vocabulary", () => {
    const matrix = parseDxResourceLifecycleScenarioMatrix(
      DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX,
    );
    const terms = new Set([
      ...matrix.designTerms,
      ...matrix.journeys.flatMap((journey) => journey.designTerms),
    ]);

    for (const term of REQUIRED_DESIGN_TERMS) {
      assert.ok(terms.has(term), `expected design term ${term}`);
    }
  });

  it("keeps Pact and CUE architecture artifacts aligned with the parsed matrix shape", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/dx_resource_lifecycle_scenario_matrix.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };
    const pactMatrix = parseDxResourceLifecycleScenarioMatrix(
      pact.interactions[0].response.body,
    );

    assert.deepEqual(
      pactMatrix.journeys.map((journey) => journey.role),
      REQUIRED_ROLES,
    );

    const cue = readFileSync(
      new URL("../architecture/dx_resource_lifecycle_scenario_matrix.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "targetPackage",
      "proofNote",
      "designRefs",
      "designTerms",
      "scopeOut",
      "sdkCalls",
      "apiCalls",
      "mcpTools",
      "expectedArtifacts",
      "proofMode",
      "fixtureRequirements",
      "scenarioPaths",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
    for (const staleField of [
      "target_package",
      "proof_note",
      "design_refs",
      "design_terms",
      "scope_out",
      "sdk_calls",
      "api_calls",
      "mcp_tools",
      "expected_artifacts",
      "proof_mode",
      "fixture_requirements",
      "scenario_paths",
    ]) {
      assert.doesNotMatch(cue, new RegExp(`\\b${staleField}\\b`));
    }
  });

  it("rejects matrix fixtures that drop required journeys or design anchors", () => {
    assert.throws(
      () =>
        parseDxResourceLifecycleScenarioMatrix({
          ...DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX,
          journeys: DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX.journeys.filter(
            (journey) => journey.role !== "sre",
          ),
        }),
      /missing required role sre/,
    );

    assert.throws(
      () =>
        parseDxResourceLifecycleScenarioMatrix({
          ...DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX,
          designTerms: DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX.designTerms.filter(
            (term) => term !== "Gatekeeper",
          ),
          journeys: DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX.journeys.map((journey) => ({
            ...journey,
            designTerms: journey.designTerms.filter((term) => term !== "Gatekeeper"),
          })),
        }),
      /missing required design term Gatekeeper/,
    );
  });

  it("guards adversarial scope creep before visual or production implementation work", () => {
    assert.deepEqual(
      classifyDxScenarioScope("Build the production CLI implementation for hobo up"),
      {
        allowed: false,
        reason: "production-implementation",
      },
    );
    assert.deepEqual(
      classifyDxScenarioScope("Run live providers with real credentials in AWS"),
      {
        allowed: false,
        reason: "live-provider-or-credential",
      },
    );
    assert.deepEqual(
      classifyDxScenarioScope("Attach customer data to the support handoff fixture"),
      {
        allowed: false,
        reason: "customer-data",
      },
    );
    assert.deepEqual(
      classifyDxScenarioScope("Create visual mockups that invent new resource behavior"),
      {
        allowed: false,
        reason: "premature-visual-behavior",
      },
    );
    assert.deepEqual(
      classifyDxScenarioScope("Add a deterministic fixture row for hobo inspect"),
      {
        allowed: true,
        reason: "matrix-fixture",
      },
    );
  });

  it("summarizes one fixture contract per role for downstream proof packages", () => {
    const summary = summarizeMatrixByRole(
      parseDxResourceLifecycleScenarioMatrix(DX_RESOURCE_LIFECYCLE_SCENARIO_MATRIX),
    );

    assert.equal(summary.length, REQUIRED_ROLES.length);
    assert.deepEqual(
      summary.map((row) => row.role),
      REQUIRED_ROLES,
    );
    assert.ok(
      summary.every((row) => row.fixtureRequirements.length >= 2),
      "each role exposes fixture requirements",
    );
  });
});
