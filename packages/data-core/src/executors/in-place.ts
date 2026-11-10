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
 */
import { requiredCustodyRoles } from "../custody.js";
import {
	DataCoreError,
	isSupersededError,
	JournalConflictError,
} from "../errors.js";
import {
	createMemoryMigrationJournal,
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
					progress.status = "running";
				}
				break;
			case MIGRATION_EVENTS.Verified:
				if (isJsonString(data.point)) progress.verified.add(data.point);
				break;
			case MIGRATION_EVENTS.Held:
				progress.status = "held";
				progress.heldAt = isJsonString(data.phase) ? data.phase : undefined;
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

export async function runInPlaceEvolve(
	options: InPlaceEvolveOptions,
): Promise<InPlaceEvolveResult> {
	const clock = options.clock ?? (() => new Date().toISOString());
	const { plan, port } = options;
	const journal = options.journal ?? createMemoryMigrationJournal();
	const facts: MigrationFact[] = [...(await journal.load(plan.migrationId))];
	const progress = progressOf(facts);
	const { applied, verified } = progress;

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
	): Promise<InPlaceEvolveResult> => {
		await emit(MIGRATION_EVENTS.Held, {
			migrationId: plan.migrationId,
			phase: sitsAt(),
			reason: reasons.join("; "),
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
	): Promise<InPlaceEvolveResult> => {
		// Fail closed. No way to replay erasures is not the same as no
		// erasures: the store stays as it is and the run holds for one.
		if (options.replayErasures === undefined) {
			return hold([reason, NO_ERASURE_REPLAY_REASON], violations);
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

	/**
	 * Apply one phase and record it. A failure is answered by the rollback and
	 * its result is returned; `undefined` means the phase holds.
	 */
	const applyPhase = async (
		snapshot: SchemaSnapshotRef,
		phase: SchemaPhase,
		statements: readonly string[],
		failed: string,
	): Promise<InPlaceEvolveResult | undefined> => {
		await proceed();
		// Not a compare-and-set — the phase's fact follows the phase — but a
		// run that can see it has been overtaken does not run statements the
		// migration has already run. The restore, below, is the step guarded
		// by a fact of its own.
		const journaled = await journal.load(plan.migrationId);
		if (journaled.length !== facts.length) {
			throw new JournalConflictError(plan.migrationId, facts.length);
		}
		let result: SchemaPhaseResult;
		try {
			result = await port.applyPhase(phase, statements);
		} catch (error) {
			// A superseded driver stops; it does not restore anything.
			if (error instanceof Error && isSupersededError(error)) throw error;
			return rollback(snapshot, `${failed}: ${failureReason(error)}`);
		}
		applied.set(phase, result);
		await emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase,
			statements: statements.length,
			...(phase === "backfill" ? { changes: result.changes } : undefined),
			appliedAt: clock(),
		});
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
