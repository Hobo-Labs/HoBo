import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  GOVERNANCE_DIMENSIONS,
  GOVERNANCE_TRACEABILITY_REQUIREMENTS,
  createGovernanceConformanceFixture,
  createGovernanceGoldenReplayCorpus,
  evaluateGovernanceConformance,
  replayGovernanceDecisionLog,
  validateGovernanceTraceability,
  verifyGovernanceGoldenReplayCorpus,
} from "../src/governance-conformance-suite.js";

describe("governance conformance suite contract", () => {
  it("passes the composite hobo verify decision only when every governance dimension passes", () => {
    const result = evaluateGovernanceConformance(createGovernanceConformanceFixture());

    assert.equal(result.deployable, true);
    assert.equal(result.decision.effect, "allow");
    assert.equal(result.decision.reason, "all-governance-gates-passed");
    assert.deepEqual(result.blockedBy, []);
    assert.deepEqual(result.coverage.passedDimensions, GOVERNANCE_DIMENSIONS);
    assert.deepEqual(result.coverage.missingDimensions, []);
    assert.ok(result.events.some((event) => event.type === "policy.Decided"));
    assert.equal(result.events.at(-1).type, "governance.CompositeDecided");
    assert.equal(result.events.at(-1).data.deployable, true);
  });

  it("blocks with a precise reason for each single failing governance dimension", () => {
    for (const dimension of GOVERNANCE_DIMENSIONS) {
      const result = evaluateGovernanceConformance(fixtureWithGateFailure(dimension));

      assert.equal(result.deployable, false, dimension);
      assert.equal(result.decision.effect, "deny", dimension);
      assert.deepEqual(result.blockedBy, [
        {
          dimension,
          reason: `${dimension} failed its conformance proof`,
        },
      ]);
      assert.ok(
        result.events.some(
          (event) =>
            event.type === "governance.GateResultRecorded" &&
            event.data.dimension === dimension &&
            event.data.status === "fail",
        ),
        dimension,
      );
    }
  });

  it("does not pass partial gate success as a composite decision", () => {
    const result = evaluateGovernanceConformance(fixtureWithGateFailure("policy"));

    assert.equal(result.deployable, false);
    assert.equal(result.coverage.passedDimensions.length, GOVERNANCE_DIMENSIONS.length - 1);
    assert.deepEqual(result.coverage.failedDimensions, ["policy"]);
  });

  it("blocks absent cross-team gate results instead of skipping them", () => {
    const fixture = createGovernanceConformanceFixture();
    fixture.gateResults = fixture.gateResults.filter((gate) => gate.dimension !== "quota");

    const result = evaluateGovernanceConformance(fixture);

    assert.equal(result.deployable, false);
    assert.deepEqual(result.blockedBy, [
      {
        dimension: "quota",
        reason: "absent-cross-team-gate-result: quota",
      },
    ]);
    assert.deepEqual(result.coverage.missingDimensions, ["quota"]);
    assert.ok(
      result.events.some(
        (event) =>
          event.type === "governance.GateResultRecorded" &&
          event.data.dimension === "quota" &&
          event.data.status === "missing",
      ),
    );
  });

  it("replays the composite decision deterministically from the emitted decision log", () => {
    const result = evaluateGovernanceConformance(fixtureWithGateFailure("guardrail-coverage"));
    const replayed = replayGovernanceDecisionLog([...result.events].reverse());
    const replayedAgain = replayGovernanceDecisionLog(result.events);

    assert.equal(replayed.matchesRecordedDecision, true);
    assert.deepEqual(replayed.decision, result.decision);
    assert.deepEqual(replayedAgain, replayed);
  });

  it("matches a golden replay corpus for policy decision logs", () => {
    const corpus = createGovernanceGoldenReplayCorpus([
      {
        id: "all-green",
        fixture: createGovernanceConformanceFixture(),
      },
      {
        id: "unsigned-attestation-block",
        fixture: fixtureWithGateFailure("signing"),
      },
    ]);

    const verified = verifyGovernanceGoldenReplayCorpus(corpus);

    assert.equal(verified.ok, true);
    assert.deepEqual(
      verified.results.map((result) => [result.id, result.matches]),
      [
        ["all-green", true],
        ["unsigned-attestation-block", true],
      ],
    );
  });

  it("validates that every governance Plan and ADR is covered or explicitly scoped out", () => {
    const result = validateGovernanceTraceability(governanceTraceabilityFixture());

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.requiredIds,
      GOVERNANCE_TRACEABILITY_REQUIREMENTS,
    );
    assert.ok(result.covered.some((entry) => entry.id === "PLAN-29" && entry.issueIds.includes("HOBO-227")));
    assert.ok(
      result.scopedOut.some(
        (entry) => entry.id === "ADR-0044" && entry.deferredTo === "Progressive Delivery",
      ),
    );
  });

  it("flags an ADR decision with no mapped slice", () => {
    const traceability = governanceTraceabilityFixture();
    delete traceability.records["ADR-0061"];

    const result = validateGovernanceTraceability(traceability);

    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, [
      {
        id: "ADR-0061",
        reason: "no traceability record",
      },
    ]);
  });
});

function fixtureWithGateFailure(dimension) {
  const fixture = createGovernanceConformanceFixture();
  fixture.gateResults = fixture.gateResults.map((gate) =>
    gate.dimension === dimension
      ? {
          ...gate,
          status: "fail",
          reason: `${dimension} failed its conformance proof`,
        }
      : gate,
  );
  return fixture;
}

function governanceTraceabilityFixture() {
  return {
    records: {
      "PLAN-29": {
        issueIds: ["HOBO-146", "HOBO-175", "HOBO-183", "HOBO-187", "HOBO-227"],
        proof: "docs/design/proofs/hobo-227-governance-conformance/README.md",
      },
      "PLAN-46": {
        issueIds: ["HOBO-183", "HOBO-227"],
        proof: "docs/design/proofs/hobo-227-governance-conformance/README.md",
      },
      "ADR-0015": {
        issueIds: ["HOBO-146", "HOBO-227"],
        proof: "src/draft/technical-proofs/governance-conformance-suite-contract",
      },
      "ADR-0044": {
        issueIds: ["HOBO-179", "HOBO-303", "HOBO-384"],
        outOfScope: {
          deferredTo: "Progressive Delivery",
          reason: "HOBO-227 consumes flag and rollout gate results; rollout engines remain owned by Harness slices.",
        },
      },
      "ADR-0046": {
        issueIds: ["HOBO-175", "HOBO-282", "HOBO-349", "HOBO-227"],
        proof: "policy decision log replay emits OCSF-exportable policy.Decided facts",
      },
      "ADR-0060": {
        issueIds: ["HOBO-183", "HOBO-227"],
        proof: "residency dimension blocks the composite decision",
      },
      "ADR-0061": {
        issueIds: ["HOBO-146", "HOBO-227"],
        outOfScope: {
          deferredTo: "AI-safety",
          reason: "HOBO-227 requires guardrail coverage evidence but does not implement guardrail engines.",
        },
      },
      "ADR-0074": {
        issueIds: ["HOBO-196", "HOBO-223", "HOBO-227"],
        proof: "mandatory policy and signed decision logs are required gate inputs",
      },
    },
  };
}
