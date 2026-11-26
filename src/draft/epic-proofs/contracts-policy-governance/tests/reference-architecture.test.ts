import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  BOUNDARY_CONTRACTS,
  createMockBoundaryHarness,
  runDenyCeilingBypassSimulation,
  runFailClosedSimulation,
  runGovernedDeploySimulation,
  validateBoundaryCoverage,
} from "../services/reference-architecture.js";

describe("Contracts, Policy & Governance reference architecture", () => {
  it("runs a governed deploy through mocked service boundaries", async () => {
    const harness = createMockBoundaryHarness();

    const result = await runGovernedDeploySimulation(harness);

    assert.equal(result.scenario, "compatible deploy produces auditable approval obligations");
    assert.equal(result.gatekeeper.deployable, true);
    assert.equal(result.gatekeeper.status, "deployable");
    assert.equal(result.policyDecision.effect, "require-approval");
    assert.deepEqual(result.obligationGate.reasons, []);
    assert.equal(result.conformance.deployable, true);
    assert.equal(result.conformanceReplay.matchesRecordedDecision, true);
    assert.deepEqual(harness.networkCalls, []);
    assert.deepEqual(validateBoundaryCoverage(result.boundaryDecisions), {
      ok: true,
      missing: [],
      extra: [],
    });
  });

  it("blocks lower-scope attempts to disable mandatory governance gates", async () => {
    const result = await runDenyCeilingBypassSimulation(createMockBoundaryHarness());

    assert.equal(result.scenario, "mandatory governance cannot be bypassed");
    assert.equal(result.gatekeeper.deployable, false);
    assert.equal(result.gatekeeper.status, "blocked");
    assert.match(
      result.gatekeeper.failures.map((failure) => failure.reason).join("\n"),
      /mandatory deny-ceiling forbids disabling contracts/,
    );
    assert.equal(result.denyCeiling.ok, false);
    assert.match(result.denyCeiling.violations.join("\n"), /attempts to allow/);
  });

  it("fails closed when policy providers are unavailable or malformed", async () => {
    const result = await runFailClosedSimulation(createMockBoundaryHarness({
      policyProviderMode: "unavailable",
    }));

    assert.equal(result.scenario, "policy uncertainty fails closed");
    assert.equal(result.gatekeeper.deployable, false);
    assert.equal(result.failClosedDecision.effect, "deny");
    assert.equal(result.failClosedDecision.failClosed, true);
    assert.match(result.failClosedDecision.reason, /policy evaluator unavailable/);
    assert.equal(result.boundaryDecisions["Gatekeeper to Policy Engine"].status, "mocked_provider_unavailable");
  });

  it("declares the full boundary set used by the simulation", () => {
    assert.equal(BOUNDARY_CONTRACTS.length, 10);
    assert.deepEqual(
      BOUNDARY_CONTRACTS.map((boundary) => boundary.boundary).sort(),
      [
        "Contract Engine to Deployed State Projection",
        "Gatekeeper to Artifact Provenance Verifier",
        "Gatekeeper to Contract Engine",
        "Gatekeeper to Cost/Quota Policy",
        "Gatekeeper to Obligation Engine",
        "Gatekeeper to Policy Engine",
        "Governance Suite to Evidence Store",
        "Policy Engine to Audit Log",
        "Policy Engine to Policy Pack Registry",
        "Policy Engine to RBAC Directory",
      ],
    );
  });
});
