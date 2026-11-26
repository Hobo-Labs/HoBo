import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  CHAOS_RESILIENCE_TESTS_SCOPE,
  REQUIRED_M1_EVIDENCE,
  REQUIRED_OPERATING_BOUNDARIES,
  canStartChaosResilienceFollowUp,
  classifyChaosResilienceRequest,
  validateChaosResilienceScope,
} from "../src/chaos-resilience-tests-scope.ts";

test("M0 record states the chaos and resilience test goal, personas, scope, and boundaries", () => {
  const result = validateChaosResilienceScope(CHAOS_RESILIENCE_TESTS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(CHAOS_RESILIENCE_TESTS_SCOPE.issue, "HOBO-439");
  assert.equal(CHAOS_RESILIENCE_TESTS_SCOPE.phase, "M0");
  assert.match(CHAOS_RESILIENCE_TESTS_SCOPE.goal, /Chaos & Resilience Tests/i);
  assert.deepEqual(
    CHAOS_RESILIENCE_TESTS_SCOPE.personas.map((persona) => persona.id),
    [
      "sre-operator",
      "release-owner",
      "platform-engineer",
      "security-lead",
      "support-operator",
    ],
  );
  assert.deepEqual(
    CHAOS_RESILIENCE_TESTS_SCOPE.operatingBoundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_OPERATING_BOUNDARIES].sort(),
  );
});

test("owning dependencies and M1 evidence are explicit before follow-up work can start", () => {
  assert.deepEqual(
    CHAOS_RESILIENCE_TESTS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Chaos & Resilience Tests",
      "Reliability, Observability & Cost",
      "E2E Test Matrix",
      "Security Verification",
      "V1 Release Program & Cutline",
      "V1 Launch Support Desk & Escalation",
      "Operators/SRE",
    ],
  );
  assert.deepEqual(
    CHAOS_RESILIENCE_TESTS_SCOPE.m1Evidence.map((evidence) => evidence.id).sort(),
    [...REQUIRED_M1_EVIDENCE].sort(),
  );
});

test("M1-M4 follow-up issues stay blocked until M0 acceptance is recorded", () => {
  for (const phase of ["M1", "M2", "M3", "M4"] as const) {
    assert.equal(canStartChaosResilienceFollowUp({ phase, m0Accepted: false }).allowed, false);
    assert.equal(canStartChaosResilienceFollowUp({ phase, m0Accepted: true }).allowed, true);
  }

  assert.equal(canStartChaosResilienceFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects live chaos, Golden Suite, SRE, UI, support, and credential creep", () => {
  const invalid = structuredClone(CHAOS_RESILIENCE_TESTS_SCOPE);
  invalid.scopeIn.push("Build a live chaos runner that injects production faults through a provider adapter.");
  invalid.scopeIn.push("Implement the full Golden Suite and SLO computation engine.");
  invalid.scopeIn.push("Ship the SRE remediation engine, dashboard UI, support queue, and credential mutation path.");

  const result = validateChaosResilienceScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live chaos runner/i);
  assert.match(result.errors.join("\n"), /Golden Suite/i);
  assert.match(result.errors.join("\n"), /SRE remediation/i);
  assert.match(result.errors.join("\n"), /dashboard UI/i);
  assert.match(result.errors.join("\n"), /credential mutation/i);
});

test("request routing keeps adjacent implementation ownership explicit", () => {
  assert.deepEqual(classifyChaosResilienceRequest("define steady-state hypothesis rows"), {
    owner: "Chaos & Resilience Tests",
    inScope: true,
  });
  assert.deepEqual(classifyChaosResilienceRequest("compute SLO burn rate and metric window"), {
    owner: "Reliability, Observability & Cost",
    inScope: false,
  });
  assert.deepEqual(classifyChaosResilienceRequest("mutate provider credentials during live fault injection"), {
    owner: "Security Verification",
    inScope: false,
  });
  assert.deepEqual(classifyChaosResilienceRequest("implement SRE runbook remediation workflow"), {
    owner: "Operators/SRE",
    inScope: false,
  });
  assert.deepEqual(classifyChaosResilienceRequest("publish customer support incident update"), {
    owner: "V1 Launch Support Desk & Escalation",
    inScope: false,
  });
});

test("architecture evidence names schema, constraints, pact, and event boundary", () => {
  const architecture = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../contracts/pacts/chaos-resilience-tests-scope.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const proto = readFileSync(
    new URL("../proto/chaos_resilience_tests_scope.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../cue/chaos_resilience_tests_scope.cue", import.meta.url),
    "utf8",
  );

  assert.equal(pact.consumer.name, "ReleaseCutlineGate");
  assert.equal(pact.provider.name, "ChaosResilienceTestsScopeRecord");
  assert.ok(pact.interactions.length >= 2);

  for (const typeName of [
    "ChaosResilienceTestsScope",
    "ChaosResiliencePersona",
    "ChaosResilienceBoundary",
    "ChaosResilienceEvidence",
    "ChaosResilienceState",
  ]) {
    assert.match(proto, new RegExp(`(?:message|enum) ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /derived domain types/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Event/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /Snapshot/i);
  assert.match(architecture, /read store/i);
});
