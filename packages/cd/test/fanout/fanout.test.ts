// WP23 fan-out acceptance (D21, I20; §10 rows "3 of 400 Camps offline",
// "Failures exceed the budget mid-fan-out", "Mandatory pilot group fails").
import { describe, expect, it } from "vitest";
import {
	DepartureAction,
	FanoutState,
	FanoutStrategy,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS, CD_SUBSCRIPTIONS } from "../../src/events.js";
import {
	campKey,
	FANOUT_METRIC,
	FANOUT_REASON,
	foldFanout,
	statusOf,
} from "../../src/fanout/index.js";
import type { FanoutId } from "../../src/ports.js";
import {
	camp,
	decisionOf,
	FREIGHT,
	fanoutOf,
	groupAt,
	healthy,
	MINUTE,
} from "./fakes.js";
import { addCamps, drive, freightB, harness, startInput } from "./harness.js";

describe("fan-out: 400 Camps PROGRESSIVE_PER_GROUP with 3 unreachable (§10 WP23 row 1)", () => {
	it("defers the 3 unreachable Camps (never failed), qualifies quorum 95%, and catches them up on reconnect", async () => {
		const h = harness();
		const decision = decisionOf(400, 40);
		addCamps(h, decision);
		const offline = ["c017", "c205", "c399"];
		for (const id of offline) h.inventory.setStatus(id, healthy(id, [], false));

		const started = await h.controller.start(
			startInput(decision, fanoutOf()),
			h.ctx,
		);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await drive(h);

		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(status?.state).toBe(FanoutState.COMPLETED);
		expect(status?.failed).toEqual([]);
		expect([...(status?.deferred ?? [])].sort()).toEqual(offline);
		expect(status?.succeeded).toHaveLength(397);

		const qualified = await h.controller.qualified({
			pipeline: "web",
			node: "prod",
		});
		expect(qualified.stableFreightId).toBe(FREIGHT);
		expect(qualified.qualifiedCampIds.length).toBeGreaterThanOrEqual(
			Math.ceil(0.95 * 400),
		);
		for (const id of offline)
			expect(qualified.qualifiedCampIds).not.toContain(id);
		// The unreachable Camps never had a promotion requested.
		for (const id of offline)
			expect(
				h.promotions.calls.some((c) => c.request.targets.includes(camp(id))),
			).toBe(false);

		// Reconnect: they catch up to the node's qualified Freight (MATCH_NODE).
		for (const id of offline) h.inventory.setStatus(id, healthy(id));
		await drive(h);
		const after = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(after?.deferred).toEqual([]);
		expect(after?.succeeded).toHaveLength(400);
		const caughtUp = h.promotions.calls.filter((c) =>
			offline.includes(c.request.targets[0] ?? ""),
		);
		expect(caughtUp.every((c) => c.request.freightId === FREIGHT)).toBe(true);
		expect(caughtUp.map((c) => c.request.idempotencyKey).sort()).toEqual(
			offline.map((id) => campKey(started.value.fanoutId, id)).sort(),
		);
		expect(
			(await h.controller.qualified({ pipeline: "web", node: "prod" }))
				.qualifiedCampIds,
		).toHaveLength(400);
		expect(h.telemetry.count(FANOUT_METRIC.stepError)).toBe(0);
		expect(h.telemetry.count(FANOUT_METRIC.started)).toBe(1);
	});

	it("defers Camps that are NO_PLACE-tainted or in a closed window at their turn", async () => {
		const h = harness();
		const decision = decisionOf(10, 5);
		addCamps(h, decision);
		h.inventory.setStatus(
			"c001",
			healthy("c001", [
				{
					key: "lease-lost",
					value: "",
					effect: 1,
					source: 1,
					reason: "",
					addedBy: "",
					addedAt: "",
					$typeName: "hobo.cd.v1.TaintRecord",
				},
			]),
		);
		h.windows.closed.add("c006");
		const started = await h.controller.start(
			startInput(decision, fanoutOf(), { windows: ["prod-weekdays"] }),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		await drive(h);
		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect([...(status?.deferred ?? [])].sort()).toEqual(["c001", "c006"]);
		expect(status?.failed).toEqual([]);
		expect(
			h.windows.calls.some((names) => names.includes("prod-weekdays")),
		).toBe(true);
	});
});

describe("fan-out: mandatory groups (§10 WP23 row 3)", () => {
	it("a mandatory pilot group failure blocks the remaining groups; they never start", async () => {
		const h = harness();
		const decision = decisionOf(30, 10, { mandatory: ["pilot"] });
		addCamps(h, decision);
		const started = await h.controller.start(
			startInput(
				decision,
				fanoutOf({ mandatoryGroups: ["pilot"], maxFailures: 10 }),
			),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		await drive(h, (campId) => (campId === "c003" ? "fail" : "pass"));
		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(status?.state).toBe(FanoutState.HALTED);
		expect(status?.reasons[0]?.code).toBe(FANOUT_REASON.mandatoryFailed);
		const requested = new Set(
			h.promotions.calls.map((c) => c.request.targets[0]),
		);
		for (let i = 10; i < 30; i += 1)
			expect(requested.has(camp(`c${String(i).padStart(3, "0")}`))).toBe(false);
		expect(status?.pending).toHaveLength(20);
	});

	it("runs mandatory groups first even when declared later in the decision", async () => {
		const h = harness();
		const decision = decisionOf(20, 10);
		groupAt(decision, 1).name = "canary";
		addCamps(h, decision);
		const started = await h.controller.start(
			startInput(
				decision,
				fanoutOf({
					strategy: FanoutStrategy.PROGRESSIVE,
					maxConcurrency: 20,
					mandatoryGroups: ["canary"],
				}),
			),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		const first = h.promotions.calls.map((c) => c.request.targets[0]);
		expect(first).toHaveLength(10);
		expect(first.every((id) => Number(String(id).slice(1)) >= 10)).toBe(true);
	});
});

describe("fan-out: failure budget (§10 WP23 row 2)", () => {
	it("exceeding 2% failures halts, and rollback_on_halt restores the failed Camps only", async () => {
		const h = harness();
		const decision = decisionOf(400, 40);
		addCamps(h, decision);
		// 2% of 400 = 8 tolerated; the 9th failure halts. All failures sit in group 0.
		const failing = new Set(
			Array.from({ length: 9 }, (_, i) => `c${String(i * 4).padStart(3, "0")}`),
		);
		const started = await h.controller.start(
			startInput(
				decision,
				fanoutOf({ maxFailuresPercent: 2, maxConcurrency: 40 }),
			),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		await drive(h, (campId) => (failing.has(campId) ? "fail" : "pass"));
		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(status?.state).toBe(FanoutState.HALTED);
		expect(status?.reasons[0]?.code).toBe(FANOUT_REASON.budgetExceeded);
		expect(new Set(status?.failed)).toEqual(failing);
		expect(h.promotions.rollbacks.map((r) => r.campId).sort()).toEqual(
			[...failing].sort(),
		);
		// Succeeded Camps were never rolled back; later groups never started.
		expect(status?.succeeded.every((id) => !failing.has(id))).toBe(true);
		expect(
			h.promotions.calls.some((c) => c.request.targets[0] === "c040"),
		).toBe(false);
		expect(h.telemetry.count(FANOUT_METRIC.halted)).toBe(1);
		expect(h.telemetry.count(FANOUT_METRIC.rolledBack)).toBe(9);
	});

	it("8 failures out of 400 at 2% stay within budget and the run completes", async () => {
		const h = harness();
		const decision = decisionOf(400, 40);
		addCamps(h, decision);
		const failing = new Set(
			Array.from(
				{ length: 8 },
				(_, i) => `c${String(i * 50).padStart(3, "0")}`,
			),
		);
		const started = await h.controller.start(
			startInput(decision, fanoutOf({ maxFailuresPercent: 2 })),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		await drive(h, (campId) => (failing.has(campId) ? "fail" : "pass"));
		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(status?.state).toBe(FanoutState.COMPLETED);
		expect(h.promotions.rollbacks).toEqual([]);
	});

	it("deferred Camps never count against max_failures", async () => {
		const h = harness();
		const decision = decisionOf(20, 10);
		addCamps(h, decision);
		for (let i = 0; i < 5; i += 1)
			h.inventory.setStatus(`c00${i}`, healthy(`c00${i}`, [], false));
		const started = await h.controller.start(
			startInput(decision, fanoutOf({ maxFailures: 1 })),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		await drive(h);
		expect(
			(await h.controller.get(started.value.fanoutId as FanoutId))?.state,
		).toBe(FanoutState.COMPLETED);
	});

	it("fails a Camp whose promotion does not qualify within progress_deadline_ms", async () => {
		const h = harness();
		const decision = decisionOf(2, 2);
		addCamps(h, decision);
		const started = await h.controller.start(
			startInput(
				decision,
				fanoutOf({ maxFailures: 5, progressDeadlineMs: BigInt(5 * MINUTE) }),
			),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		await drive(h, (campId) => (campId === "c000" ? "hold" : "pass"), {
			maxTicks: 10,
		});
		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(status?.failed).toEqual(["c000"]);
		const events = h.store.events(CD_STREAMS.fanout(started.value.fanoutId));
		expect(JSON.stringify(events)).toContain(FANOUT_REASON.progressDeadline);
	});
});

describe("fan-out: bounded concurrency under chaos (I20)", () => {
	it("never more than max_concurrency in flight with transient port failures, failures and two replicas", async () => {
		const h = harness({ leases: true });
		const replicaB = h.make("replica-b");
		const decision = decisionOf(120, 30);
		addCamps(h, decision);
		let seed = 7;
		const rand = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
			return seed / 2_147_483_648;
		};
		h.promotions.throwOn = () => rand() < 0.15;
		const max = 7;
		const started = await h.controller.start(
			startInput(
				decision,
				fanoutOf({
					strategy: FanoutStrategy.PROGRESSIVE,
					maxConcurrency: max,
					maxFailures: 120,
				}),
			),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		const stream = CD_STREAMS.fanout(started.value.fanoutId);
		let peakJournal = 0;
		for (let i = 0; i < 300; i += 1) {
			const controller = rand() < 0.5 ? h.controller : replicaB;
			// A competing replica sometimes holds the lease: that tick does nothing.
			if (rand() < 0.2)
				await h.store.holdLease(
					CD_SUBSCRIPTIONS.fanout(started.value.fanoutId),
					"replica-c",
					10,
				);
			await controller.tick(h.ctx).catch(() => undefined);
			const view = foldFanout(h.store.events(stream));
			if (view)
				peakJournal = Math.max(peakJournal, statusOf(view).inFlight.length);
			for (const promotion of h.promotions.live()) {
				const r = rand();
				if (r < 0.5)
					h.promotions.settle(
						promotion.targetCampIds[0] ?? "",
						r < 0.1 ? "fail" : "pass",
					);
			}
			h.time.advance(MINUTE + 1);
		}
		expect(peakJournal).toBeLessThanOrEqual(max);
		expect(h.promotions.peakLive).toBeLessThanOrEqual(max);
		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(status?.state).toBe(FanoutState.COMPLETED);
	});

	it("a tick while another replica holds the lease changes nothing", async () => {
		const h = harness({ leases: true });
		const decision = decisionOf(10, 5);
		addCamps(h, decision);
		const started = await h.controller.start(
			startInput(decision, fanoutOf()),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		const before = h.store.events(
			CD_STREAMS.fanout(started.value.fanoutId),
		).length;
		for (const p of h.promotions.live())
			h.promotions.settle(p.targetCampIds[0] ?? "", "pass");
		h.time.advance(2 * MINUTE);
		await h.store.holdLease(
			CD_SUBSCRIPTIONS.fanout(started.value.fanoutId),
			"replica-z",
		);
		await h.controller.tick(h.ctx);
		expect(
			h.store.events(CD_STREAMS.fanout(started.value.fanoutId)).length,
		).toBe(before);
	});
});

describe("fan-out: control and lifecycle", () => {
	it("start is idempotent: the same key yields one fan-out and one promotion per Camp", async () => {
		const h = harness();
		const decision = decisionOf(4, 4);
		addCamps(h, decision);
		const input = startInput(decision, fanoutOf());
		const a = await h.controller.start(input, h.ctx);
		const b = await h.controller.start(input, h.ctx);
		expect(a.ok && b.ok && a.value.fanoutId === b.value.fanoutId).toBe(true);
		expect((await h.controller.list()).length).toBe(1);
		expect(
			new Set(h.promotions.calls.map((c) => c.request.idempotencyKey)).size,
		).toBe(4);
		expect(
			h.promotions.calls.every(
				(c) => c.request.fanoutId === (a.ok ? a.value.fanoutId : ""),
			),
		).toBe(true);
	});

	it("refuses yanked Freight at start and halts a running fan-out when its Freight is yanked (I13)", async () => {
		const h = harness();
		const decision = decisionOf(4, 2);
		addCamps(h, decision);
		h.freight.yanked.add(freightB);
		const refused = await h.controller.start(
			startInput(decision, fanoutOf(), { freightId: freightB }),
			h.ctx,
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.reasons[0]?.code).toBe(FANOUT_REASON.freightUnusable);

		const started = await h.controller.start(
			startInput(decision, fanoutOf()),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		h.freight.yanked.add(FREIGHT);
		await h.controller.tick(h.ctx);
		const status = await h.controller.get(started.value.fanoutId as FanoutId);
		expect(status?.state).toBe(FanoutState.HALTED);
		expect(status?.reasons[0]?.code).toBe(FANOUT_REASON.freightUnusable);
	});

	it("refuses a decision for another node, unknown mandatory groups and ambiguous limits", async () => {
		const h = harness();
		const decision = decisionOf(4, 2);
		const other = await h.controller.start(
			startInput(decision, fanoutOf(), { node: "staging" }),
			h.ctx,
		);
		expect(other.ok ? "" : other.reasons[0]?.code).toBe(
			FANOUT_REASON.decisionMismatch,
		);
		const unknown = await h.controller.start(
			startInput(decision, fanoutOf({ mandatoryGroups: ["nope"] })),
			h.ctx,
		);
		expect(unknown.ok ? "" : unknown.reasons[0]?.code).toBe(
			FANOUT_REASON.unknownMandatoryGroup,
		);
		const both = await h.controller.start(
			startInput(
				decision,
				fanoutOf({ maxConcurrency: 2, maxConcurrencyPercent: 10 }),
			),
			h.ctx,
		);
		expect(both.ok ? "" : both.reasons[0]?.code).toBe(FANOUT_REASON.invalid);
	});

	it("halt, resume and rollback are governed: proposal-only and denied principals are refused", async () => {
		const h = harness();
		const decision = decisionOf(10, 5);
		addCamps(h, decision);
		const started = await h.controller.start(
			startInput(decision, fanoutOf()),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		const id = started.value.fanoutId as FanoutId;
		h.authorizer.proposalOnly.add("fanout.halt");
		expect((await h.controller.halt(id, "stop", h.ctx)).ok).toBe(false);
		h.authorizer.proposalOnly.clear();
		const halted = await h.controller.halt(id, "operator stop", h.ctx);
		expect(halted.ok && halted.value.state).toBe(FanoutState.HALTED);
		const calls = h.promotions.calls.length;
		await h.controller.tick(h.ctx);
		expect(h.promotions.calls.length).toBe(calls);
		h.authorizer.deny.add("fanout.resume");
		expect((await h.controller.resume(id, h.ctx)).ok).toBe(false);
		h.authorizer.deny.clear();
		const resumed = await h.controller.resume(id, h.ctx);
		expect(resumed.ok && resumed.value.state).toBe(FanoutState.RUNNING);
		const rolled = await h.controller.rollback(id, "bad release", h.ctx);
		expect(rolled.ok && rolled.value.state).toBe(FanoutState.ROLLED_BACK);
		expect(h.promotions.rollbacks.map((r) => r.campId).sort()).toEqual([
			"c000",
			"c001",
			"c002",
			"c003",
			"c004",
		]);
		expect(h.authorizer.calls.map((c) => c.action)).toEqual(
			expect.arrayContaining([
				"promote",
				"fanout.halt",
				"fanout.resume",
				"fanout.rollback",
			]),
		);
	});

	it("resume restarts the failure budget from the failures already counted", async () => {
		const h = harness();
		const decision = decisionOf(10, 10);
		addCamps(h, decision);
		const started = await h.controller.start(
			startInput(
				decision,
				fanoutOf({ maxFailures: 1, maxConcurrency: 3, rollbackOnHalt: false }),
			),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		const id = started.value.fanoutId as FanoutId;
		await drive(h, (c) => (["c000", "c001"].includes(c) ? "fail" : "pass"), {
			maxTicks: 3,
		});
		expect((await h.controller.get(id))?.state).toBe(FanoutState.HALTED);
		expect(h.promotions.rollbacks).toEqual([]);
		await h.controller.resume(id, h.ctx);
		await drive(h);
		expect((await h.controller.get(id))?.state).toBe(FanoutState.COMPLETED);
	});

	it("newer Freight supersedes an in-flight fan-out at the next group boundary, then runs", async () => {
		const h = harness();
		const decision = decisionOf(20, 5);
		addCamps(h, decision);
		const first = await h.controller.start(
			startInput(decision, fanoutOf()),
			h.ctx,
		);
		if (!first.ok) throw new Error("start refused");
		const second = await h.controller.start(
			startInput(decision, fanoutOf(), { freightId: freightB }),
			h.ctx,
		);
		if (!second.ok) throw new Error("start refused");
		// The newer fan-out waits; the older one still has group 0 in flight.
		expect(
			h.promotions.calls.filter((c) => c.request.freightId === freightB),
		).toHaveLength(0);
		await drive(h);
		const old = await h.controller.get(first.value.fanoutId as FanoutId);
		expect(old?.state).toBe(FanoutState.SUPERSEDED);
		expect(old?.succeeded).toEqual(["c000", "c001", "c002", "c003", "c004"]);
		expect(old?.pending).toHaveLength(15);
		const next = await h.controller.get(second.value.fanoutId as FanoutId);
		expect(next?.state).toBe(FanoutState.COMPLETED);
		expect(next?.succeeded).toHaveLength(20);
	});

	it("Camps dropped by a new decision depart per DepartureAction (ORPHAN_DATA keeps data, records it)", async () => {
		const h = harness();
		const first = decisionOf(4, 4, { decisionId: "d1" });
		addCamps(h, first);
		const a = await h.controller.start(startInput(first, fanoutOf()), h.ctx);
		if (!a.ok) throw new Error("start refused");
		await drive(h);
		h.desired.place("c003", [
			{ name: "web", port: "hobo:http-service" },
			{ name: "orders-db", port: "database" },
		]);
		const second = decisionOf(3, 3, { decisionId: "d2" });
		const b = await h.controller.start(
			startInput(second, fanoutOf(), { freightId: freightB }),
			h.ctx,
		);
		if (!b.ok) throw new Error("start refused");
		await drive(h);
		const departs = h.promotions.calls.filter(
			(c) => c.request.intent === "depart",
		);
		expect(departs.map((c) => c.request.targets[0])).toEqual(["c003"]);
		const departed = h.store
			.events(CD_STREAMS.fanout(b.value.fanoutId))
			.filter((e) => e.type === CD_EVENTS.CampDeparted)
			.map((e) => e.data);
		expect(departed).toEqual([
			expect.objectContaining({
				campId: "c003",
				action: "DEPARTURE_ACTION_ORPHAN_DATA",
				kept: ["orders-db"],
			}),
		]);
		expect(DepartureAction[DepartureAction.ORPHAN_DATA]).toBe("ORPHAN_DATA");
	});

	it("replay equals live: folding the journal rebuilds the exact status (I8)", async () => {
		const h = harness();
		const decision = decisionOf(30, 10);
		addCamps(h, decision);
		h.inventory.setStatus("c011", healthy("c011", [], false));
		const started = await h.controller.start(
			startInput(decision, fanoutOf()),
			h.ctx,
		);
		if (!started.ok) throw new Error("start refused");
		await drive(h, (c) => (c === "c004" ? "fail" : "pass"));
		const live = await h.controller.get(started.value.fanoutId as FanoutId);
		const replay = foldFanout(
			h.store.events(CD_STREAMS.fanout(started.value.fanoutId)),
		);
		expect(replay && statusOf(replay)).toEqual(live);
	});
});
