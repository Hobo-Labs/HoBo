import assert from "node:assert/strict";
import { test } from "vitest";

import { runDataPlaneReferenceSimulation } from "../services/data-plane-reference-architecture.js";

test("Snapshop order flow writes through CQRS, projects through replay/live, and pushes reactive reads", async () => {
  const result = await runDataPlaneReferenceSimulation();

  assert.equal(result.epic.slug, "data-plane-event-sourcing-cqrs-reactivity");
  assert.equal(result.orderFlow.outcome, "projected-and-pushed");
  assert.equal(result.orderFlow.command.seq, 1);
  assert.equal(result.orderFlow.domainBody.roundTripValid, true);
  assert.equal(result.orderFlow.replayLive.equivalent, true);
  assert.deepEqual(result.orderFlow.reactor.latestPush.seq, { "order:1001": 1 });
  assert.equal(result.orderFlow.graphql.orders[0].totalCents, 4200);
});

test("projection sinks, search, and extension packages stay mocked but contract-visible", async () => {
  const result = await runDataPlaneReferenceSimulation();

  assert.equal(result.sinks.relational.status, "consumer_tested");
  assert.equal(result.sinks.document.status, "consumer_tested");
  assert.equal(result.sinks.changeFeed.eventType, "data.Changed");
  assert.equal(result.search.fullText.hits[0].id, "order:1001");
  assert.equal(result.search.vector.mode, "step");
  assert.equal(result.search.embed.egress, "local-only");
  assert.equal(result.rawEscapeHatch.portabilityFlagged, true);
  assert.equal(result.rawEscapeHatch.writeBlocked, true);
});

test("adversarial paths fail closed without rewriting the event log", async () => {
  const result = await runDataPlaneReferenceSimulation();

  assert.equal(result.adversarial.projectionLag.eventType, "projection.Lagged");
  assert.equal(result.adversarial.snapshotDivergence.recoveredBy, "full-replay");
  assert.equal(result.adversarial.poisonEvent.outcome, "quarantined-and-skipped");
  assert.equal(result.adversarial.cryptoShred.tombstoneVisible, true);
  assert.equal(result.adversarial.cryptoShred.originalEventsUnchanged, true);
  assert.equal(result.adversarial.authFlagReadSet.revokedSessionPushed, true);
  assert.equal(result.adversarial.coalescing.maxBufferedPerStream, 1);
});
