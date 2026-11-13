// D7 lowering, ramp defaults and the stage plan the orchestrator hands Station cutover.
import { describe, expect, it } from "vitest";
import { RolloutStrategy } from "../../src/_generated/cd_pb.js";
import { CD_RAMP_DEFAULTS, PROGRESSIVE_UNSUPPORTED } from "../../src/events.js";
import type { RolloutId } from "../../src/ports.js";
import {
	cohortAware,
	effectiveStrategy,
	lowerCamp,
	stagePercentsFor,
	TRAFFIC_LADDER,
} from "../../src/rollout/lowering.js";
import {
	STAGE_BACKENDS,
	stagePlanId,
	stageRoutingPlan,
	stageShare,
} from "../../src/rollout/routing.js";
import { camp, T0, TENANT } from "./fakes.js";

const rollout = (): RolloutId => {
	// SAFETY: literal test id.
	return "rollout-x" as RolloutId;
};

describe("D7 lowering", () => {
	it("ranks edge.canary → lb.weighted → dns.weighted → inprocess.weighted", () => {
		expect(TRAFFIC_LADDER).toEqual([
			"edge.canary",
			"lb.weighted",
			"dns.weighted",
			"inprocess.weighted",
		]);
		const best = lowerCamp({
			campId: camp("a"),
			strategy: RolloutStrategy.CANARY,
			offerings: ["dns.weighted", "edge.canary"],
			fallbackForbidden: false,
		});
		expect(best.offeringId).toBe("edge.canary");
		expect(best.fallbackFrom).toEqual([]);
		const dns = lowerCamp({
			campId: camp("a"),
			strategy: RolloutStrategy.CANARY,
			offerings: ["dns.weighted", "inprocess.weighted"],
			fallbackForbidden: false,
		});
		expect(dns.offeringId).toBe("dns.weighted");
		expect(dns.fallbackFrom).toEqual(["edge.canary", "lb.weighted"]);
	});

	it("refuses progressive-unsupported when no rung is realizable (I6)", () => {
		const lowered = lowerCamp({
			campId: camp("a"),
			strategy: RolloutStrategy.EXPERIMENT,
			offerings: ["lb.lifecycle"],
			fallbackForbidden: false,
		});
		expect(lowered.offeringId).toBe("");
		expect(lowered.refusal?.code).toBe(PROGRESSIVE_UNSUPPORTED);
		expect(lowered.refusal?.subject).toBe("a");
	});

	it("refuses a fallback rung that policy forbids, recording what it fell back from", () => {
		const lowered = lowerCamp({
			campId: camp("a"),
			strategy: RolloutStrategy.BLUE_GREEN,
			offerings: ["lb.weighted"],
			fallbackForbidden: true,
		});
		expect(lowered.refusal?.code).toBe(PROGRESSIVE_UNSUPPORTED);
		expect(lowered.fallbackFrom).toEqual(["edge.canary"]);
	});

	it("all-at-once needs no rung", () => {
		const lowered = lowerCamp({
			campId: camp("a"),
			strategy: RolloutStrategy.ALL_AT_ONCE,
			offerings: [],
			fallbackForbidden: true,
		});
		expect(lowered.refusal).toBeUndefined();
	});

	it("uses CD_RAMP_DEFAULTS, never local constants, and ends every ramp at 100", () => {
		const of = (s: RolloutStrategy, p: readonly number[] = []) => {
			const r = stagePercentsFor(s, p);
			return r.ok ? r.value : r.reasons[0]?.code;
		};
		expect(of(RolloutStrategy.CANARY)).toEqual([...CD_RAMP_DEFAULTS.canary]);
		expect(of(RolloutStrategy.BLUE_GREEN)).toEqual([
			...CD_RAMP_DEFAULTS.blueGreen,
		]);
		expect(of(RolloutStrategy.EXPERIMENT)).toEqual([
			...CD_RAMP_DEFAULTS.experiment,
			100,
		]);
		expect(of(RolloutStrategy.ALL_AT_ONCE)).toEqual([100]);
		expect(of(RolloutStrategy.CANARY, [1, 10, 50])).toEqual([1, 10, 50, 100]);
		expect(of(RolloutStrategy.CANARY, [10, 10])).toBe("rollout-stages-invalid");
		expect(of(RolloutStrategy.CANARY, [0, 50])).toBe("rollout-stages-invalid");
		expect(of(RolloutStrategy.CANARY, [12.5])).toBe("rollout-stages-invalid");
		expect(of(RolloutStrategy.BLUE_GREEN, [50, 100])).toBe(
			"rollout-stages-invalid",
		);
	});

	it("unspecified is canary; comparisons only while traffic is split", () => {
		expect(effectiveStrategy(RolloutStrategy.UNSPECIFIED)).toBe(
			RolloutStrategy.CANARY,
		);
		expect(cohortAware(RolloutStrategy.CANARY, 25)).toBe(true);
		expect(cohortAware(RolloutStrategy.CANARY, 100)).toBe(false);
		expect(cohortAware(RolloutStrategy.BLUE_GREEN, 0)).toBe(false);
	});
});

describe("stage RoutingPlan", () => {
	it("is a neutral stable/candidate split with a deterministic id", () => {
		const plan = stageRoutingPlan({
			rolloutId: rollout(),
			campId: camp("a"),
			tenant: TENANT,
			percent: 25,
			atMs: T0,
		});
		expect(plan.planId).toBe(stagePlanId(rollout(), camp("a"), 25));
		expect(plan.backends.map((b) => [b.id, b.weight])).toEqual([
			[STAGE_BACKENDS.stable, 75],
			[STAGE_BACKENDS.candidate, 25],
		]);
		expect(stageShare(plan)).toBe(25);
	});

	it("omits a cohort at 0% (weights are positive on the wire)", () => {
		const zero = stageRoutingPlan({
			rolloutId: rollout(),
			campId: camp("a"),
			tenant: TENANT,
			percent: 0,
			atMs: T0,
		});
		expect(zero.backends.map((b) => b.id)).toEqual([STAGE_BACKENDS.stable]);
		expect(stageShare(zero)).toBe(0);
		const full = stageRoutingPlan({
			rolloutId: rollout(),
			campId: camp("a"),
			tenant: TENANT,
			percent: 100,
			atMs: T0,
		});
		expect(stageShare(full)).toBe(100);
	});
});
