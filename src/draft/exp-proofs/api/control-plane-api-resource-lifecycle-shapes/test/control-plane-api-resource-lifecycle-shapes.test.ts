import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

import {
  CONTROL_PLANE_API_RESOURCE_LIFECYCLE_PROOF,
  REQUIRED_ACCEPTANCE_DOMAIN_TERMS,
  REQUIRED_BOUNDARY_CASES,
  REQUIRED_OPERATIONS,
  classifyControlPlaneApiScope,
  parseControlPlaneApiResourceLifecycleProof,
  summarizeOperationParity,
} from "../src/control-plane-api-resource-lifecycle-shapes.ts";

describe("control-plane API resource lifecycle shapes", () => {
  it("specifies every shared control-plane operation with request and response shapes", () => {
    const contract = parseControlPlaneApiResourceLifecycleProof(CONTROL_PLANE_API_RESOURCE_LIFECYCLE_PROOF);

    assert.equal(contract.issue, "HOBO-569");
    assert.equal(
      contract.targetPackage,
      "src/draft/exp-proofs/api/control-plane-api-resource-lifecycle-shapes",
    );

    assert.deepEqual(
      contract.operations.map((operation) => operation.id),
      REQUIRED_OPERATIONS,
    );

    for (const operation of contract.operations) {
      assert.ok(operation.requestContract.length > 0, `${operation.id} request`);
      assert.ok(operation.responseContract.length > 0, `${operation.id} response`);
      assert.ok(operation.domainTerms.length > 0, `${operation.id} domain terms`);
    }
  });

  it("pins the named HOBO-569 API shape vocabulary", () => {
    const contract = parseControlPlaneApiResourceLifecycleProof(CONTROL_PLANE_API_RESOURCE_LIFECYCLE_PROOF);
    const acceptanceTerms = new Set(
      contract.operations.flatMap((operation) => [
        ...operation.requestContract,
        ...operation.responseContract,
        ...operation.domainTerms,
      ]),
    );

    for (const term of REQUIRED_ACCEPTANCE_DOMAIN_TERMS) {
      assert.ok(acceptanceTerms.has(term), `missing ${term}`);
    }
  });

  it("pins fail-closed refusal envelopes for every required boundary case", () => {
    const contract = parseControlPlaneApiResourceLifecycleProof(CONTROL_PLANE_API_RESOURCE_LIFECYCLE_PROOF);
    const refusalCodes = new Set(contract.refusalEnvelopes.map((envelope) => envelope.code));

    for (const code of REQUIRED_BOUNDARY_CASES) {
      assert.ok(refusalCodes.has(code), `missing ${code}`);
    }

    assert.ok(
      contract.refusalEnvelopes.every(
        (envelope) => envelope.remediation && envelope.proofMode && envelope.fixtureId && envelope.redactionClass,
      ),
      "refusals carry remediation, proof mode, fixture id, and redaction class",
    );
  });

  it("proves API and MCP callers receive equivalent typed results", () => {
    const parity = summarizeOperationParity(
      parseControlPlaneApiResourceLifecycleProof(CONTROL_PLANE_API_RESOURCE_LIFECYCLE_PROOF),
    );

    assert.equal(parity.length, REQUIRED_OPERATIONS.length);
    assert.ok(parity.every((row) => row.apiEndpoint.startsWith("/")));
    assert.ok(parity.every((row) => row.mcpTool.startsWith("hobo_")));
    assert.ok(parity.every((row) => row.sharedResultEnvelope === true));
  });

  it("requires protobuf, CUE, and Pact fixture expectations for the boundary", () => {
    const contract = parseControlPlaneApiResourceLifecycleProof(CONTROL_PLANE_API_RESOURCE_LIFECYCLE_PROOF);

    assert.equal(contract.contractFixtures.protobuf, "architecture/control_plane_api_resource_lifecycle_shapes.proto");
    assert.equal(contract.contractFixtures.cue, "architecture/control_plane_api_resource_lifecycle_shapes.cue");
    assert.equal(
      contract.contractFixtures.pact,
      "architecture/pacts/control_plane_api_resource_lifecycle_shapes.pact.json",
    );
  });

  it("keeps Pact and CUE architecture artifacts aligned with the parsed contract shape", () => {
    // SAFETY: `const pact = JSON.parse(` is required at this I/O or test boundary.
    const pact = JSON.parse(
      readFileSync(
        new URL(
          "../architecture/pacts/control_plane_api_resource_lifecycle_shapes.pact.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as {
      readonly interactions: ReadonlyArray<{
        readonly response: { readonly body: unknown };
      }>;
    };
    const pactContract = parseControlPlaneApiResourceLifecycleProof(
      pact.interactions[0].response.body,
    );

    assert.deepEqual(
      pactContract.operations.map((operation) => operation.id),
      REQUIRED_OPERATIONS,
    );
    assert.deepEqual(
      pactContract.refusalEnvelopes.map((envelope) => envelope.code),
      REQUIRED_BOUNDARY_CASES,
    );

    const cue = readFileSync(
      new URL("../architecture/control_plane_api_resource_lifecycle_shapes.cue", import.meta.url),
      "utf8",
    );
    for (const field of [
      "targetPackage",
      "proofNote",
      "designRefs",
      "refusalEnvelopes",
      "contractFixtures",
      "scopeOut",
      "humanName",
      "cliCommand",
      "apiEndpoint",
      "mcpTool",
      "requestShape",
      "responseShape",
      "domainTerms",
      "sharedResultEnvelope",
      "fixtureId",
      "proofMode",
      "redactionClass",
    ]) {
      assert.match(cue, new RegExp(`\\b${field}\\b`));
    }
    for (const staleField of [
      "target_package",
      "proof_note",
      "design_refs",
      "refusal_envelopes",
      "contract_fixtures",
      "scope_out",
      "human_name",
      "cli_command",
      "api_endpoint",
      "mcp_tool",
      "request_shape",
      "response_shape",
      "domain_terms",
      "shared_result_envelope",
      "fixture_id",
      "proof_mode",
      "redaction_class",
    ]) {
      assert.doesNotMatch(cue, new RegExp(`\\b${staleField}\\b`));
    }
  });

  it("guards scope-out requests for production implementation and live state", () => {
    assert.deepEqual(classifyControlPlaneApiScope("Build the production REST implementation"), {
      allowed: false,
      reason: "production-api-implementation",
    });
    assert.deepEqual(classifyControlPlaneApiScope("Persist real DeploymentPlans in a live database"), {
      allowed: false,
      reason: "real-persistence",
    });
    assert.deepEqual(classifyControlPlaneApiScope("Call an AWS provider adapter with real credentials"), {
      allowed: false,
      reason: "live-provider-or-credential",
    });
    assert.deepEqual(classifyControlPlaneApiScope("Bypass Planner and Gatekeeper for a dashboard endpoint"), {
      allowed: false,
      reason: "planner-gatekeeper-bypass",
    });
    assert.deepEqual(classifyControlPlaneApiScope("Add deterministic API shape fixtures"), {
      allowed: true,
      reason: "fixture-contract",
    });
  });
});
