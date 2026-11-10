/**
 * The shared run loop every pattern executor is built on.
 *
 * It gives each executor four things, the same way every time:
 *
 * - **Resumability.** A phase that already has a `migration.PhaseApplied`
 *   fact is skipped and its recorded checkpoint handed back, so re-running an
 *   executor after a crash or a hold continues instead of restarting.
 * - **Continuous policy.** The verdict is recomputed before every phase
 *   (ADR-0177 decision 9). A negative verdict holds the migration at its
 *   last safe state; nothing in the phase runs.
 * - **Safe holds.** A hold is recorded as a fact with its reason, and only in
 *   a phase the catalog marks holdable.
 * - **Facts, not logs.** Everything observable about a run is a
 *   `migration.*` fact in the journal.
 */
import type { PolicyVerdict } from "../custody.js";
import { DataCoreError } from "../errors.js";
import {
	assertHoldable,
	foldMigration,
	MIGRATION_EVENTS,
	type MigrationFact,
	type MigrationJournal,
	type MigrationState,
} from "../facts.js";
import type { JsonObject, JsonValue } from "../json.js";
import {
	getPattern,
	isSafeHold,
	type MigrationPatternId,
	type MigrationPhase,
	type RollbackPosture,
} from "../patterns.js";
import type { Awaitable } from "../spi.js";

export interface MigrationRuntime {
	readonly migrationId: string;
	readonly journal: MigrationJournal;
	/** Injected clock, RFC 3339. Executors never read the wall clock. */
	readonly clock: () => string;
	/** Recomputed before every phase transition. */
	readonly policy: (phase: MigrationPhase) => Awaitable<PolicyVerdict>;
	readonly onFact?: (fact: MigrationFact) => void;
	/**
	 * Runs after a phase's fact is journaled. Exists so a test can crash a run
	 * at every phase boundary and prove it resumes to the same result.
	 */
	readonly afterPhase?: (phase: MigrationPhase) => Awaitable<void>;
	/**
	 * Stop after this phase and report `held`. An operator's "run up to the
	 * verify step and wait" — and the way a soak window is left open.
	 */
	readonly pauseAfter?: MigrationPhase;
}

export const MIGRATION_RUN_STATUSES = [
	"completed",
	"held",
	"rolled-back",
	"failed",
] as const;
export type MigrationRunStatus = (typeof MIGRATION_RUN_STATUSES)[number];

// domain-view: executor result; wire form is MigrationRunResult in data-models/data_core.proto.
export interface MigrationRunResult {
	readonly migrationId: string;
	readonly pattern: MigrationPatternId;
	readonly status: MigrationRunStatus;
	/** The last phase that completed. */
	readonly phase: MigrationPhase;
	/** Rollback still available at the point the run stopped. */
	readonly rollback: RollbackPosture;
	readonly reason?: string;
	/** Impedance the run surfaced (ADR-0144): real limits, stated. */
	readonly impedance: readonly string[];
	readonly facts: readonly MigrationFact[];
	readonly state: MigrationState;
}

/** Thrown inside a phase to stop the run at a safe hold. */
export class MigrationHold extends Error {
	readonly phase: MigrationPhase;
	readonly reason: string;

	constructor(phase: MigrationPhase, reason: string) {
		super(`migration held at ${phase}: ${reason}`);
		this.name = "MigrationHold";
		this.phase = phase;
		this.reason = reason;
	}
}

/** Thrown inside a phase when the run compensated and must stop. */
export class MigrationRollback extends Error {
	readonly reason: string;
	readonly lossless: boolean;

	constructor(reason: string, lossless: boolean) {
		super(`migration rolled back: ${reason}`);
		this.name = "MigrationRollback";
		this.reason = reason;
		this.lossless = lossless;
	}
}

export interface PlannedDetails {
	readonly decisionDigest?: string;
	readonly custodyDigest?: string;
	readonly source?: string;
	readonly target?: string;
	readonly dataset?: string;
}

export class MigrationRun {
	private facts: MigrationFact[];
	private current: MigrationState;
	private lastPhase: MigrationPhase = "plan";
	private readonly impedance = new Set<string>();

	private constructor(
		readonly runtime: MigrationRuntime,
		readonly pattern: MigrationPatternId,
		facts: readonly MigrationFact[],
	) {
		this.facts = [...facts];
		this.current = foldMigration(runtime.migrationId, facts);
		const done = this.current.completedPhases;
		this.lastPhase = done[done.length - 1] ?? "plan";
	}

	static async open(
		runtime: MigrationRuntime,
		pattern: MigrationPatternId,
		details: PlannedDetails = {},
	): Promise<MigrationRun> {
		const facts = await runtime.journal.load(runtime.migrationId);
		const run = new MigrationRun(runtime, pattern, facts);
		if (run.current.pattern !== undefined && run.current.pattern !== pattern) {
			throw new DataCoreError(
				"INVALID_MIGRATION_PLAN",
				`migration ${runtime.migrationId} was planned as ${run.current.pattern}; it cannot continue as ${pattern}`,
				{ detail: { migrationId: runtime.migrationId, pattern } },
			);
		}
		if (run.current.status === "new") {
			await run.emit(MIGRATION_EVENTS.Planned, {
				migrationId: runtime.migrationId,
				pattern,
				phases: [...getPattern(pattern).phases],
				...(details.decisionDigest === undefined
					? undefined
					: { decisionDigest: details.decisionDigest }),
				...(details.custodyDigest === undefined
					? undefined
					: { custodyDigest: details.custodyDigest }),
				...(details.source === undefined
					? undefined
					: { source: details.source }),
				...(details.target === undefined
					? undefined
					: { target: details.target }),
				...(details.dataset === undefined
					? undefined
					: { dataset: details.dataset }),
				plannedAt: runtime.clock(),
			});
		}
		return run;
	}

	get state(): MigrationState {
		return this.current;
	}

	/**
	 * The recorded cutover decision, if one was journaled. The decision is
	 * written *before* write authority moves, so a run that crashed between
	 * the two finds it here and completes the move instead of re-litigating it.
	 */
	cutOverDecision(): JsonObject | undefined {
		if (!this.current.cutOver) return undefined;
		for (let index = this.facts.length - 1; index >= 0; index -= 1) {
			const fact = this.facts[index];
			if (fact?.type === MIGRATION_EVENTS.CutOver) return fact.data;
		}
		return undefined;
	}

	noteImpedance(code: string): void {
		this.impedance.add(code);
	}

	checkpoint(phase: MigrationPhase): JsonObject | undefined {
		return this.current.checkpoints[phase];
	}

	/** A string a completed phase checkpointed, or a loud failure. */
	checkpointText(phase: MigrationPhase, key: string): string {
		const value: JsonValue | undefined = this.checkpoint(phase)?.[key];
		if (value === undefined || value === null) {
			throw new DataCoreError(
				"ILLEGAL_PHASE_TRANSITION",
				`phase ${phase} recorded no ${key}; it must complete before a later phase reads it`,
				{ detail: { phase, key } },
			);
		}
		return String(value);
	}

	async emit(type: string, data: JsonObject): Promise<void> {
		const fact: MigrationFact = Object.freeze({
			type,
			data: Object.freeze({ ...data }),
		});
		await this.runtime.journal.append(this.runtime.migrationId, fact);
		this.facts.push(fact);
		this.current = foldMigration(this.runtime.migrationId, this.facts);
		this.runtime.onFact?.(fact);
	}

	/**
	 * Run one phase. Skipped when already complete; held when policy says no;
	 * otherwise the body runs and its checkpoint is journaled.
	 */
	async phase(
		phase: MigrationPhase,
		body: () => Promise<JsonObject>,
	): Promise<JsonObject> {
		const recorded = this.checkpoint(phase);
		if (recorded !== undefined) {
			this.lastPhase = phase;
			return recorded;
		}
		const verdict = await this.runtime.policy(phase);
		if (!verdict.ok) {
			// Hold where the migration actually sits: the last completed phase,
			// or — straight after the one non-holdable step — the phase it has
			// already entered in effect (the soak window).
			throw new MigrationHold(
				isSafeHold(this.lastPhase) ? this.lastPhase : phase,
				`policy verdict is negative before ${phase}: ${verdict.findings
					.map((finding) => finding.code)
					.join(", ")}`,
			);
		}
		if (this.current.status === "held") {
			await this.emit(MIGRATION_EVENTS.Resumed, {
				migrationId: this.runtime.migrationId,
				phase,
				resumedAt: this.runtime.clock(),
			});
		}
		const checkpoint = await body();
		await this.emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: this.runtime.migrationId,
			phase,
			checkpoint,
			appliedAt: this.runtime.clock(),
		});
		this.lastPhase = phase;
		await this.runtime.afterPhase?.(phase);
		if (this.runtime.pauseAfter === phase) {
			// Pausing after the one non-holdable step means waiting in the phase
			// that follows it — the soak window.
			const phases = getPattern(this.pattern).phases;
			const next = phases[phases.indexOf(phase) + 1];
			throw new MigrationHold(
				isSafeHold(phase) || next === undefined ? phase : next,
				`paused after ${phase} as requested`,
			);
		}
		return checkpoint;
	}

	result(
		status: MigrationRunStatus,
		rollback: RollbackPosture,
		reason?: string,
	): MigrationRunResult {
		return Object.freeze({
			migrationId: this.runtime.migrationId,
			pattern: this.pattern,
			status,
			phase: this.lastPhase,
			rollback,
			...(reason === undefined ? undefined : { reason }),
			impedance: Object.freeze([...this.impedance].sort()),
			facts: Object.freeze([...this.facts]),
			state: this.current,
		});
	}

	/**
	 * Drive an executor body to a result, turning a hold or a rollback raised
	 * inside a phase into a recorded fact and a typed status. Anything else is
	 * recorded as `migration.Failed` and rethrown — a crash is not a status.
	 */
	async drive(
		body: () => Promise<RollbackPosture>,
		rollbackAt: (phase: MigrationPhase) => RollbackPosture,
	): Promise<MigrationRunResult> {
		// A finished migration is finished: re-running it is a no-op, not a
		// second cutover.
		if (this.current.status === "completed") {
			return this.result("completed", "none");
		}
		if (this.current.status === "rolled-back") {
			return this.result("rolled-back", "none");
		}
		try {
			const posture = await body();
			await this.emit(MIGRATION_EVENTS.Completed, {
				migrationId: this.runtime.migrationId,
				pattern: this.pattern,
				completedAt: this.runtime.clock(),
			});
			return this.result("completed", posture);
		} catch (error) {
			if (error instanceof MigrationHold) {
				assertHoldable(error.phase);
				await this.emit(MIGRATION_EVENTS.Held, {
					migrationId: this.runtime.migrationId,
					phase: error.phase,
					reason: error.reason,
					heldAt: this.runtime.clock(),
				});
				return this.result("held", rollbackAt(error.phase), error.reason);
			}
			if (error instanceof MigrationRollback) {
				await this.emit(MIGRATION_EVENTS.RolledBack, {
					migrationId: this.runtime.migrationId,
					reason: error.reason,
					lossless: error.lossless,
					rolledBackAt: this.runtime.clock(),
				});
				return this.result("rolled-back", "none", error.reason);
			}
			await this.emit(MIGRATION_EVENTS.Failed, {
				migrationId: this.runtime.migrationId,
				reason: error instanceof Error ? error.name : "non-Error thrown",
				failedAt: this.runtime.clock(),
			});
			throw error;
		}
	}
}
