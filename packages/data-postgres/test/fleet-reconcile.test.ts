/**
 * `reconcileFleet` as a caller of the shared one-active loop
 * (`createOneActiveFleet`), over the `SqlExecutor` double: the Postgres
 * observer feeds the loop, `decideFleet` chooses, and the reconcile finishes
 * what the loop sealed.
 */
import { DEFAULT_FLEET_POLICY } from "@hobo/backend-routing";
import { Health } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	type FleetEvent,
	type FleetReconcileOptions,
	parseFleetLayout,
	reconcileFleet,
} from "../src/index.js";
import { FleetSqlDouble } from "./fleet-sql-double.js";

const layout = parseFleetLayout({
	dataPrefix: "app_",
	controlPrefix: "app_fleet_",
});
const START = Date.UTC(2026, 10, 11);

function fleet(names: readonly string[]) {
	const executors = new Map(names.map((name) => [name, new FleetSqlDouble()]));
	let clock = START;
	const events: FleetEvent[] = [];
	const options = (
		overrides: Partial<FleetReconcileOptions> = {},
	): FleetReconcileOptions => ({
		backends: names.map((id) => ({
			id,
			executor: executors.get(id) ?? new FleetSqlDouble(),
		})),
		layout,
		models: [],
		policy: DEFAULT_FLEET_POLICY,
		leaseMs: 1000,
		graceMs: 1000,
		ensureSchema: async () => undefined,
		checkBudget: () => ({ ok: true, code: "ok", reason: "affordable" }),
		meter: undefined,
		limits: undefined,
		decidedBy: "service:reconcile",
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
		log: (event) => events.push(event),
		...overrides,
	});
	const at = (name: string) => {
		const executor = executors.get(name);
		if (executor === undefined) throw new Error(`no backend ${name}`);
		return executor;
	};
	return { options, at, events, now: () => clock };
}

describe("reconcileFleet on the one-active loop", () => {
	it("bootstraps the first backend and keeps a healthy writer", async () => {
		const { options, at, events } = fleet(["a", "b", "c"]);
		const report = await reconcileFleet(options());
		expect(report.status).toBe("settled");
		expect(report.assignment).toMatchObject({ epoch: 1, active: "a" });
		expect(report.transitions[0]).toMatchObject({
			step: "bootstrap",
			status: "decided",
		});
		expect(report.tick).toMatchObject({ action: "keep", active: "a" });
		expect(report.decision?.action).toBe("keep");
		expect(report.observations.map((entry) => entry.name)).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(
			report.observations.every(
				(entry) => entry.observation.health === Health.REACHABLE,
			),
		).toBe(true);
		expect(at("b").log.map((row) => row.reason)).toEqual(["bootstrap"]);
		expect(events.some((event) => event.kind === "tick")).toBe(true);
	});

	it("fails over to the freshest standby and records its lag as the loss window", async () => {
		const { options, at, now } = fleet(["a", "b", "c"]);
		await reconcileFleet(options());
		at("a").up = false;
		at("b").snapshotAtMs = now() - 60_000;
		at("c").snapshotAtMs = now() - 5 * 60_000;
		const report = await reconcileFleet(options());
		expect(report.decision).toMatchObject({
			action: "failover",
			target: "b",
			reasons: ["writer-unreachable"],
		});
		expect(report.tick).toMatchObject({ action: "failover", target: "b" });
		expect(report.transitions.map((entry) => entry.step)).toEqual([
			"failover",
			"activate",
		]);
		expect(report.assignment).toMatchObject({
			epoch: 3,
			active: "b",
			sealed: false,
			reason: "failover-complete",
			// The standby's lag when it was measured: its snapshot was a minute
			// old, and the writer was probed for the minute of the threshold.
			lossWindowMs: 120_000,
		});
		expect(at("c").log.map((row) => row.reason)).toEqual([
			"bootstrap",
			"failover:unreachable",
			"failover-complete",
		]);
	});

	it("activates a failover an earlier tick sealed but did not finish", async () => {
		const { options, at, now } = fleet(["a", "b", "c"]);
		await reconcileFleet(options());
		at("a").up = false;
		at("b").snapshotAtMs = now() - 60_000;
		at("c").snapshotAtMs = now() - 5 * 60_000;
		// Seal by hand, as a reconciler that stopped after the seal left it.
		for (const name of ["b", "c"])
			at(name).log.push({
				epoch: 2,
				active: null,
				sealed: true,
				target: "c",
				reason: "failover:unreachable",
				lossWindowMs: null,
				decidedAtMs: now(),
				decidedBy: "service:other",
				members: null,
			});
		const report = await reconcileFleet(options());
		expect(report.transitions[0]).toMatchObject({
			step: "activate",
			status: "decided",
			active: "c",
		});
		expect(report.assignment).toMatchObject({
			epoch: 3,
			active: "c",
			lossWindowMs: 5 * 60_000,
		});
	});

	it("stops without a majority", async () => {
		const { options, at } = fleet(["a", "b", "c"]);
		await reconcileFleet(options());
		at("a").up = false;
		at("b").up = false;
		const report = await reconcileFleet(options());
		expect(report).toMatchObject({
			status: "no-majority",
			assignment: undefined,
		});
	});

	it("pins the member set as a decided epoch when membership epochs are on", async () => {
		const { options, at } = fleet(["a", "b", "c"]);
		const report = await reconcileFleet(options({ membershipEpochs: true }));
		expect(report.tick).toMatchObject({
			action: "membership",
			reasons: ["pin-members", "proposal-decided"],
		});
		expect(report.transitions.at(-1)).toMatchObject({
			step: "membership",
			status: "decided",
			epoch: 2,
		});
		expect(report.assignment?.members).toEqual(["a", "b", "c"]);
		expect(at("a").log.map((row) => row.members)).toEqual([null, "{a,b,c}"]);
		// A second tick has nothing to change and goes on to decide.
		const next = await reconcileFleet(options({ membershipEpochs: true }));
		expect(next.tick?.action).toBe("keep");
	});

	it("runs a fleet of one backend without the register's loop", async () => {
		const { options } = fleet(["a"]);
		const report = await reconcileFleet(options());
		expect(report.tick).toMatchObject({ action: "single", active: "a" });
		expect(report.assignment).toMatchObject({ epoch: 1, active: "a" });
		expect(report.observations).toHaveLength(1);
	});
});
