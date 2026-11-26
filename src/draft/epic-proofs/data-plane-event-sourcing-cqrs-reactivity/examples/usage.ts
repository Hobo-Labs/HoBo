/**
 * Runnable example for data-plane-event-sourcing-cqrs-reactivity. The draft-artifact
 * gate EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Runs the same reference simulation the cucumber steps drive
 * (services/data-plane-reference-architecture.ts): a typed order event through CQRS,
 * replay/live equivalence, portable sinks + search, and adversarial data handling.
 */
import { strict as assert } from "node:assert";

import { runDataPlaneReferenceSimulation } from "../services/data-plane-reference-architecture.ts";

const result = await runDataPlaneReferenceSimulation();
assert.equal(result.epic.slug, "data-plane-event-sourcing-cqrs-reactivity");

// 1) Order flow: typed event appends once, replay==live, Reactor pushes the view.
const orderFlow = result.orderFlow;
assert.equal(orderFlow.domainBody.roundTripValid, true);
assert.equal(orderFlow.command.seq, 1);
assert.equal(orderFlow.outcome, "projected-and-pushed");
assert.equal(orderFlow.replayLive.equivalent, true);
assert.deepEqual(orderFlow.reactor.latestPush.seq, { "order:1001": 1 });
assert.equal(orderFlow.graphql.orders[0].totalCents, 4200);
console.log(
	`order flow outcome=${orderFlow.outcome} seq=${orderFlow.command.seq} replayLiveEquivalent=${orderFlow.replayLive.equivalent}`,
);
console.log(`graphql read totalCents=${orderFlow.graphql.orders[0].totalCents}`);

// 2) Sinks stay portable and consumer-tested; raw driver access is read-only + flagged.
assert.equal(result.sinks.relational.status, "consumer_tested");
assert.equal(result.sinks.document.status, "consumer_tested");
assert.equal(result.sinks.changeFeed.eventType, "data.Changed");
assert.equal(result.search.fullText.hits[0].id, "order:1001");
assert.equal(result.search.embed.egress, "local-only");
assert.equal(result.rawEscapeHatch.portabilityFlagged, true);
assert.equal(result.rawEscapeHatch.writeBlocked, true);
console.log(
	`sinks relational=${result.sinks.relational.status} document=${result.sinks.document.status} changeFeed=${result.sinks.changeFeed.eventType}`,
);
console.log(
	`search fullText hit=${result.search.fullText.hits[0].id} embed egress=${result.search.embed.egress}`,
);
console.log(
	`raw escape hatch flagged=${result.rawEscapeHatch.portabilityFlagged} writeBlocked=${result.rawEscapeHatch.writeBlocked}`,
);

// 3) Adversarial paths: lag labeled, divergence replays, poison quarantines, erasure tombstones.
const adversarial = result.adversarial;
assert.equal(adversarial.projectionLag.eventType, "projection.Lagged");
assert.equal(adversarial.snapshotDivergence.recoveredBy, "full-replay");
assert.equal(adversarial.poisonEvent.outcome, "quarantined-and-skipped");
assert.equal(adversarial.cryptoShred.tombstoneVisible, true);
assert.equal(adversarial.cryptoShred.originalEventsUnchanged, true);
console.log(
	`adversarial lag=${adversarial.projectionLag.eventType} divergence=${adversarial.snapshotDivergence.recoveredBy} poison=${adversarial.poisonEvent.outcome}`,
);
console.log(
	`crypto-shred tombstoneVisible=${adversarial.cryptoShred.tombstoneVisible} logUnchanged=${adversarial.cryptoShred.originalEventsUnchanged}`,
);

console.log(
	"EPIC HELD: append-only events, equivalent replay, portable reads, and history-preserving erasure",
);
