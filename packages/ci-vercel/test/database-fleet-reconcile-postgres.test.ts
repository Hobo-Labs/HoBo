import {
	addUsage,
	billingPeriod,
	DEFAULT_FLEET_POLICY,
	type FleetBackend,
	type FleetEvent,
	type FleetReconcileOptions,
	parseFleetFinancialModel,
	readCurrentAssignment,
	readDataDigests,
	readWatermark,
	reconcileFleet,
	replicateSnapshot,
	type SqlExecutor,
	sqlAssignmentRegister,
} from "@hobo/data-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backendAt,
	createTestFleet,
	fleetServersAvailable,
	type TestBackend,
	testLayout,
} from "./database-fleet-harness.js";

/** Real PostgreSQL. Set HOBO_CI_TEST_FLEET_POSTGRES to three servers. */
const SCHEMA = [
	"CREATE TABLE IF NOT EXISTS hobo_ci_events (seq bigserial PRIMARY KEY, body text NOT NULL)",
	"CREATE TABLE IF NOT EXISTS hobo_ci_configuration (partition_id text PRIMARY KEY, body text NOT NULL)",
];

/** PLACEHOLDER plans for tests: a monthly operations cap, then a hard stop. */
function capped(backend: string, operations: number) {
	return parseFleetFinancialModel({
		backend,
		plan: "placeholder",
		fixedMonthlyFeeMicros: 0,
		allowances: [
			{
				unit: "operations",
				included: operations,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
		],
		evidence: { source: "placeholder for tests", observedAt: "2026-11-10" },
	});
}

/** A backend that can be taken down without stopping its server. */
function switchable(backend: TestBackend) {
	const state = { down: false };
	const refuse = () =>
		Promise.reject(
			Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			}),
		);
	const executor: SqlExecutor = {
		query: (sql, parameters) =>
			state.down ? refuse() : backend.executor.query(sql, parameters),
		session: (run) => (state.down ? refuse() : backend.executor.session(run)),
	};
	return { state, backend: { id: backend.id, executor } };
}

describe.skipIf(!fleetServersAvailable)(
	"fleet reconciler on PostgreSQL",
	() => {
		let fleet: Awaited<ReturnType<typeof createTestFleet>>;
		let raw: TestBackend[];
		let nodes: ReturnType<typeof switchable>[];
		let backends: FleetBackend[];
		let offset = 0;
		let events: FleetEvent[];
		const now = () => Date.now() + offset;
		const options = (
			overrides: Partial<FleetReconcileOptions> = {},
		): FleetReconcileOptions => ({
			backends,
			layout: testLayout,
			models: [
				capped("b0", 1_000_000_000),
				capped("b1", 1_000_000_000),
				capped("b2", 1_000_000_000),
			],
			policy: { ...DEFAULT_FLEET_POLICY, failoverAfterMs: 4000, minDwellMs: 0 },
			leaseMs: 30_000,
			graceMs: 5000,
			ensureSchema: async (backend) => {
				const pool = raw.find((entry) => entry.id === backend.id)?.pool;
				for (const statement of SCHEMA) await pool?.query(statement);
			},
			checkBudget: () => ({ ok: true, code: "ok", reason: "affordable" }),
			meter: undefined,
			limits: undefined,
			decidedBy: "test-reconciler",
			now,
			sleep: async (ms) => {
				offset += ms;
			},
			log: (event) => {
				events.push(event);
			},
			...overrides,
		});
		const writerRows = async (backend: TestBackend) =>
			(
				await backend.pool.query(
					"SELECT seq::text, body FROM hobo_ci_events ORDER BY seq",
				)
			).rows;

		beforeEach(async () => {
			fleet = await createTestFleet(3);
			raw = fleet.backends;
			nodes = raw.map(switchable);
			backends = nodes.map((node) => node.backend);
			offset = 0;
			events = [];
			for (const statement of SCHEMA)
				await backendAt(raw, 0).pool.query(statement);
			await backendAt(raw, 0).pool.query(
				"INSERT INTO hobo_ci_events (body) VALUES ('one'), ('two'), ('three')",
			);
		});
		afterEach(async () => {
			await fleet.close();
		});

		it("bootstraps, creates the schema on standbys, copies and keeps the writer", async () => {
			const report = await reconcileFleet(options());
			expect(report.status).toBe("settled");
			expect(report.assignment).toMatchObject({ epoch: 1, active: "b0" });
			expect(report.transitions).toMatchObject([
				{ step: "bootstrap", status: "decided", active: "b0" },
			]);
			expect(report.replications).toMatchObject([
				{ source: "b0", target: "b1", status: "replicated", rows: 3 },
				{ source: "b0", target: "b2", status: "replicated", rows: 3 },
			]);
			expect(report.decision).toMatchObject({
				action: "keep",
				reasons: ["writer-healthy"],
			});
			for (const standby of raw.slice(1)) {
				expect(await readDataDigests(standby, testLayout)).toEqual(
					await readDataDigests(backendAt(raw, 0), testLayout),
				);
				expect(await readWatermark(standby, testLayout)).toMatchObject({
					source: "b0",
					sourceEpoch: 1,
				});
			}
			expect(
				report.observations.map((entry) => [
					entry.backend,
					entry.health,
					entry.schemaCurrent,
				]),
			).toEqual([
				["b0", "reachable", true],
				["b1", "reachable", true],
				["b2", "reachable", true],
			]);
			const lag = report.observations[1]?.standbyLagMs;
			expect(lag).toBeGreaterThanOrEqual(0);
			expect(lag).toBeLessThan(10_000);
			// A second tick has nothing to rewrite.
			const idle = await reconcileFleet(options());
			expect(idle.replications.map((entry) => entry.bytes)).toEqual([0, 0]);
			expect(events.map((event) => event.kind)).toContain("decision");
		});

		it("switches on a budget signal without losing a row, and overwrites the old writer", async () => {
			await reconcileFleet(options());
			const [first, second] = raw;
			if (!first || !second) throw new Error("fleet too small");
			// The writer has all but spent a small allowance this month.
			const period = billingPeriod(now());
			await addUsage(first, testLayout, {
				period: period.id,
				unit: "operations",
				used: 9990,
			});
			// Written after the last copy: only the final copy can carry it.
			await first.pool.query(
				"INSERT INTO hobo_ci_events (body) VALUES ('late')",
			);
			const models = [
				capped("b0", 10_000),
				capped("b1", 1_000_000_000),
				capped("b2", 5_000_000),
			];
			const before = offset;
			const report = await reconcileFleet(options({ models }));
			expect(report.decision).toMatchObject({
				action: "switch",
				target: "b1",
				reasons: ["operations-exhaustion-projected"],
			});
			expect(report.transitions).toMatchObject([
				{ step: "seal", status: "decided", active: "b0", target: "b1" },
				{ step: "activate", status: "decided", active: "b1" },
			]);
			// Writers were given a lease and a grace to stop before the final copy.
			expect(offset - before).toBeGreaterThanOrEqual(35_000);
			expect(report.assignment).toMatchObject({
				epoch: 3,
				active: "b1",
				sealed: false,
				lossWindowMs: undefined,
				reason: "switch-complete",
			});
			expect(await writerRows(second)).toEqual(await writerRows(first));
			expect((await writerRows(second)).at(-1)).toEqual({
				seq: "4",
				body: "late",
			});
			// The new writer's sequence continues after the copied rows.
			const next = await second.pool.query(
				"INSERT INTO hobo_ci_events (body) VALUES ('on-new-writer') RETURNING seq::text",
			);
			expect(next.rows).toEqual([{ seq: "5" }]);
			// A row written on the old writer after it lost the role is gone after
			// the next tick: it is a standby now and is overwritten.
			await first.pool.query(
				"INSERT INTO hobo_ci_events (body) VALUES ('stale-writer')",
			);
			const after = await reconcileFleet(options({ models }));
			expect(after.assignment).toMatchObject({ epoch: 3, active: "b1" });
			expect(after.replications).toMatchObject([
				{ source: "b1", target: "b0", status: "replicated" },
				{ source: "b1", target: "b2", status: "replicated" },
			]);
			expect(await writerRows(first)).toEqual(await writerRows(second));
			// And the old writer is not somewhere to switch back to.
			expect(after.decision?.action).toBe("keep");
		});

		it("fails over after the threshold, records the loss window, and refuses to overwrite the new writer", async () => {
			const settled = await reconcileFleet(options());
			const [first, second, third] = raw;
			const [writer] = nodes;
			if (!first || !second || !third || !writer)
				throw new Error("fleet too small");
			// The third standby misses one round: it will be staler.
			await first.pool.query(
				"INSERT INTO hobo_ci_events (body) VALUES ('four')",
			);
			offset += 60_000;
			const assignment = settled.assignment;
			if (!assignment) throw new Error("fleet was not settled");
			await replicateSnapshot({
				source: first,
				target: second,
				layout: testLayout,
				assignment,
			});
			// Written after the last copy, then the writer goes away.
			await first.pool.query(
				"INSERT INTO hobo_ci_events (body) VALUES ('lost')",
			);
			offset += 5 * 60_000;
			writer.state.down = true;
			const before = offset;
			const report = await reconcileFleet(options());
			// It waited out the failover threshold before deciding (the slept
			// part of it; the probes themselves took the rest in real time).
			expect(offset - before).toBeGreaterThanOrEqual(3500);
			expect(report.observations[0]).toMatchObject({
				backend: "b0",
				health: "unreachable",
			});
			expect(report.observations[0]?.failingForMs).toBeGreaterThanOrEqual(4000);
			expect(report.decision).toMatchObject({
				action: "failover",
				target: "b1",
				reasons: ["writer-unreachable"],
			});
			const lag = report.decision?.lossWindowMs ?? 0;
			// The databases keep real time while this test's clock was advanced
			// one minute before the last copy, five after it, and the threshold.
			expect(lag).toBeGreaterThanOrEqual(6 * 60_000 + 4000);
			expect(lag).toBeLessThan(6 * 60_000 + 30_000);
			expect(report.assignment).toMatchObject({
				epoch: 2,
				active: "b1",
				lossWindowMs: lag,
				reason: "failover:writer-unreachable",
			});
			expect((await writerRows(second)).map((row) => row.body)).toEqual([
				"one",
				"two",
				"three",
				"four",
			]);
			// The old writer returns still believing it is the writer; its own log
			// says so until repaired, and it is then an ordinary standby.
			writer.state.down = false;
			const stale = await replicateSnapshot({
				source: first,
				target: second,
				layout: testLayout,
				assignment,
			});
			expect(stale).toMatchObject({
				status: "refused",
				refusal: "target-is-writer",
			});
			const next = await reconcileFleet(options());
			expect(next.assignment).toMatchObject({ epoch: 2, active: "b1" });
			expect(next.replications).toMatchObject([
				{ source: "b1", target: "b0", status: "replicated" },
				{ source: "b1", target: "b2", status: "replicated" },
			]);
			expect((await writerRows(first)).map((row) => row.body)).not.toContain(
				"lost",
			);
		});

		it("holds instead of promoting a standby older than the objective", async () => {
			await reconcileFleet(options());
			const [writer] = nodes;
			if (!writer) throw new Error("fleet too small");
			offset += 21 * 60_000;
			writer.state.down = true;
			const report = await reconcileFleet(options());
			expect(report.decision).toMatchObject({
				action: "hold",
				target: undefined,
				reasons: ["writer-unreachable", "no-standby-within-rpo"],
			});
			expect(
				report.decision?.candidates.map((entry) => entry.reasons[0]),
			).toEqual(["lag 21m exceeds rpo 20m", "lag 21m exceeds rpo 20m"]);
			expect(report.transitions).toEqual([]);
			const resolution = await readCurrentAssignment(
				sqlAssignmentRegister(raw, testLayout),
			);
			expect(resolution).toMatchObject({
				status: "current",
				assignment: { epoch: 1, active: "b0" },
			});
		});

		it("stops without a majority and changes nothing", async () => {
			await reconcileFleet(options());
			const [, second, third] = nodes;
			if (!second || !third) throw new Error("fleet too small");
			second.state.down = true;
			third.state.down = true;
			const report = await reconcileFleet(options());
			expect(report).toMatchObject({
				status: "no-majority",
				transitions: [],
				replications: [],
			});
		});

		it("lets two reconcilers race: one decision per epoch", async () => {
			await reconcileFleet(options());
			const [first] = raw;
			if (!first) throw new Error("fleet too small");
			await addUsage(first, testLayout, {
				period: billingPeriod(now()).id,
				unit: "operations",
				used: 9990,
			});
			const models = [
				capped("b0", 10_000),
				capped("b1", 1_000_000_000),
				capped("b2", 5_000_000),
			];
			const reports = await Promise.all([
				reconcileFleet(options({ models, decidedBy: "left" })),
				reconcileFleet(options({ models, decidedBy: "right" })),
			]);
			const decided = reports
				.flatMap((report) => report.transitions)
				.filter((entry) => entry.status === "decided");
			// One seal and one activation in total, whoever did which.
			expect(decided.map((entry) => entry.step).sort()).toEqual([
				"activate",
				"seal",
			]);
			expect(new Set(decided.map((entry) => entry.epoch)).size).toBe(2);
			const logs = await Promise.all(
				raw.map(
					async (backend) =>
						(
							await backend.pool.query(
								"SELECT epoch::text, active, sealed, decided_by FROM hobo_ci_fleet_assignments ORDER BY epoch",
							)
						).rows,
				),
			);
			expect(logs[1]).toEqual(logs[0]);
			expect(logs[2]).toEqual(logs[0]);
			expect(logs[0]?.map((row) => row.epoch)).toEqual(["1", "2", "3"]);
			const resolution = await readCurrentAssignment(
				sqlAssignmentRegister(raw, testLayout),
			);
			expect(resolution).toMatchObject({
				status: "current",
				assignment: { epoch: 3, active: "b1", sealed: false },
			});
		});
	},
);
