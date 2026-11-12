// Realizer conformance (plan 0024 D5/D6, I5, I9, I12). A Realizer drives one
// Camp toward a desired Set and reports only what it observed.
import {
	abortedSignal,
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkSecretFree,
	requireCapability,
	runCdAssertions,
} from "./cd-kit.js";
import {
	CD_RECONCILE_STATUS,
	type RealizeInputLike,
	type RealizerLike,
	type ReconcileObservationLike,
	type SetRecordLike,
} from "./cd-shapes.js";

export const REALIZER_SUITE = "hobo.cd.realizer/v1";

// public-contract: assertion names of the Realizer suite.
export const REALIZER_ASSERTIONS = Object.freeze([
	"convergeReachesConverged",
	"convergeIsIdempotent",
	"observeIsReadOnly",
	"neverConvergedWithoutObservation",
	"providerSuccessWithoutEffectIsNotConverged",
	"failureIsTypedBlocked",
	"abortIsHonoured",
	"observationIsSecretFree",
] as const);
export type RealizerAssertion = (typeof REALIZER_ASSERTIONS)[number];

/** The target a realizer drives, as the harness controls and inspects it. */
export interface RealizerTarget {
	/** Count of mutating calls the target has received. */
	mutations(): number;
	/** Make the next apply fail with a provider error. */
	failNextApply?(): void;
	/** Make the next apply report success while changing nothing. */
	lieOnNextApply?(): void;
}

export interface RealizerHarness<TSet extends SetRecordLike, TResolved, TCtx> {
	readonly subject: string;
	/** A fresh realizer bound to a fresh target. */
	create(): Promise<{
		realizer: RealizerLike<RealizeInputLike<TSet, TResolved>, TCtx>;
		target: RealizerTarget;
	}>;
	/** A desired-state input for the bound target. `signal` overrides the default live signal. */
	input(signal?: AbortSignal): RealizeInputLike<TSet, TResolved>;
	ctx(): TCtx;
}

function converged(observation: ReconcileObservationLike): boolean {
	return observation.status === CD_RECONCILE_STATUS.CONVERGED;
}

export async function runRealizerConformance<
	TSet extends SetRecordLike,
	TResolved,
	TCtx,
>(
	harness: RealizerHarness<TSet, TResolved, TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<RealizerAssertion>> {
	const remediateConverge =
		"converge must apply the desired Set and confirm it by observation (I5)";
	return runCdAssertions<RealizerAssertion>(
		REALIZER_SUITE,
		harness.subject,
		{
			convergeReachesConverged: async () => {
				const { realizer } = await harness.create();
				const input = harness.input();
				const result = await realizer.converge(input, harness.ctx());
				check(
					converged(result),
					`converge reported status ${result.status}`,
					remediateConverge,
				);
				check(
					result.campId === input.campId,
					"observation names another Camp",
					"echo the input campId",
				);
				check(
					result.setId === input.desired.setId,
					"observation names another Set",
					"echo the desired setId",
				);
				check(
					result.fenceToken === String(input.fence),
					`observation fence ${result.fenceToken} is not ${input.fence}`,
					"stamp the lease fence on every observation (I4)",
				);
			},
			convergeIsIdempotent: async () => {
				const { realizer, target } = await harness.create();
				await realizer.converge(harness.input(), harness.ctx());
				const after = target.mutations();
				const again = await realizer.converge(harness.input(), harness.ctx());
				check(
					converged(again),
					"second converge is not CONVERGED",
					remediateConverge,
				);
				check(
					target.mutations() === after,
					`second converge mutated the target ${target.mutations() - after} more time(s)`,
					"converge is idempotent: observe first and apply only the difference (I12)",
				);
			},
			observeIsReadOnly: async () => {
				const { realizer, target } = await harness.create();
				await realizer.converge(harness.input(), harness.ctx());
				const before = target.mutations();
				const seen = await realizer.observe(harness.input(), harness.ctx());
				check(
					target.mutations() === before,
					"observe mutated the target",
					"observe reads; only converge writes",
				);
				check(
					converged(seen),
					`observe after converge reported ${seen.status}`,
					"observe reports the target as it is",
				);
			},
			neverConvergedWithoutObservation: async () => {
				const { realizer, target } = await harness.create();
				const seen = await realizer.observe(harness.input(), harness.ctx());
				check(
					!converged(seen),
					"observe of an untouched target reported CONVERGED",
					"report convergence only from observation (I5)",
				);
				check(
					target.mutations() === 0,
					"observe of an untouched target mutated it",
					"observe reads; only converge writes",
				);
			},
			providerSuccessWithoutEffectIsNotConverged: async () => {
				const { realizer, target } = await harness.create();
				requireCapability(target.lieOnNextApply, "target.lieOnNextApply")();
				const result = await realizer.converge(harness.input(), harness.ctx());
				check(
					!converged(result),
					"provider success without effect was reported CONVERGED",
					"an ambiguous provider outcome is resolved by observation only (I5)",
				);
			},
			failureIsTypedBlocked: async () => {
				const { realizer, target } = await harness.create();
				requireCapability(target.failNextApply, "target.failNextApply")();
				const result = await realizer.converge(harness.input(), harness.ctx());
				check(
					!converged(result),
					"a failed apply was reported CONVERGED",
					remediateConverge,
				);
				check(
					result.reasons.length > 0,
					"a failed apply carries no reasons",
					"report a typed ReasonRecord",
				);
				for (const reason of result.reasons) {
					check(
						reason.code.length > 0 && (reason.remediation ?? "").length > 0,
						`reason ${reason.code} lacks code or remediation`,
						"every reason has a code and a next step",
					);
				}
			},
			abortIsHonoured: async () => {
				const { realizer, target } = await harness.create();
				let result: ReconcileObservationLike | undefined;
				try {
					result = await realizer.converge(
						harness.input(abortedSignal()),
						harness.ctx(),
					);
				} catch {
					result = undefined;
				}
				check(
					result === undefined || !converged(result),
					"an aborted converge reported CONVERGED",
					"check the signal before every mutating call",
				);
				check(
					target.mutations() === 0,
					"an aborted converge mutated the target",
					"check the signal before every mutating call",
				);
			},
			observationIsSecretFree: async () => {
				const { realizer } = await harness.create();
				const result = await realizer.converge(harness.input(), harness.ctx());
				checkSecretFree(result, "the observation");
			},
		},
		options,
	);
}
