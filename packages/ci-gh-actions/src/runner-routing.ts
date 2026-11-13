/**
 * Committed routing policy: `runnerRouting` in `.hobo/ci.json` (plan 0026,
 * 3.4; ADR-0181). It replaces every repository variable and box environment
 * variable that chose a runner label, a tier, a slot split, a limit or a
 * reporter. Its values are the code's defaults, so committing them changed
 * nothing.
 *
 * Mirrored by `#RunnerRouting` in `data-models/onboarding.cue` and, without
 * dependencies, by `scripts/ci/runner-routing.mts` (what the route job runs
 * from a sparse checkout). The three agree on every fixture.
 */
import { z } from "zod";

/**
 * GitHub's generic self-hosted labels: any self-hosted runner carries them, so
 * a route naming one would hand the job to whichever runner asks first.
 */
export const GENERIC_RUNNER_LABELS: ReadonlySet<string> = new Set([
	"self-hosted",
	"linux",
	"x64",
	"arm64",
	"windows",
	"macos",
]);

/** A runner label routing may name: lower case, never a generic one. */
export const RunnerRoutingLabelSchema = z
	.string()
	.regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/u)
	.refine((label) => !GENERIC_RUNNER_LABELS.has(label), {
		message: "a generic self-hosted label matches any runner",
	});

const whole = (min: number, max: number) => z.number().int().min(min).max(max);

const RunnerRoutingPoolSchema = z
	.object({
		labels: z.array(RunnerRoutingLabelSchema).min(1).max(16),
		runnerNamePrefix: z.string().min(1).max(128),
		maxRunners: whole(0, 10_000),
	})
	.strict();

export const RUNNER_ROUTING_PINS = [
	"auto",
	"fleet",
	"local",
	"github",
] as const;
export type RunnerRoutingPin = (typeof RUNNER_ROUTING_PINS)[number];

export const RunnerRoutingSchema = z
	.object({
		pin: z.enum(RUNNER_ROUTING_PINS),
		queue: z
			.object({ maxWaitSeconds: whole(1, 3600), maxQueued: whole(1, 100) })
			.strict(),
		labels: z
			.object({
				fleet: RunnerRoutingLabelSchema,
				trunk: RunnerRoutingLabelSchema,
				local: RunnerRoutingLabelSchema,
				github: RunnerRoutingLabelSchema,
			})
			.strict(),
		localRunner: z.boolean(),
		mainWorkspaceParallelCap: whole(1, 8),
		verdict: z
			.object({
				minFreeRunners: whole(1, 9999),
				enterMs: whole(10_000, 3_600_000),
				exitMs: whole(10_000, 3_600_000),
				stallMs: whole(60_000, 3_600_000),
			})
			.strict(),
		box: z
			.object({
				slots: whole(1, 8),
				trunkSlots: whole(0, 7),
				trunkLend: z.union([z.literal(0), z.literal(1)]),
				prCapWithTrunk: whole(0, 8),
				mergeGroupLeases: whole(1, 8),
				capacityVolatilityMb: whole(0, 1_048_576),
				trunkHeadroomFleetDeferMs: whole(1000, 3_600_000),
				jobAdmission: z.enum(["pull", "push"]),
			})
			.strict()
			.refine((box) => box.trunkSlots < box.slots, {
				message: "trunkSlots must leave at least one shared slot",
			}),
		externalPools: z.array(RunnerRoutingPoolSchema).max(32),
		retiredVariables: z
			.array(z.string().regex(/^HOBO_CI_[A-Z0-9_]{1,60}$/u))
			.max(32),
	})
	.strict()
	.meta({ id: "RunnerRouting" });

export type RunnerRouting = Readonly<z.infer<typeof RunnerRoutingSchema>>;

/** The policy, or nothing when it is not one. Never throws. */
export function parseRunnerRouting(
	value: z.infer<ReturnType<typeof z.json>> | undefined,
): RunnerRouting | undefined {
	const parsed = RunnerRoutingSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Every label a routing slip may name: the committed `labels`. */
export function runnerRoutingLabels(
	policy: RunnerRouting,
): ReadonlySet<string> {
	return new Set(Object.values(policy.labels));
}
