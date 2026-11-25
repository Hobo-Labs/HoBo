import { create } from "@bufbuild/protobuf";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	Health,
	type Observation,
	ObservationSchema,
} from "../../src/_generated/fleet_pb.js";
import { parseMemberName } from "../../src/ids.js";
import {
	eligibleForActive,
	failingLongerThan,
} from "../../src/observation/index.js";
import type { NamedObservation } from "../../src/ports.js";

type TodayHealth =
	| "reachable"
	| "unreachable"
	| "quota-exhausted"
	| "auth"
	| "unknown";

type TodayObservation = Readonly<{
	backend: string;
	health: TodayHealth;
	failingForMs: number;
	schemaCurrent: boolean;
	standbyLagMs: number | undefined;
}>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const RPO = 20 * MINUTE;

function span(ms: number): string {
	return ms < 120_000
		? `${Math.round(ms / 1000)}s`
		: `${Math.round(ms / 60_000)}m`;
}

function decideFleetReasons(
	entry: TodayObservation,
	failing: boolean,
	rpoMs: number,
): string[] {
	const reasons: string[] = [];
	if (entry.health !== "reachable") reasons.push(entry.health);
	if (!entry.schemaCurrent) reasons.push("schema-not-current");
	if (failing) {
		if (entry.standbyLagMs === undefined) reasons.push("never-copied");
		else if (entry.standbyLagMs > rpoMs)
			reasons.push(
				`lag ${span(entry.standbyLagMs)} exceeds rpo ${span(rpoMs)}`,
			);
	}
	return reasons;
}

function routeFleetReasons(entry: TodayObservation): string[] {
	return entry.health !== "reachable" ? [entry.health] : [];
}

const HEALTH = {
	reachable: Health.REACHABLE,
	unreachable: Health.UNREACHABLE,
	"quota-exhausted": Health.QUOTA_EXHAUSTED,
	auth: Health.AUTH,
	unknown: Health.UNKNOWN,
} as const satisfies Readonly<Record<TodayHealth, Health>>;

function named(
	entry: TodayObservation,
	readyWhenCurrent: true | undefined,
): NamedObservation {
	const observation: Observation = create(ObservationSchema, {
		memberId: `bkd_${"0".repeat(32)}`,
		health: HEALTH[entry.health],
		failingForMs: entry.failingForMs,
		ready: entry.schemaCurrent ? readyWhenCurrent : false,
		lagMs: entry.standbyLagMs,
	});
	return { name: parseMemberName(entry.backend), observation };
}

const seen = (
	backend: string,
	overrides: Partial<TodayObservation> = {},
): TodayObservation => ({
	backend,
	health: "reachable",
	failingForMs: 0,
	schemaCurrent: true,
	standbyLagMs: 5 * MINUTE,
	...overrides,
});

const routed = (
	backend: string,
	overrides: Partial<TodayObservation> = {},
): TodayObservation => ({
	backend,
	health: "reachable",
	failingForMs: 0,
	schemaCurrent: true,
	standbyLagMs: undefined,
	...overrides,
});

const TODAY: readonly TodayObservation[] = [
	seen("a"),
	seen("b"),
	seen("c"),
	seen("c", { schemaCurrent: false }),
	seen("d", { health: "unreachable", failingForMs: HOUR }),
	seen("a", { health: "unreachable", failingForMs: 30_000 }),
	seen("a", { health: "unreachable", failingForMs: 2 * MINUTE }),
	seen("a", { health: "unreachable", failingForMs: HOUR }),
	seen("b", { standbyLagMs: 9 * MINUTE }),
	seen("c", { standbyLagMs: 4 * MINUTE }),
	seen("a", { health: "quota-exhausted", failingForMs: HOUR }),
	seen("b", { standbyLagMs: 21 * MINUTE }),
	seen("c", { standbyLagMs: undefined }),
	seen("b", { health: "auth", failingForMs: HOUR, standbyLagMs: 1000 }),
	seen("c", { schemaCurrent: false, standbyLagMs: 1000 }),
	seen("d", { standbyLagMs: 10 * MINUTE }),
	seen("b", { standbyLagMs: 60_000 }),
	seen("c", { standbyLagMs: 10 * MINUTE }),
	routed("upstash"),
	routed("valkey"),
	routed("turso"),
	routed("blob"),
	routed("redis"),
	routed("upstash", { health: "unreachable", failingForMs: 30_000 }),
	routed("upstash", { health: "unreachable", failingForMs: 2 * MINUTE }),
	routed("upstash", { health: "quota-exhausted", failingForMs: HOUR }),
];

const expected = (reasons: readonly string[]) =>
	reasons.map((each) => (each === "schema-not-current" ? "not-ready" : each));

describe("eligibleForActive", () => {
	it("equals decideFleet's eligibility and reasons for every observation of its tests, in both modes", () => {
		for (const readyWhenCurrent of [true, undefined] as const)
			for (const failing of [true, false]) {
				const answers = eligibleForActive(
					TODAY.map((entry) => named(entry, readyWhenCurrent)),
					{ mode: failing ? "failover" : "switch", recoveryPointMs: RPO },
				);
				expect(answers).toHaveLength(TODAY.length);
				TODAY.forEach((entry, index) => {
					const reasons = expected(decideFleetReasons(entry, failing, RPO));
					expect(answers[index]).toEqual({
						name: entry.backend,
						eligible: reasons.length === 0,
						reasons,
					});
				});
			}
	});

	it("equals routeFleetByBudget's health reasons with no recovery point, in both modes", () => {
		const current = TODAY.filter((entry) => entry.schemaCurrent);
		for (const mode of ["failover", "switch"] as const) {
			const answers = eligibleForActive(
				current.map((entry) => named(entry, undefined)),
				{ mode, recoveryPointMs: undefined },
			);
			current.forEach((entry, index) => {
				const reasons = routeFleetReasons(entry);
				expect(answers[index]).toEqual({
					name: entry.backend,
					eligible: reasons.length === 0,
					reasons,
				});
			});
		}
	});

	it("keeps today's reason strings", () => {
		const [lagging, never, down] = eligibleForActive(
			[
				seen("b", { standbyLagMs: 21 * MINUTE }),
				seen("c", { standbyLagMs: undefined }),
				seen("d", { health: "quota-exhausted", failingForMs: HOUR }),
			].map((entry) => named(entry, undefined)),
			{ mode: "failover", recoveryPointMs: RPO },
		);
		expect(lagging?.reasons).toEqual(["lag 21m exceeds rpo 20m"]);
		expect(never?.reasons).toEqual(["never-copied"]);
		expect(down?.reasons).toEqual(["quota-exhausted"]);
	});

	it("treats absent ready as ready, and absent lag as refusing only in failover with a recovery point", () => {
		const bare: NamedObservation = {
			name: parseMemberName("cache"),
			observation: create(ObservationSchema, { health: Health.REACHABLE }),
		};
		expect(bare.observation.ready).toBeUndefined();
		expect(bare.observation.lagMs).toBeUndefined();
		for (const [mode, recoveryPointMs, eligible] of [
			["failover", RPO, false],
			["failover", undefined, true],
			["switch", RPO, true],
			["switch", undefined, true],
		] as const)
			expect(
				eligibleForActive([bare], { mode, recoveryPointMs })[0]?.eligible,
			).toBe(eligible);
	});

	it("names the other health states of the closed set as today's tokens", () => {
		const answers = eligibleForActive(
			[Health.DRAINING, Health.PRESSURED, Health.UNSPECIFIED].map((health) => ({
				name: parseMemberName("m"),
				observation: create(ObservationSchema, { health }),
			})),
			{ mode: "switch", recoveryPointMs: undefined },
		);
		expect(answers.map((entry) => entry.reasons)).toEqual([
			["draining"],
			["pressured"],
			["unspecified"],
		]);
	});

	it("agrees with decideFleet for any observation (property)", () => {
		const today = fc.record({
			backend: fc.constantFrom("a", "b", "c"),
			health: fc.constantFrom<TodayHealth>(
				"reachable",
				"unreachable",
				"quota-exhausted",
				"auth",
				"unknown",
			),
			failingForMs: fc.nat(),
			schemaCurrent: fc.boolean(),
			standbyLagMs: fc.option(fc.nat({ max: 4 * HOUR }), { nil: undefined }),
		});
		fc.assert(
			fc.property(
				fc.array(today, { maxLength: 8 }),
				fc.boolean(),
				fc.nat({ max: 2 * HOUR }),
				(entries, failing, rpoMs) => {
					const answers = eligibleForActive(
						entries.map((entry) => named(entry, true)),
						{ mode: failing ? "failover" : "switch", recoveryPointMs: rpoMs },
					);
					return entries.every((entry, index) => {
						const reasons = expected(decideFleetReasons(entry, failing, rpoMs));
						const answer = answers[index];
						return (
							answer !== undefined &&
							answer.eligible === (reasons.length === 0) &&
							JSON.stringify(answer.reasons) === JSON.stringify(reasons)
						);
					});
				},
			),
		);
	});
});

describe("failingLongerThan", () => {
	const at = (health: Health, failingForMs: number) =>
		create(ObservationSchema, { health, failingForMs });

	it("is today's failover threshold: failing for at least that long", () => {
		expect(failingLongerThan(at(Health.UNREACHABLE, 59_999), 60_000)).toBe(
			false,
		);
		expect(failingLongerThan(at(Health.UNREACHABLE, 60_000), 60_000)).toBe(
			true,
		);
		expect(failingLongerThan(at(Health.QUOTA_EXHAUSTED, HOUR), 60_000)).toBe(
			true,
		);
	});

	it("is never true of a reachable member", () => {
		expect(failingLongerThan(at(Health.REACHABLE, HOUR), 0)).toBe(false);
	});
});
