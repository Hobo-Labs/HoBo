/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased governance fixtures and recursive merge values at the contract boundary. */

import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const GOVERNANCE_DIMENSIONS = Object.freeze([
  "contracts",
  "policy",
  "obligations",
  "residency",
  "guardrail-coverage",
  "quota",
  "signing",
]);

export const GOVERNANCE_TRACEABILITY_REQUIREMENTS = Object.freeze([
  "PLAN-29",
  "PLAN-46",
  "ADR-0015",
  "ADR-0044",
  "ADR-0046",
  "ADR-0060",
  "ADR-0061",
  "ADR-0074",
]);

export const GOVERNANCE_CONFORMANCE_SUITE_ID = "hobo.verify/governance-conformance@0.1.0";

const PASS = "pass";
const MISSING = "missing";
const FIXED_RECORDED_AT = "2026-06-28T07:20:00.000Z";

export function createGovernanceConformanceFixture(overrides = {}) {
  return deepMerge(
    {
      id: "governance-conformance:checkout-prod",
      target: {
        command: "hobo verify",
        environment: "prod",
        deploymentId: "deployment:checkout-prod",
      },
      recordedAt: FIXED_RECORDED_AT,
      policyPackVersion: "governance-pack@2026.06.28",
      gateResults: GOVERNANCE_DIMENSIONS.map((dimension) => passingGateResult(dimension)),
    },
    overrides,
  );
}

export function evaluateGovernanceConformance(fixtureInput) {
  const fixture = normalizeFixture(fixtureInput);
  const gateResults = normalizeGateResults(fixture.gateResults);
  const gateResultByDimension = new Map(gateResults.map((gate) => [gate.dimension, gate]));
  const eventData = [];
  const blockedBy = [];
  const passedDimensions = [];
  const failedDimensions = [];
  const missingDimensions = [];

  for (const dimension of GOVERNANCE_DIMENSIONS) {
    const gate = gateResultByDimension.get(dimension);
    const recordedGate = gate ?? missingGateResult(dimension);
    eventData.push(recordedGate);

    if (!gate || gate.status === MISSING) {
      missingDimensions.push(dimension);
      blockedBy.push({
        dimension,
        reason: `absent-cross-team-gate-result: ${dimension}`,
      });
      continue;
    }

    if (gate.status !== PASS) {
      failedDimensions.push(dimension);
      blockedBy.push({
        dimension,
        reason: gate.reason ?? `${dimension} gate returned ${gate.status}`,
      });
      continue;
    }

    passedDimensions.push(dimension);
  }

  const deployable = blockedBy.length === 0;
  const decision = {
    effect: deployable ? "allow" : "deny",
    reason: deployable ? "all-governance-gates-passed" : "governance-composite-blocked",
    target: fixture.target,
    blockedBy,
    passedDimensions,
    evidence: {
      suite: GOVERNANCE_CONFORMANCE_SUITE_ID,
      policyPackVersion: fixture.policyPackVersion,
      requiredDimensions: GOVERNANCE_DIMENSIONS,
    },
  };

  const events = buildDecisionEvents({
    fixture,
    gateResults: eventData,
    decision,
    deployable,
  });

  return {
    suiteId: GOVERNANCE_CONFORMANCE_SUITE_ID,
    deployable,
    decision,
    blockedBy,
    coverage: {
      requiredDimensions: GOVERNANCE_DIMENSIONS,
      passedDimensions,
      failedDimensions,
      missingDimensions,
    },
    events,
  };
}

export function replayGovernanceDecisionLog(eventsInput) {
  if (!Array.isArray(eventsInput)) {
    throw new TypeError("events must be an array");
  }

  const events = [...eventsInput].sort((left, right) => left.seq - right.seq);
  const gateResults = events
    .filter((event) => event.type === "governance.GateResultRecorded")
    .map((event) => event.data);
  const composite = events.find((event) => event.type === "governance.CompositeDecided");
  const policyDecision = events.find((event) => event.type === "policy.Decided");

  const replayed = evaluateGovernanceConformance({
    id: composite?.data?.fixtureId ?? "governance-conformance:replay",
    target: composite?.data?.target ?? policyDecision?.data?.target ?? {},
    recordedAt: events[0]?.ts ?? FIXED_RECORDED_AT,
    policyPackVersion: policyDecision?.data?.policyPackVersion ?? "unknown",
    gateResults,
  });
  const recordedDecision = composite?.data?.decision ?? null;

  return {
    decision: replayed.decision,
    recordedDecision,
    matchesRecordedDecision: stableStringify(replayed.decision) === stableStringify(recordedDecision),
  };
}

export function createGovernanceGoldenReplayCorpus(cases) {
  if (!Array.isArray(cases)) {
    throw new TypeError("cases must be an array");
  }

  return cases.map((entry) => {
    const result = evaluateGovernanceConformance(entry.fixture);
    return {
      id: entry.id,
      events: result.events,
      expectedDecision: result.decision,
    };
  });
}

export function verifyGovernanceGoldenReplayCorpus(corpus) {
  if (!Array.isArray(corpus)) {
    throw new TypeError("corpus must be an array");
  }

  const results = corpus.map((entry) => {
    const replayed = replayGovernanceDecisionLog(entry.events);
    return {
      id: entry.id,
      matches:
        replayed.matchesRecordedDecision &&
        stableStringify(replayed.decision) === stableStringify(entry.expectedDecision),
    };
  });

  return {
    ok: results.every((result) => result.matches),
    results,
  };
}

export function validateGovernanceTraceability(traceabilityInput) {
  const records = traceabilityInput?.records ?? {};
  const covered = [];
  const scopedOut = [];
  const missing = [];

  for (const id of GOVERNANCE_TRACEABILITY_REQUIREMENTS) {
    const record = records[id];
    if (!record) {
      missing.push({ id, reason: "no traceability record" });
      continue;
    }

    const issueIds = Array.isArray(record.issueIds) ? unique(record.issueIds) : [];
    if (issueIds.length > 0) {
      covered.push({
        id,
        issueIds,
        proof: record.proof,
      });
    }

    if (record.outOfScope) {
      if (isNonEmptyString(record.outOfScope.deferredTo) && isNonEmptyString(record.outOfScope.reason)) {
        scopedOut.push({
          id,
          deferredTo: record.outOfScope.deferredTo,
          reason: record.outOfScope.reason,
        });
      } else {
        missing.push({ id, reason: "out-of-scope record needs deferredTo and reason" });
      }
    }

    if (issueIds.length === 0 && !record.outOfScope) {
      missing.push({ id, reason: "no mapped issue or out-of-scope marker" });
    }
  }

  return {
    ok: missing.length === 0,
    requiredIds: GOVERNANCE_TRACEABILITY_REQUIREMENTS,
    covered,
    scopedOut,
    missing,
  };
}

function passingGateResult(dimension) {
  return {
    dimension,
    status: PASS,
    reason: `${dimension} conformance proof passed`,
    evidence: {
      producer: producerForDimension(dimension),
      digest: `sha256:${createHash("sha256").update(dimension).digest("hex")}`,
    },
  };
}

function missingGateResult(dimension) {
  return {
    dimension,
    status: MISSING,
    reason: `absent-cross-team-gate-result: ${dimension}`,
    evidence: null,
  };
}

function normalizeFixture(fixture) {
  if (!fixture || !isJsonObject(fixture) || Array.isArray(fixture)) {
    throw new TypeError("fixture must be an object");
  }
  if (!isNonEmptyString(fixture.id)) {
    throw new TypeError("fixture.id must be a non-empty string");
  }
  if (!Array.isArray(fixture.gateResults)) {
    throw new TypeError("fixture.gateResults must be an array");
  }
  return fixture;
}

function normalizeGateResults(gateResults) {
  const seen = new Set();
  return gateResults.map((gate) => {
    if (!gate || !isJsonObject(gate) || Array.isArray(gate)) {
      throw new TypeError("gate result must be an object");
    }
    if (!GOVERNANCE_DIMENSIONS.includes(gate.dimension)) {
      throw new TypeError(`unknown governance dimension: ${gate.dimension}`);
    }
    if (seen.has(gate.dimension)) {
      throw new TypeError(`duplicate governance dimension: ${gate.dimension}`);
    }
    seen.add(gate.dimension);
    if (!isNonEmptyString(gate.status)) {
      throw new TypeError(`${gate.dimension}.status must be a non-empty string`);
    }
    return {
      dimension: gate.dimension,
      status: gate.status,
      reason: gate.reason,
      evidence: gate.evidence ?? null,
    };
  });
}

function buildDecisionEvents({ fixture, gateResults, decision, deployable }) {
  const events = [];
  let seq = 1;
  for (const gate of gateResults) {
    events.push(event(fixture, seq++, "governance.GateResultRecorded", gate));
  }
  events.push(
    event(fixture, seq++, "policy.Decided", {
      effect: decision.effect,
      reason: decision.reason,
      target: fixture.target,
      policyPackVersion: fixture.policyPackVersion,
      obligations: decision.blockedBy.length === 0 ? ["governance-release-approved"] : [],
      blockedBy: decision.blockedBy,
    }),
  );
  events.push(
    event(fixture, seq++, "governance.CompositeDecided", {
      fixtureId: fixture.id,
      deployable,
      target: fixture.target,
      decision,
    }),
  );
  return events;
}

function event(fixture, seq, type, data) {
  return {
    id: `${fixture.id}:${seq}`,
    seq,
    type,
    streamId: `governance:${fixture.id}`,
    ts: timestampFor(fixture.recordedAt, seq),
    data: structuredClone(data),
  };
}

function timestampFor(recordedAt, seq) {
  return new Date(Date.parse(recordedAt) + seq * 1000).toISOString();
}

function producerForDimension(dimension) {
  return {
    contracts: "contract-engine",
    policy: "policy-engine",
    obligations: "obligation-engine",
    residency: "data-governance-policy",
    "guardrail-coverage": "guardrail-conformance",
    quota: "budget-quota-policy",
    signing: "hobo-attestation",
  }[dimension];
}

function deepMerge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? structuredClone(base) : structuredClone(overrides);
  }
  if (!base || !isJsonObject(base)) {
    return overrides === undefined ? base : overrides;
  }

  const output = { ...structuredClone(base) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    output[key] = deepMerge(output[key], value);
  }
  return output;
}

function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObject(nested)]),
  );
}

function unique(values) {
  return [...new Set(values.filter(isNonEmptyString))];
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased governance fixtures and recursive merge values at the contract boundary. */
