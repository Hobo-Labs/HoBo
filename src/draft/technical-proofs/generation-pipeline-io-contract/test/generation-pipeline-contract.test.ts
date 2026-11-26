import assert from "node:assert/strict";
import { test } from "vitest";

import {
  GenerationContractError,
  appendGenerationEvent,
  authoritativeContractFromRequest,
  rebuildGenerationRun,
  validateGenerationEvent,
  validateGenRequest,
  validateGenResult
} from "../src/contract.js";

const digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

function validRequest(overrides = {}) {
  return {
    schema: "hobo.gen.request/v1",
    requestId: "gen-run-1",
    artifactKind: "provider",
    target: {
      witPort: "hobo:database/postgres@0.1.0"
    },
    capabilityManifestRef: {
      uri: "oci://registry.example/hobo/provider-postgres@sha256:1111",
      digest
    },
    authoritativeRefs: [
      {
        kind: "wit",
        ref: "wit://hobo/database@0.1.0"
      },
      {
        kind: "conformance-suite",
        suiteId: "conformance.provider.database@0.1.0",
        ref: "oci://registry.example/hobo/conformance/database@sha256:1111"
      }
    ],
    materialRefs: [
      {
        kind: "provider-docs",
        ref: "https://example.invalid/docs",
        trusted: false,
        sanitized: true
      }
    ],
    ...overrides
  };
}

function validResult(overrides = {}) {
  return {
    schema: "hobo.gen.result/v1",
    requestId: "gen-run-1",
    candidateRef: {
      uri: "oci://registry.example/hobo/candidates/provider-postgres@sha256:1111",
      digest
    },
    validationReportRef: {
      uri: "oci://registry.example/hobo/reports/gen-run-1@sha256:1111",
      digest
    },
    provenanceRef: {
      uri: "oci://registry.example/hobo/provenance/gen-run-1@sha256:1111",
      digest
    },
    gateDecision: {
      effect: "certify",
      policyRef: "policy.gen.low-risk"
    },
    ...overrides
  };
}

test("GenRequest and GenResult round-trip fixture with contract-first fields", () => {
  const request = validateGenRequest(validRequest());

  assert.equal(request.artifactKind, "provider");
  assert.equal(request.authoritativeRefs.at(-1).suiteId, "conformance.provider.database@0.1.0");

  const result = validateGenResult(validResult());

  assert.equal(result.gateDecision.effect, "certify");
});

test("material refs stay untrusted and cannot override the authoritative contract", () => {
  const request = validateGenRequest(validRequest());
  const contract = authoritativeContractFromRequest(request);

  assert.deepEqual(contract, {
    requestId: "gen-run-1",
    artifactKind: "provider",
    target: {
      witPort: "hobo:database/postgres@0.1.0"
    },
    conformanceSuiteId: "conformance.provider.database@0.1.0",
    capabilityManifestDigest: digest
  });
  assert.equal("materialRefs" in contract, false);

  assertContractError(
    () =>
      validateGenRequest(
        validRequest({
          materialRefs: [
            {
              kind: "provider-docs",
              ref: "https://example.invalid/injection",
              trusted: true,
              sanitized: true
            }
          ]
        })
      ),
    "gen.request.material_must_be_untrusted"
  );
});

test("ungated generation is unrepresentable without a conformance suite", () => {
  assertContractError(
    () =>
      validateGenRequest(
        validRequest({
          authoritativeRefs: [
            {
              kind: "wit",
              ref: "wit://hobo/database@0.1.0"
            }
          ]
        })
      ),
    "gen.request.conformance_suite_required"
  );
});

test("gen event stream rebuilds the generation run from zero like the live view", () => {
  const request = validRequest();
  const result = validResult();
  const events = [
    envelope(1, "gen.Requested", request),
    envelope(2, "gen.CandidateGenerated", {
      requestId: "gen-run-1",
      candidateRef: result.candidateRef,
      iteration: 0
    }),
    envelope(3, "gen.ValidationFailed", {
      requestId: "gen-run-1",
      candidateRef: result.candidateRef,
      validationReportRef: result.validationReportRef,
      failingAssertions: ["trace.replay.mismatch"]
    }),
    envelope(4, "gen.Repaired", {
      requestId: "gen-run-1",
      candidateRef: result.candidateRef,
      iteration: 1,
      failingAssertions: ["trace.replay.mismatch"]
    }),
    envelope(5, "gen.Validated", {
      requestId: "gen-run-1",
      candidateRef: result.candidateRef,
      validationReportRef: result.validationReportRef,
      passed: true
    }),
    envelope(6, "gen.Certified", result)
  ].map(validateGenerationEvent);

  const live = events.reduce(appendGenerationEvent, undefined);
  const rebuilt = rebuildGenerationRun(events);

  assert.deepEqual(rebuilt, live);
  assert.equal(rebuilt.request.requestId, "gen-run-1");
  assert.equal(rebuilt.candidates.length, 1);
  assert.deepEqual(rebuilt.failingAssertions, ["trace.replay.mismatch"]);
  assert.equal(rebuilt.finalDecision.effect, "certify");
});

test("repair and needs-human events carry bounded-repair evidence", () => {
  assertContractError(
    () =>
      validateGenerationEvent(
        envelope(1, "gen.Repaired", {
          requestId: "gen-run-1",
          candidateRef: validResult().candidateRef,
          iteration: 1,
          failingAssertions: []
        })
      ),
    "gen.event.failing_assertions"
  );

  const event = validateGenerationEvent(
    envelope(2, "gen.NeedsHuman", {
      requestId: "gen-run-1",
      reason: "repair-budget-exhausted",
      budgetExhausted: true,
      failingAssertions: ["trace.replay.mismatch"]
    })
  );

  assert.equal(event.data.budgetExhausted, true);
});

test("gen.SafetyRejected records malicious candidate findings before certification", () => {
  const result = validResult();
  const event = validateGenerationEvent(
    envelope(3, "gen.SafetyRejected", {
      requestId: "gen-run-1",
      candidateRef: result.candidateRef,
      validationReportRef: result.validationReportRef,
      safetyReportRef: {
        uri: "oci://registry.example/hobo/safety/gen-run-1@sha256:1111",
        digest
      },
      failingAssertions: ["sandbox.network_egress_denied"]
    })
  );

  const rebuilt = rebuildGenerationRun([
    envelope(2, "gen.Validated", {
      requestId: "gen-run-1",
      candidateRef: result.candidateRef,
      validationReportRef: result.validationReportRef,
      passed: true
    }),
    event
  ]);

  assert.equal(event.type, "gen.SafetyRejected");
  assert.equal(rebuilt.finalDecision.effect, "deny");
  assert.deepEqual(rebuilt.safetyRejections.at(-1).findings, [
    "sandbox.network_egress_denied"
  ]);
});

test("generation events pin run correlation to the request id", () => {
  assertContractError(
    () =>
      validateGenerationEvent({
        ...envelope(1, "gen.CandidateGenerated", {
          requestId: "gen-run-1",
          candidateRef: validResult().candidateRef,
          iteration: 0
        }),
        correlationId: "other-run"
      }),
    "gen.event.correlation_mismatch"
  );
});

function envelope(seq, type, data) {
  return {
    id: `01JGEN${seq}`,
    type,
    v: 1,
    streamId: "generation:gen-run-1",
    seq,
    ts: `2026-06-25T04:00:0${seq}.000Z`,
    actor: {
      kind: "agent",
      id: "agent:swe"
    },
    tenant: "tenant:demo",
    correlationId: "gen-run-1",
    data
  };
}

function assertContractError(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof GenerationContractError && error.code === code
  );
}
