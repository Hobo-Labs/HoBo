import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createFakeIdentity,
  createFakeProvider,
  replayImportedSeedLog,
  runHoboYardUp,
} from "../src/self-host-bootstrap-saga.js";

describe("self-host bootstrap saga contract", () => {
  it("self-deploys the Yard Bindle and retires the seed credential after Identity handover", () => {
    const provider = createFakeProvider();
    const identity = createFakeIdentity({ federated: true });

    const result = runHoboYardUp(baseInput({ provider, identity }));

    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.events.map((event) => event.type),
      [
        "bootstrap.AttemptStarted",
        "seed.Started",
        "artifact.BundleVerified",
        "identity.SeedTokenUsed",
        "delta.Opened",
        "resource.Provisioning",
        "resource.Provisioned",
        "seedLog.Imported",
        "identity.Issued",
        "token.Revoked",
        "seed.Discarded",
        "bootstrap.Completed",
      ],
    );
    assert.deepEqual(
      provider.calls.map((call) => call.kind),
      ["plan", "reconcile"],
    );
    assert.equal(result.events.find((event) => event.type === "identity.SeedTokenUsed").data.scope, "bootstrap-apply:yard-prod:camp-prod");
    assert.equal(result.handover.seedCredentialRetired, true);
    assert.equal(result.handover.brokeredByRealIdentity, true);
  });

  it("imports the seed log as replayable provenance and no-ops the same completed attempt", () => {
    const result = runHoboYardUp(baseInput());
    const replay = replayImportedSeedLog(result.realYard.importedSeedLog);

    assert.equal(replay.attemptId, "attempt-001");
    assert.equal(replay.seedTokenAudited, true);
    assert.equal(replay.liveCommandReplay, false);
    assert.deepEqual(replay.provisionedResources, ["yard-gateway", "yard-identity", "yard-event-store"]);

    const rerun = runHoboYardUp(baseInput({ previousEvents: result.allEvents }));

    assert.equal(rerun.status, "noop");
    assert.deepEqual(rerun.events, []);
  });

  it("resumes after the seed crashes after infra is provisioned but before handover", () => {
    const provider = createFakeProvider();
    const first = runHoboYardUp(
      baseInput({
        provider,
        identity: createFakeIdentity({ federated: true }),
        crashAfterEvent: "resource.Provisioned",
      }),
    );

    assert.equal(first.status, "interrupted");
    assert.equal(provider.calls.filter((call) => call.kind === "reconcile").length, 1);
    assert.ok(first.events.some((event) => event.type === "resource.Provisioned"));
    assert.ok(!first.events.some((event) => event.type === "seedLog.Imported"));

    const resumed = runHoboYardUp(
      baseInput({
        provider,
        identity: createFakeIdentity({ federated: true }),
        previousEvents: first.allEvents,
        targetState: first.targetState,
      }),
    );

    assert.equal(resumed.status, "completed");
    assert.equal(provider.calls.filter((call) => call.kind === "reconcile").length, 1);
    assert.ok(!resumed.events.some((event) => event.type === "identity.SeedTokenUsed"));
    assert.ok(resumed.events.some((event) => event.type === "seedLog.Imported"));
    assert.ok(resumed.events.some((event) => event.type === "bootstrap.Completed"));
  });

  it("blocks handover before real Identity is federated and does not retire the seed credential", () => {
    const result = runHoboYardUp(baseInput({ identity: createFakeIdentity({ federated: false }) }));

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "identity-not-federated");
    assert.ok(result.events.some((event) => event.type === "resource.Provisioned"));
    assert.ok(result.events.some((event) => event.type === "seedLog.Imported"));
    assert.ok(result.events.some((event) => event.type === "bootstrap.Blocked"));
    assert.ok(!result.events.some((event) => event.type === "token.Revoked"));
    assert.ok(!result.events.some((event) => event.type === "seed.Discarded"));
    assert.equal(result.handover.seedCredentialRetired, false);
  });

  it("fails closed when the operator credential expires mid-apply", () => {
    const provider = createFakeProvider({ expireCredentialDuringApply: true });
    const result = runHoboYardUp(baseInput({ provider, identity: createFakeIdentity({ federated: true }) }));

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "operator-credential-expired-mid-apply");
    assert.equal(result.retry.requiresOperatorRelogin, true);
    assert.ok(result.events.some((event) => event.type === "identity.SeedTokenUsed"));
    assert.ok(result.events.some((event) => event.type === "resource.Provisioning"));
    assert.ok(!result.events.some((event) => event.type === "resource.Provisioned"));
    assert.ok(!result.events.some((event) => event.type === "token.Refreshed"));
    assert.ok(!provider.calls.some((call) => call.kind === "refresh-token"));
  });

  it("keeps air-gapped self-deploy inside the boundary with zero egress", () => {
    const provider = createFakeProvider();
    const result = runHoboYardUp(
      baseInput({
        mode: "airgap",
        provider,
        identity: createFakeIdentity({ federated: true }),
        offlineBundleDigest: "sha256:yard-bindle",
        inBoundaryTrustRoot: "trust-root-local",
      }),
    );

    assert.equal(result.status, "completed");
    assert.equal(result.events.find((event) => event.type === "artifact.BundleVerified").data.mode, "airgap");
    assert.deepEqual(result.egressAttempts, []);
    assert.ok(provider.calls.every((call) => call.egress === false));
    assert.equal(result.realYard.importedSeedLog.airGapped, true);
  });

  it("blocks a different second bootstrap lineage for the same target", () => {
    const first = runHoboYardUp(baseInput());
    const provider = createFakeProvider();
    const second = runHoboYardUp(
      baseInput({
        attemptId: "attempt-002",
        provider,
        previousEvents: first.allEvents,
        targetState: first.targetState,
      }),
    );

    assert.equal(second.status, "blocked");
    assert.equal(second.reason, "target-yard-already-has-a-different-bootstrap-attempt");
    assert.deepEqual(provider.calls, []);
    assert.ok(second.events.some((event) => event.type === "bootstrap.Blocked"));
  });
});

function baseInput(overrides = {}) {
  return {
    attemptId: "attempt-001",
    targetYard: "yard-prod",
    targetCamp: "camp-prod",
    operatorCredential: {
      id: "cred-001",
      subject: "spiffe://operator/alice",
      expiresAt: "2026-06-27T20:30:00.000Z",
    },
    now: "2026-06-27T19:30:00.000Z",
    provider: createFakeProvider(),
    identity: createFakeIdentity({ federated: true }),
    ...overrides,
  };
}
