import assert from "node:assert/strict";
import { test } from "vitest";

import {
  rebuildGenerationRun,
  validateGenerationEvent
} from "../../generation-pipeline-io-contract/src/contract.js";
import {
  SandboxContractError,
  profileDigest
} from "../../no-egress-generation-sandbox-contract/src/contract.js";
import {
  ValidationStageContractError,
  runValidationStage,
  validateValidationReport
} from "../src/validation-stage.js";

const digest = (char) => `sha256:${char.repeat(64)}`;

function digestRef(name, char) {
  return {
    uri: `draft://generation-validation/${name}@${digest(char)}`,
    digest: digest(char)
  };
}

function genRequest(overrides = {}) {
  return {
    schema: "hobo.gen.request/v1",
    requestId: "gen-validation-1",
    artifactKind: "provider",
    target: {
      witPort: "hobo:database/postgres@0.1.0"
    },
    capabilityManifestRef: digestRef("manifest", "1"),
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
        kind: "recorded-traces",
        ref: "oci://registry.example/hobo/traces/gen-validation-1@sha256:2222",
        trusted: false,
        sanitized: true
      }
    ],
    ...overrides
  };
}

function candidate(overrides = {}) {
  return {
    requestId: "gen-validation-1",
    artifactKind: "provider",
    targetWitPort: "hobo:database/postgres@0.1.0",
    conformanceSuiteId: "conformance.provider.database@0.1.0",
    ref: digestRef("candidate", "2"),
    ...overrides
  };
}

function sandboxProfile(overrides = {}) {
  return {
    schema: "hobo.sandbox.profile/v1",
    id: "gen-validation-profile",
    isolation: {
      tier: "microvm",
      engine: "firecracker"
    },
    network: {
      mode: "none",
      allow: []
    },
    filesystem: {
      scratch: "/sandbox/scratch",
      writable: ["/sandbox/scratch"],
      readonly: ["/workspace/input"]
    },
    capabilities: [
      {
        interface: "hobo:conformance/runner@0.1.0",
        stability: "preview",
        scope: {
          suiteId: "conformance.provider.database@0.1.0",
          targetPort: "hobo:database/postgres@0.1.0"
        },
        verbs: ["run"]
      }
    ],
    resources: {
      cpuMs: 30_000,
      memoryMiB: 512,
      wallClockMs: 60_000
    },
    assertions: [
      "no-egress",
      "capability-scoped",
      "scratch-only-write",
      "resource-budgeted"
    ],
    ...overrides
  };
}

test("known-good candidate emits gen.Validated under the no-egress sandbox profile", async () => {
  const request = genRequest();
  const profile = sandboxProfile();
  const result = await runValidationStage({
    request,
    candidate: candidate(),
    sandboxProfile: profile,
    runConformance: async () => ({
      suiteId: "conformance.provider.database@0.1.0",
      targetPort: "hobo:database/postgres@0.1.0",
      passed: true,
      assertions: [
        { id: "contract.connects", passed: true },
        { id: "contract.destroy.clean", passed: true }
      ]
    }),
    replayTraces: async () => ({
      passed: true,
      traces: [{ id: "trace:charge-ok", matched: true }]
    }),
    seq: 3,
    ts: "2026-06-26T02:00:00.000Z"
  });

  assert.equal(result.outcome, "validated");
  assert.equal(result.event.type, "gen.Validated");
  assert.equal(result.event.data.passed, true);
  assert.equal(result.report.sandbox.profileDigest, profileDigest(profile));
  assert.equal(result.report.conformance.suiteId, "conformance.provider.database@0.1.0");
  assert.deepEqual(result.report.traceReplay.diffs, []);
  validateValidationReport(result.report);

  const priorEvents = [
    envelope(1, "gen.Requested", request),
    envelope(2, "gen.CandidateGenerated", {
      requestId: request.requestId,
      candidateRef: candidate().ref,
      iteration: 0
    })
  ].map(validateGenerationEvent);
  const rebuilt = rebuildGenerationRun([...priorEvents, result.event]);
  assert.equal(rebuilt.validations.at(-1).passed, true);
});

test("conformance failure emits gen.ValidationFailed with the precise failing set", async () => {
  const result = await runValidationStage({
    request: genRequest(),
    candidate: candidate(),
    sandboxProfile: sandboxProfile(),
    runConformance: async () => ({
      suiteId: "conformance.provider.database@0.1.0",
      targetPort: "hobo:database/postgres@0.1.0",
      passed: false,
      assertions: [
        { id: "contract.connects", passed: true },
        { id: "contract.require-miss", passed: false }
      ]
    }),
    replayTraces: async () => ({
      passed: true,
      traces: [{ id: "trace:charge-ok", matched: true }]
    })
  });

  assert.equal(result.outcome, "validation-failed");
  assert.equal(result.event.type, "gen.ValidationFailed");
  assert.deepEqual(result.event.data.failingAssertions, ["conformance:contract.require-miss"]);
});

test("trace replay mismatch fails even when conformance is green", async () => {
  const result = await runValidationStage({
    request: genRequest(),
    candidate: candidate(),
    sandboxProfile: sandboxProfile(),
    runConformance: async () => ({
      suiteId: "conformance.provider.database@0.1.0",
      targetPort: "hobo:database/postgres@0.1.0",
      passed: true,
      assertions: [{ id: "contract.connects", passed: true }]
    }),
    replayTraces: async () => ({
      passed: false,
      traces: [
        {
          id: "trace:charge-ok",
          matched: false,
          expectedDigest: digest("3"),
          actualDigest: digest("4")
        }
      ]
    })
  });

  assert.equal(result.outcome, "validation-failed");
  assert.equal(result.report.conformance.passed, true);
  assert.deepEqual(result.event.data.failingAssertions, ["trace:trace:charge-ok"]);
});

test("sandbox profile with egress fails closed before validation can pass", async () => {
  await assert.rejects(
    () =>
      runValidationStage({
        request: genRequest(),
        candidate: candidate(),
        sandboxProfile: sandboxProfile({
          network: { mode: "allowlist", allow: ["https://api.example.com"] }
        }),
        runConformance: async () => ({ passed: true }),
        replayTraces: async () => ({ passed: true })
      }),
    (error) => error instanceof SandboxContractError && error.code === "network.egress_not_allowed"
  );
});

test("candidate claiming a suite or port the stage did not run is rejected", async () => {
  await assert.rejects(
    () =>
      runValidationStage({
        request: genRequest(),
        candidate: candidate({
          conformanceSuiteId: "conformance.provider.redis@0.1.0"
        }),
        sandboxProfile: sandboxProfile(),
        runConformance: async () => ({
          suiteId: "conformance.provider.database@0.1.0",
          targetPort: "hobo:database/postgres@0.1.0",
          passed: true,
          assertions: [{ id: "contract.connects", passed: true }]
        }),
        replayTraces: async () => ({ passed: true })
      }),
    (error) =>
      error instanceof ValidationStageContractError &&
      error.code === "validation.candidate_suite_mismatch"
  );

  await assert.rejects(
    () =>
      runValidationStage({
        request: genRequest(),
        candidate: candidate(),
        sandboxProfile: sandboxProfile(),
        runConformance: async () => ({
          suiteId: "conformance.provider.redis@0.1.0",
          targetPort: "hobo:cache/redis@0.1.0",
          passed: true,
          assertions: [{ id: "contract.connects", passed: true }]
        }),
        replayTraces: async () => ({ passed: true })
      }),
    (error) =>
      error instanceof ValidationStageContractError &&
      error.code === "validation.suite_mismatch"
  );
});

function envelope(seq, type, data) {
  return {
    id: `01JVALIDATE${seq}`,
    type,
    v: 1,
    streamId: "generation:gen-validation-1",
    seq,
    ts: `2026-06-26T02:00:0${seq}.000Z`,
    actor: {
      kind: "agent",
      id: "agent:generation-validator"
    },
    tenant: "tenant:demo",
    correlationId: "gen-validation-1",
    data
  };
}
