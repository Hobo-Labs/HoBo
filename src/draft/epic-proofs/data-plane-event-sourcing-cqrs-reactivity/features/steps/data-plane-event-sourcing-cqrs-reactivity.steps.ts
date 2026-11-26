/**
 * Executable step definitions for data-plane-event-sourcing-cqrs-reactivity.feature.
 *
 * Drives the epic's real reference simulation
 * (services/data-plane-reference-architecture.ts) and asserts the projection,
 * search, and adversarial artifacts it actually produces.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runDataPlaneReferenceSimulation } from "../../services/data-plane-reference-architecture.js";

type Simulation = Awaited<ReturnType<typeof runDataPlaneReferenceSimulation>>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runDataPlaneReferenceSimulation();
	return simulationPromise;
}

type DataPlaneWorld = {
	result?: Simulation;
};

// --- Scenario: Place an order and read it through a reactive projection ------------------

Given(
	"a typed order domain event, a CQRS aggregate, and a tenant-scoped materialization",
	async function (this: DataPlaneWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.epic.slug,
			"data-plane-event-sourcing-cqrs-reactivity",
		);
		assert.equal(
			this.result.orderFlow.domainBody.roundTripValid,
			true,
			"domain body round-trips its schema",
		);
	},
);

When(
	"the Snapshop app places an order through the data plane",
	function (this: DataPlaneWorld) {
		assert.equal(
			this.result?.orderFlow.command.seq,
			1,
			"order command appended at seq 1",
		);
	},
);

Then(
	"the order event appends once, replay and live projections agree, and the Reactor pushes the updated view",
	function (this: DataPlaneWorld) {
		const orderFlow = this.result?.orderFlow;
		assert.ok(orderFlow);
		assert.equal(orderFlow.outcome, "projected-and-pushed");
		assert.equal(
			orderFlow.replayLive.equivalent,
			true,
			"replay and live projection agree",
		);
		assert.deepEqual(orderFlow.reactor.latestPush.seq, { "order:1001": 1 });
		assert.equal(
			orderFlow.graphql.orders[0].totalCents,
			4200,
			"GraphQL reads the projected snapshot",
		);
	},
);

// --- Scenario: Keep reads portable while exposing explicit escape hatches ----------------

Given(
	"relational, document, full-text, and vector projection surfaces",
	async function (this: DataPlaneWorld) {
		this.result = await simulation();
		assert.ok(
			this.result.sinks.relational && this.result.sinks.document,
			"sink surfaces exist",
		);
	},
);

When(
	"the reference projection updates and portable search runs",
	function (this: DataPlaneWorld) {
		assert.equal(
			this.result?.sinks.changeFeed.eventType,
			"data.Changed",
			"sink updates flow as change events",
		);
	},
);

Then(
	"every sink boundary is consumer-tested and raw driver access stays read-only and portability-flagged",
	function (this: DataPlaneWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.sinks.relational.status, "consumer_tested");
		assert.equal(result.sinks.document.status, "consumer_tested");
		assert.equal(
			result.search.fullText.hits[0].id,
			"order:1001",
			"full-text search finds the projected order",
		);
		assert.equal(
			result.search.embed.egress,
			"local-only",
			"embedding stays local",
		);
		assert.equal(result.rawEscapeHatch.portabilityFlagged, true);
		assert.equal(
			result.rawEscapeHatch.writeBlocked,
			true,
			"raw driver writes are blocked",
		);
	},
);

// --- Scenario: Handle stale, poisoned, and erased data without rewriting history ---------

Given(
	"projection lag, snapshot divergence, a poison event, and an erasure request",
	async function (this: DataPlaneWorld) {
		this.result = await simulation();
		assert.ok(this.result.adversarial, "adversarial paths must have run");
	},
);

When(
	"the data plane rebuilds from the event log",
	function (this: DataPlaneWorld) {
		assert.equal(
			this.result?.adversarial.snapshotDivergence.recoveredBy,
			"full-replay",
			"divergence recovers by full replay",
		);
	},
);

Then(
	"stale reads are labeled, poison events quarantine, and erased fields tombstone without log rewrite",
	function (this: DataPlaneWorld) {
		const adversarial = this.result?.adversarial;
		assert.ok(adversarial);
		assert.equal(
			adversarial.projectionLag.eventType,
			"projection.Lagged",
			"stale reads carry a lag label",
		);
		assert.equal(adversarial.poisonEvent.outcome, "quarantined-and-skipped");
		assert.equal(adversarial.cryptoShred.tombstoneVisible, true);
		assert.equal(
			adversarial.cryptoShred.originalEventsUnchanged,
			true,
			"the event log is never rewritten",
		);
	},
);
