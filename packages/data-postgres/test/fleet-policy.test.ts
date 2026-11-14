/**
 * The fleet policy and the usage meter, offline.
 *
 * Every plan number in this file is a PLACEHOLDER chosen to make the
 * arithmetic easy to read. None of them describes a real product or price.
 */
import {
	DEFAULT_FLEET_POLICY,
	decideFleet,
	type FleetBudgetRequest,
	type FleetDecisionInput,
	type FleetFinancialModel,
	parseFleetFinancialModel,
	parseFleetPolicy,
} from "@hobo/backend-routing";
import {
	type AssignmentEntry,
	Health,
	type NamedObservation,
	parseMemberName,
} from "@hobo/fleet";
import { parseAssignmentEntry } from "@hobo/fleet/assignment";
import { describe, expect, it } from "vitest";
import { postgresObservation } from "../src/fleet/records.js";
import {
	billingPeriod,
	createUsageMeter,
	parseFleetLayout,
	type SqlExecutor,
} from "../src/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Ten days into a thirty-day month.
const NOW = Date.UTC(2026, 10, 11);
const period = billingPeriod(NOW);

function assignment(
	active: string,
	overrides: Partial<AssignmentEntry> = {},
): AssignmentEntry {
	return parseAssignmentEntry({
		epoch: 4,
		active: parseMemberName(active),
		sealed: false,
		target: undefined,
		reason: "test",
		lossWindowMs: undefined,
		decidedAtMs: NOW - 7 * DAY,
		decidedBy: "test",
		members: undefined,
		...overrides,
	});
}

/** PLACEHOLDER plan: `included` operations a month, then the service stops. */
function capped(backend: string, included: number) {
	return parseFleetFinancialModel({
		backend,
		plan: "placeholder capped",
		fixedMonthlyFeeMicros: 0,
		allowances: [
			{
				unit: "operations",
				included,
				beyond: "hard-stop",
				meteredMicrosPerUnit: undefined,
			},
		],
		evidence: { source: "placeholder for tests", observedAt: "2026-11-10" },
	});
}

/** PLACEHOLDER plan whose allowance nobody has verified. */
function unverified(backend: string) {
	return parseFleetFinancialModel({
		backend,
		plan: "placeholder unverified",
		fixedMonthlyFeeMicros: undefined,
		allowances: [
			{
				unit: "operations",
				included: undefined,
				beyond: "unknown",
				meteredMicrosPerUnit: undefined,
			},
		],
		evidence: { source: "placeholder for tests", observedAt: "2026-11-10" },
	});
}

/** What a tick saw of a backend; `overrides` uses the `Observation` field names. */
type Seen = Readonly<{
	health?: Health;
	failingForMs?: number;
	ready?: boolean;
	lagMs?: number | undefined;
	usage?: readonly Readonly<{ unit: string; used: number }>[];
}>;

function seen(
	backend: string,
	operations: number,
	overrides: Seen = {},
): NamedObservation {
	return {
		name: parseMemberName(backend),
		observation: postgresObservation({
			health: overrides.health ?? Health.REACHABLE,
			probeLatencyMs: 10,
			failingForMs: overrides.failingForMs ?? 0,
			ready: overrides.ready ?? true,
			lagMs: "lagMs" in overrides ? overrides.lagMs : 5 * 60_000,
			usage: overrides.usage ?? [{ unit: "operations", used: operations }],
		}),
	};
}

function input(
	overrides: Partial<FleetDecisionInput> & {
		observations: readonly NamedObservation[];
		models: readonly FleetFinancialModel[];
	},
): FleetDecisionInput {
	return {
		assignment: assignment("a"),
		policy: DEFAULT_FLEET_POLICY,
		period,
		checkBudget: () => ({ ok: true, code: "ok", reason: "affordable" }),
		nowMs: NOW,
		...overrides,
	};
}

describe("parsing", () => {
	it("keeps unknown representable and refuses half-stated models", () => {
		expect(unverified("a").allowances[0]?.included).toBeUndefined();
		const metered = {
			unit: "operations" as const,
			included: 100,
			beyond: "metered" as const,
			meteredMicrosPerUnit: undefined,
		};
		expect(() =>
			parseFleetFinancialModel({ ...capped("a", 1), allowances: [metered] }),
		).toThrow(/metered allowance carries a price/u);
		expect(() =>
			parseFleetFinancialModel({
				...capped("a", 1),
				allowances: [
					...capped("a", 1).allowances,
					...capped("a", 2).allowances,
				],
			}),
		).toThrow(/at most one allowance/u);
		expect(() =>
			parseFleetFinancialModel({
				...capped("a", 1),
				evidence: { source: "x", observedAt: "last week" },
			}),
		).toThrow(/YYYY-MM-DD/u);
		expect(() =>
			parseFleetPolicy({ ...DEFAULT_FLEET_POLICY, hysteresisFactor: 0.5 }),
		).toThrow(/at least 1/u);
		expect(() =>
			parseFleetPolicy({ ...DEFAULT_FLEET_POLICY, rpoMs: -1 }),
		).toThrow(/rpoMs/u);
	});
});

describe("keep", () => {
	it("keeps a healthy writer that is far from its allowance", () => {
		// 10,000 used in ten days of thirty: on course for 30,000 of 100,000.
		const decision = decideFleet(
			input({
				observations: [seen("a", 10_000), seen("b", 500), seen("c", 500)],
				models: [
					capped("a", 100_000),
					capped("b", 100_000),
					capped("c", 100_000),
				],
			}),
		);
		expect(decision).toMatchObject({
			action: "keep",
			writer: "a",
			epoch: 4,
			reasons: ["writer-healthy"],
		});
		expect(decision.candidates.map((entry) => entry.backend)).toEqual([
			"b",
			"c",
		]);
	});

	it("does not move on a guess when the writer's allowance is unknown", () => {
		const decision = decideFleet(
			input({
				observations: [seen("a", 10_000_000), seen("b", 0)],
				models: [unverified("a"), capped("b", 100_000_000)],
			}),
		);
		expect(decision.action).toBe("keep");
	});
});

describe("planned switch", () => {
	// 9,000 a day: 90,000 used of 100,000, so about 1.1 days are left.
	const exhausting = seen("a", 90_000);

	it("switches before a hard allowance runs out, to the standby with most headroom", () => {
		const decision = decideFleet(
			input({
				observations: [exhausting, seen("b", 1000), seen("c", 1000)],
				models: [
					capped("a", 100_000),
					capped("b", 200_000),
					capped("c", 900_000),
				],
			}),
		);
		expect(decision).toMatchObject({
			action: "switch",
			target: "c",
			lossWindowMs: undefined,
			reasons: ["operations-exhaustion-projected"],
		});
		expect(decision.candidates[0]).toMatchObject({
			backend: "c",
			eligible: true,
			feasibility: "feasible",
		});
	});

	it("does not flap: the standby it left is not a place to go back to", () => {
		// After moving to c, a is still nearly spent this month.
		const decision = decideFleet(
			input({
				assignment: assignment("c"),
				observations: [seen("c", 890_000), seen("a", 90_000), seen("b", 1000)],
				models: [
					capped("a", 100_000),
					capped("b", 200_000),
					capped("c", 900_000),
				],
			}),
		);
		const back = decision.candidates.find((entry) => entry.backend === "a");
		expect(back).toMatchObject({ eligible: false, feasibility: "infeasible" });
		expect(decision.target).not.toBe("a");
	});

	it("treats a known allowance with an unknown overage as a hard stop", () => {
		const unclear = parseFleetFinancialModel({
			...capped("a", 100_000),
			allowances: [
				{
					unit: "operations",
					included: 100_000,
					beyond: "unknown",
					meteredMicrosPerUnit: undefined,
				},
			],
		});
		const decision = decideFleet(
			input({
				observations: [exhausting, seen("b", 0)],
				models: [unclear, capped("b", 900_000)],
			}),
		);
		expect(decision).toMatchObject({ action: "switch", target: "b" });
	});

	it("does not ask the budget about a backend with a missing fact", () => {
		const asked: string[] = [];
		const decision = decideFleet(
			input({
				observations: [seen("a", 10_000), seen("b", 0)],
				models: [unverified("a"), capped("b", 900_000)],
				checkBudget: (request) => {
					asked.push(request.backend);
					return { ok: false, code: "refused", reason: "always" };
				},
			}),
		);
		// The writer's cost is unknown, so nothing is concluded about it.
		expect(asked).toEqual(["b"]);
		expect(decision.action).toBe("keep");
	});

	it("needs a margin: headroom of one horizon is not enough", () => {
		// b would last about four days under this workload: more than the
		// three-day horizon, less than the six days the margin requires.
		const decision = decideFleet(
			input({
				observations: [exhausting, seen("b", 0)],
				models: [capped("a", 100_000), capped("b", 36_000)],
			}),
		);
		expect(decision).toMatchObject({
			action: "keep",
			reasons: ["operations-exhaustion-projected", "no-feasible-standby"],
		});
		expect(decision.candidates[0]?.reasons[0]).toMatch(
			/operations runs out in/u,
		);
	});

	it("waits out the minimum dwell after the previous decision", () => {
		const decision = decideFleet(
			input({
				assignment: assignment("a", { decidedAtMs: NOW - 60_000 }),
				observations: [exhausting, seen("b", 0)],
				models: [capped("a", 100_000), capped("b", 900_000)],
			}),
		);
		expect(decision).toMatchObject({
			action: "keep",
			reasons: ["operations-exhaustion-projected", "minimum-dwell-not-reached"],
		});
	});

	it("never switches to a standby whose allowance is unknown or that is unhealthy", () => {
		const decision = decideFleet(
			input({
				observations: [
					exhausting,
					seen("b", 0),
					seen("c", 0, { ready: false }),
					seen("d", 0, { health: Health.UNREACHABLE, failingForMs: HOUR }),
				],
				models: [
					capped("a", 100_000),
					unverified("b"),
					capped("c", 900_000),
					capped("d", 900_000),
				],
			}),
		);
		expect(decision.action).toBe("keep");
		expect(
			Object.fromEntries(
				decision.candidates.map((entry) => [entry.backend, entry.reasons]),
			),
		).toEqual({
			b: ["operations:allowance-unknown", "fee-unknown"],
			c: ["schema-not-current"],
			d: ["unreachable"],
		});
	});

	it("asks the injected budget check with the projected period, and obeys it", () => {
		const requests: FleetBudgetRequest[] = [];
		const decision = decideFleet(
			input({
				observations: [seen("a", 10_000), seen("b", 300)],
				models: [capped("a", 100_000), capped("b", 100_000)],
				checkBudget: (request) => {
					requests.push(request);
					return request.backend === "a"
						? { ok: false, code: "budget.policy.exhausted", reason: "too dear" }
						: { ok: true, code: "ok", reason: "affordable" };
				},
			}),
		);
		expect(decision).toMatchObject({
			action: "switch",
			target: "b",
			reasons: ["budget-infeasible:budget.policy.exhausted"],
		});
		// b: 300 already spent plus twenty more days at 1,000 a day.
		expect(requests.find((request) => request.backend === "b")).toEqual({
			backend: "b",
			costBoundMicros: 0,
			measurements: [{ unit: "operations", used: 20_300 }],
			nowMs: NOW,
		});
	});

	it("prices metered use beyond the allowance into the cost bound", () => {
		const requests: FleetBudgetRequest[] = [];
		decideFleet(
			input({
				observations: [seen("a", 10_000), seen("b", 0)],
				models: [
					capped("a", 100_000),
					parseFleetFinancialModel({
						...capped("b", 5000),
						fixedMonthlyFeeMicros: 1_000_000,
						allowances: [
							{
								unit: "operations",
								included: 5000,
								beyond: "metered",
								meteredMicrosPerUnit: 10,
							},
						],
					}),
				],
				checkBudget: (request) => {
					requests.push(request);
					return { ok: true, code: "ok", reason: "affordable" };
				},
			}),
		);
		// 20,000 projected, 15,000 beyond the allowance at 10 micros each.
		expect(
			requests.find((request) => request.backend === "b")?.costBoundMicros,
		).toBe(1_150_000);
	});

	it("moves off a writer whose database no longer fits its storage", () => {
		const storage = (backend: string, included: number) =>
			parseFleetFinancialModel({
				...capped(backend, 1),
				allowances: [
					{
						unit: "storage-bytes",
						included,
						beyond: "hard-stop",
						meteredMicrosPerUnit: undefined,
					},
				],
			});
		const sized = (backend: string): NamedObservation =>
			seen(backend, 0, {
				usage: [{ unit: "storage-bytes", used: 2_000_000_000 }],
			});
		const decision = decideFleet(
			input({
				observations: [sized("a"), sized("b"), sized("c")],
				models: [
					storage("a", 2_000_000_000),
					storage("b", 1_000_000_000),
					storage("c", 8_000_000_000),
				],
			}),
		);
		expect(decision).toMatchObject({
			action: "switch",
			target: "c",
			reasons: ["storage-bytes-exhaustion-projected"],
		});
	});
});

describe("failover", () => {
	const down = (
		failingForMs: number,
		usage: readonly Readonly<{ unit: string; used: number }>[] = [],
	) => seen("a", 0, { health: Health.UNREACHABLE, failingForMs, usage });
	const models = [
		capped("a", 100_000),
		capped("b", 100_000),
		capped("c", 100_000),
	];

	it("holds until the writer has been failing for the threshold", () => {
		const decision = decideFleet(
			input({
				observations: [down(30_000), seen("b", 0), seen("c", 0)],
				models,
			}),
		);
		expect(decision).toMatchObject({
			action: "hold",
			reasons: ["writer-unreachable", "awaiting-failover-threshold"],
		});
	});

	it("promotes the freshest standby within the objective and records its lag", () => {
		const decision = decideFleet(
			input({
				observations: [
					down(2 * 60_000),
					seen("b", 0, { lagMs: 9 * 60_000 }),
					seen("c", 0, { lagMs: 4 * 60_000 }),
				],
				models,
			}),
		);
		expect(decision).toMatchObject({
			action: "failover",
			target: "c",
			lossWindowMs: 4 * 60_000,
			reasons: ["writer-unreachable"],
		});
	});

	it("names a quota stop as the cause", () => {
		const decision = decideFleet(
			input({
				observations: [
					seen("a", 0, { health: Health.QUOTA_EXHAUSTED, failingForMs: HOUR }),
					seen("b", 0),
				],
				models,
			}),
		);
		expect(decision).toMatchObject({
			action: "failover",
			target: "b",
			reasons: ["writer-quota-exhausted"],
		});
	});

	it("holds, with the reason per standby, when every standby is older than the objective", () => {
		const decision = decideFleet(
			input({
				observations: [
					down(HOUR),
					seen("b", 0, { lagMs: 21 * 60_000 }),
					seen("c", 0, { lagMs: undefined }),
				],
				models,
			}),
		);
		expect(decision).toMatchObject({
			action: "hold",
			target: undefined,
			reasons: ["writer-unreachable", "no-standby-within-rpo"],
		});
		expect(
			Object.fromEntries(
				decision.candidates.map((entry) => [entry.backend, entry.reasons[0]]),
			),
		).toEqual({ b: "lag 21m exceeds rpo 20m", c: "never-copied" });
	});

	it("skips standbys that are down or have another schema", () => {
		const decision = decideFleet(
			input({
				observations: [
					down(HOUR),
					seen("b", 0, {
						health: Health.AUTH,
						failingForMs: HOUR,
						lagMs: 1000,
					}),
					seen("c", 0, { ready: false, lagMs: 1000 }),
					seen("d", 0, { lagMs: 10 * 60_000 }),
				],
				models: [...models, capped("d", 100_000)],
			}),
		);
		expect(decision).toMatchObject({ action: "failover", target: "d" });
	});

	it("still promotes a standby whose allowance is unknown: down costs more", () => {
		const decision = decideFleet(
			input({
				observations: [down(HOUR), seen("b", 0)],
				models: [capped("a", 100_000), unverified("b")],
			}),
		);
		expect(decision).toMatchObject({ action: "failover", target: "b" });
		expect(decision.candidates[0]?.feasibility).toBe("unknown");
	});

	it("prefers an affordable standby over a fresher one that is not", () => {
		const decision = decideFleet(
			input({
				observations: [
					// The writer's last measured use is still known to the host.
					down(HOUR, [{ unit: "operations", used: 1000 }]),
					seen("b", 0, { lagMs: 60_000 }),
					seen("c", 0, { lagMs: 10 * 60_000 }),
				],
				models,
				checkBudget: (request) =>
					request.backend === "b"
						? { ok: false, code: "budget.policy.exhausted", reason: "too dear" }
						: { ok: true, code: "ok", reason: "affordable" },
			}),
		);
		expect(decision).toMatchObject({ action: "failover", target: "c" });
	});
});

describe("holding", () => {
	it("decides nothing while a switch is in flight", () => {
		const decision = decideFleet(
			input({
				assignment: assignment("a", {
					sealed: true,
					target: parseMemberName("b"),
				}),
				observations: [seen("a", 0), seen("b", 0)],
				models: [capped("a", 1), capped("b", 1)],
			}),
		);
		expect(decision).toMatchObject({
			action: "hold",
			reasons: ["switch-in-flight"],
		});
	});
});

describe("usage meter", () => {
	const layout = parseFleetLayout({
		dataPrefix: "app_",
		controlPrefix: "app_fleet_",
	});

	function recorder(fail = false) {
		const writes: (readonly (string | number | boolean | null)[])[] = [];
		const executor: SqlExecutor = {
			async query(_sql, parameters) {
				if (fail) throw new Error("connection refused");
				writes.push(parameters ?? []);
				return { rows: [] };
			},
			session: (run) => run(executor),
		};
		return { writes, executor };
	}

	it("names the UTC calendar month", () => {
		expect(billingPeriod(Date.UTC(2026, 11, 31, 23, 59))).toEqual({
			id: "2026-12",
			startsAtMs: Date.UTC(2026, 11, 1),
			endsAtMs: Date.UTC(2027, 0, 1),
		});
	});

	it("adds each backend's count to that backend and then forgets it", async () => {
		const meter = createUsageMeter();
		const first = recorder();
		const second = recorder();
		meter.record("a");
		meter.record("a", 4);
		meter.record("b", 2);
		const backends = [
			{ id: "a", executor: first.executor },
			{ id: "b", executor: second.executor },
		];
		await meter.flush(backends, layout, NOW);
		expect(first.writes).toEqual([["2026-11", "operations", 5]]);
		expect(second.writes).toEqual([["2026-11", "operations", 2]]);
		expect(meter.pending("a")).toBe(0);
		await meter.flush(backends, layout, NOW);
		expect(first.writes).toHaveLength(1);
	});

	it("keeps the count of a backend it could not reach", async () => {
		const meter = createUsageMeter();
		const broken = recorder(true);
		meter.record("a", 3);
		await meter.flush([{ id: "a", executor: broken.executor }], layout, NOW);
		meter.record("a", 2);
		expect(meter.pending("a")).toBe(5);
	});
});
