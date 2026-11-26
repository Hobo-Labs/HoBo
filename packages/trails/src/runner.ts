/**
 * Trail runner — plan / progressive dual / cutover / compensate.
 * Progressive ramp uses Harness FeatureFlagStore behind a sealed local port.
 */
import { type TrailRunRecord, TrailRunService } from "./aggregate.js";
import { type CanTrailResult, evaluateCanTrail } from "./can-trail.js";
import type { DataDualPort } from "./data-dual-port.js";
import {
	applySchemaStep,
	createContractAssertedDataDualFixtures,
	type DataDualFixture,
	type DataDualResult,
	evaluateDataDual,
	evaluateDataDualEvidence,
	type SchemaApplyResult,
} from "./data-steps.js";
import {
	orderTrailSteps,
	type TrailDefinition,
	type TrailStep,
} from "./definition.js";
import { TRAIL_EVENTS, type TrailEvent } from "./events.js";
import {
	stepChecksum,
	type TrailHistoryEntry,
	TrailHistoryStore,
} from "./history.js";
import {
	activateIdentityContinuousFromMatching,
	advanceIdentityTrailRamp,
	createHandsOffIdentityTrail,
	type IdentityTrailHandle,
	type TrailIdentityProgress,
} from "./identity-trail.js";
import {
	createProgressiveFlagPort,
	type ProgressiveFlagPort,
} from "./progressive-flags.js";
import { composeTrailWithRecipes } from "./recipes.js";

// public-contract: trail runner schema.
export const TRAIL_RUNNER_SCHEMA = "hobo.trail-runner/v1" as const;

export type TrailPlanEvidence = Readonly<{
	schemaVersion: typeof TRAIL_RUNNER_SCHEMA;
	canTrail: CanTrailResult;
	orderedStepIds: readonly string[];
	dryRun: true;
	identityContinuous: boolean;
	bindleConfigRequired: boolean;
}>;

export type TrailRunResult = Readonly<{
	schemaVersion: typeof TRAIL_RUNNER_SCHEMA;
	run: TrailRunRecord;
	events: readonly TrailEvent[];
	history: readonly TrailHistoryEntry[];
	schemaResults: readonly SchemaApplyResult[];
	dataResults: readonly DataDualResult[];
	identityProgress?: TrailIdentityProgress;
	/** Progressive cohort flag percent when Harness ramp used. */
	rampPercent: number;
	aborted: boolean;
	cutover: boolean;
	compensated: boolean;
}>;

export type TrailRunnerOptions = Readonly<{
	readonly tenant: string;
	readonly target: string;
	readonly now?: () => string;
	readonly history?: TrailHistoryStore;
	readonly dataFixture?: DataDualFixture;
	/**
	 * Live data-dual port (two real stores + CDC replication). When present it
	 * supersedes `dataFixture`: every data step re-snapshots both stores so the
	 * oracle judges live state, not a frozen fixture (vision-gap Phase 7).
	 */
	readonly dataDual?: DataDualPort;
	readonly dualOracleReady?: boolean;
	readonly junctionHealthy?: boolean;
	readonly policyAllows?: boolean;
}>;

export class TrailRunner {
	readonly tenant: string;
	readonly target: string;
	readonly history: TrailHistoryStore;
	readonly service: TrailRunService;
	private readonly flags: ProgressiveFlagPort;
	private readonly dataFixture: DataDualFixture;
	private readonly dataDual: DataDualPort | undefined;
	private readonly dualOracleReady: boolean;
	private readonly junctionHealthy: boolean;
	private readonly policyAllows: boolean;
	private readonly now: () => string;

	constructor(options: TrailRunnerOptions) {
		this.tenant = options.tenant;
		this.target = options.target;
		this.now = options.now ?? (() => new Date().toISOString());
		this.history = options.history ?? new TrailHistoryStore();
		this.flags = createProgressiveFlagPort(this.now);
		this.service = new TrailRunService({ now: this.now });
		this.dataFixture =
			options.dataFixture ?? createContractAssertedDataDualFixtures();
		this.dataDual = options.dataDual;
		this.dualOracleReady = options.dualOracleReady !== false;
		this.junctionHealthy = options.junctionHealthy !== false;
		this.policyAllows = options.policyAllows !== false;
	}

	/** Dry-run plan — no mutations. */
	plan(trail: TrailDefinition): TrailPlanEvidence {
		const composed = composeTrailWithRecipes(trail);
		const canTrail = evaluateCanTrail({
			trail: composed,
			policyAllows: this.policyAllows,
			dualOracleReady: this.dualOracleReady,
			junctionHealthy: this.junctionHealthy,
		});
		const ordered = canTrail.ok ? orderTrailSteps(composed.steps) : [];
		return Object.freeze({
			schemaVersion: TRAIL_RUNNER_SCHEMA,
			canTrail,
			orderedStepIds: Object.freeze(ordered.map((s) => s.id)),
			dryRun: true as const,
			identityContinuous: canTrail.evidence.identityContinuous,
			bindleConfigRequired: canTrail.evidence.bindleConfigRequired,
		});
	}

	/**
	 * Execute progressive Trail. Auto-abort + compensate on dual/junction failure.
	 */
	run(
		trail: TrailDefinition,
		options?: {
			readonly dryRun?: boolean;
			/** Force dual divergence for Golden fail-closed tests. */
			readonly forceDataDiverge?: boolean;
			/** Progressive ramp percents (Harness-style). */
			readonly rampSteps?: readonly number[];
		},
	): TrailRunResult {
		const composed = composeTrailWithRecipes(trail);
		const plan = this.plan(composed);
		if (!plan.canTrail.ok) {
			this.service.start({
				trail: composed,
				tenant: this.tenant,
				target: this.target,
				identityLinked: plan.identityContinuous,
			});
			this.service.fail(plan.canTrail.summary);
			return this.result({
				schemaResults: [],
				dataResults: [],
				rampPercent: 0,
				aborted: true,
				cutover: false,
				compensated: false,
			});
		}

		const ordered = orderTrailSteps(composed.steps);
		const identityLinked = ordered.some(
			(s) => s.kind === "identity-continuous",
		);
		this.service.start({
			trail: composed,
			tenant: this.tenant,
			target: this.target,
			identityLinked,
		});

		const dryRun = options?.dryRun === true;
		const schemaResults: SchemaApplyResult[] = [];
		const dataResults: DataDualResult[] = [];
		let identityProgress: TrailIdentityProgress | undefined;
		let identityHandle: IdentityTrailHandle | undefined;
		let rampPercent = 0;

		const dataFixture = options?.forceDataDiverge
			? createContractAssertedDataDualFixtures({ diverge: true })
			: this.dataFixture;

		// Identity continuous hands-off path first when present.
		if (identityLinked) {
			identityHandle = createHandsOffIdentityTrail({
				tenant: this.tenant,
				now: this.now,
			});
			identityProgress = activateIdentityContinuousFromMatching({
				handle: identityHandle,
			});
			const idStep = ordered.find((s) => s.kind === "identity-continuous");
			if (idStep) {
				this.service.enterDual(idStep.id);
				this.service.completeStep(idStep.id);
			}
		}

		for (const step of ordered) {
			if (step.kind === "identity-continuous") continue; // already handled
			if (
				this.history.isApplied(
					composed.id,
					step.id,
					this.target,
					this.tenant,
				) &&
				!dryRun
			) {
				this.service.completeStep(step.id);
				continue;
			}

			if (step.kind === "schema") {
				const r = applySchemaStep(step, { dryRun });
				schemaResults.push(r);
				if (r.dualSchema) this.service.enterDual(step.id);
				this.service.completeStep(step.id);
				if (!dryRun) {
					this.recordHistory(composed, step);
				}
			} else if (
				step.kind === "data-transform" ||
				step.kind === "continuous-dual-data"
			) {
				// Live port supersedes the fixture: judge both stores NOW so the
				// oracle sees real replicated state at this step. A port that
				// offers digest evidence is judged on it — no row leaves the
				// store; the row view is the fallback for ports without it.
				const liveEvidence = this.dataDual?.evidence?.();
				const r =
					liveEvidence !== undefined
						? evaluateDataDualEvidence(step, liveEvidence)
						: evaluateDataDual(
								step,
								this.dataDual ? this.dataDual.snapshot() : dataFixture,
							);
				dataResults.push(r);
				if (!r.consistent || !r.zeroLoss) {
					this.service.setDualHealth(false);
					return this.result({
						schemaResults,
						dataResults,
						...(identityProgress !== undefined
							? { identityProgress }
							: undefined),
						rampPercent,
						aborted: true,
						cutover: false,
						compensated: true,
					});
				}
				this.service.enterDual(step.id);
				this.service.completeStep(step.id);
				if (!dryRun) this.recordHistory(composed, step);
			} else if (step.kind === "junction-rebind") {
				if (!this.junctionHealthy) {
					this.service.setJunctionHealth(false);
					return this.result({
						schemaResults,
						dataResults,
						...(identityProgress !== undefined
							? { identityProgress }
							: undefined),
						rampPercent,
						aborted: true,
						cutover: false,
						compensated: true,
					});
				}
				this.service.completeStep(step.id);
				if (!dryRun) this.recordHistory(composed, step);
			} else if (step.kind === "validation") {
				const dualOk =
					dataResults.every((d) => d.consistent && d.zeroLoss) &&
					(identityProgress ? identityProgress.migrationPresent : true);
				if (!dualOk) {
					this.service.setDualHealth(false);
					return this.result({
						schemaResults,
						dataResults,
						...(identityProgress !== undefined
							? { identityProgress }
							: undefined),
						rampPercent,
						aborted: true,
						cutover: false,
						compensated: true,
					});
				}
				this.service.markValidated();
				this.service.completeStep(step.id);
				if (!dryRun) this.recordHistory(composed, step);
			} else if (step.kind === "cutover") {
				// Progressive ramp via Harness FeatureFlagStore before cutover.
				const ramps = options?.rampSteps ?? [10, 50, 100];
				const flagKey = `trail.${composed.id}.${this.target}`;
				this.flags.define({
					key: flagKey,
					percentage: 0,
					defaultValue: false,
					metadata: { tenant: this.tenant, trail: composed.id },
				});
				for (const p of ramps) {
					this.flags.define({
						key: flagKey,
						percentage: p,
					});
					rampPercent = p;
					this.service.ramp(p, step.id);
					// Auto-abort if dual health flipped mid-ramp.
					if (this.service.snapshot()?.dualOk === false) {
						return this.result({
							schemaResults,
							dataResults,
							...(identityProgress !== undefined
								? { identityProgress }
								: undefined),
							rampPercent,
							aborted: true,
							cutover: false,
							compensated: true,
						});
					}
				}
				if (identityHandle && identityProgress?.migrationPresent) {
					identityProgress = advanceIdentityTrailRamp(identityHandle, 100);
				}
				this.service.cutover();
				this.service.completeStep(step.id);
				if (!dryRun) this.recordHistory(composed, step);
			} else {
				// secretless-reresolve, custom, compose — mark complete when safe.
				this.service.completeStep(step.id);
				if (!dryRun) this.recordHistory(composed, step);
			}
		}

		// If no explicit cutover step but all steps done, cutover.
		const snap = this.service.snapshot();
		if (
			snap &&
			snap.state !== "cutover" &&
			snap.state !== "compensated" &&
			snap.state !== "failed" &&
			snap.state !== "aborted"
		) {
			if (snap.state !== "validated") this.service.markValidated();
			this.service.cutover();
			rampPercent = 100;
		}

		return this.result({
			schemaResults,
			dataResults,
			...(identityProgress !== undefined ? { identityProgress } : undefined),
			rampPercent,
			aborted: false,
			cutover: this.service.snapshot()?.state === "cutover",
			compensated: this.service.snapshot()?.state === "compensated",
		});
	}

	private recordHistory(trail: TrailDefinition, step: TrailStep): void {
		const entry = this.history.record({
			trailId: trail.id,
			trailVersion: trail.version,
			stepId: step.id,
			target: this.target,
			tenant: this.tenant,
			checksum: stepChecksum(step),
			appliedAt: this.now(),
			status: "applied",
		});
		// Also emit history event on the run stream.
		const rec = this.service.snapshot();
		if (rec) {
			this.service.events.push(
				Object.freeze({
					id: `evt-history-${entry.stepId}-${rec.runId}`,
					type: TRAIL_EVENTS.HistoryRecorded,
					schemaVersion: "hobo.trail-events/v1" as const,
					tenant: this.tenant,
					seq: this.service.events.length + 1,
					time: this.now(),
					correlationId: `corr-trail-${rec.runId}`,
					causationId: `cause-history-${entry.stepId}`,
					retention: rec.identityLinked
						? ("credential-audit-never-compact" as const)
						: ("standard" as const),
					data: Object.freeze({
						trailId: entry.trailId,
						stepId: entry.stepId,
						checksum: entry.checksum,
						target: entry.target,
					}),
				}),
			);
		}
	}

	private result(input: {
		schemaResults: SchemaApplyResult[];
		dataResults: DataDualResult[];
		identityProgress?: TrailIdentityProgress;
		rampPercent: number;
		aborted: boolean;
		cutover: boolean;
		compensated: boolean;
	}): TrailRunResult {
		const run = this.service.snapshot();
		if (run === null) {
			throw new Error("trail run result requested before the run started");
		}
		// Derive terminal flags from aggregate state — never claim compensated
		// while run.state is still cutover (or the reverse).
		const compensated = run.state === "compensated";
		const cutover = run.state === "cutover";
		const aborted =
			input.aborted ||
			run.state === "aborted" ||
			run.state === "failed" ||
			compensated;
		return Object.freeze({
			schemaVersion: TRAIL_RUNNER_SCHEMA,
			run,
			events: Object.freeze([...this.service.events]),
			history: this.history.list({
				tenant: this.tenant,
				target: this.target,
			}),
			schemaResults: Object.freeze([...input.schemaResults]),
			dataResults: Object.freeze([...input.dataResults]),
			...(input.identityProgress !== undefined
				? { identityProgress: input.identityProgress }
				: undefined),
			rampPercent: compensated ? 0 : input.rampPercent,
			aborted,
			cutover,
			compensated,
		});
	}
}
