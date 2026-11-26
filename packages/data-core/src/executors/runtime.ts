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
 *   last safe state; nothing in the phase runs. So does a verdict whose
 *   custody path leaves out a place this run puts data — a relay, a retained
 *   change log, the retiring source: a copy nobody judged is not approved.
 * - **Safe holds.** A hold is recorded as a fact with its reason, and only in
 *   a phase the catalog marks holdable.
 * - **Facts, not logs.** Everything observable about a run is a
 *   `migration.*` fact in the journal.
 * - **One driver.** Every fact is appended as a compare-and-set on the head
 *   this run read. A run that loses it — another driver appended first — or
 *   whose conditional apply is refused as stale, has been superseded: it
 *   records nothing further, compensates nothing, and rethrows the refusal.
 */
import { type PolicyVerdict, uncoveredCustodyRoles } from "../custody.js";
import {
	DataCoreError,
	isSupersededError,
	JournalConflictError,
	StaleAuthorityMoveError,
} from "../errors.js";
import {
	assertHoldable,
	type FenceSide,
	fenceTokenDigest,
	foldMigration,
	liftMigrationFacts,
	MIGRATION_EVENTS,
	type MigrationFact,
	type MigrationJournal,
	type MigrationRealization,
	type MigrationState,
} from "../facts.js";
import { isJsonString, type JsonObject, type JsonValue } from "../json.js";
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

export interface MigrationHoldOptions {
	/**
	 * The `migration.Held` fact is already journaled. A compensation writes
	 * its hold *before* it gives write authority back, so the run loop must
	 * not write it a second time.
	 */
	readonly recorded?: boolean;
	/**
	 * Raised by the run loop between two phases — a negative verdict, a
	 * requested pause — rather than from inside one. Nothing is half-done, so
	 * the hold is safe wherever it falls, including after the flip.
	 */
	readonly between?: boolean;
	/** The phase the run was about to enter, for a hold between two phases. */
	readonly before?: MigrationPhase;
	/**
	 * The engine is still doing work the last verdict approved — an initial
	 * copy that has not finished, a tail that still lags — and the run stops
	 * only because its bounded wait is spent. A native transfer is left running
	 * through such a hold: pausing it would restart the copy, or let the lag
	 * grow, every time the run came back. Every other hold pauses it.
	 */
	readonly working?: boolean;
}

/** Thrown to stop the run at a safe hold. */
export class MigrationHold extends Error {
	readonly phase: MigrationPhase;
	readonly reason: string;
	readonly recorded: boolean;
	readonly between: boolean;
	readonly before?: MigrationPhase;
	readonly working: boolean;

	constructor(
		phase: MigrationPhase,
		reason: string,
		options: MigrationHoldOptions = {},
	) {
		super(`migration held at ${phase}: ${reason}`);
		this.name = "MigrationHold";
		this.phase = phase;
		this.reason = reason;
		this.recorded = options.recorded === true;
		this.between = options.between === true;
		this.working = options.working === true;
		if (options.before !== undefined) this.before = options.before;
	}
}

/** Thrown inside a phase when the run compensated and must stop. */
export class MigrationRollback extends Error {
	readonly reason: string;
	readonly lossless: boolean;
	/** Counts to record with the fact; never a record, never a message. */
	readonly details: JsonObject;

	constructor(reason: string, lossless: boolean, details: JsonObject = {}) {
		super(`migration rolled back: ${reason}`);
		this.name = "MigrationRollback";
		this.reason = reason;
		this.lossless = lossless;
		this.details = details;
	}
}

/**
 * What a failure is recorded as. A class name, plus the code when the error is
 * this package's own — a code comes from a closed list, so it is safe to
 * journal. Never a message: a thrown message can carry a connection string.
 */
export function failureReason(cause: unknown): string {
	if (cause instanceof DataCoreError) return `${cause.name}: ${cause.code}`;
	return cause instanceof Error ? cause.name : "non-Error thrown";
}

/**
 * What a router compares-and-sets on when a migration asks it to move write
 * authority: which migration, and the journal head — the number of facts up
 * to and including the journaled decision — the move was decided at.
 *
 * The journal is a compare-and-set, so exactly one decision exists at any
 * head, and a later decision always has a higher one. A router keeps, per
 * migration, the highest head it has applied and refuses a move that names a
 * lower one with `StaleAuthorityMoveError` (`admitAuthorityMove` is that rule,
 * ready to call). A move at the head already applied is the same decision
 * again — a resumed run finishing what a crashed one started — and is applied
 * again; that is the idempotence a router must have.
 *
 * The refusal is how a driver that journaled a decision, stalled inside the
 * router call, and was overtaken — by a rollback, say — is kept from landing
 * its move after the fact. The executor treats the refusal as supersession:
 * it stops, records nothing and compensates nothing.
 */
// domain-view: in-process identity of an authority move; wire form is AuthorityMoveRef in data-models/data_core.proto.
export interface AuthorityMoveRef {
	readonly migrationId: string;
	/** The journal head the decision was made at; higher outranks lower. */
	readonly head: number;
}

/** An authority move into the event log, or of a log's single writer. */
export interface AuthorityHandover extends AuthorityMoveRef {
	/** The token of the fence on the old authority. */
	readonly fenceToken: string;
}

/**
 * The router's side of the contract, as one call: admit a move at or above
 * the highest head applied for its migration and remember it; refuse a lower
 * one. `applied` is the router's own durable state — one number per
 * migration — and must be updated in the same step that moves authority.
 */
export function admitAuthorityMove(
	applied: Map<string, number>,
	move: AuthorityMoveRef,
): void {
	const highest = applied.get(move.migrationId) ?? 0;
	if (move.head < highest) {
		throw new StaleAuthorityMoveError(move.migrationId, move.head, highest);
	}
	applied.set(move.migrationId, move.head);
}

/** What the journal says about the fence this migration last raised on a side. */
export interface FenceClaim {
	/** Digest of the token the last journaled raise answered. */
	readonly digest?: string;
	/** A raise was requested and what it answered was never journaled. */
	readonly pending: boolean;
	/**
	 * A hold was journaled after the raise. Whoever held may still be about to
	 * release that fence, so nothing new is decided under it.
	 */
	readonly abandoned: boolean;
}

/** What a phase is told when the verdict in front of it is negative. */
export interface PhaseDenial {
	/** The hold reason, as it would be journaled. */
	readonly reason: string;
	/** Finding codes of the verdict; `CUSTODY_PATH_INCOMPLETE` for an uncovered role. */
	readonly findings: readonly string[];
}

export interface PhaseOptions {
	/**
	 * Asked when the verdict before the phase is negative. Answering `true`
	 * runs the phase anyway. For the one case where going ahead reduces
	 * exposure rather than adding to it: a rollback out of the soak window,
	 * which moves authority back to where the data already was.
	 */
	readonly underDenial?: (denial: PhaseDenial) => Awaitable<boolean>;
}

export interface DriveHooks {
	/**
	 * Runs once a hold is journaled and before the run reports it. A copy
	 * executor pauses its native transfer here.
	 */
	readonly held?: (hold: MigrationHold) => Awaitable<void>;
}

/**
 * The token a resumed cutover acts with. `held` is what the store (or the
 * caller's quiesce) answered when asked again; it is accepted only when it is
 * the token the journaled decision's digest names. Anything else means the
 * fence was lifted and raised again behind the migration's back.
 */
export function decidedFenceToken(decided: JsonObject, held: string): string {
	// A journal written before tokens were kept out of it.
	const legacy = decided.fenceToken;
	if (isJsonString(legacy)) return legacy;
	if (fenceTokenDigest(held) !== decided.fenceTokenDigest) {
		throw new DataCoreError(
			"FENCE_TOKEN_MISMATCH",
			"the fence in place is not the one the cutover was decided under",
			{ detail: { phase: "fence-and-flip" } },
		);
	}
	return held;
}

export interface PlannedDetails {
	/** How records travel; recorded in the plan and binding on every resume. */
	readonly realization?: MigrationRealization;
	/** The native migration profile, for a `native` realization. */
	readonly profile?: string;
	readonly decisionDigest?: string;
	readonly custodyDigest?: string;
	readonly source?: string;
	readonly target?: string;
	readonly dataset?: string;
	/**
	 * Whether this run keeps a reverse tail. Not journaled: it is read only to
	 * decide which custody roles the run creates, and so which a verdict must
	 * have judged. Absent takes the more demanding reading.
	 */
	readonly reverseTail?: boolean;
}

export class MigrationRun {
	private facts: MigrationFact[];
	private current: MigrationState;
	private lastPhase: MigrationPhase = "plan";
	private readonly impedance = new Set<string>();
	private reverseTail: boolean | undefined;

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
		// Lifted before anything folds them: a journal written by an earlier
		// release is read as the bodies written today, so its plan is checked
		// against this run's pattern and its fence tokens never reach a fold.
		const facts = liftMigrationFacts(
			await runtime.journal.load(runtime.migrationId),
		);
		const run = new MigrationRun(runtime, pattern, facts);
		run.reverseTail = details.reverseTail;
		if (run.current.pattern !== undefined && run.current.pattern !== pattern) {
			throw new DataCoreError(
				"INVALID_MIGRATION_PLAN",
				`migration ${runtime.migrationId} was planned as ${run.current.pattern}; it cannot continue as ${pattern}`,
				{ detail: { migrationId: runtime.migrationId, pattern } },
			);
		}
		if (run.current.status !== "new" && details.realization !== undefined) {
			// The realization is part of the plan. A run planned one way is
			// never continued the other: that would be a downgrade (or an
			// upgrade) nobody decided, with the first transport's objects
			// still in place.
			const planned = run.current.realization ?? "hub";
			if (
				planned !== details.realization ||
				run.current.profile !== details.profile
			) {
				throw new DataCoreError(
					"INVALID_MIGRATION_PLAN",
					`migration ${runtime.migrationId} was planned with the ${planned} realization; it cannot continue as ${details.realization}`,
					{
						detail: {
							migrationId: runtime.migrationId,
							pattern,
							realization: planned,
						},
					},
				);
			}
		}
		if (run.current.status === "new") {
			await run.emit(MIGRATION_EVENTS.Planned, {
				migrationId: runtime.migrationId,
				pattern,
				phases: [...getPattern(pattern).phases],
				...(details.realization === undefined
					? undefined
					: { realization: details.realization }),
				...(details.profile === undefined
					? undefined
					: { profile: details.profile }),
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
	 * How many facts this run holds: the head its next append is conditional
	 * on. It only grows, and only one driver can have appended the fact at any
	 * given count, so it also serves as the run's fencing epoch — an executor
	 * stamps it on what it applies, and a higher one outranks a lower one.
	 */
	get head(): number {
		return this.facts.length;
	}

	private lastFact(type: string): JsonObject | undefined {
		for (let index = this.facts.length - 1; index >= 0; index -= 1) {
			const fact = this.facts[index];
			if (fact?.type === type) return fact.data;
		}
		return undefined;
	}

	/**
	 * The head a journaled decision was made at: the number of facts up to and
	 * including the last fact of this type. What an authority move is stamped
	 * with — the same number whichever run finishes the move.
	 */
	decisionHead(type: string): number {
		for (let index = this.facts.length - 1; index >= 0; index -= 1) {
			if (this.facts[index]?.type === type) return index + 1;
		}
		throw new DataCoreError(
			"ILLEGAL_PHASE_TRANSITION",
			`no ${type} is journaled; authority cannot move without its decision`,
			{ detail: { type } },
		);
	}

	/**
	 * What this migration can prove about the fence on a side, from its own
	 * journal. `undefined` when it never asked for one there: a fence found
	 * standing is then somebody else's.
	 */
	fenceClaim(side: FenceSide): FenceClaim | undefined {
		let requested = false;
		let pending = false;
		let abandoned = false;
		let digest: string | undefined;
		for (const { type, data } of this.facts) {
			if (type === MIGRATION_EVENTS.FenceRequested && data.side === side) {
				requested = true;
				pending = true;
			} else if (
				(type === MIGRATION_EVENTS.FenceRaised && data.side === side) ||
				// A journal from before raises were recorded: the cutover names
				// the source fence it was decided under.
				(type === MIGRATION_EVENTS.CutOver && side === "source")
			) {
				if (isJsonString(data.fenceTokenDigest)) {
					requested = true;
					pending = false;
					abandoned = false;
					digest = data.fenceTokenDigest;
				}
			} else if (type === MIGRATION_EVENTS.Held && digest !== undefined) {
				abandoned = true;
			}
		}
		if (!requested) return undefined;
		return {
			...(digest === undefined ? undefined : { digest }),
			pending,
			abandoned,
		};
	}

	/** Journal the digest of the token a raise answered; see `FenceClaim`. */
	async recordFence(
		side: FenceSide,
		phase: MigrationPhase,
		fenceToken: string,
	): Promise<void> {
		await this.emit(MIGRATION_EVENTS.FenceRaised, {
			migrationId: this.runtime.migrationId,
			side,
			phase,
			fenceTokenDigest: fenceTokenDigest(fenceToken),
			raisedAt: this.runtime.clock(),
		});
	}

	/** A string the first fact of a type recorded, if any did. */
	firstText(type: string, key: string, side?: FenceSide): string | undefined {
		for (const fact of this.facts) {
			if (fact.type !== type) continue;
			if (side !== undefined && fact.data.side !== side) continue;
			const value = fact.data[key];
			if (isJsonString(value)) return value;
		}
		return undefined;
	}

	/**
	 * The recorded rollback decision, if one was journaled and not yet carried
	 * out. Like the cutover decision it is written *before* write authority
	 * moves, so a run that crashed in between finishes handing authority back
	 * instead of asking again whether to.
	 */
	rollbackDecision(): JsonObject | undefined {
		if (!this.current.rollbackDecided) return undefined;
		return this.lastFact(MIGRATION_EVENTS.RollbackDecided);
	}

	/**
	 * True when an earlier attempt compensated: verification under the fence
	 * failed, reads were sent home and the fence was released.
	 */
	compensated(): boolean {
		return this.facts.some(
			(fact) =>
				fact.type === MIGRATION_EVENTS.Held && fact.data.compensated === true,
		);
	}

	/**
	 * Journal that a write fence is about to be raised. Written first, as a
	 * compare-and-set: a driver that is no longer the migration's driver loses
	 * the append here and never reaches the fence.
	 */
	async requestFence(side: FenceSide, phase: MigrationPhase): Promise<void> {
		await this.emit(MIGRATION_EVENTS.FenceRequested, {
			migrationId: this.runtime.migrationId,
			side,
			phase,
			requestedAt: this.runtime.clock(),
		});
	}

	/**
	 * Journal a hold *now*, ahead of the side effects that give write authority
	 * back. Returns the hold for the caller to throw once it has compensated;
	 * the run loop then knows not to record it twice.
	 */
	async recordHold(
		phase: MigrationPhase,
		reason: string,
		details: JsonObject = {},
		working = false,
	): Promise<MigrationHold> {
		assertHoldable(phase);
		await this.emit(MIGRATION_EVENTS.Held, {
			migrationId: this.runtime.migrationId,
			phase,
			reason,
			...details,
			heldAt: this.runtime.clock(),
		});
		return new MigrationHold(phase, reason, { recorded: true, working });
	}

	/**
	 * The recorded cutover decision, if one was journaled. The decision is
	 * written *before* write authority moves, so a run that crashed between
	 * the two finds it here and completes the move instead of re-litigating it.
	 */
	cutOverDecision(): JsonObject | undefined {
		if (!this.current.cutOver) return undefined;
		return this.lastFact(MIGRATION_EVENTS.CutOver);
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
		// Conditional on the head this run holds: see `MigrationJournal.append`.
		await this.runtime.journal.append(
			this.runtime.migrationId,
			fact,
			this.facts.length,
		);
		this.facts.push(fact);
		this.current = foldMigration(this.runtime.migrationId, this.facts);
		this.runtime.onFact?.(fact);
	}

	/**
	 * The verdict in front of a phase, when it does not let the phase run:
	 * negative, or silent about a place this run puts data.
	 */
	private async denial(
		phase: MigrationPhase,
	): Promise<PhaseDenial | undefined> {
		const verdict = await this.runtime.policy(phase);
		// A verdict judges the path it was given. The roles this run creates
		// that the path never named were not judged at all, so a positive
		// verdict says nothing about them: fail closed.
		const uncovered = uncoveredCustodyRoles(verdict, {
			pattern: this.pattern,
			...(this.current.realization === undefined
				? undefined
				: { realization: this.current.realization }),
			...(this.reverseTail === undefined
				? undefined
				: { reverseTail: this.reverseTail }),
		});
		if (verdict.ok && uncovered.length === 0) return undefined;
		const codes = verdict.ok ? [] : verdict.findings.map((found) => found.code);
		const reasons = [
			...(verdict.ok
				? []
				: [`policy verdict is negative before ${phase}: ${codes.join(", ")}`]),
			...(uncovered.length === 0
				? []
				: [
						`policy verdict does not cover this migration before ${phase}: CUSTODY_PATH_INCOMPLETE (no custody point for ${uncovered.join(", ")})`,
					]),
		];
		return {
			reason: reasons.join("; "),
			findings: [
				...new Set([
					...codes,
					...(uncovered.length === 0 ? [] : ["CUSTODY_PATH_INCOMPLETE"]),
				]),
			],
		};
	}

	/**
	 * Run one phase. Skipped when already complete; held when policy says no;
	 * otherwise the body runs and its checkpoint is journaled.
	 *
	 * One thing is not put to policy: a rollback that is already decided and
	 * journaled. Its decision binds, and what is left of it — handing write
	 * authority back and releasing the fence — is what ends the exposure a
	 * negative verdict objects to. Holding it would leave both stores fenced.
	 */
	async phase(
		phase: MigrationPhase,
		body: () => Promise<JsonObject>,
		options: PhaseOptions = {},
	): Promise<JsonObject> {
		const recorded = this.checkpoint(phase);
		if (recorded !== undefined) {
			this.lastPhase = phase;
			return recorded;
		}
		const denial = this.current.rollbackDecided
			? undefined
			: await this.denial(phase);
		if (
			denial !== undefined &&
			(await options.underDenial?.(denial)) !== true
		) {
			throw new MigrationHold(this.holdBetween(phase), denial.reason, {
				between: true,
				before: phase,
			});
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
			const phases = getPattern(this.pattern).phases;
			const next = phases[phases.indexOf(phase) + 1];
			throw new MigrationHold(
				this.holdBetween(next),
				`paused after ${phase} as requested`,
				{
					between: true,
					...(next === undefined ? undefined : { before: next }),
				},
			);
		}
		return checkpoint;
	}

	/**
	 * Where a run that stops between two phases sits: the last completed
	 * phase. The one exception keeps its established name — straight after the
	 * flip, a pattern with a soak window is already in it. A pattern without
	 * one sits after its completed flip; nothing is half-done there, which is
	 * what makes it safe to wait.
	 */
	private holdBetween(next: MigrationPhase | undefined): MigrationPhase {
		if (isSafeHold(this.lastPhase)) return this.lastPhase;
		return next === "soak" ? next : this.lastPhase;
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
		hooks: DriveHooks = {},
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
			// Superseded: another driver owns the migration now. Nothing is
			// recorded and nothing is compensated — a fact would lose the same
			// compare-and-set, and a compensation would act on a view of the
			// migration that is no longer true.
			if (error instanceof Error && isSupersededError(error)) throw error;
			if (error instanceof MigrationHold) {
				if (!error.recorded) {
					// A hold between two phases is safe wherever it falls; one
					// raised inside a phase must name a phase that can be held.
					if (!error.between) assertHoldable(error.phase);
					await this.emit(MIGRATION_EVENTS.Held, {
						migrationId: this.runtime.migrationId,
						phase: error.phase,
						reason: error.reason,
						...(error.before === undefined
							? undefined
							: { before: error.before }),
						heldAt: this.runtime.clock(),
					});
				}
				// After the fact, never before it: a driver that lost the append
				// above is no longer the one to act on the migration's transfer.
				await hooks.held?.(error);
				return this.result("held", rollbackAt(error.phase), error.reason);
			}
			if (error instanceof MigrationRollback) {
				await this.emit(MIGRATION_EVENTS.RolledBack, {
					migrationId: this.runtime.migrationId,
					reason: error.reason,
					lossless: error.lossless,
					...error.details,
					rolledBackAt: this.runtime.clock(),
				});
				return this.result("rolled-back", "none", error.reason);
			}
			try {
				await this.emit(MIGRATION_EVENTS.Failed, {
					migrationId: this.runtime.migrationId,
					reason: failureReason(error),
					failedAt: this.runtime.clock(),
				});
			} catch (journalError) {
				if (journalError instanceof JournalConflictError) {
					// The failure could not be recorded because this driver was
					// superseded; that, not the failure, is what the caller acts on.
					throw new JournalConflictError(
						this.runtime.migrationId,
						this.facts.length,
						{ cause: error },
					);
				}
				throw journalError;
			}
			throw error;
		}
	}
}
