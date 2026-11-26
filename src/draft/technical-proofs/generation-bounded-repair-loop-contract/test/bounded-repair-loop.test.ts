import assert from "node:assert/strict";
import { test } from "vitest";

import {
  rebuildGenerationRun,
  validateGenerationEvent
} from "../../generation-pipeline-io-contract/src/contract.js";
import {
  RepairLoopContractError,
  replayBoundedRepairRun,
  runBoundedRepairLoop
} from "../src/bounded-repair-loop.js";

const digest = (char) => `sha256:${char.repeat(64)}`;

function digestRef(name, char) {
  return {
    uri: `draft://generation-repair/${name}@${digest(char)}`,
    digest: digest(char)
  };
}

function genRequest(overrides = {}) {
  return {
    schema: "hobo.gen.request/v1",
    requestId: "gen-repair-1",
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

test("converges within the repair budget and keeps gen.Repaired evidence replayable", async () => {
  const request = genRequest();
  const initialCandidateRef = digestRef("candidate-0", "2");
  const validationScript = [
    failure(initialCandidateRef, "3", ["trace.replay.mismatch"]),
    failure(digestRef("candidate-1", "4"), "5", ["contract.assertion.failed"]),
    pass(digestRef("candidate-2", "6"), "7")
  ];

  const result = await runBoundedRepairLoop({
    request,
    initialCandidateRef,
    maxRepairAttempts: 2,
    validateCandidate: scriptedValidator(validationScript),
    regenerateCandidate: async ({ iteration }) => ({
      candidateRef: digestRef(`candidate-${iteration}`, iteration === 1 ? "4" : "6")
    }),
    seqStart: 3,
    ts: "2026-06-25T19:00:00.000Z"
  });

  assert.equal(result.outcome, "converged");
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "gen.ValidationFailed",
      "gen.Repaired",
      "gen.ValidationFailed",
      "gen.Repaired",
      "gen.Validated"
    ]
  );
  assert.deepEqual(
    result.events
      .filter((event) => event.type === "gen.Repaired")
      .map((event) => ({
        iteration: event.data.iteration,
        failingAssertions: event.data.failingAssertions
      })),
    [
      { iteration: 1, failingAssertions: ["trace.replay.mismatch"] },
      { iteration: 2, failingAssertions: ["contract.assertion.failed"] }
    ]
  );

  const eventLog = [...priorEvents(request, initialCandidateRef), ...result.events];
  assert.deepEqual(replayBoundedRepairRun(eventLog), rebuildGenerationRun(eventLog));
});

test("terminates an oscillating candidate at the budget with one gen.NeedsHuman", async () => {
  const request = genRequest();
  const initialCandidateRef = digestRef("candidate-0", "2");
  const regeneratedRefs = [digestRef("candidate-a", "4"), initialCandidateRef];
  const validationScript = [
    failure(initialCandidateRef, "3", ["trace.replay.mismatch"]),
    failure(regeneratedRefs[0], "5", ["conformance.assertion.failed"]),
    failure(initialCandidateRef, "7", ["trace.replay.mismatch"])
  ];
  const regenerateCalls = [];

  const result = await runBoundedRepairLoop({
    request,
    initialCandidateRef,
    maxRepairAttempts: 2,
    validateCandidate: scriptedValidator(validationScript),
    regenerateCandidate: async (input) => {
      regenerateCalls.push(input);
      return { candidateRef: regeneratedRefs[input.iteration - 1] };
    },
    seqStart: 3
  });

  assert.equal(result.outcome, "needs-human");
  assert.equal(result.events.filter((event) => event.type === "gen.NeedsHuman").length, 1);
  assert.equal(result.events.filter((event) => event.type === "gen.Repaired").length, 2);
  assert.equal(regenerateCalls.length, 2);
  assert.deepEqual(result.finalEvent.data, {
    requestId: "gen-repair-1",
    reason: "repair-budget-exhausted",
    budgetExhausted: true,
    failingAssertions: ["trace.replay.mismatch"]
  });
});

test("repair budget is per-run and cannot be disabled by request payload", async () => {
  const request = genRequest({
    repairBudget: {
      disabled: true,
      maxRepairAttempts: 99
    }
  });

  const result = await runBoundedRepairLoop({
    request,
    initialCandidateRef: digestRef("candidate-0", "2"),
    maxRepairAttempts: 1,
    validateCandidate: scriptedValidator([
      failure(digestRef("candidate-0", "2"), "3", ["trace.replay.mismatch"]),
      failure(digestRef("candidate-1", "4"), "5", ["trace.replay.mismatch"])
    ]),
    regenerateCandidate: async () => ({ candidateRef: digestRef("candidate-1", "4") }),
    seqStart: 3
  });

  assert.equal(result.outcome, "needs-human");
  assert.equal(result.events.filter((event) => event.type === "gen.Repaired").length, 1);
  assert.equal(result.events.filter((event) => event.type === "gen.NeedsHuman").length, 1);
});

test("invalid configured budgets fail closed before the loop can run", async () => {
  await assert.rejects(
    () =>
      runBoundedRepairLoop({
        request: genRequest(),
        initialCandidateRef: digestRef("candidate-0", "2"),
        maxRepairAttempts: 0,
        validateCandidate: async () => pass(digestRef("candidate-0", "2"), "3"),
        regenerateCandidate: async () => ({ candidateRef: digestRef("candidate-1", "4") })
      }),
    (error) => error instanceof RepairLoopContractError && error.code === "repair.budget"
  );
});

function pass(candidateRef, reportChar) {
  return {
    passed: true,
    candidateRef,
    validationReportRef: digestRef("validation-report", reportChar)
  };
}

function failure(candidateRef, reportChar, failingAssertions) {
  return {
    passed: false,
    candidateRef,
    validationReportRef: digestRef("validation-report", reportChar),
    failingAssertions
  };
}

function scriptedValidator(script) {
  const remaining = [...script];
  return async () => {
    assert.ok(remaining.length > 0, "validation script exhausted");
    return remaining.shift();
  };
}

function envelope(seq, type, data) {
  return {
    id: `01JREPAIR${seq}`,
    type,
    v: 1,
    streamId: "generation:gen-repair-1",
    seq,
    ts: `2026-06-25T19:00:0${seq}.000Z`,
    actor: {
      kind: "agent",
      id: "agent:generation-repair-loop"
    },
    tenant: "tenant:demo",
    correlationId: "gen-repair-1",
    data
  };
}
