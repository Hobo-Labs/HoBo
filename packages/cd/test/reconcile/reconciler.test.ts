/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test fixtures brand ids minted by the fake journal, build partial generated records, and read controlled JSON fixtures at the test boundary. */
// WP7 acceptance (plan 0024 §9 WP7, §10 rows owned by WP7).
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampClaimRecordSchema,
	CampManagement,
	DepartureAction,
	ReconcileObservationRecordSchema,
	ReconcilerMode,
	ReconcileStatus,
	SetOrigin,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS } from "../../src/events.js";
import type { DriftPolicy, Realizer } from "../../src/ports.js";
import {
	createCampReconciler,
	createDriftPolicy,
	createInProcessTransport,
	RECONCILE_EVENTS,
	RECONCILE_METRICS,
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
	type FakeRealizer,
	observationOf,
	resolvedFor,
	setFor,
	statusEvents,
	TENANT,
} from "./fakes.js";

const CAMP = asCamp("camp-eu-1");

function harness(
	opts: {
		observeFields?: readonly string[];
		realizer?: FakeRealizer;
		drift?: DriftPolicy;
		departure?: DepartureAction;
		classification?: Readonly<Record<string, string>>;
	} = {},
) {
	const clock = createClock();
	const store = createFakeStore(clock);
	const desired = createFakeDesired(store, opts.observeFields ?? []);
	const transport = createInProcessTransport({
		store,
		tenant: TENANT,
		now: clock.now,
		desired,
		feedTimeoutMs: 500,
	});
	const realizer =
		opts.realizer ??
		createFakeRealizer(
			opts.classification ? { classification: opts.classification } : {},
		);
	const sink = createRecordingSink();
	const reconciler = (
		id: string,
		holderId = "host-1",
		r: Realizer = realizer,
	) =>
		createCampReconciler({
			store,
			tenant: TENANT,
			now: clock.now,
			reconcilerId: asReconciler(id),
			mode: ReconcilerMode.CONDUCTOR,
			campIds: [CAMP],
			holderId,
			transport,
			realizer: r,
			drift: opts.drift ?? createDriftPolicy(),
			telemetry: sink,
			...(opts.departure !== undefined
				? {
						departureAction: () =>
							opts.departure ?? DepartureAction.UNSPECIFIED,
					}
				: {}),
		});
	return {
		clock,
		store,
		desired,
		transport,
		realizer,
		sink,
		reconciler,
		ctx: ctxAt(clock),
	};
}

const V1 = [
	{ name: "api", port: "compute", version: "1" },
	{ name: "db", port: "database", version: "1" },
];

describe("createCampReconciler", () => {
	it("converges a new Set and reports ReconcileStarted → StatusObserved → Converged on the status stream", async () => {
		const h = harness();
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		const obs = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		const types = statusEvents(h.store, CAMP).map((e) => e.type);
		expect(types).toEqual([
			CD_EVENTS.ReconcileStarted,
			CD_EVENTS.StatusObserved,
			CD_EVENTS.StatusObserved,
			CD_EVENTS.Converged,
		]);
		// Spec and status never share a stream (D5).
		expect(
			statusEvents(h.store, CAMP).every(
				(e) => e.streamId === "cd-camp-status-camp-eu-1",
			),
		).toBe(true);
		expect(h.realizer.mutatingCalls).toEqual(["apply:api", "apply:db"]);
	});

	it("I4: two reconcilers with different ids on one Camp — one writes, the other is fenced out", async () => {
		const h = harness();
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		const realizerB = createFakeRealizer();
		const a = h.reconciler("r-a", "host-a");
		const b = h.reconciler("r-b", "host-b", realizerB);
		const controller = new AbortController();
		// A holds the lease across passes (run mode) and writes.
		const run = a.run(controller.signal);
		await new Promise((r) => setTimeout(r, 30));
		const refused = await b.reconcileOnce(CAMP, h.ctx);
		expect(refused.status).toBe(ReconcileStatus.BLOCKED);
		expect(refused.reasons.map((r) => r.code)).toEqual(["lease-held"]);
		expect(realizerB.converges + realizerB.observes).toBe(0);
		controller.abort();
		await run;
		const writers = new Set(
			statusEvents(h.store, CAMP).map((e) => observationOf(e).reconcilerId),
		);
		expect([...writers]).toEqual(["r-a"]);
	});

	it("I4: a reconciler whose lease was taken over stops before mutating and its stale fence is refused", async () => {
		const h = harness();
		const r1 = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, r1, 1), r1);
		const transportLease = await h.transport.claim({
			reconcilerId: asReconciler("old"),
			campId: CAMP,
			holderId: "host-old",
			ttlMs: 30_000,
		});
		expect(transportLease.ok).toBe(true);
		if (!transportLease.ok) return;
		h.clock.advance(31_000);
		await h.reconciler("new", "host-new").reconcileOnce(CAMP, h.ctx);
		const stale = await h.transport.report(
			transportLease.value,
			create(ReconcileObservationRecordSchema, {
				campId: CAMP,
				reconcilerId: "old",
				fenceToken: transportLease.value.fence.toString(10),
				status: ReconcileStatus.CONVERGED,
			}),
		);
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.reasons[0]?.code).toBe("stale-fence");
		const checkpoint = await h.transport.checkpoint(
			transportLease.value,
			1n as never,
		);
		expect(checkpoint.ok).toBe(false);
	});

	it("a crash between execute and observe does not repeat the mutation", async () => {
		const h = harness();
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		h.realizer.crashAfterApply = true;
		const crashed = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		expect(crashed.status).toBe(ReconcileStatus.BLOCKED);
		expect(h.realizer.mutatingCalls).toEqual(["apply:api", "apply:db"]);
		// A fresh process resumes from the uncommitted checkpoint and observes.
		const resumed = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		expect(resumed.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.realizer.mutatingCalls).toEqual(["apply:api", "apply:db"]);
		expect(h.realizer.converges).toBe(1);
	});

	it("checkpoint resume: a restarted reconciler skips committed changes and applies only newer ones", async () => {
		const h = harness();
		const r1 = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, r1, 1), r1);
		await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		const r2 = resolvedFor(CAMP, [
			{ name: "api", version: "2" },
			V1[1] ?? { name: "db" },
		]);
		await h.desired.publish(setFor(CAMP, r2, 2), r2);
		h.realizer.mutatingCalls.length = 0;
		const restarted = h.reconciler("r1");
		const obs = await restarted.reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(obs.setId).toBe(setFor(CAMP, r2, 2).setId);
		expect(h.realizer.mutatingCalls).toEqual(["apply:api"]);
		// Once more: nothing new, the redelivered current Set is only observed.
		const again = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		expect(again.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.realizer.mutatingCalls).toEqual(["apply:api"]);
	});

	it("a missing blob blocks with a reason and does not checkpoint", async () => {
		const h = harness();
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, resolved, 1), undefined);
		const obs = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.BLOCKED);
		expect(obs.reasons[0]?.code).toBe("resolved-set-missing");
		expect(obs.reasons[0]?.remediation).toMatch(
			/Restore the resolved-set blob/u,
		);
		expect(h.realizer.converges + h.realizer.observes).toBe(0);
		const types = statusEvents(h.store, CAMP).map((e) => e.type);
		expect(types).toContain(CD_EVENTS.ReconcileBlocked);
		// The blob returns: the same change is retried (no checkpoint was taken).
		h.desired.blobs.set(resolved.contentHash, resolved);
		const retried = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		expect(retried.status).toBe(ReconcileStatus.CONVERGED);
	});

	it("topology Deltas reconcile like any Set", async () => {
		const h = harness();
		const r1 = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, r1, 1), r1);
		await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		const r2 = resolvedFor(CAMP, [
			{ name: "api", version: "1" },
			{ name: "db", port: "database", version: "2" },
		]);
		await h.desired.publish(setFor(CAMP, r2, 2, SetOrigin.TOPOLOGY), r2);
		const obs = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.realizer.mutatingCalls.at(-1)).toBe("apply:db");
	});

	it("emits reconcile metrics through TelemetrySink", async () => {
		const h = harness();
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		const names = h.sink.points.map((p) => p.name);
		expect(names).toEqual(
			expect.arrayContaining([
				RECONCILE_METRICS.passes,
				RECONCILE_METRICS.duration,
				RECONCILE_METRICS.converged,
				RECONCILE_METRICS.mutations,
			]),
		);
		expect(
			h.sink.points.find((p) => p.name === RECONCILE_METRICS.passes)
				?.attributes["hobo.cd.camp"],
		).toBe(CAMP);
	});
});

describe("drift", () => {
	async function converged(h: ReturnType<typeof harness>) {
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		const rec = h.reconciler("r1");
		await rec.reconcileOnce(CAMP, h.ctx);
		return rec;
	}

	it("drift routes per class: modified reconciles, external proposes, deleted data escalates", async () => {
		const h = harness();
		const rec = await converged(h);
		const target = h.realizer.target;
		// modified → reconcile (re-apply the current Set, no new Delta)
		h.clock.advance(61_000);
		(target.get("api") ?? { driftKind: "" }).driftKind = "modified:image";
		h.realizer.mutatingCalls.length = 0;
		const healed = await rec.reconcileOnce(CAMP, h.ctx);
		expect(healed.status).toBe(ReconcileStatus.CONVERGED);
		expect(healed.reasons.map((r) => r.code)).toContain("drift-reconciled");
		expect(h.realizer.mutatingCalls).toEqual(["apply:api"]);
		// external → propose (detect-only; never re-applied)
		h.clock.advance(61_000);
		target.set("cdn", {
			hash: "x",
			kind: "edge",
			classification: "",
			attributes: {},
			driftKind: "external",
			retained: [],
		});
		h.realizer.mutatingCalls.length = 0;
		const proposed = await rec.reconcileOnce(CAMP, h.ctx);
		expect(proposed.reasons.map((r) => r.code)).toEqual(
			expect.arrayContaining(["drift-detected", "drift-proposed"]),
		);
		expect(h.realizer.mutatingCalls).toEqual([]);
		expect(statusEvents(h.store, CAMP).map((e) => e.type)).toContain(
			RECONCILE_EVENTS.DiffProposed,
		);
		target.delete("cdn");
		// deleted data resource → escalate (re-creating it would lose data)
		h.clock.advance(61_000);
		(target.get("db") ?? { driftKind: "" }).driftKind = "deleted";
		const escalated = await rec.reconcileOnce(CAMP, h.ctx);
		expect(escalated.status).toBe(ReconcileStatus.BLOCKED);
		expect(escalated.reasons.map((r) => r.code)).toContain("drift-escalated");
		expect(h.realizer.mutatingCalls).toEqual([]);
	});

	it("ignored drift is recorded and emits no write", async () => {
		const h = harness({
			drift: createDriftPolicy({ routes: { modified: "ignore" } }),
		});
		const rec = await converged(h);
		h.clock.advance(61_000);
		(h.realizer.target.get("api") ?? { driftKind: "" }).driftKind =
			"modified:tags";
		h.realizer.mutatingCalls.length = 0;
		const obs = await rec.reconcileOnce(CAMP, h.ctx);
		expect(obs.reasons.map((r) => r.code)).toEqual(
			expect.arrayContaining(["drift-detected", "drift-ignored"]),
		);
		expect(h.realizer.mutatingCalls).toEqual([]);
		expect(statusEvents(h.store, CAMP).map((e) => e.type)).toContain(
			RECONCILE_EVENTS.DriftDetected,
		);
	});

	it("an autoscaler-owned replica change is not drift", async () => {
		const h = harness();
		const rec = await converged(h);
		h.clock.advance(61_000);
		(h.realizer.target.get("api") ?? { driftKind: "" }).driftKind =
			"modified:replicas";
		h.realizer.mutatingCalls.length = 0;
		const obs = await rec.reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		const api = obs.resources.find((r) => r.resource === "api");
		expect(api?.driftKind).toBe("");
		expect(api?.retained).toContain("replicas");
		expect(h.realizer.mutatingCalls).toEqual([]);
		expect(statusEvents(h.store, CAMP).map((e) => e.type)).not.toContain(
			RECONCILE_EVENTS.DriftDetected,
		);
	});

	it("a mapping-rule hobo.cd/retain field is excluded from drift", async () => {
		const h = harness();
		const resolved = resolvedFor(CAMP, [
			{ name: "fn", port: "edge-worker", retain: "memoryMb" },
		]);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		const rec = h.reconciler("r1");
		await rec.reconcileOnce(CAMP, h.ctx);
		h.clock.advance(61_000);
		(h.realizer.target.get("fn") ?? { driftKind: "" }).driftKind =
			"modified:memoryMb";
		const obs = await rec.reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(obs.resources[0]?.retained).toEqual(["memoryMb"]);
	});

	it("flapping drift with the same fingerprint emits no duplicate DriftDetected and no second remediation", async () => {
		const h = harness();
		const rec = await converged(h);
		h.realizer.stuck.add("api");
		h.clock.advance(61_000);
		(h.realizer.target.get("api") ?? { driftKind: "" }).driftKind =
			"modified:image";
		await rec.reconcileOnce(CAMP, h.ctx);
		const converges = h.realizer.converges;
		const detected = statusEvents(h.store, CAMP).filter(
			(e) => e.type === RECONCILE_EVENTS.DriftDetected,
		).length;
		h.clock.advance(61_000);
		await rec.reconcileOnce(CAMP, h.ctx);
		expect(h.realizer.converges).toBe(converges);
		expect(
			statusEvents(h.store, CAMP).filter(
				(e) => e.type === RECONCILE_EVENTS.DriftDetected,
			).length,
		).toBe(detected);
	});

	it("the same fingerprint after a confirmed reconverge is new drift, and repeated remediation escalates instead of oscillating", async () => {
		const h = harness();
		const rec = await converged(h);
		const drift = () => {
			(h.realizer.target.get("api") ?? { driftKind: "" }).driftKind =
				"modified:image";
		};
		h.clock.advance(61_000);
		drift();
		const first = await rec.reconcileOnce(CAMP, h.ctx);
		expect(first.reasons.map((r) => r.code)).toContain("drift-reconciled");
		h.clock.advance(61_000);
		drift();
		const converges = h.realizer.converges;
		const second = await rec.reconcileOnce(CAMP, h.ctx);
		expect(second.status).toBe(ReconcileStatus.BLOCKED);
		expect(second.reasons.map((r) => r.code)).toEqual(
			expect.arrayContaining(["drift-detected", "drift-escalated"]),
		);
		expect(h.realizer.converges).toBe(converges);
		expect(
			statusEvents(h.store, CAMP).filter(
				(e) => e.type === RECONCILE_EVENTS.DriftDetected,
			).length,
		).toBe(2);
	});

	it("version pin: a newer version running on the target is drift back to the Set's pinned version, never a rewrite of desired state", async () => {
		const h = harness();
		const rec = await converged(h);
		const api = h.realizer.target.get("api");
		if (!api) throw new Error("api missing");
		api.hash = "compute:2";
		api.driftKind = "modified:version";
		h.clock.advance(61_000);
		const obs = await rec.reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.CONVERGED);
		expect(h.realizer.target.get("api")?.hash).toBe("compute:1");
		expect(await h.desired.current(CAMP)).toEqual(
			setFor(CAMP, resolvedFor(CAMP, V1), 1),
		);
	});
});

describe("observe-only, observations and departure", () => {
	it("an OBSERVE_ONLY Camp produces zero mutating calls", async () => {
		const h = harness();
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(
			setFor(CAMP, resolved, 1),
			resolved,
			CampManagement.OBSERVE_ONLY,
		);
		const rec = h.reconciler("r1");
		const obs = await rec.reconcileOnce(CAMP, h.ctx);
		expect(obs.status).toBe(ReconcileStatus.OBSERVED);
		h.clock.advance(61_000);
		h.realizer.target.set("legacy", {
			hash: "h",
			kind: "compute",
			classification: "",
			attributes: {},
			driftKind: "modified:image",
			retained: [],
		});
		const again = await rec.reconcileOnce(CAMP, h.ctx);
		expect(again.reasons.map((r) => r.code)).toContain("drift-detected");
		expect(h.realizer.converges).toBe(0);
		expect(h.realizer.mutatingCalls).toEqual([]);
		expect(statusEvents(h.store, CAMP).map((e) => e.type)).not.toContain(
			CD_EVENTS.ReconcileStarted,
		);
	});

	it("observations carry kind, classification, declared attributes, retained, claims and handover — secret-free", async () => {
		const realizer = createFakeRealizer({
			classification: { db: "personal-data" },
		});
		const base = realizer.observe.bind(realizer);
		realizer.observe = async (input, ctx) => {
			const obs = await base(input, ctx);
			for (const r of obs.resources)
				r.attributes = {
					"tls.minVersion": "1.2",
					"debug.dump": "x",
					apiToken: "ghp_abcdefghijklmnopqrstuvwxyz0123",
				};
			obs.claims = [
				create(CampClaimRecordSchema, { name: "region", value: "eu-west-1" }),
			];
			obs.handover = { endpoint: "db.internal:5432", password: "hunter2" };
			return obs;
		};
		const h = harness({
			observeFields: ["tls.minVersion", "apiToken"],
			realizer,
		});
		const resolved = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		const obs = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		const db = obs.resources.find((r) => r.resource === "db");
		expect(db?.kind).toBe("database");
		expect(db?.classification).toBe("personal-data");
		expect(Object.keys(db?.attributes ?? {}).sort()).toEqual([
			"apiToken",
			"tls.minVersion",
		]);
		expect(db?.attributes.apiToken).toMatch(/^secretRef:/u);
		expect(db?.retained).toEqual(
			expect.arrayContaining(["engineMinorVersion"]),
		);
		expect(obs.claims[0]?.reportedBy).toBe("r1");
		expect(obs.claims[0]?.observedAt).not.toBe("");
		expect(obs.handover.endpoint).toBe("db.internal:5432");
		expect(obs.handover.password).toMatch(/^secretRef:/u);
		const codes = obs.reasons.map((r) => r.code);
		expect(codes).toEqual(
			expect.arrayContaining([
				"attribute-undeclared",
				"attribute-secret-redacted",
				"handover-secret-redacted",
			]),
		);
		const reported = JSON.stringify(
			statusEvents(h.store, CAMP).map((e) => e.data),
		);
		expect(reported).not.toContain("hunter2");
		expect(reported).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
	});

	it("an oversized attribute is truncated with a reason, never dropped silently", async () => {
		const realizer = createFakeRealizer();
		const base = realizer.observe.bind(realizer);
		realizer.observe = async (input, ctx) => {
			const obs = await base(input, ctx);
			for (const r of obs.resources)
				r.attributes = {
					"policy.document": "p".repeat(40_000),
					"z.after": "kept?",
				};
			return obs;
		};
		const h = harness({
			observeFields: ["policy.document", "z.after"],
			realizer,
		});
		const resolved = resolvedFor(CAMP, [{ name: "api" }]);
		await h.desired.publish(setFor(CAMP, resolved, 1), resolved);
		const obs = await h.reconciler("r1").reconcileOnce(CAMP, h.ctx);
		const api = obs.resources.find((r) => r.resource === "api");
		const doc = api?.attributes["policy.document"] ?? "";
		expect(new TextEncoder().encode(doc).length).toBeLessThan(16_384);
		expect(doc).toMatch(/…\[truncated sha256:[0-9a-f]{64}\]$/u);
		const codes = obs.reasons.map((r) => `${r.code}@${r.subject}`);
		expect(codes).toContain("attribute-truncated@api/policy.document");
		expect(codes).toContain("attribute-dropped@api/z.after");
	});

	it("ORPHAN_DATA keeps the database and records it", async () => {
		const h = harness();
		const r1 = resolvedFor(CAMP, V1);
		await h.desired.publish(setFor(CAMP, r1, 1), r1);
		const rec = h.reconciler("r1");
		await rec.reconcileOnce(CAMP, h.ctx);
		const depart = resolvedFor(CAMP, []);
		await h.desired.publish(
			setFor(CAMP, depart, 2, SetOrigin.DEPARTURE),
			depart,
		);
		const obs = await rec.reconcileOnce(CAMP, h.ctx);
		expect(h.realizer.mutatingCalls).toContain("delete:api");
		expect(h.realizer.mutatingCalls).not.toContain("delete:db");
		expect(h.realizer.target.has("db")).toBe(true);
		expect(h.realizer.lastKeep).toEqual(["db"]);
		const departed = statusEvents(h.store, CAMP).filter(
			(e) => e.type === CD_EVENTS.CampDeparted,
		);
		expect(departed).toHaveLength(1);
		expect(
			departed[0] && (departed[0].data as { orphans: string[] }).orphans,
		).toEqual(["db"]);
		expect(obs.reasons.map((r) => r.code)).toContain("departure-orphaned");
	});

	it("DELETE departure removes data too; a realizer that ignores `keep` is caught", async () => {
		const del = harness({ departure: DepartureAction.DELETE });
		const r1 = resolvedFor(CAMP, V1);
		await del.desired.publish(setFor(CAMP, r1, 1), r1);
		const rec = del.reconciler("r1");
		await rec.reconcileOnce(CAMP, del.ctx);
		const depart = resolvedFor(CAMP, []);
		await del.desired.publish(
			setFor(CAMP, depart, 2, SetOrigin.DEPARTURE),
			depart,
		);
		await rec.reconcileOnce(CAMP, del.ctx);
		expect(del.realizer.target.size).toBe(0);

		const bad = harness();
		bad.realizer.ignoreKeep = true;
		await bad.desired.publish(setFor(CAMP, r1, 1), r1);
		const rec2 = bad.reconciler("r1");
		await rec2.reconcileOnce(CAMP, bad.ctx);
		await bad.desired.publish(
			setFor(CAMP, depart, 2, SetOrigin.DEPARTURE),
			depart,
		);
		const obs = await rec2.reconcileOnce(CAMP, bad.ctx);
		expect(obs.status).toBe(ReconcileStatus.BLOCKED);
		expect(obs.reasons.map((r) => r.code)).toContain("departure-keep-violated");
	});
});
