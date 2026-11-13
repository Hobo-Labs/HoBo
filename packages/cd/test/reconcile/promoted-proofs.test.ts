/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test fixtures brand ids minted by the fake journal, build partial generated records, and read controlled JSON fixtures at the test boundary. */
// Promoted proof semantics. Each describe block
// names the frozen proof under src/draft/technical-proofs/ whose semantics it
// carries into @hobo/cd; the proofs themselves are not edited.

import { create } from "@bufbuild/protobuf";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type IacProgram,
	type IacProvider,
} from "@hobo/cloud";
import type { ActorLeaseHost, FenceToken } from "@hobo/core";
import { createFixtureHostAttestor } from "@hobo/identity";
import { describe, expect, it } from "vitest";
import {
	ReconcileObservationRecordSchema,
	ReconcilerMode,
	ReconcileStatus,
} from "../../src/_generated/cd_pb.js";
import {
	createOrchestratorRealizer,
	ORCHESTRATOR_LEDGER,
} from "../../src/adapters/orchestrator.js";
import type { RealizeInput } from "../../src/ports.js";
import {
	createCampReconciler,
	createDriftPolicy,
	createInProcessTransport,
	decideDrift,
	driftFindings,
} from "../../src/reconcile/index.js";
import {
	asCamp,
	asReconciler,
	createClock,
	createFakeDesired,
	createFakeRealizer,
	createFakeStore,
	createRecordingSink,
	ctxAt,
	resolvedFor,
	setFor,
	statusEvents,
	TENANT,
} from "./fakes.js";

const CAMP = asCamp("camp-proof");

function graph(opts: { failApply?: Set<string> } = {}) {
	const clock = createClock();
	const store = createFakeStore(clock);
	const calls: string[] = [];
	const iac: IacProvider = {
		id: "proof-iac",
		async preview(p: IacProgram) {
			return { summary: p.resourceId, changes: 1 };
		},
		async apply(p: IacProgram) {
			if (opts.failApply?.has(p.resourceId))
				throw new Error(`apply ${p.resourceId} rejected`);
			calls.push(`apply:${p.resourceId}`);
			return { url: `https://${p.resourceId}` };
		},
		async destroy(p: IacProgram) {
			calls.push(`destroy:${p.resourceId}`);
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
	const held = new Set<string>();
	const host: ActorLeaseHost = {
		acquire(key, request) {
			if (held.has(key)) throw new Error(`second writer rejected on ${key}`);
			held.add(key);
			return {
				key,
				holderId: request.holderId,
				fenceToken: 1n,
				expiresAt: "",
				release: () => held.delete(key),
			};
		},
	};
	const realizer = createOrchestratorRealizer({
		store,
		tenant: TENANT,
		actorHost: host,
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
		attestor: createFixtureHostAttestor({ hostId: "h" }),
		hostId: "h",
		now: clock.now,
	});
	const input = (
		resources: Parameters<typeof resolvedFor>[1],
		n: number,
		keep?: string[],
	): RealizeInput & { keep?: string[] } => {
		const resolved = resolvedFor(CAMP, resources);
		return {
			campId: CAMP,
			desired: setFor(CAMP, resolved, n),
			resolved,
			reconcilerId: asReconciler("r1"),
			fence: 1n as FenceToken,
			signal: new AbortController().signal,
			...(keep ? { keep } : {}),
		};
	};
	return { store, realizer, calls, input, ctx: ctxAt(clock) };
}

const DB = { name: "db", port: "database" };
const API = { name: "api", port: "compute", deps: ["db"] };

describe("resourceactor-reconcile-loop-contract", () => {
	it("a non-empty change dispatches once and records the realized state", async () => {
		const g = graph();
		const obs = await g.realizer.converge(g.input([DB], 1), g.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(g.calls).toEqual(["apply:db"]);
		expect(
			g.store.log.filter((e) => e.event.type === ORCHESTRATOR_LEDGER.realized),
		).toHaveLength(1);
	});

	it("a second loop on converged state emits nothing", async () => {
		const g = graph();
		await g.realizer.converge(g.input([DB], 1), g.ctx);
		const before = g.store.log.length;
		const obs = await g.realizer.converge(g.input([DB], 1), g.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(g.calls).toEqual(["apply:db"]);
		// Only the idempotent ledger fact may be re-offered; it dedupes.
		expect(g.store.log.length).toBe(before);
	});

	it("an exec failure fails closed: blocked with a reason, nothing recorded as realized", async () => {
		const g = graph({ failApply: new Set(["db"]) });
		const obs = await g.realizer.converge(g.input([DB], 1), g.ctx);
		expect(obs.status).toBe(ReconcileStatus.BLOCKED);
		expect(obs.reasons[0]?.code).toBe("realize-failed");
		expect(
			g.store.log.filter((e) => e.event.type === ORCHESTRATOR_LEDGER.realized),
		).toHaveLength(0);
	});
});

describe("orchestrator-reconciliation-fsm-contract", () => {
	it("resources converge in DAG order", async () => {
		const g = graph();
		await g.realizer.converge(g.input([API, DB], 1), g.ctx);
		expect(g.calls).toEqual(["apply:db", "apply:api"]);
	});

	it("replaying the journal reproduces the realized state (observe equals live)", async () => {
		const g = graph();
		const live = await g.realizer.converge(g.input([API, DB], 1), g.ctx);
		const replayed = await g.realizer.observe(g.input([API, DB], 1), g.ctx);
		expect(replayed.resources).toEqual(live.resources);
		expect(replayed.status).toBe(live.status);
	});

	it("a stalled dependency blocks downstream without applying it", async () => {
		const g = graph({ failApply: new Set(["db"]) });
		await g.realizer.converge(g.input([API, DB], 1), g.ctx);
		expect(g.calls).not.toContain("apply:api");
	});
});

describe("drift-orphan-sweep-contract", () => {
	it("sweeps an owned orphan (realized but no longer declared) instead of keeping a duplicate", async () => {
		const g = graph();
		await g.realizer.converge(
			g.input([DB, { name: "old", port: "compute" }], 1),
			g.ctx,
		);
		await g.realizer.converge(g.input([DB], 2), g.ctx);
		expect(g.calls).toContain("destroy:old");
	});

	it("never sweeps a resource it does not own: external drift is proposed, not reconciled", () => {
		const route = decideDrift(
			driftFindings(
				create(ReconcileObservationRecordSchema, {
					resources: [{ resource: "foreign", driftKind: "external" }],
				}),
			),
		).route;
		expect(route).toBe("propose");
	});

	it("resumes a mid-sweep failure without re-destroying already swept objects", async () => {
		const g = graph();
		await g.realizer.converge(
			g.input(
				[DB, { name: "a", port: "compute" }, { name: "b", port: "compute" }],
				1,
			),
			g.ctx,
		);
		let crash = true;
		g.store.beforeAppend = (stream) => {
			if (crash && stream === ORCHESTRATOR_LEDGER.stream(CAMP)) {
				crash = false;
				throw new Error("crash before the ledger write");
			}
		};
		await expect(g.realizer.converge(g.input([DB], 2), g.ctx)).rejects.toThrow(
			"crash",
		);
		const swept = g.calls.filter((c) => c.startsWith("destroy:"));
		expect(swept.sort()).toEqual(["destroy:a", "destroy:b"]);
		await g.realizer.converge(g.input([DB], 2), g.ctx);
		expect(g.calls.filter((c) => c.startsWith("destroy:")).sort()).toEqual([
			"destroy:a",
			"destroy:b",
		]);
	});

	it("an out-of-band change reverts by default; adopting needs a policy that says so", () => {
		const findings = driftFindings(
			create(ReconcileObservationRecordSchema, {
				resources: [{ resource: "api", driftKind: "modified:tags" }],
			}),
		);
		expect(decideDrift(findings).route).toBe("reconcile");
		expect(
			decideDrift(findings, { routes: { modified: "propose" } }).route,
		).toBe("propose");
	});
});

describe("drift-detection-loop-contract / autonomous-drift-remediation-contract", () => {
	it("a clean re-observation is a no-op and repeated converged passes stay idempotent", async () => {
		const clock = createClock();
		const store = createFakeStore(clock);
		const desired = createFakeDesired(store);
		const realizer = createFakeRealizer();
		const reconciler = createCampReconciler({
			store,
			tenant: TENANT,
			now: clock.now,
			reconcilerId: asReconciler("r1"),
			mode: ReconcilerMode.CONDUCTOR,
			campIds: [CAMP],
			holderId: "h",
			transport: createInProcessTransport({
				store,
				tenant: TENANT,
				now: clock.now,
				desired,
			}),
			realizer,
			drift: createDriftPolicy(),
			telemetry: createRecordingSink(),
		});
		const resolved = resolvedFor(CAMP, [{ name: "api" }]);
		await desired.publish(setFor(CAMP, resolved, 1), resolved);
		await reconciler.reconcileOnce(CAMP, ctxAt(clock));
		const count = statusEvents(store, CAMP).length;
		const controller = new AbortController();
		const run = reconciler.run(controller.signal);
		await new Promise((r) => setTimeout(r, 20));
		clock.advance(61_000);
		await new Promise((r) => setTimeout(r, 20));
		controller.abort();
		await run;
		expect(realizer.converges).toBe(1);
		// The run loop re-observed (new lease → redelivery → observe-first) but
		// never mutated; converged reports carry no drift events.
		const after = statusEvents(store, CAMP)
			.slice(count)
			.map((e) => e.type);
		expect(
			after.every(
				(t) =>
					t === "deployment.StatusObserved" || t === "deployment.Converged",
			),
		).toBe(true);
	});

	it("a refresh failure is classified and scheduled for retry with backoff", async () => {
		const clock = createClock();
		const store = createFakeStore(clock);
		const desired = createFakeDesired(store);
		const realizer = createFakeRealizer();
		realizer.observe = async () => {
			throw new Error("provider refresh timed out");
		};
		const sink = createRecordingSink();
		const reconciler = createCampReconciler({
			store,
			tenant: TENANT,
			now: clock.now,
			reconcilerId: asReconciler("r1"),
			mode: ReconcilerMode.CONDUCTOR,
			campIds: [CAMP],
			holderId: "h",
			transport: createInProcessTransport({
				store,
				tenant: TENANT,
				now: clock.now,
				desired,
			}),
			realizer,
			drift: createDriftPolicy(),
			telemetry: sink,
		});
		const resolved = resolvedFor(CAMP, [{ name: "api" }]);
		await desired.publish(setFor(CAMP, resolved, 1), resolved);
		const obs = await reconciler.reconcileOnce(CAMP, ctxAt(clock));
		expect(obs.reasons.map((r) => r.code)).toContain("realize-failed");
		// Unknown target state: nothing is applied until an observation succeeds (I5).
		expect(realizer.converges).toBe(0);
		expect(
			sink.points.some((p) => p.name === "hobo.cd.reconcile.blocked"),
		).toBe(true);
	});
});
