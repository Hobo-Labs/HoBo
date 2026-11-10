/**
 * `in-place-evolve`: expand → backfill → contract inside the live store
 * (ADR-0032 §3-4, ADR-0177 decision 5).
 *
 * Only the contract phase is destructive, and it is blocked while a
 * compatibility gate reports consumers still reading the old shape — a drop
 * that would break a still-running consumer never executes. Failure
 * compensates by restoring the pre-migration snapshot: forward-only recovery,
 * no `.down` scripts.
 *
 * Additions over the original Trails executor this was promoted from:
 *
 * - Policy is re-evaluated before every phase.
 * - A restore re-applies the erasures recorded since the snapshot, so a
 *   rollback can never resurrect an erased subject — and a rollback with no
 *   way to do that does not restore at all. It holds.
 * - The run is resumable from a journal. Run again with the same journal, it
 *   skips every phase that has a `migration.PhaseApplied` fact and restores,
 *   if it must, the *first* snapshot — the one taken before anything changed.
 * - No fact and no result carries a thrown message. A failure is recorded as
 *   the error's class name, plus its code when it is this package's own.
 * - Every fact is a compare-and-set on the journal head the run read, and the
 *   restore — the one step that destroys work — has its decision journaled
 *   first. A second run of the same migration whose view is out of date loses
 *   that append and restores nothing.
 * - A phase is write-ahead too: `migration.PhaseIntended` is journaled, as a
 *   compare-and-set, before its statements run. A run that finds an intent
 *   with no answer — the process died between the statements and their fact —
 *   does not know whether they committed. It does not run them again on a
 *   guess, and it never restores the snapshot because of them: the store has
 *   been taking writes since. It asks the plan's probe for the phase, and
 *   holds when there is none.
 */
import { requiredCustodyRoles } from "../custody.js";
import { DataCoreError, isSupersededError } from "../errors.js";
import {
	createMemoryMigrationJournal,
	liftMigrationFacts,
	MIGRATION_EVENTS,
	type MigrationFact,
	type MigrationJournal,
} from "../facts.js";
import {
	isJsonNumber,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import type { MigrationPhase } from "../patterns.js";
import type {
	Awaitable,
	SchemaApplyPort,
	SchemaPhase,
	SchemaPhaseResult,
	SchemaSnapshotRef,
} from "../spi.js";
import { failureReason } from "./runtime.js";

// public-contract: the schema id an in-place-evolve result is published under.
export const IN_PLACE_EVOLVE_CONTRACT = "hobo.in-place-evolve/v1";

/**
 * Compatibility-gate evidence for the destructive contract phase. Consumers
 * still on the old shape block the drop; the dual window simply stays open.
 */
export interface CompatGateEvidence {
	readonly gateId: string;
	readonly consumersOnLegacySchema: readonly string[];
	readonly verifiedAt: string;
}

/**
 * One probe per phase: a violations query, run through the port's `verify`,
 * that returns **no rows exactly when the phase's statements are fully in
 * effect**. For `ALTER TABLE users DROP COLUMN full_name`: the rows of the
 * catalog that still describe `full_name`.
 *
 * A probe is how a run that cannot know whether a phase committed finds out
 * (see `PHASE_OUTCOME_UNKNOWN`). No rows: the phase is recorded as applied and
 * not run again. Rows: it is not in effect, and is applied. A caller who knows
 * the statements are safe to run twice can say so with a probe that always
 * returns a row.
 */
export interface InPlacePhaseProbes {
	readonly expand?: string;
	readonly backfill?: string;
	readonly contract?: string;
}

export interface InPlaceEvolvePlan {
	readonly migrationId: string;
	readonly expand: readonly string[];
	readonly backfill: readonly string[];
	readonly contract: readonly string[];
	/** Violations query per verification point; an empty result verifies. */
	readonly verify: {
		readonly afterBackfill: string;
		readonly afterContract?: string;
	};
	/** How to tell whether a phase took effect; see `InPlacePhaseProbes`. */
	readonly probes?: InPlacePhaseProbes;
}

export const IN_PLACE_EVOLVE_STATUSES = [
	"completed",
	"contract-blocked",
	"held",
	"rolled-back",
	"failed",
] as const;
export type InPlaceEvolveStatus = (typeof IN_PLACE_EVOLVE_STATUSES)[number];

// domain-view: executor result; wire form is InPlaceEvolveResult in data-models/data_core.proto.
export interface InPlaceEvolveResult {
	readonly contract: typeof IN_PLACE_EVOLVE_CONTRACT;
	readonly migrationId: string;
	readonly status: InPlaceEvolveStatus;
	/** True when expand and backfill hold and the dual window is open. */
	readonly dualWindowOpen: boolean;
	readonly snapshot?: SchemaSnapshotRef;
	readonly phases: readonly SchemaPhaseResult[];
	readonly blockedReasons: readonly string[];
	readonly violations: readonly JsonObject[];
	/** Every fact of the migration, those of earlier runs included. */
	readonly facts: readonly MigrationFact[];
}

/**
 * The part of a policy verdict this executor reads. A full `PolicyVerdict`
 * satisfies it; so does a caller that has only an outcome and finding codes.
 */
export interface PolicyOutcome {
	readonly ok: boolean;
	readonly findings: readonly { readonly code: string }[];
	/**
	 * The custody roles the path behind the verdict named. An in-place
	 * migration keeps data in two places — the store, and the snapshot it
	 * rolls back to — and a verdict that judged neither, or only one, does not
	 * cover it: the run holds. Absent names none.
	 */
	readonly roles?: readonly string[];
}

export interface InPlaceEvolveOptions {
	readonly port: SchemaApplyPort;
	readonly plan: InPlaceEvolvePlan;
	readonly compatGate: () => Awaitable<CompatGateEvidence>;
	readonly clock?: () => string;
	readonly onFact?: (fact: MigrationFact) => void;
	/** Recomputed before each phase. Absent means no policy plane is wired. */
	readonly policy?: (phase: SchemaPhase) => Awaitable<PolicyOutcome>;
	/**
	 * Re-apply erasures recorded since the snapshot. Called after every
	 * successful restore; returns how many were re-applied.
	 *
	 * A rollback needs it. A restore brings back the store as it was when the
	 * snapshot was taken, every subject erased since included, so without this
	 * hook a failed phase does not restore: the run holds, and says why. A
	 * caller with nothing to replay says so by returning zero.
	 */
	readonly replayErasures?: (snapshot: SchemaSnapshotRef) => Awaitable<number>;
	/**
	 * Where the run's facts are kept. With a journal, running the same plan
	 * again resumes it: phases already applied are skipped, and the snapshot
	 * restored on failure is the first one taken. Without one, every call is
	 * a fresh run that remembers nothing — re-running a held migration that
	 * way would apply `expand` a second time.
	 */
	readonly journal?: MigrationJournal;
}

const SCHEMA_PHASES = ["expand", "backfill", "contract"] as const;

function isSchemaPhase(value: JsonValue | undefined): value is SchemaPhase {
	return (
		isJsonString(value) &&
		// SAFETY: membership test against the closed tuple of schema phases.
		(SCHEMA_PHASES as readonly string[]).includes(value)
	);
}

type Recorded =
	| "new"
	| "running"
	| "held"
	| "completed"
	| "rolled-back"
	| "failed";

/** What earlier runs of this migration left in the journal. */
interface Progress {
	status: Recorded;
	planned: boolean;
	/** The first snapshot taken: the one that predates every change. */
	snapshot: SchemaSnapshotRef | undefined;
	readonly applied: Map<SchemaPhase, SchemaPhaseResult>;
	/**
	 * Phases with an intent on record and no answer after it: neither a
	 * `PhaseApplied` nor a failure the port reported. Whether their statements
	 * committed is not known.
	 */
	readonly unanswered: Set<SchemaPhase>;
	/** The pattern the journal was planned as, when it says. */
	pattern: string | undefined;
	readonly verified: Set<string>;
	heldAt: string | undefined;
	reason: string | undefined;
	/** A restore was decided and journaled; it is finished, not reconsidered. */
	rollbackDecided: boolean;
}

function count(value: JsonValue | undefined): number {
	return isJsonNumber(value) ? value : 0;
}

function progressOf(facts: readonly MigrationFact[]): Progress {
	const progress: Progress = {
		status: "new",
		planned: false,
		snapshot: undefined,
		applied: new Map(),
		unanswered: new Set(),
		pattern: undefined,
		verified: new Set(),
		heldAt: undefined,
		reason: undefined,
		rollbackDecided: false,
	};
	for (const { type, data } of facts) {
		// Finished is finished: nothing appended later reopens it.
		if (progress.status === "completed" || progress.status === "rolled-back") {
			break;
		}
		switch (type) {
			case MIGRATION_EVENTS.Planned:
				progress.planned = true;
				progress.status = "running";
				if (isJsonString(data.pattern)) progress.pattern = data.pattern;
				break;
			case MIGRATION_EVENTS.PhaseIntended:
				if (isSchemaPhase(data.phase)) progress.unanswered.add(data.phase);
				break;
			case MIGRATION_EVENTS.SnapshotTaken:
				if (
					progress.snapshot === undefined &&
					isJsonString(data.snapshotRef) &&
					isJsonString(data.takenAt)
				) {
					progress.snapshot = { ref: data.snapshotRef, takenAt: data.takenAt };
				}
				break;
			case MIGRATION_EVENTS.PhaseApplied:
				if (isSchemaPhase(data.phase)) {
					progress.applied.set(data.phase, {
						phase: data.phase,
						statements: count(data.statements),
						changes: count(data.changes),
					});
					progress.unanswered.delete(data.phase);
					progress.status = "running";
				}
				break;
			case MIGRATION_EVENTS.Verified:
				if (isJsonString(data.point)) progress.verified.add(data.point);
				break;
			case MIGRATION_EVENTS.Held:
				progress.status = "held";
				progress.heldAt = isJsonString(data.phase) ? data.phase : undefined;
				// The port answered: the phase failed. That is an answer.
				if (isSchemaPhase(data.failedPhase)) {
					progress.unanswered.delete(data.failedPhase);
				}
				break;
			case MIGRATION_EVENTS.Resumed:
				progress.status = "running";
				break;
			case MIGRATION_EVENTS.CutOver:
				progress.status = "completed";
				break;
			case MIGRATION_EVENTS.RolledBack:
				progress.status = "rolled-back";
				progress.reason = isJsonString(data.reason) ? data.reason : undefined;
				break;
			case MIGRATION_EVENTS.RollbackDecided:
				progress.rollbackDecided = true;
				break;
			case MIGRATION_EVENTS.Failed:
				progress.status = "failed";
				break;
			default:
				break;
		}
	}
	return progress;
}

interface Outcome {
	readonly status: InPlaceEvolveStatus;
	readonly dualWindowOpen: boolean;
	readonly blockedReasons?: readonly string[];
	readonly violations?: readonly JsonObject[];
}

// public-contract: why a failed phase holds instead of restoring when no erasure replay is wired.
export const NO_ERASURE_REPLAY_REASON =
	"the snapshot was not restored: no erasure replay was supplied, and a restore without one would bring back every subject erased since the snapshot";

/**
 * A phase's intent is journaled and nothing answers it: an earlier run died
 * between running the statements and recording that it had. They may have
 * committed. The run holds; it neither runs them again nor restores. Resolved
 * by a probe for the phase in the plan (`InPlacePhaseProbes`).
 */
// public-contract: hold code for a phase whose statements may or may not have committed.
export const PHASE_OUTCOME_UNKNOWN = "PHASE_OUTCOME_UNKNOWN";

/**
 * A phase that was applied again after an unanswered intent failed. The
 * snapshot is not restored for it — the store has been taking writes since
 * the first attempt — and the run holds for a person.
 */
// public-contract: hold code for a re-applied phase that failed; never answered by a restore.
export const PHASE_REAPPLY_FAILED = "PHASE_REAPPLY_FAILED";

/** What a lifted in-place plan names as its pattern; see `liftMigrationFact`. */
const IN_PLACE_PATTERN = "in-place-evolve";

export async function runInPlaceEvolve(
	options: InPlaceEvolveOptions,
): Promise<InPlaceEvolveResult> {
	const clock = options.clock ?? (() => new Date().toISOString());
	const { plan, port } = options;
	const journal = options.journal ?? createMemoryMigrationJournal();
	// Lifted before they are folded: see `liftMigrationFact`.
	const facts: MigrationFact[] = [
		...liftMigrationFacts(await journal.load(plan.migrationId)),
	];
	const progress = progressOf(facts);
	const { applied, verified, unanswered } = progress;
	if (progress.pattern !== undefined && progress.pattern !== IN_PLACE_PATTERN) {
		throw new DataCoreError(
			"INVALID_MIGRATION_PLAN",
			`migration ${plan.migrationId} was planned as ${progress.pattern}; it cannot continue as ${IN_PLACE_PATTERN}`,
			{ detail: { migrationId: plan.migrationId, pattern: IN_PLACE_PATTERN } },
		);
	}

	const emit = async (type: string, data: JsonObject): Promise<void> => {
		const fact = Object.freeze({ type, data: Object.freeze({ ...data }) });
		// A compare-and-set on the head this run read: a second driver of the
		// same migration loses the append and stops.
		await journal.append(plan.migrationId, fact, facts.length);
		facts.push(fact);
		options.onFact?.(fact);
	};
	const finish = (outcome: Outcome): InPlaceEvolveResult =>
		Object.freeze({
			contract: IN_PLACE_EVOLVE_CONTRACT,
			migrationId: plan.migrationId,
			status: outcome.status,
			dualWindowOpen: outcome.dualWindowOpen,
			...(progress.snapshot === undefined
				? undefined
				: { snapshot: progress.snapshot }),
			phases: Object.freeze(
				SCHEMA_PHASES.flatMap((phase) => {
					const result = applied.get(phase);
					return result === undefined ? [] : [result];
				}),
			),
			blockedReasons: Object.freeze([...(outcome.blockedReasons ?? [])]),
			violations: Object.freeze([...(outcome.violations ?? [])]),
			facts: Object.freeze([...facts]),
		});

	// A finished migration is finished: run again, it changes nothing.
	if (progress.status === "completed") {
		return finish({ status: "completed", dualWindowOpen: false });
	}
	if (progress.status === "rolled-back") {
		return finish({
			status: "rolled-back",
			dualWindowOpen: false,
			blockedReasons: progress.reason === undefined ? [] : [progress.reason],
		});
	}

	/** True while expand and backfill hold and nothing has been dropped. */
	const dualWindow = (): boolean =>
		applied.has("backfill") && !applied.has("contract");
	/** The uniform phase a run that stops now sits in. */
	const sitsAt = (): MigrationPhase => {
		if (applied.has("backfill")) return "verify";
		return applied.has("expand") ? "prepare" : "plan";
	};

	let resuming = progress.status === "held";
	/** Record, once, that a held run is moving again. */
	const proceed = async (): Promise<void> => {
		if (!resuming) return;
		resuming = false;
		await emit(MIGRATION_EVENTS.Resumed, {
			migrationId: plan.migrationId,
			phase: progress.heldAt ?? sitsAt(),
			resumedAt: clock(),
		});
	};
	const hold = async (
		reasons: readonly string[],
		violations: readonly JsonObject[] = [],
		failedPhase?: SchemaPhase,
	): Promise<InPlaceEvolveResult> => {
		await emit(MIGRATION_EVENTS.Held, {
			migrationId: plan.migrationId,
			phase: sitsAt(),
			reason: reasons.join("; "),
			...(failedPhase === undefined ? undefined : { failedPhase }),
			heldAt: clock(),
		});
		return finish({
			status: "held",
			dualWindowOpen: dualWindow(),
			blockedReasons: reasons,
			violations,
		});
	};
	const denied = async (phase: SchemaPhase): Promise<string | undefined> => {
		const verdict = await options.policy?.(phase);
		if (verdict === undefined) return undefined;
		// A positive verdict over a path that never named the store or its
		// rollback snapshot says nothing about them: fail closed.
		const named = verdict.roles ?? [];
		const uncovered = requiredCustodyRoles({
			pattern: "in-place-evolve",
		}).filter((role) => !named.includes(role));
		if (verdict.ok && uncovered.length === 0) return undefined;
		return [
			...(verdict.ok
				? []
				: [
						`policy verdict is negative before ${phase}: ${verdict.findings
							.map((finding) => finding.code)
							.join(", ")}`,
					]),
			...(uncovered.length === 0
				? []
				: [
						`policy verdict does not cover this migration before ${phase}: CUSTODY_PATH_INCOMPLETE (no custody point for ${uncovered.join(", ")})`,
					]),
		].join("; ");
	};

	const rollback = async (
		snapshot: SchemaSnapshotRef,
		reason: string,
		violations: readonly JsonObject[] = [],
		failedPhase?: SchemaPhase,
	): Promise<InPlaceEvolveResult> => {
		// Fail closed. No way to replay erasures is not the same as no
		// erasures: the store stays as it is and the run holds for one.
		if (options.replayErasures === undefined) {
			return hold([reason, NO_ERASURE_REPLAY_REASON], violations, failedPhase);
		}
		await proceed();
		// Decide, record, then act. The decision is a compare-and-set, so a run
		// whose view of the migration is out of date — another run finished it
		// meanwhile — stops here instead of restoring a snapshot over it.
		if (!progress.rollbackDecided) {
			await emit(MIGRATION_EVENTS.RollbackDecided, {
				migrationId: plan.migrationId,
				lossless: false,
				erasuresFrom: snapshot.takenAt,
				decidedAt: clock(),
			});
			progress.rollbackDecided = true;
		}
		let erasuresReplayed: number;
		try {
			await port.restore(snapshot);
			// A restored snapshot predates every erasure since it was taken.
			erasuresReplayed = await options.replayErasures(snapshot);
		} catch (restoreError) {
			// The class name, never the message: see `failureReason`.
			await emit(MIGRATION_EVENTS.Failed, {
				migrationId: plan.migrationId,
				reason: `restore failed after ${reason}: ${failureReason(restoreError)}`,
				failedAt: clock(),
			});
			return finish({
				status: "failed",
				dualWindowOpen: false,
				blockedReasons: [reason],
				violations,
			});
		}
		await emit(MIGRATION_EVENTS.RolledBack, {
			migrationId: plan.migrationId,
			reason,
			snapshotRef: snapshot.ref,
			erasuresReplayed,
			rolledBackAt: clock(),
		});
		return finish({
			status: "rolled-back",
			dualWindowOpen: false,
			blockedReasons: [reason],
			violations,
		});
	};

	const intend = (
		phase: SchemaPhase,
		statements: readonly string[],
		retry: boolean,
	): Promise<void> =>
		// Written first, as a compare-and-set: a run that has been overtaken
		// loses it here and runs no statement, and a run that dies after its
		// statements leaves this behind to say that they may have committed.
		emit(MIGRATION_EVENTS.PhaseIntended, {
			migrationId: plan.migrationId,
			phase,
			statements: statements.length,
			...(retry ? { retry } : undefined),
			intendedAt: clock(),
		});
	const record = async (
		phase: SchemaPhase,
		statements: readonly string[],
		result: SchemaPhaseResult | undefined,
	): Promise<void> => {
		applied.set(
			phase,
			result ?? { phase, statements: statements.length, changes: 0 },
		);
		unanswered.delete(phase);
		await emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase,
			statements: statements.length,
			...(phase === "backfill" && result !== undefined
				? { changes: result.changes }
				: undefined),
			// Found in effect by the probe; this run did not run it.
			...(result === undefined ? { recovered: true } : undefined),
			appliedAt: clock(),
		});
	};
	/**
	 * Ask the plan's probe whether a phase is in effect. `undefined` when
	 * there is no probe, or it could not be asked: nothing is known.
	 */
	const inEffect = async (phase: SchemaPhase): Promise<boolean | undefined> => {
		const probe = plan.probes?.[phase];
		if (probe === undefined) return undefined;
		try {
			return (await port.verify(probe)).length === 0;
		} catch (error) {
			if (error instanceof Error && isSupersededError(error)) throw error;
			return undefined;
		}
	};

	/**
	 * A phase with an intent on record and no answer. Never applied on a
	 * guess, and never answered by a restore: `undefined` means it is settled
	 * and the run goes on; anything else is the hold.
	 */
	const settle = async (
		phase: SchemaPhase,
		statements: readonly string[],
	): Promise<InPlaceEvolveResult | undefined> => {
		const effective = await inEffect(phase);
		if (effective === undefined) {
			return hold([
				`${PHASE_OUTCOME_UNKNOWN}: an earlier run started the ${phase} phase and never recorded finishing it; its statements may have committed. They were not run again and nothing was restored. Give the plan a probe for ${phase} (a query that returns no rows once the phase is in effect) and run again`,
			]);
		}
		await proceed();
		if (effective) {
			await record(phase, statements, undefined);
			return undefined;
		}
		await intend(phase, statements, true);
		let result: SchemaPhaseResult;
		try {
			result = await port.applyPhase(phase, statements);
		} catch (error) {
			if (error instanceof Error && isSupersededError(error)) throw error;
			// Not a restore, whatever is wired: the store has been written to
			// since the first attempt, and the snapshot predates all of it.
			return hold([
				`${PHASE_REAPPLY_FAILED}: the ${phase} phase was applied again after an unrecorded attempt and failed: ${failureReason(error)}. Nothing was restored`,
			]);
		}
		await record(phase, statements, result);
		return undefined;
	};

	/**
	 * Apply one phase and record it. A failure the port reports is answered by
	 * the rollback and its result is returned; `undefined` means the phase is
	 * applied and the run goes on.
	 */
	const applyPhase = async (
		snapshot: SchemaSnapshotRef,
		phase: SchemaPhase,
		statements: readonly string[],
		failed: string,
	): Promise<InPlaceEvolveResult | undefined> => {
		if (unanswered.has(phase)) return settle(phase, statements);
		await proceed();
		await intend(phase, statements, false);
		let result: SchemaPhaseResult;
		try {
			result = await port.applyPhase(phase, statements);
		} catch (error) {
			// A superseded driver stops; it does not restore anything.
			if (error instanceof Error && isSupersededError(error)) throw error;
			// A throw is the port's answer that the phase is not in effect —
			// unless the plan can check, and the check says it is: the answer
			// was lost on the way back, not the phase.
			if ((await inEffect(phase)) === true) {
				await record(phase, statements, undefined);
				return undefined;
			}
			return rollback(
				snapshot,
				`${failed}: ${failureReason(error)}`,
				[],
				phase,
			);
		}
		await record(phase, statements, result);
		return undefined;
	};

	if (!progress.planned) {
		await emit(MIGRATION_EVENTS.Planned, {
			migrationId: plan.migrationId,
			phases: [...SCHEMA_PHASES],
			plannedAt: clock(),
		});
	}

	// A restore an earlier run decided, or could not finish, is finished
	// first: the decision binds.
	if (
		(progress.rollbackDecided || progress.status === "failed") &&
		progress.snapshot !== undefined
	) {
		return rollback(progress.snapshot, "an earlier restore did not complete");
	}

	if (!applied.has("expand")) {
		const beforeExpand = await denied("expand");
		if (beforeExpand !== undefined) return hold([beforeExpand]);
		// Snapshot BEFORE any mutation: rollback is snapshot-restore, so a
		// migration without a snapshot must never touch the store. Taken once:
		// a resumed run reuses the first, which is the only one that predates
		// the migration.
		if (progress.snapshot === undefined) {
			await proceed();
			const taken = await port.snapshot();
			progress.snapshot = taken;
			await emit(MIGRATION_EVENTS.SnapshotTaken, {
				migrationId: plan.migrationId,
				snapshotRef: taken.ref,
				takenAt: taken.takenAt,
			});
		}
	}
	const snapshot = progress.snapshot;
	if (snapshot === undefined) {
		throw new DataCoreError(
			"INVALID_MIGRATION_PLAN",
			`migration ${plan.migrationId} has an applied phase on record and no snapshot; it cannot be resumed safely`,
			{ detail: { migrationId: plan.migrationId } },
		);
	}

	// Expand: additive, never destructive.
	if (!applied.has("expand")) {
		const stopped = await applyPhase(
			snapshot,
			"expand",
			plan.expand,
			"phase execution failed",
		);
		if (stopped !== undefined) return stopped;
	}

	// Backfill: fill the new shape from the old.
	if (!applied.has("backfill")) {
		const beforeBackfill = await denied("backfill");
		// Expand is additive, so sitting here is a safe hold.
		if (beforeBackfill !== undefined) return hold([beforeBackfill]);
		const stopped = await applyPhase(
			snapshot,
			"backfill",
			plan.backfill,
			"phase execution failed",
		);
		if (stopped !== undefined) return stopped;
	}

	if (!applied.has("contract")) {
		// Verify the dual window before anything destructive.
		if (!verified.has("after-backfill")) {
			const violations = await port.verify(plan.verify.afterBackfill);
			if (violations.length > 0) {
				return rollback(snapshot, "backfill verification failed", violations);
			}
			await proceed();
			verified.add("after-backfill");
			await emit(MIGRATION_EVENTS.Verified, {
				migrationId: plan.migrationId,
				point: "after-backfill",
				verifiedAt: clock(),
			});
		}

		// Gate the destructive contract phase: consumers still reading the old
		// shape BLOCK the drop. Blocked is not failure — the dual window stays
		// open (expand + backfill retained) until consumers move.
		const gate = await options.compatGate();
		if (gate.consumersOnLegacySchema.length > 0) {
			return finish({
				status: "contract-blocked",
				dualWindowOpen: true,
				blockedReasons: [
					`compat gate ${gate.gateId}: ${gate.consumersOnLegacySchema.join(", ")} still read the old shape`,
				],
			});
		}

		const beforeContract = await denied("contract");
		if (beforeContract !== undefined) return hold([beforeContract]);
		const stopped = await applyPhase(
			snapshot,
			"contract",
			plan.contract,
			"contract phase failed",
		);
		if (stopped !== undefined) return stopped;
	}

	if (plan.verify.afterContract && !verified.has("after-contract")) {
		const violations = await port.verify(plan.verify.afterContract);
		if (violations.length > 0) {
			return rollback(snapshot, "contract verification failed", violations);
		}
		await proceed();
		await emit(MIGRATION_EVENTS.Verified, {
			migrationId: plan.migrationId,
			point: "after-contract",
			verifiedAt: clock(),
		});
	}

	await proceed();
	await emit(MIGRATION_EVENTS.CutOver, {
		migrationId: plan.migrationId,
		cutOverAt: clock(),
	});
	return finish({ status: "completed", dualWindowOpen: false });
}
