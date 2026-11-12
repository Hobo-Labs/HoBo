// The CD chaos lane (plan 0024 WP20). Each fault is injected into a world that
// is converging a workload; the suite steps the world, checks the fault's
// invariants after every step, heals, and requires convergence within a bound.
// "Never ends wedged" is the shared property: every fault recovers.
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	runCdAssertions,
} from "./cd-kit.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const CD_CHAOS_SUITE = "hobo.cd.chaos/v1";

// public-contract: the CD chaos faults (plan 0024 WP20).
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

/** What the harness observes of the world after each step. */
export type ChaosObservation = Readonly<{
	/** Every target Camp converged to the newest desired Set. */
	converged: boolean;
	/** Mutating applies beyond one per (Camp, Set). */
	duplicateApplies: number;
	/** NO_RUN taints present (only operators or multi-signal rules may add them). */
	noRunTaints: number;
	/** Failovers running and the Rail's max_concurrent. */
	failoversInFlight: number;
	failoverBudget: number;
	/** Failover sources purged before their replacement qualified. */
	purgedBeforeReplacementQualified: number;
	/** Checkpoints that moved backwards or were lost across a store failover. */
	checkpointRegressions: number;
	/** Freight created from unverified payloads during a source outage. */
	unverifiedFreight: number;
}>;

export interface ChaosWorld {
	inject(fault: CdChaosFault): Promise<void>;
	heal(fault: CdChaosFault): Promise<void>;
	/** One tick of every controller and reconciler, plus clock advance. */
	step(): Promise<void>;
	observe(): Promise<ChaosObservation>;
}

export interface CdChaosHarness {
	readonly subject: string;
	/** A world converging a workload, with the controllers the fault touches running. */
	create(fault: CdChaosFault): Promise<ChaosWorld>;
}

export type CdChaosOptions = CdSuiteOptions &
	Readonly<{
		/** Steps the fault stays injected. Default 20. */
		faultSteps?: number;
		/** Steps allowed to recover after heal. Default 40. */
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
				// Invariant breaches are reported under `:invariants`; recovery is judged separately.
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
