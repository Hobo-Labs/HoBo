import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	runCdAssertions,
} from "./cd-kit.js";

export const CD_CHAOS_SUITE = "hobo.cd.chaos/v1";

export const CD_CHAOS_FAULTS = Object.freeze([
	"reconciler-killed-mid-converge",
	"agent-partitioned",
	"store-failover",
	"source-registry-outage",
	"agent-flapping-conditions",
	"mass-lease-loss",
] as const);
export type CdChaosFault = (typeof CD_CHAOS_FAULTS)[number];

export type CdChaosAssertion =
	| `${CdChaosFault}:invariants`
	| `${CdChaosFault}:recovers`;

export type ChaosObservation = Readonly<{
	converged: boolean;
	duplicateApplies: number;
	noRunTaints: number;
	failoversInFlight: number;
	failoverBudget: number;
	purgedBeforeReplacementQualified: number;
	checkpointRegressions: number;
	unverifiedFreight: number;
}>;

export interface ChaosWorld {
	inject(fault: CdChaosFault): Promise<void>;
	heal(fault: CdChaosFault): Promise<void>;
	step(): Promise<void>;
	observe(): Promise<ChaosObservation>;
}

export interface CdChaosHarness {
	readonly subject: string;
	create(fault: CdChaosFault): Promise<ChaosWorld>;
}

export type CdChaosOptions = CdSuiteOptions &
	Readonly<{
		faultSteps?: number;
		recoverSteps?: number;
	}>;

function checkInvariants(
	fault: CdChaosFault,
	o: ChaosObservation,
	phase: string,
): void {
	const at = `${fault} ${phase}`;
	check(
		o.duplicateApplies === 0,
		`${at}: ${o.duplicateApplies} duplicate apply(ies)`,
		"resume by observation; never repeat an apply (§10 WP7)",
	);
	check(
		o.noRunTaints === 0,
		`${at}: ${o.noRunTaints} NO_RUN taint(s)`,
		"agent self-reports never add NO_RUN (I19, §10 WP22)",
	);
	check(
		o.failoversInFlight <= o.failoverBudget,
		`${at}: ${o.failoversInFlight} failovers over budget ${o.failoverBudget}`,
		"the failover budget holds (I21)",
	);
	check(
		o.purgedBeforeReplacementQualified === 0,
		`${at}: a source was purged before its replacement qualified`,
		"GRACEFUL never purges early (I21)",
	);
	check(
		o.checkpointRegressions === 0,
		`${at}: ${o.checkpointRegressions} checkpoint regression(s)`,
		"no lost or duplicate checkpoint across failover (§10 WP17)",
	);
	check(
		o.unverifiedFreight === 0,
		`${at}: Freight created without a verified read`,
		"trigger, don't trust (I15)",
	);
}

export async function runCdChaos(
	harness: CdChaosHarness,
	options: CdChaosOptions = {},
): Promise<CdConformanceReport<CdChaosAssertion>> {
	const faultSteps = options.faultSteps ?? 20;
	const recoverSteps = options.recoverSteps ?? 40;
	const checks: Partial<Record<CdChaosAssertion, () => Promise<void>>> = {};
	const outcomes = new Map<CdChaosFault, Promise<ChaosObservation>>();
	const play = (fault: CdChaosFault): Promise<ChaosObservation> => {
		const existing = outcomes.get(fault);
		if (existing) return existing;
		const run = (async () => {
			const world = await harness.create(fault);
			await world.inject(fault);
			for (let i = 0; i < faultSteps; i += 1) {
				await world.step();
				checkInvariants(
					fault,
					await world.observe(),
					`during fault (step ${i + 1})`,
				);
			}
			await world.heal(fault);
			for (let i = 0; i < recoverSteps; i += 1) {
				await world.step();
				const o = await world.observe();
				checkInvariants(fault, o, `after heal (step ${i + 1})`);
				if (o.converged) return o;
			}
			return world.observe();
		})();
		outcomes.set(fault, run);
		return run;
	};
	for (const fault of CD_CHAOS_FAULTS) {
		checks[`${fault}:invariants`] = async () => {
			await play(fault);
		};
		checks[`${fault}:recovers`] = async () => {
			let final: ChaosObservation | undefined;
			try {
				final = await play(fault);
			} catch {
				return check(
					false,
					`${fault} broke an invariant before recovery could be judged`,
					"fix the invariant first",
				);
			}
			check(
				final.converged,
				`${fault} did not converge within ${recoverSteps} steps after heal`,
				"chaos never ends wedged (WP20 Accept)",
			);
		};
	}
	return runCdAssertions(
		CD_CHAOS_SUITE,
		harness.subject,
		// oxlint-disable-next-line anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the loop above assigned every assertion key.
		checks as Record<CdChaosAssertion, () => Promise<void>>,
		options,
	);
}
