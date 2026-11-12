// FanoutController conformance (plan 0024 D21, I20). Fan-out only schedules
// per-Camp promotions: bounded concurrency, mandatory groups first, a failure
// budget that halts, deferral that never counts as failure, and no wedge.
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	runCdAssertions,
} from "./cd-kit.js";
import { CD_FANOUT_STATE, CD_FANOUT_STRATEGY } from "./cd-shapes.js";

export const FANOUT_CONTROLLER_SUITE = "hobo.cd.fanout-controller/v1";

// public-contract: assertion names of the FanoutController suite.
export const FANOUT_CONTROLLER_ASSERTIONS = Object.freeze([
	"concurrencyIsBounded",
	"mandatoryGroupRunsFirst",
	"mandatoryFailureStopsRemainder",
	"budgetExceededHalts",
	"deferredAreNotFailures",
	"startIsIdempotent",
	"neverWedges",
] as const);
export type FanoutControllerAssertion =
	(typeof FANOUT_CONTROLLER_ASSERTIONS)[number];

export type FanoutCampOutcome = "succeed" | "fail" | "defer";

export type FanoutScenario = Readonly<{
	/** The decision's Camps in decision order. */
	camps: readonly string[];
	groups: readonly Readonly<{
		name: string;
		campIds: readonly string[];
		mandatory: boolean;
	}>[];
	strategy: number;
	maxConcurrency: number;
	maxFailures: number;
	/** How each Camp's promotion ends (defer = unreachable when its turn comes). */
	outcomes: Readonly<Record<string, FanoutCampOutcome>>;
}>;

/** Structural view of FanoutStatusRecord. */
export type FanoutStatusLike = Readonly<{
	fanoutId: string;
	state: number;
	inFlight: readonly string[];
	succeeded: readonly string[];
	failed: readonly string[];
	deferred: readonly string[];
	pending: readonly string[];
}>;

export interface FanoutWorld {
	status(): Promise<FanoutStatusLike>;
	/** One controller tick plus settling of in-flight promotions per `outcomes`. */
	tick(): Promise<void>;
	/** Camps whose promotion was requested, in request order. */
	started(): readonly string[];
	/** Start again with the same idempotency key; returns the fan-out id. */
	startAgain(): Promise<string>;
}

export interface FanoutControllerHarness {
	readonly subject: string;
	start(scenario: FanoutScenario): Promise<FanoutWorld>;
}

const TERMINAL: ReadonlySet<number> = new Set([
	CD_FANOUT_STATE.HALTED,
	CD_FANOUT_STATE.COMPLETED,
	CD_FANOUT_STATE.ROLLED_BACK,
	CD_FANOUT_STATE.SUPERSEDED,
]);

function camps(prefix: string, n: number): string[] {
	return Array.from(
		{ length: n },
		(_, i) => `${prefix}-${String(i).padStart(2, "0")}`,
	);
}

/** Tick until terminal, checking `each` after every tick. Fails if it wedges. */
export async function settleFanout(
	world: FanoutWorld,
	bound: number,
	each: (status: FanoutStatusLike) => void = () => undefined,
): Promise<FanoutStatusLike> {
	for (let i = 0; i < bound; i += 1) {
		await world.tick();
		const status = await world.status();
		each(status);
		if (TERMINAL.has(status.state)) return status;
	}
	const status = await world.status();
	check(
		false,
		`fan-out still ${status.state} after ${bound} ticks (in flight ${status.inFlight.join(",")})`,
		"a fan-out always reaches a terminal state; it never wedges",
	);
	return status;
}

export async function runFanoutControllerConformance(
	harness: FanoutControllerHarness,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<FanoutControllerAssertion>> {
	const six = camps("camp", 6);
	const allSucceed = (ids: readonly string[]) =>
		Object.fromEntries(ids.map((id) => [id, "succeed" as const]));
	const progressive: FanoutScenario = {
		camps: six,
		groups: [{ name: "all", campIds: six, mandatory: false }],
		strategy: CD_FANOUT_STRATEGY.PROGRESSIVE,
		maxConcurrency: 2,
		maxFailures: 0,
		outcomes: allSucceed(six),
	};
	const piloted = (pilotOutcome: "succeed" | "fail"): FanoutScenario => ({
		camps: six,
		groups: [
			{ name: "pilot", campIds: six.slice(0, 2), mandatory: true },
			{ name: "rest", campIds: six.slice(2), mandatory: false },
		],
		strategy: CD_FANOUT_STRATEGY.PROGRESSIVE_PER_GROUP,
		maxConcurrency: 6,
		maxFailures: 10,
		outcomes: { ...allSucceed(six), [six[0] ?? ""]: pilotOutcome },
	});
	const bound = 6 * 8;
	return runCdAssertions<FanoutControllerAssertion>(
		FANOUT_CONTROLLER_SUITE,
		harness.subject,
		{
			concurrencyIsBounded: async () => {
				const world = await harness.start(progressive);
				const end = await settleFanout(world, bound, (status) => {
					check(
						status.inFlight.length <= 2,
						`${status.inFlight.length} Camps in flight over max_concurrency 2`,
						"never exceed max_concurrency (I20)",
					);
				});
				check(
					end.state === CD_FANOUT_STATE.COMPLETED,
					`fan-out ended ${end.state}`,
					"a fan-out with no failures completes",
				);
				check(
					end.succeeded.length === 6,
					`${end.succeeded.length} of 6 succeeded`,
					"every Camp is promoted",
				);
			},
			mandatoryGroupRunsFirst: async () => {
				const world = await harness.start(piloted("succeed"));
				const pilot = new Set(six.slice(0, 2));
				await settleFanout(world, bound, (status) => {
					const pilotDone = [...pilot].every((id) =>
						status.succeeded.includes(id),
					);
					const restStarted = world.started().some((id) => !pilot.has(id));
					check(
						!restStarted || pilotDone,
						"a later group started before the mandatory group finished",
						"mandatory groups finish before others start (I20)",
					);
				});
			},
			mandatoryFailureStopsRemainder: async () => {
				const world = await harness.start(piloted("fail"));
				const end = await settleFanout(world, bound);
				const pilot = new Set(six.slice(0, 2));
				check(
					world.started().every((id) => pilot.has(id)),
					"remaining groups started after a mandatory failure",
					"a failed mandatory group stops the fan-out (§10 WP23)",
				);
				check(
					end.state !== CD_FANOUT_STATE.COMPLETED,
					"fan-out completed despite a failed mandatory group",
					"halt when a mandatory group fails",
				);
			},
			budgetExceededHalts: async () => {
				const ten = camps("camp", 10);
				const scenario: FanoutScenario = {
					camps: ten,
					groups: [{ name: "all", campIds: ten, mandatory: false }],
					strategy: CD_FANOUT_STRATEGY.PROGRESSIVE,
					maxConcurrency: 1,
					maxFailures: 1,
					outcomes: Object.fromEntries(
						ten.map((id, i) => [id, i < 4 ? "fail" : "succeed"]),
					),
				};
				const world = await harness.start(scenario);
				const end = await settleFanout(world, 10 * 8);
				check(
					end.state === CD_FANOUT_STATE.HALTED ||
						end.state === CD_FANOUT_STATE.ROLLED_BACK,
					`fan-out ended ${end.state}`,
					"halt when failures exceed max_failures (I20)",
				);
				check(
					world.started().length <= 3,
					`${world.started().length} Camps started after the budget was spent`,
					"stop scheduling at the halt",
				);
			},
			deferredAreNotFailures: async () => {
				const ten = camps("camp", 10);
				const scenario: FanoutScenario = {
					camps: ten,
					groups: [{ name: "all", campIds: ten, mandatory: false }],
					strategy: CD_FANOUT_STRATEGY.PROGRESSIVE,
					maxConcurrency: 3,
					maxFailures: 0,
					outcomes: Object.fromEntries(
						ten.map((id, i) => [id, i % 4 === 1 ? "defer" : "succeed"]),
					),
				};
				const world = await harness.start(scenario);
				const end = await settleFanout(world, 10 * 8);
				check(
					end.state !== CD_FANOUT_STATE.HALTED,
					"deferred Camps halted a zero-budget fan-out",
					"deferred Camps never count as failures (I20)",
				);
				check(
					end.failed.length === 0,
					`${end.failed.length} Camps marked failed`,
					"an unreachable Camp is deferred, not failed (§10 WP23)",
				);
				check(
					end.deferred.length === 3,
					`${end.deferred.length} of 3 unreachable Camps deferred`,
					"record deferred Camps for catch-up",
				);
			},
			startIsIdempotent: async () => {
				const world = await harness.start(progressive);
				const first = (await world.status()).fanoutId;
				const again = await world.startAgain();
				check(
					first === again,
					"the same idempotency key started a second fan-out",
					"start is idempotent (I12)",
				);
			},
			neverWedges: async () => {
				for (const scenario of [
					progressive,
					piloted("succeed"),
					piloted("fail"),
				]) {
					await settleFanout(await harness.start(scenario), bound);
				}
			},
		},
		options,
	);
}
