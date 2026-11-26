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
	readonly clock: () => string;
	readonly policy: (phase: MigrationPhase) => Awaitable<PolicyVerdict>;
	readonly onFact?: (fact: MigrationFact) => void;
	readonly afterPhase?: (phase: MigrationPhase) => Awaitable<void>;
	readonly pauseAfter?: MigrationPhase;
}

export const MIGRATION_RUN_STATUSES = [
	"completed",
	"held",
	"rolled-back",
	"failed",
] as const;
export type MigrationRunStatus = (typeof MIGRATION_RUN_STATUSES)[number];

// domain-view:
export interface MigrationRunResult {
	readonly migrationId: string;
	readonly pattern: MigrationPatternId;
	readonly status: MigrationRunStatus;
	readonly phase: MigrationPhase;
	readonly rollback: RollbackPosture;
	readonly reason?: string;
	readonly impedance: readonly string[];
	readonly facts: readonly MigrationFact[];
	readonly state: MigrationState;
}

export interface MigrationHoldOptions {
	readonly recorded?: boolean;
	readonly between?: boolean;
	readonly before?: MigrationPhase;
	readonly working?: boolean;
}

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

export class MigrationRollback extends Error {
	readonly reason: string;
	readonly lossless: boolean;
	readonly details: JsonObject;

	constructor(reason: string, lossless: boolean, details: JsonObject = {}) {
		super(`migration rolled back: ${reason}`);
		this.name = "MigrationRollback";
		this.reason = reason;
		this.lossless = lossless;
		this.details = details;
	}
}

export function failureReason(cause: unknown): string {
	if (cause instanceof DataCoreError) return `${cause.name}: ${cause.code}`;
	return cause instanceof Error ? cause.name : "non-Error thrown";
}

// domain-view: in-process identity of an authority move; wire form is AuthorityMoveRef in data-models/data_core.proto.
export interface AuthorityMoveRef {
	readonly migrationId: string;
	readonly head: number;
}

export interface AuthorityHandover extends AuthorityMoveRef {
	readonly fenceToken: string;
}

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

export interface FenceClaim {
	readonly digest?: string;
	readonly pending: boolean;
	readonly abandoned: boolean;
}

export interface PhaseDenial {
	readonly reason: string;
	readonly findings: readonly string[];
}

export interface PhaseOptions {
	readonly underDenial?: (denial: PhaseDenial) => Awaitable<boolean>;
}

export interface DriveHooks {
	readonly held?: (hold: MigrationHold) => Awaitable<void>;
}

export function decidedFenceToken(decided: JsonObject, held: string): string {
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
	readonly realization?: MigrationRealization;
	readonly profile?: string;
	readonly decisionDigest?: string;
	readonly custodyDigest?: string;
	readonly source?: string;
	readonly target?: string;
	readonly dataset?: string;
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

	firstText(type: string, key: string, side?: FenceSide): string | undefined {
		for (const fact of this.facts) {
			if (fact.type !== type) continue;
			if (side !== undefined && fact.data.side !== side) continue;
			const value = fact.data[key];
			if (isJsonString(value)) return value;
		}
		return undefined;
	}

	rollbackDecision(): JsonObject | undefined {
		if (!this.current.rollbackDecided) return undefined;
		return this.lastFact(MIGRATION_EVENTS.RollbackDecided);
	}

	compensated(): boolean {
		return this.facts.some(
			(fact) =>
				fact.type === MIGRATION_EVENTS.Held && fact.data.compensated === true,
		);
	}

	async requestFence(side: FenceSide, phase: MigrationPhase): Promise<void> {
		await this.emit(MIGRATION_EVENTS.FenceRequested, {
			migrationId: this.runtime.migrationId,
			side,
			phase,
			requestedAt: this.runtime.clock(),
		});
	}

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
		await this.runtime.journal.append(
			this.runtime.migrationId,
			fact,
			this.facts.length,
		);
		this.facts.push(fact);
		this.current = foldMigration(this.runtime.migrationId, this.facts);
		this.runtime.onFact?.(fact);
	}

	private async denial(
		phase: MigrationPhase,
	): Promise<PhaseDenial | undefined> {
		const verdict = await this.runtime.policy(phase);
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

	async drive(
		body: () => Promise<RollbackPosture>,
		rollbackAt: (phase: MigrationPhase) => RollbackPosture,
		hooks: DriveHooks = {},
	): Promise<MigrationRunResult> {
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
			if (error instanceof Error && isSupersededError(error)) throw error;
			if (error instanceof MigrationHold) {
				if (!error.recorded) {
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
