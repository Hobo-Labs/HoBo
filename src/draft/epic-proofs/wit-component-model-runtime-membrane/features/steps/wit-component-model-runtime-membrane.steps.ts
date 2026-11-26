/**
 * Executable step definitions for wit-component-model-runtime-membrane.feature.
 *
 * Drives the epic's real reference service (services/wit-runtime-reference.ts)
 * scenario runners over the committed fixture — runtime-local checkout,
 * cross-host membrane, SDK conformance, and host upgrade — plus the pact
 * boundary verification. All boundaries mocked; no live hosts.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  CONTRACT_BOUNDARIES,
  loadMembraneFixture,
  runMembraneReferenceSimulation,
  verifyPactContracts,
} from "../../services/wit-runtime-reference.js";

type MembraneRun = Awaited<ReturnType<typeof runMembraneReferenceSimulation>>;

type MembraneWorld = {
  scenarioId?: string;
  run?: MembraneRun;
};

const world: MembraneWorld = {};

function eventTypes(run: MembraneRun): string[] {
  return run.events.map((event: { type: string }) => event.type);
}

function failureCodes(run: MembraneRun): string[] {
  return run.failures.map((failure: { code: string }) => failure.code);
}

// --- Scenario: Runtime-local checkout records durable effects ----------------

Given("a Bindle importing pinned WIT runtime and capability ports", async () => {
  world.scenarioId = "runtimeLocalCheckout";
  const fixture = await loadMembraneFixture();
  assert.ok(fixture.scenarios.runtimeLocalCheckout, "the checkout scenario fixture exists");
});

When("the runtime-local Camp executes the checkout membrane scenario", async () => {
  world.run = await runMembraneReferenceSimulation("runtimeLocalCheckout");
});

Then(
  "EventStore, ActorHost, Queue, and Streamer membrane effects are recorded durably",
  () => {
    const run = world.run;
    assert.ok(run, "the checkout scenario must have run");
    assert.equal(run.status, "completed");
    const types = eventTypes(run);
    for (const effect of [
      "runtime.EventAppended",
      "runtime.ActorStateAppended",
      "runtime.QueueHandled",
      "runtime.StreamFrameWritten",
    ]) {
      assert.ok(types.includes(effect), `durable effect ${effect} is recorded`);
    }
    assert.ok(types.includes("wit.PinVerified"), "the WIT pin is verified first");
    assert.deepEqual(run.failures, [], "the happy-path checkout has no failures");
  },
);

Then("the membrane scenario makes no Yard data-path call", () => {
  const run = world.run;
  assert.ok(run);
  assert.deepEqual(run.liveNetworkCalls, []);
  assert.ok(
    run.boundaries.every((boundary: { mocked: boolean }) => boundary.mocked),
    "every crossed boundary is a mocked pact seam",
  );
});

// --- Scenario: Cross-host membrane refuses unsafe links ----------------------

Given("caller and provider components negotiating WIT and wRPC versions", () => {
  world.scenarioId = "crossHostMembrane";
});

When(
  "the cross-host membrane scenario exercises the link floor, deadline, and backpressure",
  async () => {
    world.run = await runMembraneReferenceSimulation("crossHostMembrane");
  },
);

Then("the membrane returns typed link failures before the provider is trusted", () => {
  const run = world.run;
  assert.ok(run, "the cross-host scenario must have run");
  assert.equal(run.status, "link_blocked_then_recovered");
  const codes = failureCodes(run);
  assert.deepEqual(codes, [
    "wire-version-below-floor",
    "deadline-exceeded",
    "membrane-overloaded",
  ]);
  const types = eventTypes(run);
  assert.ok(
    types.indexOf("link.Rejected") < types.indexOf("link.Established"),
    "the unsafe link is rejected before any link is established",
  );
});

Then("the cross-host link recovers only through the lattice's linked-only route", () => {
  const run = world.run;
  assert.ok(run);
  const crossHostCall = run.events.find(
    (event: { type: string }) => event.type === "lattice.CrossHostCalled",
  );
  assert.ok(crossHostCall, "the recovered link performs a lattice cross-host call");
  assert.equal(crossHostCall.detail.route, "linked-only");
});

// --- Scenario: SDK parity and websocket fan-out stay deny-by-default ---------

Given("a generated SDK idiom layer and a websocket extension over Streamer", () => {
  world.scenarioId = "sdkConformance";
});

When("the SDK conformance membrane scenario runs with drifted grants", async () => {
  world.run = await runMembraneReferenceSimulation("sdkConformance");
});

Then(
  "the membrane denies the missing capability grant and fails the semantics annex vector",
  () => {
    const run = world.run;
    assert.ok(run, "the SDK conformance scenario must have run");
    assert.equal(run.status, "certified_with_denials");
    const codes = failureCodes(run);
    assert.ok(codes.includes("grant-missing"), "the missing grant is denied");
    assert.ok(codes.includes("semantics-annex-failed"), "the parity drift is failed");
    const denial = run.events.find(
      (event: { type: string }) => event.type === "capability.GrantDenied",
    );
    assert.equal(denial?.detail.capability, "wasi:blobstore");
    assert.ok(
      eventTypes(run).includes("websocket.FrameFannedOut"),
      "the websocket extension still fans out over Streamer",
    );
  },
);

// --- Scenario: Host upgrades require conformance and upcaster evidence -------

Given("a component-host manifest pin and a candidate host adapter", () => {
  world.scenarioId = "hostUpgrade";
});

When("the membrane host-upgrade gate evaluates the candidate", async () => {
  world.run = await runMembraneReferenceSimulation("hostUpgrade");
});

Then(
  "the upgrade is blocked until upcaster evidence passes and the manifest is repinned",
  () => {
    const run = world.run;
    assert.ok(run, "the host-upgrade scenario must have run");
    assert.equal(run.status, "upgrade_ready_after_gate");
    assert.deepEqual(failureCodes(run), ["missing-upcaster"]);
    const types = eventTypes(run);
    assert.ok(
      types.indexOf("componentHost.UpgradeBlocked") <
        types.indexOf("componentHost.ManifestRepinned"),
      "the upgrade blocks before the manifest is repinned",
    );
    assert.ok(
      types.indexOf("componentHost.UpcasterEvidenceAccepted") <
        types.indexOf("componentHost.ManifestRepinned"),
      "upcaster evidence is accepted before repinning",
    );
  },
);

Then("every membrane pact boundary stays consumer-tested", async () => {
  const verification = await verifyPactContracts();
  assert.equal(verification.status, "verified");
  assert.equal(verification.boundaries.length, CONTRACT_BOUNDARIES.length);
  assert.ok(
    verification.boundaries.every(
      (boundary: { status: string }) => boundary.status === "consumer_tested",
    ),
  );
});
