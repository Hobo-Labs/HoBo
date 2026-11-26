import assert from "node:assert/strict";
import { test } from "vitest";

import {
  rebuildGenerationRun,
  validateGenerationEvent
} from "../../generation-pipeline-io-contract/src/contract.js";
import {
  ForgeCertificationLoopError,
  replayForgeCertificationRun,
  runCertificationGate,
  runForgeCertificationLoop
} from "../src/forge-certification-loop.js";

const digest = (char) => `sha256:${char.repeat(64)}`;
const hex = (n) => digest(n.toString(16)[0] ?? "a");

function digestRef(name, char) {
  return {
    uri: `draft://forge-certification/${name}@${digest(char)}`,
    digest: digest(char)
  };
}

function genRequest(overrides = {}) {
  return {
    schema: "hobo.gen.request/v1",
    requestId: "forge-cert-1",
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
    materialRefs: [],
    ...overrides
  };
}

function sandboxProfile() {
  return {
    schema: "hobo.sandbox.profile/v1",
    id: "forge-cert-profile",
    isolation: { tier: "microvm", engine: "firecracker" },
    network: { mode: "none", allow: [] },
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
    resources: { cpuMs: 30000, memoryMiB: 512, wallClockMs: 60000 },
    assertions: ["no-egress", "capability-scoped", "scratch-only-write", "resource-budgeted"]
  };
}

function candidate(overrides = {}) {
  return {
    requestId: "forge-cert-1",
    targetWitPort: "hobo:database/postgres@0.1.0",
    ref: digestRef("candidate", "2"),
    ...overrides
  };
}

function conformanceSuites() {
  return [
    {
      suiteId: "conformance.provider.database@0.1.0",
      witInterface: "hobo:database/postgres@0.1.0"
    }
  ];
}

function passValidation(candidateValue, reportChar = "3", rerunChar = "a") {
  return {
    passed: true,
    candidate: candidateValue,
    validationReportRef: digestRef("validation-report", reportChar),
    sandboxRerun: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: true,
      digest: digest(rerunChar)
    },
    sandboxEvents: []
  };
}

function failValidation(candidateValue, reportChar, failingAssertions) {
  return {
    passed: false,
    repairable: true,
    candidate: candidateValue,
    validationReportRef: digestRef("validation-report", reportChar),
    failingAssertions
  };
}

test("Given seeded-defect candidate When bounded repair converges Then certification emits replayable gen events", async () => {
  const request = genRequest();
  const initial = candidate({ ref: digestRef("candidate-0", "2") });
  const script = [
    failValidation(initial, "3", ["conformance.assertion.failed"]),
    passValidation(candidate({ ref: digestRef("candidate-1", "4") }), "5")
  ];

  const result = await runForgeCertificationLoop({
    request,
    sandboxProfile: sandboxProfile(),
    initialCandidate: initial,
    conformanceSuites: conformanceSuites(),
    maxRepairAttempts: 2,
    validateInSandbox: scriptedValidator(script),
    repairCandidate: async ({ iteration }) => ({
      candidate: candidate({ ref: digestRef(`candidate-${iteration}`, iteration === 1 ? "4" : "6") })
    }),
    seqStart: 3,
    ts: "2026-07-02T00:00:00.000Z"
  });

  assert.equal(result.outcome, "certified");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["gen.ValidationFailed", "gen.Repaired", "gen.Validated", "gen.Certified"]
  );
  assert.equal(result.repairAttempts, 1);

  const eventLog = [...priorEvents(request, initial.ref), ...result.events];
  assert.deepEqual(replayForgeCertificationRun(eventLog), rebuildGenerationRun(eventLog));
});

test("Given forged conformance attachment When gate reruns in sandbox Then certification is refused with audit evidence", async () => {
  const forgedCandidate = candidate({
    attachedConformanceReport: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: true,
      digest: digest("f")
    }
  });

  const gate = runCertificationGate({
    candidate: forgedCandidate,
    sandboxRerun: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: true,
      digest: digest("a")
    },
    sandboxEvents: []
  });

  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failingAssertions, ["conformance.report_forged"]);
  assert.equal(gate.auditEvents[0].type, "conformance.ReportRejected");

  const result = await runForgeCertificationLoop({
    request: genRequest(),
    sandboxProfile: sandboxProfile(),
    initialCandidate: forgedCandidate,
    conformanceSuites: conformanceSuites(),
    maxRepairAttempts: 2,
    validateInSandbox: async () =>
      passValidation(forgedCandidate, "3", "a"),
    repairCandidate: async () => {
      throw new Error("repair must not run for forged report refusal");
    }
  });

  assert.equal(result.outcome, "refused");
  assert.equal(result.refusalReason, "conformance.report_forged");
  assert.equal(result.events.at(-1)?.type, "gen.SafetyRejected");
  assert.match(result.auditEvents[0].reason, /report_mismatch/);
});

test("Given forged pass digest When in-boundary sandbox rerun fails Then certification is refused with audit evidence", async () => {
  const forgedDigest = digest("a");
  const forgedCandidate = candidate({
    attachedConformanceReport: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: true,
      digest: forgedDigest
    }
  });

  const gate = runCertificationGate({
    candidate: forgedCandidate,
    sandboxRerun: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: false,
      digest: forgedDigest
    },
    sandboxEvents: []
  });

  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failingAssertions, ["conformance.report_forged"]);
  assert.equal(gate.auditEvents[0].type, "conformance.ReportRejected");
  assert.equal(gate.auditEvents[0].reason, "conformance.in_boundary_rerun_failed");

  const result = await runForgeCertificationLoop({
    request: genRequest(),
    sandboxProfile: sandboxProfile(),
    initialCandidate: forgedCandidate,
    conformanceSuites: conformanceSuites(),
    maxRepairAttempts: 2,
    validateInSandbox: async () => ({
      ...passValidation(forgedCandidate, "3"),
      sandboxRerun: {
        suiteId: "conformance.provider.database@0.1.0",
        passed: false,
        digest: forgedDigest
      }
    }),
    repairCandidate: async () => {
      throw new Error("repair must not run for in-boundary rerun failure");
    }
  });

  assert.equal(result.outcome, "refused");
  assert.equal(result.refusalReason, "conformance.report_forged");
  assert.equal(result.events.at(-1)?.type, "gen.SafetyRejected");
  assert.equal(result.auditEvents[0].reason, "conformance.in_boundary_rerun_failed");
});

test("Given undeclared egress attempt When sandbox blocks escape Then certification is refused with auditable evidence", async () => {
  const egressCandidate = candidate();
  const escapeEvent = {
    type: "sandbox.EscapeAttemptBlocked",
    runId: "forge-cert-1-attempt-0",
    profileDigest: digest("b"),
    attempt: {
      kind: "network",
      target: "https://attacker.example/exfiltrate",
      decision: "denied"
    }
  };

  const gate = runCertificationGate({
    candidate: egressCandidate,
    sandboxRerun: {
      suiteId: "conformance.provider.database@0.1.0",
      passed: true,
      digest: hex(10)
    },
    sandboxEvents: [escapeEvent]
  });

  assert.equal(gate.ok, false);
  assert.deepEqual(gate.failingAssertions, ["sandbox.undeclared_egress"]);
  assert.equal(gate.auditEvents[0].type, "sandbox.EgressDenied");

  const result = await runForgeCertificationLoop({
    request: genRequest(),
    sandboxProfile: sandboxProfile(),
    initialCandidate: egressCandidate,
    conformanceSuites: conformanceSuites(),
    maxRepairAttempts: 2,
    validateInSandbox: async () => ({
      ...passValidation(egressCandidate, "3"),
      sandboxEvents: [escapeEvent]
    }),
    repairCandidate: async () => {
      throw new Error("repair must not run for egress refusal");
    }
  });

  assert.equal(result.outcome, "refused");
  assert.equal(result.refusalReason, "sandbox.undeclared_egress");
  assert.equal(result.events.at(-1)?.type, "gen.SafetyRejected");
  assert.equal(result.auditEvents[0].type, "sandbox.EgressDenied");
});

test("Given oscillating repair When budget exhausts Then one gen.NeedsHuman is emitted", async () => {
  const initial = candidate({ ref: digestRef("candidate-0", "2") });
  const script = [
    failValidation(initial, "3", ["trace.replay.mismatch"]),
    failValidation(candidate({ ref: digestRef("candidate-1", "4") }), "5", ["trace.replay.mismatch"]),
    failValidation(initial, "7", ["trace.replay.mismatch"])
  ];

  const result = await runForgeCertificationLoop({
    request: genRequest(),
    sandboxProfile: sandboxProfile(),
    initialCandidate: initial,
    conformanceSuites: conformanceSuites(),
    maxRepairAttempts: 2,
    validateInSandbox: scriptedValidator(script),
    repairCandidate: async ({ iteration }) => ({
      candidate: candidate({ ref: digestRef(`candidate-${iteration}`, iteration === 1 ? "4" : "2") })
    }),
    seqStart: 3
  });

  assert.equal(result.outcome, "needs-human");
  assert.equal(result.events.filter((event) => event.type === "gen.NeedsHuman").length, 1);
  assert.equal(result.events.filter((event) => event.type === "gen.Repaired").length, 2);
});

test("invalid repair budget fails closed before the loop runs", async () => {
  await assert.rejects(
    () =>
      runForgeCertificationLoop({
        request: genRequest(),
        sandboxProfile: sandboxProfile(),
        initialCandidate: candidate(),
        conformanceSuites: conformanceSuites(),
        maxRepairAttempts: 0,
        validateInSandbox: async () => passValidation(candidate()),
        repairCandidate: async () => ({ candidate: candidate() })
      }),
    (error) => error instanceof ForgeCertificationLoopError && error.code === "forge.budget"
  );
});

function scriptedValidator(script) {
  const remaining = [...script];
  return async () => {
    assert.ok(remaining.length > 0, "validation script exhausted");
    return remaining.shift();
  };
}

function priorEvents(request = genRequest(), candidateRef = digestRef("candidate-0", "2")) {
  return [
    envelope(1, "gen.Requested", request),
    envelope(2, "gen.CandidateGenerated", {
      requestId: request.requestId,
      candidateRef,
      iteration: 0
    })
  ].map(validateGenerationEvent);
}

function envelope(seq, type, data) {
  return {
    id: `01JFORGE${seq}`,
    type,
    v: 1,
    streamId: "forge:forge-cert-1",
    seq,
    ts: `2026-07-02T00:00:0${seq}.000Z`,
    actor: { kind: "agent", id: "agent:forge-certification-loop" },
    tenant: "tenant:demo",
    correlationId: "forge-cert-1",
    data
  };
}
