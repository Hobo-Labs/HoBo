// HealthSource conformance (plan 0024 D9, I5). A health source returns the
// samples it observed for one cohort and window, or a typed refusal. It never
// fabricates data: "no data" must reach the verifier as no data, so that the
// verification fails closed.
import {
	abortedSignal,
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkSecretFree,
	checkTypedRefusal,
	runCdAssertions,
} from "./cd-kit.js";
import {
	CD_COHORT,
	type HealthSamplesLike,
	type HealthSourceLike,
	type Outcome,
} from "./cd-shapes.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const HEALTH_SOURCE_SUITE = "hobo.cd.health-source/v1";

// public-contract: assertion names of the HealthSource suite.
export const HEALTH_SOURCE_ASSERTIONS = Object.freeze([
	"kindIsDeclared",
	"returnsObservedSamples",
	"cohortsAreSeparated",
	"noDataIsNeverFabricated",
	"unreachableIsTypedRefusal",
	"queryIsDeterministic",
	"windowIsEchoed",
	"abortIsHonoured",
	"resultsAreSecretFree",
] as const);
export type HealthSourceAssertion = (typeof HEALTH_SOURCE_ASSERTIONS)[number];

/** What the backend holds for the queried series, as the harness seeds it. */
export type HealthWorld = Readonly<{
	canary?: readonly number[];
	baseline?: readonly number[];
	/** The backend refuses connections (outage). */
	unreachable?: boolean;
}>;

export interface HealthSourceHarness<TQuery, TCtx> {
	readonly subject: string;
	readonly expectedKind: number;
	readonly campId: string;
	create(world: HealthWorld): Promise<HealthSourceLike<TQuery, TCtx>>;
	query(): TQuery;
	ctx(): TCtx;
}

const FROM_MS = 1_000_000;
const TO_MS = 1_600_000;

function sorted(values: readonly number[]): string {
	return [...values].sort((a, b) => a - b).join(",");
}

export async function runHealthSourceConformance<TQuery, TCtx>(
	harness: HealthSourceHarness<TQuery, TCtx>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<HealthSourceAssertion>> {
	const ask = (
		source: HealthSourceLike<TQuery, TCtx>,
		cohort: number,
		signal: AbortSignal = new AbortController().signal,
	): Promise<Outcome<HealthSamplesLike>> =>
		source.query(
			{
				query: harness.query(),
				campId: harness.campId,
				cohort,
				fromMs: FROM_MS,
				toMs: TO_MS,
				signal,
			},
			harness.ctx(),
		);
	const samples = async (
		source: HealthSourceLike<TQuery, TCtx>,
		cohort: number,
	): Promise<HealthSamplesLike> => {
		const outcome = await ask(source, cohort);
		check(
			outcome.ok,
			"a reachable backend with data was refused",
			"return the observed samples",
		);
		if (!outcome.ok) throw new Error("unreachable");
		return outcome.value;
	};
	const canary = [0.01, 0.02, 0.015, 0.03];
	const baseline = [0.011, 0.012, 0.01, 0.013];
	return runCdAssertions<HealthSourceAssertion>(
		HEALTH_SOURCE_SUITE,
		harness.subject,
		{
			kindIsDeclared: async () => {
				const source = await harness.create({ canary, baseline });
				check(
					source.kind === harness.expectedKind,
					`kind ${source.kind} is not ${harness.expectedKind}`,
					"declare the HealthSourceKind served",
				);
			},
			returnsObservedSamples: async () => {
				const source = await harness.create({ canary, baseline });
				const got = await samples(source, CD_COHORT.CANARY);
				check(
					sorted(got.values) === sorted(canary),
					`canary samples ${got.values.join(",")} differ from the backend`,
					"return exactly the observed samples",
				);
			},
			cohortsAreSeparated: async () => {
				const source = await harness.create({ canary, baseline });
				const a = await samples(source, CD_COHORT.CANARY);
				const b = await samples(source, CD_COHORT.BASELINE);
				check(
					sorted(b.values) === sorted(baseline),
					"baseline samples differ from the backend",
					"filter by the query's cohort_label",
				);
				check(
					sorted(a.values) !== sorted(b.values),
					"canary and baseline returned the same samples",
					"canary and baseline are separate series",
				);
			},
			noDataIsNeverFabricated: async () => {
				const source = await harness.create({ canary: [], baseline: [] });
				const outcome = await ask(source, CD_COHORT.CANARY);
				check(
					!outcome.ok || outcome.value.values.length === 0,
					`an empty backend produced ${outcome.ok ? outcome.value.values.length : 0} sample(s)`,
					"no data is no data; the verifier fails closed on it (I5, C3)",
				);
			},
			unreachableIsTypedRefusal: async () => {
				const source = await harness.create({ unreachable: true });
				const outcome = await ask(source, CD_COHORT.CANARY);
				checkTypedRefusal(outcome, "a query against an unreachable backend");
			},
			queryIsDeterministic: async () => {
				const source = await harness.create({ canary, baseline });
				const a = await samples(source, CD_COHORT.CANARY);
				const b = await samples(source, CD_COHORT.CANARY);
				check(
					a.values.join(",") === b.values.join(","),
					"two identical queries disagree",
					"the same query over the same window returns the same samples (I8)",
				);
			},
			windowIsEchoed: async () => {
				const source = await harness.create({ canary, baseline });
				const got = await samples(source, CD_COHORT.CANARY);
				check(
					got.fromMs === FROM_MS && got.toMs === TO_MS,
					`window ${got.fromMs}..${got.toMs} is not the requested one`,
					"echo the queried window",
				);
			},
			abortIsHonoured: async () => {
				const source = await harness.create({ canary, baseline });
				let outcome: Outcome<HealthSamplesLike> | undefined;
				try {
					outcome = await ask(source, CD_COHORT.CANARY, abortedSignal());
				} catch {
					outcome = undefined;
				}
				check(
					outcome === undefined || !outcome.ok,
					"an aborted query returned samples",
					"check the signal before and after the request",
				);
			},
			resultsAreSecretFree: async () => {
				const source = await harness.create({ unreachable: true });
				checkSecretFree(await ask(source, CD_COHORT.CANARY), "the refusal");
				const live = await harness.create({ canary, baseline });
				checkSecretFree(await ask(live, CD_COHORT.CANARY), "the samples");
			},
		},
		options,
	);
}
