// Wires the promotion service over the WP6 doubles.
import type { PrincipalRef } from "@hobo/core";
import { createA2HApprover } from "../../src/adapters/approval.js";
import type { FanoutAggregateGate } from "../../src/adapters/gatekeeper.js";
import type { TrailsMigrations } from "../../src/adapters/trails.js";
import type { DeployGate } from "../../src/ports.js";
import {
	createPromotionService,
	type PlacedCamps,
	type PromotionServiceDeps,
} from "../../src/promotion/index.js";
import type { Mutable } from "../../src/promotion/journal.js";
import {
	FakeCampPolicy,
	FakeDesired,
	FakeFreight,
	FakeGate,
	FakeNotify,
	FakePipelines,
	FakeResolver,
	FakeRollouts,
	FakeRunbooks,
	FakeSuites,
	FakeVerification,
	RecordingAuthorizer,
	RecordingTelemetry,
} from "./doubles.js";
import {
	clock,
	context,
	MemoryEventStore,
	OPERATOR,
	T0,
	TENANT,
} from "./store.js";

export type HarnessOptions = Readonly<{
	gate?: DeployGate;
	trails?: TrailsMigrations;
	aggregate?: FanoutAggregateGate;
	placed?: PlacedCamps;
}>;

export function harness(options: HarnessOptions = {}) {
	const c = clock(T0);
	const store = new MemoryEventStore(c.now);
	const freight = new FakeFreight();
	const pipelines = new FakePipelines();
	const desired = new FakeDesired();
	const resolver = new FakeResolver(desired);
	const gate = new FakeGate();
	const rollouts = new FakeRollouts();
	const verification = new FakeVerification();
	const runbooks = new FakeRunbooks();
	const suites = new FakeSuites();
	const notify = new FakeNotify();
	const campPolicy = new FakeCampPolicy();
	const authorizer = new RecordingAuthorizer();
	const telemetry = new RecordingTelemetry();
	const approvals = createA2HApprover({
		store,
		tenant: TENANT,
		now: c.now,
		notify,
		authorizer,
		telemetry,
	});
	const build = () => {
		const deps: Mutable<PromotionServiceDeps> = {
			store,
			tenant: TENANT,
			now: c.now,
			freight,
			pipelines,
			desired,
			resolver,
			gate: options.gate ?? gate,
			approvals,
			rollouts,
			verification,
			runbooks,
			suites,
			notify,
			campPolicy,
			authorizer,
			telemetry,
		};
		if (options.trails) deps.trails = options.trails;
		if (options.aggregate) deps.aggregate = options.aggregate;
		if (options.placed) deps.placed = options.placed;
		return createPromotionService(deps);
	};
	const service = build();
	const ctx = (principal: PrincipalRef = OPERATOR) => context(c.now, principal);
	return {
		clock: c,
		store,
		freight,
		pipelines,
		desired,
		resolver,
		gate,
		rollouts,
		verification,
		runbooks,
		suites,
		notify,
		campPolicy,
		authorizer,
		telemetry,
		approvals,
		service,
		/** A second service over the same journal (a restarted process). */
		restart: build,
		ctx,
	};
}
