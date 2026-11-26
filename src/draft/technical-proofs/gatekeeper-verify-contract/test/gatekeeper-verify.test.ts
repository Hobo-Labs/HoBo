import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  evaluateGatekeeper,
  replayGatekeeperDecision,
  runHoboVerifyCommand,
} from "../src/gatekeeper-verify.js";

const REQUIRED_GATES = [
  "contracts",
  "policy",
  "eval",
  "conformance",
  "cost",
  "signing",
  "golden-suite",
  "deployment-plan",
];

describe("Gatekeeper hobo verify composition", () => {
  it("returns deployable when every required gate engine reports green", () => {
    const decision = evaluateGatekeeper({
      target: "prod",
      request: verifyRequest(),
      engines: greenEngines(),
    });

    assert.equal(decision.deployable, true);
    assert.equal(decision.status, "deployable");
    assert.equal(decision.failures.length, 0);
    assert.deepEqual(
      decision.results.map((result) => result.gate),
      REQUIRED_GATES,
    );
    assert.equal(decision.events.filter((event) => event.type === "gatekeeper.GatePassed").length, 8);
    assert.equal(decision.events.at(-1).type, "gatekeeper.VerifyPassed");
    assert.deepEqual(replayGatekeeperDecision(decision.events), decision);
  });

  it("blocks on a single failing gate with the engine-owned reason and suggested fix", () => {
    const decision = evaluateGatekeeper({
      target: "prod",
      request: verifyRequest(),
      engines: {
        ...greenEngines(),
        contracts: gateEngine({
          gate: "contracts",
          ok: false,
          reason: "api@1.8.0 breaks worker@1.4.2",
          suggestedFixes: ["deploy worker@1.5.0 first"],
        }),
      },
    });

    assert.equal(decision.deployable, false);
    assert.equal(decision.status, "blocked");
    assert.deepEqual(decision.failures, [
      {
        gate: "contracts",
        ok: false,
        reason: "api@1.8.0 breaks worker@1.4.2",
        suggestedFixes: ["deploy worker@1.5.0 first"],
        engineId: "engine/contracts",
      },
    ]);
    assert.ok(decision.suggestedFixes.includes("deploy worker@1.5.0 first"));
    assert.equal(decision.events.find((event) => event.gate === "contracts").type, "gatekeeper.GateFailed");
    assert.deepEqual(replayGatekeeperDecision(decision.events), decision);
  });

  it("adds a remediation hint when a failing engine omits suggested fixes", () => {
    const decision = evaluateGatekeeper({
      target: "prod",
      request: verifyRequest(),
      engines: {
        ...greenEngines(),
        eval: gateEngine({
          gate: "eval",
          ok: false,
          reason: "p95 latency regression exceeds threshold",
          suggestedFixes: undefined,
        }),
      },
    });

    assert.equal(decision.deployable, false);
    assert.deepEqual(decision.failures[0].suggestedFixes, [
      "resolve eval failure: p95 latency regression exceeds threshold",
    ]);
  });

  it("fails closed when a required gate result is missing or an engine throws", () => {
    const missing = evaluateGatekeeper({
      target: "prod",
      request: verifyRequest(),
      engines: omit(greenEngines(), "signing"),
    });

    assert.equal(missing.deployable, false);
    assert.equal(missing.failures[0].gate, "signing");
    assert.equal(missing.failures[0].reason, "missing gate engine result");

    const errored = evaluateGatekeeper({
      target: "prod",
      request: verifyRequest(),
      engines: {
        ...greenEngines(),
        conformance: () => {
          throw new Error("suite timed out");
        },
      },
    });

    assert.equal(errored.deployable, false);
    assert.equal(errored.failures[0].gate, "conformance");
    assert.equal(errored.failures[0].reason, "gate engine error: suite timed out");
  });

  it("ignores caller-supplied gateResults and only trusts engine-owned outputs", () => {
    const decision = evaluateGatekeeper({
      target: "prod",
      request: {
        ...verifyRequest(),
        gateResults: REQUIRED_GATES.map((gate) => ({ gate, ok: true })),
      },
      engines: {
        ...greenEngines(),
        cost: gateEngine({
          gate: "cost",
          ok: false,
          reason: "projected spend exceeds hard budget",
          suggestedFixes: ["request spend approval"],
        }),
      },
    });

    assert.equal(decision.deployable, false);
    assert.equal(decision.failures[0].gate, "cost");
    assert.equal(decision.failures[0].reason, "projected spend exceeds hard budget");
  });

  it("blocks prod when a deny-ceiling makes the golden suite mandatory and the request disables it", () => {
    const decision = evaluateGatekeeper({
      target: "prod",
      request: verifyRequest({ disabledGates: ["golden-suite"] }),
      engines: greenEngines(),
      policy: {
        mandatoryGatesByTarget: {
          prod: ["golden-suite"],
        },
      },
    });

    assert.equal(decision.deployable, false);
    assert.deepEqual(decision.failures[0], {
      gate: "golden-suite",
      ok: false,
      reason: "mandatory deny-ceiling forbids disabling golden-suite in prod",
      suggestedFixes: ["remove disabledGates entry for golden-suite"],
      engineId: "gatekeeper/mandatory-gate",
    });
  });

  it("exempts incident remediation from burn-freeze only, not hard gates", () => {
    const decision = evaluateGatekeeper({
      target: "prod",
      request: verifyRequest({ incidentRemediation: true }),
      engines: {
        ...greenEngines(),
        "burn-freeze": gateEngine({
          gate: "burn-freeze",
          ok: false,
          reason: "error budget burn freeze active",
          suggestedFixes: ["wait for budget recovery"],
        }),
        policy: gateEngine({
          gate: "policy",
          ok: false,
          reason: "mandatory policy denies prod apply",
          suggestedFixes: ["request a time-boxed waiver"],
        }),
      },
    });

    const burnFreeze = decision.results.find((result) => result.gate === "burn-freeze");

    assert.equal(burnFreeze.ok, true);
    assert.equal(burnFreeze.exempted, true);
    assert.equal(decision.deployable, false);
    assert.deepEqual(decision.failures.map((failure) => failure.gate), ["policy"]);
  });

  it("returns a structured hobo verify command result for a target", () => {
    const result = runHoboVerifyCommand(["--target", "prod"], {
      request: verifyRequest(),
      engines: greenEngines(),
    });

    assert.equal(result.command, "hobo verify");
    assert.equal(result.target, "prod");
    assert.equal(result.exitCode, 0);
    assert.equal(result.decision.deployable, true);
  });
});

function verifyRequest(overrides = {}) {
  return {
    deploymentId: "deployment:checkout-prod",
    actor: "spiffe://tenant-a/yard/prod/agent/deployer",
    incidentRemediation: false,
    disabledGates: [],
    ...overrides,
  };
}

function greenEngines() {
  return Object.fromEntries(
    REQUIRED_GATES.map((gate) => [
      gate,
      gateEngine({
        gate,
        ok: true,
        reason: `${gate} passed`,
      }),
    ]),
  );
}

function gateEngine(result) {
  return () => ({
    suggestedFixes: [],
    engineId: `engine/${result.gate}`,
    ...result,
  });
}

function omit(source, key) {
  const copy = { ...source };
  delete copy[key];
  return copy;
}
