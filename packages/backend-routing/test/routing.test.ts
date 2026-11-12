/**
 * Budget routing, offline. Allowances below are the vendor free tiers the
 * ADR-0179 amendment records (Upstash 500,000 commands a month; Turso 500
 * million rows read and 10 million written), used here only as numbers.
 */
import { describe, expect, it } from "vitest";
import {
	billingPeriod,
	DEFAULT_FLEET_ROUTING_MARKS,
	type FleetOffer,
	type FleetRoutingInput,
	type FleetRoutingObservation,
	type FleetUsageMeasurement,
	parseFleetAssignment,
	parseFleetFinancialModel,
	parseFleetOffer,
	parseFleetRoutingMarks,
	routeFleetByBudget,
} from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Ten days into a thirty-day month.
const NOW = Date.UTC(2026, 10, 11);
const evidence = { source: "test numbers", observedAt: "2026-11-11" };

const upstash: FleetOffer = parseFleetOffer({
	tier: "free",
	capMicros: undefined,
	model: parseFleetFinancialModel({
		backend: "upstash",
		plan: "free",
		fixedMonthlyFeeMicros: 0,
		allowances: [
			{
				unit: "commands",
				included: 500_000,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
		],
		evidence,
	}),
});
const turso: FleetOffer = parseFleetOffer({
	tier: "free",
	capMicros: undefined,
	model: parseFleetFinancialModel({
		backend: "turso",
		plan: "free",
		fixedMonthlyFeeMicros: 0,
		allowances: [
			{
				unit: "rows-read",
				included: 500_000_000,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
			{
				unit: "rows-written",
				included: 10_000_000,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
		],
		evidence,
	}),
});
const valkey: FleetOffer = parseFleetOffer({
	tier: "free",
	capMicros: undefined,
	model: parseFleetFinancialModel({
		backend: "valkey",
		plan: "free",
		fixedMonthlyFeeMicros: 0,
		allowances: [],
		evidence,
	}),
});
/** Pay-as-you-go: 0.4 micro-dollars per simple, 5 per advanced operation. */
function blob(capMicros: number | undefined): FleetOffer {
	return parseFleetOffer({
		tier: "payg",
		capMicros,
		model: parseFleetFinancialModel({
			backend: "blob",
			plan: "payg",
			fixedMonthlyFeeMicros: 0,
			allowances: [
				{
					unit: "simple-operations",
					included: 0,
					beyond: "metered",
					meteredMicrosPerUnit: 0.4,
				},
				{
					unit: "advanced-operations",
					included: 0,
					beyond: "metered",
					meteredMicrosPerUnit: 5,
				},
			],
			evidence,
		}),
	});
}

function seen(
	backend: string,
	usage: FleetUsageMeasurement[] = [],
	overrides: Partial<FleetRoutingObservation> = {},
): FleetRoutingObservation {
	return { backend, health: "reachable", failingForMs: 0, usage, ...overrides };
}

/** A month's workload so far, in every unit, at `commands` port calls. */
function workload(commands: number): FleetUsageMeasurement[] {
	return [
		{ unit: "commands", used: commands },
		{ unit: "rows-read", used: commands },
		{ unit: "rows-written", used: Math.round(commands / 2) },
		{ unit: "simple-operations", used: commands },
		{ unit: "advanced-operations", used: Math.round(commands / 2) },
	];
}

function input(
	active: string,
	overrides: Partial<FleetRoutingInput> = {},
): FleetRoutingInput {
	return {
		assignment: parseFleetAssignment({
			epoch: 3,
			active,
			sealed: false,
			target: undefined,
			reason: "test",
			lossWindowMs: undefined,
			decidedAtMs: NOW - 5 * DAY,
			decidedBy: "test",
		}),
		members: ["upstash", "valkey", "turso", "blob"],
		observations: [
			seen("upstash"),
			seen("valkey"),
			seen("turso"),
			seen("blob"),
		],
		workload: workload(0),
		offers: [upstash, valkey, turso, blob(undefined)],
		marks: DEFAULT_FLEET_ROUTING_MARKS,
		period: billingPeriod(NOW),
		nowMs: NOW,
		...overrides,
	};
}

describe("marks", () => {
	it("refuses marks that would flap or are not fractions", () => {
		expect(() =>
			parseFleetRoutingMarks({
				...DEFAULT_FLEET_ROUTING_MARKS,
				switchBackBelow: 0.9,
			}),
		).toThrow(/flaps/u);
		expect(() =>
			parseFleetRoutingMarks({ ...DEFAULT_FLEET_ROUTING_MARKS, switchAt: 1.5 }),
		).toThrow(/fractions/u);
	});
});

describe("before exhaustion", () => {
	it("keeps a free member well inside its allowance", () => {
		// 100,000 commands in ten days: on course for 300,000 of 500,000 (60%).
		const route = routeFleetByBudget(
			input("upstash", {
				workload: workload(100_000),
				observations: [seen("upstash", [{ unit: "commands", used: 100_000 }])],
			}),
		);
		expect(route).toMatchObject({
			action: "keep",
			reasons: ["writer-healthy"],
		});
		expect(route.candidates[0]).toMatchObject({
			backend: "upstash",
			eligible: true,
			projectedFraction: 0.6,
		});
	});

	it("switches at 90% projected, to a free member, not the pay-as-you-go one", () => {
		// 150,000 in ten days: on course for 450,000 (90%).
		const route = routeFleetByBudget(
			input("upstash", {
				workload: workload(150_000),
				observations: [
					seen("upstash", [{ unit: "commands", used: 150_000 }]),
					seen("turso"),
					seen("blob"),
				],
				members: ["upstash", "turso", "blob"],
			}),
		);
		expect(route).toMatchObject({
			action: "switch",
			target: "turso",
			reasons: ["commands projected 90%"],
		});
	});

	it("does not switch back until the member is under the lower mark", () => {
		// On Turso now; Upstash has spent 400,000 this month (projected far past 80%).
		const back = routeFleetByBudget(
			input("turso", {
				workload: workload(150_000),
				observations: [
					seen("upstash", [{ unit: "commands", used: 400_000 }]),
					seen("turso", [{ unit: "rows-written", used: 10_000 }]),
				],
				members: ["upstash", "turso"],
			}),
		);
		expect(back.action).toBe("keep");
		expect(back.candidates[1]).toMatchObject({
			backend: "upstash",
			eligible: false,
		});
		// A new month: Upstash's spend is gone and its projection is low again,
		// but both are free and equally cheap, so no move for its own sake.
		const nextMonth = Date.UTC(2026, 11, 2);
		const fresh = routeFleetByBudget(
			input("turso", {
				nowMs: nextMonth,
				period: billingPeriod(nextMonth),
				workload: workload(10_000),
				observations: [seen("upstash"), seen("turso")],
				members: ["upstash", "turso"],
			}),
		);
		expect(fresh.action).toBe("keep");
		expect(fresh.candidates[1]).toMatchObject({
			backend: "upstash",
			eligible: true,
		});
	});

	it("keeps an exhausting member when nothing else is feasible", () => {
		const route = routeFleetByBudget(
			input("upstash", {
				workload: workload(200_000),
				observations: [
					seen("upstash", [{ unit: "commands", used: 200_000 }]),
					seen("blob"),
				],
				members: ["upstash", "blob"],
			}),
		);
		expect(route).toMatchObject({
			action: "keep",
			reasons: ["commands projected 120%", "no-feasible-standby"],
		});
		expect(route.candidates[1]?.reasons).toContain("over-budget-cap");
	});
});

describe("preference and budget caps", () => {
	it("moves from pay-as-you-go to a free member once it is clear of the lower mark", () => {
		const route = routeFleetByBudget(
			input("blob", {
				workload: workload(10_000),
				offers: [upstash, blob(100_000_000)],
				observations: [seen("upstash"), seen("blob")],
				members: ["upstash", "blob"],
			}),
		);
		expect(route).toMatchObject({
			action: "switch",
			target: "upstash",
			reasons: ["preferred-free"],
		});
	});

	it("waits out the minimum dwell before a move for preference", () => {
		const route = routeFleetByBudget(
			input("blob", {
				workload: workload(10_000),
				offers: [upstash, blob(100_000_000)],
				observations: [seen("upstash"), seen("blob")],
				members: ["upstash", "blob"],
				assignment: parseFleetAssignment({
					epoch: 3,
					active: "blob",
					sealed: false,
					target: undefined,
					reason: "test",
					lossWindowMs: undefined,
					decidedAtMs: NOW - 60_000,
					decidedBy: "test",
				}),
			}),
		);
		expect(route).toMatchObject({
			action: "keep",
			reasons: ["preferred-free", "minimum-dwell-not-reached"],
		});
	});

	it("takes pay-as-you-go only within its cap, and prices fractions of a micro-dollar", () => {
		const capped = routeFleetByBudget(
			input("upstash", {
				workload: workload(150_000),
				offers: [upstash, blob(1_000_000)],
				observations: [
					seen("upstash", [{ unit: "commands", used: 150_000 }]),
					seen("blob"),
				],
				members: ["upstash", "blob"],
			}),
		);
		expect(capped).toMatchObject({ action: "switch", target: "blob" });
		// The twenty days left at the month's rate: 300,000 simple operations at
		// 0.4 and 150,000 advanced at 5 micro-dollars.
		expect(capped.candidates[1]?.projectedCostMicros).toBe(870_000);
	});
});

describe("failover", () => {
	it("holds until the writer has failed long enough, then takes the best reachable member", () => {
		const failing = (failingForMs: number) =>
			routeFleetByBudget(
				input("upstash", {
					observations: [
						seen("upstash", [], { health: "unreachable", failingForMs }),
						seen("valkey"),
						seen("turso"),
					],
					members: ["upstash", "valkey", "turso"],
				}),
			);
		expect(failing(1000)).toMatchObject({
			action: "hold",
			reasons: ["writer-unreachable", "awaiting-failover-threshold"],
		});
		expect(failing(120_000)).toMatchObject({
			action: "failover",
			target: "valkey",
		});
	});

	it("fails over to a member with no financial model rather than stay down", () => {
		const route = routeFleetByBudget(
			input("upstash", {
				offers: [upstash],
				observations: [
					seen("upstash", [], {
						health: "quota-exhausted",
						failingForMs: 120_000,
					}),
					seen("redis"),
				],
				members: ["upstash", "redis"],
			}),
		);
		expect(route).toMatchObject({ action: "failover", target: "redis" });
		expect(route.candidates[1]?.reasons).toContain("no-financial-model");
	});

	it("holds a sealed fleet", () => {
		const route = routeFleetByBudget(
			input("upstash", {
				assignment: parseFleetAssignment({
					epoch: 4,
					active: "upstash",
					sealed: true,
					target: "turso",
					reason: "switch",
					lossWindowMs: undefined,
					decidedAtMs: NOW,
					decidedBy: "test",
				}),
			}),
		);
		expect(route).toMatchObject({
			action: "hold",
			reasons: ["switch-in-flight"],
		});
	});
});
