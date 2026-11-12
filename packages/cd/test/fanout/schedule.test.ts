// Pure fan-out rules (D21, I20): plan parsing, the scheduler, outcome
// classification, deferral, data classification and the effective decision.
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	CampManagement,
	FanoutStrategy,
	PromotionRecordSchema,
	PromotionState,
	ReconcileObservationRecordSchema,
	TaintEffect,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import {
	budgetExceeded,
	classify,
	dataResourcesOf,
	effectiveDecision,
	eligibility,
	FANOUT_REASON,
	type FanoutPlan,
	parseFanoutPlan,
	type SlotState,
	schedule,
} from "../../src/fanout/index.js";
import type { WindowEvaluation } from "../../src/ports.js";
import { decisionOf, fanoutOf, groupAt, healthy } from "./fakes.js";

function plan(
	n: number,
	size: number,
	fields: Parameters<typeof fanoutOf>[0] = {},
	mandatory: string[] = [],
): FanoutPlan {
	const parsed = parseFanoutPlan({
		pipeline: "web",
		node: "prod",
		decision: decisionOf(n, size, { mandatory }),
		fanout: fanoutOf({ mandatoryGroups: mandatory, ...fields }),
	});
	if (!parsed.ok) throw new Error(parsed.reasons[0]?.code);
	return parsed.value;
}

function slots(
	p: FanoutPlan,
	states: Readonly<Record<string, SlotState>> = {},
) {
	return new Map(
		p.campIds.map((campId) => [
			campId,
			{ campId, state: states[campId] ?? ("pending" as SlotState) },
		]),
	);
}

const OPEN: WindowEvaluation = {
	open: true,
	rollbackAllowed: true,
	activeFreezes: [],
	overrides: [],
};

describe("parseFanoutPlan", () => {
	it("resolves defaults: concurrency = largest group, failures = 5% floored, ALL = every Camp", () => {
		const p = plan(400, 40, { maxFailuresPercent: 0 });
		expect(p.maxConcurrency).toBe(40);
		expect(p.maxFailures).toBe(20);
		expect(p.strategy).toBe("PROGRESSIVE_PER_GROUP");
		expect(plan(400, 40, { strategy: FanoutStrategy.ALL }).maxConcurrency).toBe(
			400,
		);
		expect(plan(400, 40, { maxConcurrencyPercent: 3 }).maxConcurrency).toBe(12);
		expect(plan(400, 40, { maxFailuresPercent: 2 }).maxFailures).toBe(8);
		expect(plan(10, 5, { maxFailures: 3 }).maxFailures).toBe(3);
	});

	it("orders mandatory groups first", () => {
		const decision = decisionOf(6, 2);
		groupAt(decision, 2).name = "pilot";
		const parsed = parseFanoutPlan({
			pipeline: "web",
			node: "prod",
			decision,
			fanout: fanoutOf({ mandatoryGroups: ["pilot"] }),
		});
		expect(parsed.ok && parsed.value.campIds).toEqual([
			"c004",
			"c005",
			"c000",
			"c001",
			"c002",
			"c003",
		]);
	});

	it("refuses a Camp in two groups and an empty decision", () => {
		const twice = decisionOf(4, 2);
		groupAt(twice, 1).campIds = ["c000", "c003"];
		const a = parseFanoutPlan({
			pipeline: "web",
			node: "prod",
			decision: twice,
			fanout: fanoutOf(),
		});
		expect(a.ok ? "" : a.reasons[0]?.code).toBe(FANOUT_REASON.duplicateCamp);
		const empty = decisionOf(0, 1);
		const b = parseFanoutPlan({
			pipeline: "web",
			node: "prod",
			decision: empty,
			fanout: fanoutOf(),
		});
		expect(b.ok ? "" : b.reasons[0]?.code).toBe(FANOUT_REASON.emptyDecision);
	});
});

describe("schedule", () => {
	it("PROGRESSIVE_PER_GROUP offers one group at a time, then earlier groups' deferred Camps", () => {
		const p = plan(6, 2);
		expect(
			schedule(p, slots(p), { halted: false, catchUp: false }).candidates,
		).toEqual(["c000", "c001"]);
		const s = slots(p, { c000: "succeeded", c001: "deferred" });
		expect(
			schedule(p, s, { halted: false, catchUp: false }).candidates,
		).toEqual(["c002", "c003", "c001"]);
	});

	it("never offers more than the free slots' worth of work and nothing when halted", () => {
		const p = plan(10, 10, {
			strategy: FanoutStrategy.PROGRESSIVE,
			maxConcurrency: 3,
		});
		const s = slots(p, {
			c000: "in-flight",
			c001: "in-flight",
			c002: "in-flight",
		});
		expect(schedule(p, s, { halted: false, catchUp: false }).free).toBe(0);
		expect(
			schedule(p, slots(p), { halted: true, catchUp: false }).candidates,
		).toEqual([]);
	});

	it("gates non-mandatory groups until every mandatory Camp succeeded; a mandatory failure stops scheduling", () => {
		const p = plan(4, 2, {}, ["pilot"]);
		const waiting = schedule(
			p,
			slots(p, { c000: "succeeded", c001: "in-flight" }),
			{ halted: false, catchUp: false },
		);
		expect(waiting.mandatoryGate).toBe(true);
		expect(waiting.candidates).toEqual([]);
		const failed = schedule(
			p,
			slots(p, { c000: "failed", c001: "succeeded" }),
			{ halted: false, catchUp: false },
		);
		expect(failed.mandatoryFailed).toBe(true);
		expect(failed.candidates).toEqual([]);
	});

	it("is complete with deferred Camps left; catch-up offers only those", () => {
		const p = plan(3, 3);
		const s = slots(p, { c000: "succeeded", c001: "deferred", c002: "failed" });
		const result = schedule(p, s, { halted: false, catchUp: true });
		expect(result.complete).toBe(true);
		expect(result.candidates).toEqual(["c001"]);
	});

	it("budget: strictly more failures than allowed, deferred never counted, baseline subtracted", () => {
		const p = plan(10, 10, { maxFailures: 2 });
		expect(
			budgetExceeded(p, slots(p, { c000: "failed", c001: "failed" }), 0),
		).toBe(false);
		expect(
			budgetExceeded(
				p,
				slots(p, { c000: "failed", c001: "failed", c002: "failed" }),
				0,
			),
		).toBe(true);
		expect(
			budgetExceeded(
				p,
				slots(p, { c000: "failed", c001: "failed", c002: "failed" }),
				1,
			),
		).toBe(false);
		expect(
			budgetExceeded(
				p,
				slots(p, { c000: "deferred", c001: "deferred", c002: "deferred" }),
				0,
			),
		).toBe(false);
	});
});

describe("classify and eligibility", () => {
	const base = {
		campId: "c1",
		requestedAtMs: 0,
		minSuccessMs: 100,
		progressDeadlineMs: 1_000,
	};
	const promotion = (state: PromotionState) =>
		create(PromotionRecordSchema, { promotionId: "p", state });

	it("succeeds only after qualification plus min_success_ms", () => {
		expect(
			classify({
				...base,
				promotion: promotion(PromotionState.PROMOTED),
				qualifiedAtMs: 50,
				nowMs: 149,
			}).kind,
		).toBe("in-flight");
		expect(
			classify({
				...base,
				promotion: promotion(PromotionState.PROMOTED),
				qualifiedAtMs: 50,
				nowMs: 150,
			}).kind,
		).toBe("succeeded");
	});

	it("fails on FAILED/REJECTED/ROLLED_BACK and on the progress deadline; superseded defers", () => {
		for (const state of [
			PromotionState.FAILED,
			PromotionState.REJECTED,
			PromotionState.ROLLED_BACK,
		])
			expect(
				classify({
					...base,
					promotion: promotion(state),
					qualifiedAtMs: undefined,
					nowMs: 10,
				}).kind,
			).toBe("failed");
		expect(
			classify({
				...base,
				promotion: promotion(PromotionState.VERIFYING),
				qualifiedAtMs: undefined,
				nowMs: 1_001,
			}).kind,
		).toBe("failed");
		expect(
			classify({
				...base,
				promotion: promotion(PromotionState.VERIFYING),
				qualifiedAtMs: undefined,
				nowMs: 1_000,
			}).kind,
		).toBe("in-flight");
		expect(
			classify({
				...base,
				promotion: promotion(PromotionState.SUPERSEDED),
				qualifiedAtMs: undefined,
				nowMs: 10,
			}).kind,
		).toBe("deferred");
	});

	it("defers on unknown status, OBSERVE_ONLY, taints, unreachable and closed windows", () => {
		const code = (r: ReturnType<typeof eligibility>) => r?.[0]?.code;
		expect(
			code(eligibility({ campId: "c1", status: undefined, window: OPEN })),
		).toBe(FANOUT_REASON.campStatusUnknown);
		const observeOnly = healthy("c1");
		observeOnly.management = CampManagement.OBSERVE_ONLY;
		expect(
			code(eligibility({ campId: "c1", status: observeOnly, window: OPEN })),
		).toBe(FANOUT_REASON.campNotManaged);
		const tainted = healthy("c1", [
			create(TaintRecordSchema, { key: "k", effect: TaintEffect.NO_PLACE }),
		]);
		expect(
			code(eligibility({ campId: "c1", status: tainted, window: OPEN })),
		).toBe(FANOUT_REASON.campTainted);
		expect(
			code(
				eligibility({
					campId: "c1",
					status: healthy("c1", [], false),
					window: OPEN,
				}),
			),
		).toBe(FANOUT_REASON.campUnreachable);
		expect(
			code(
				eligibility({
					campId: "c1",
					status: healthy("c1"),
					window: { ...OPEN, open: false },
				}),
			),
		).toBe(FANOUT_REASON.windowClosed);
		expect(
			eligibility({ campId: "c1", status: healthy("c1"), window: OPEN }),
		).toBeUndefined();
	});
});

describe("data resources and the effective decision", () => {
	it("treats data ports and classified or data-kind observations as data", () => {
		const resolved = {
			plan: {
				resources: [
					{ name: "web", port: "hobo:http-service" },
					{ name: "db", port: "hobo:database" },
					{ name: "q", port: "queue" },
				],
			},
		};
		const observed = create(ReconcileObservationRecordSchema, {
			resources: [
				{ resource: "files", kind: "bucket" },
				{ resource: "cache", classification: "internal" },
				{ resource: "fn", kind: "function" },
			],
		});
		expect(dataResourcesOf(resolved as never, observed)).toEqual([
			"cache",
			"db",
			"files",
			"q",
		]);
		expect(dataResourcesOf(undefined, undefined)).toEqual([]);
	});

	it("replaces failed-over Camps in groups and candidates", () => {
		const decision = decisionOf(4, 2);
		const out = effectiveDecision(decision, [{ from: "c001", to: "x9" }]);
		expect(out.groups.map((g) => g.campIds)).toEqual([
			["c000", "x9"],
			["c002", "c003"],
		]);
		expect(
			out.candidates
				.filter((c) => c.selected)
				.map((c) => c.campId)
				.sort(),
		).toEqual(["c000", "c002", "c003", "x9"]);
		expect(effectiveDecision(decision, [])).toBe(decision);
	});
});
