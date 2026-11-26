import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  CONTRACT_BOUNDARIES,
  loadMembraneFixture,
  runMembraneReferenceSimulation,
  verifyPactContracts,
} from "../services/wit-runtime-reference.js";

const fixture = await loadMembraneFixture();

test("runtime-local checkout flow records durable runtime effects without Yard data-path calls", async () => {
  const result = await runMembraneReferenceSimulation(fixture.scenarios.runtimeLocalCheckout);

  assert.equal(result.status, "completed");
  assert.equal(result.persona, "app-developer");
  assert.equal(result.verticalSlice, "runtime-local-durable-workflow");
  assert.deepEqual(result.events.map((event) => event.type), [
    "wit.PinVerified",
    "component.Instantiated",
    "link.Established",
    "runtime.QueueHandled",
    "runtime.ActorStateAppended",
    "runtime.EventAppended",
    "runtime.StreamFrameWritten",
    "runtime.TimerFired",
    "runtime.ConformanceVerified",
  ]);
  assert.equal(result.liveNetworkCalls.length, 0);
  assert.equal(result.boundaries.every((boundary) => boundary.mocked), true);
});

test("cross-host membrane rejects unsafe links before calls reach mocked providers", async () => {
  const result = await runMembraneReferenceSimulation(fixture.scenarios.crossHostMembrane);

  assert.equal(result.status, "link_blocked_then_recovered");
  assert.equal(result.persona, "platform-operator");
  assert.equal(result.verticalSlice, "portable-wrpc-membrane");
  assert.equal(result.failures.some((failure) => failure.code === "wire-version-below-floor"), true);
  assert.equal(result.failures.some((failure) => failure.code === "deadline-exceeded"), true);
  assert.equal(result.failures.some((failure) => failure.code === "membrane-overloaded"), true);
  assert.equal(result.events.some((event) => event.type === "lattice.CrossHostCalled"), true);
});

test("SDK conformance and websocket fan-out stay deny-by-default", async () => {
  const result = await runMembraneReferenceSimulation(fixture.scenarios.sdkConformance);

  assert.equal(result.status, "certified_with_denials");
  assert.equal(result.persona, "sdk-maintainer");
  assert.equal(result.verticalSlice, "sdk-and-capability-parity");
  assert.equal(result.failures.some((failure) => failure.code === "grant-missing"), true);
  assert.equal(result.failures.some((failure) => failure.code === "semantics-annex-failed"), true);
  assert.equal(result.events.some((event) => event.type === "websocket.FrameFannedOut"), true);
  assert.equal(result.events.some((event) => event.type === "yard.DataPathCalled"), false);
});

test("host upgrade and adapter certification require conformance and upcaster evidence", async () => {
  const result = await runMembraneReferenceSimulation(fixture.scenarios.hostUpgrade);

  assert.equal(result.status, "upgrade_ready_after_gate");
  assert.equal(result.persona, "runtime-operator");
  assert.equal(result.verticalSlice, "host-portability-and-upgrade");
  assert.equal(result.failures.some((failure) => failure.code === "missing-upcaster"), true);
  assert.equal(result.events.some((event) => event.type === "componentHost.ConformancePassed"), true);
  assert.equal(result.events.some((event) => event.type === "componentHost.ManifestRepinned"), true);
});

test("every WIT runtime boundary has a focused Pact fixture", async () => {
  const result = await verifyPactContracts();

  assert.equal(result.status, "verified");
  assert.deepEqual(
    result.boundaries.map((boundary) => boundary.id).sort(),
    CONTRACT_BOUNDARIES.map((boundary) => boundary.id).sort(),
  );

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pact = JSON.parse(await readFile(new URL(`../contracts/pacts/${boundary.pactFile}`, import.meta.url), "utf8"));
    assert.equal(pact.metadata.boundaryId, boundary.id);
    assert.equal(pact.consumer.name, "wit-component-model-runtime-membrane-reference");
    assert.ok(pact.provider.name);
    assert.ok(pact.interactions.length > 0);
  }
});
