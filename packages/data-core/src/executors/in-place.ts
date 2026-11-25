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

export interface CompatGateEvidence {
	readonly gateId: string;
	readonly consumersOnLegacySchema: readonly string[];
	readonly verifiedAt: string;
}

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
	readonly verify: {
		readonly afterBackfill: string;
		readonly afterContract?: string;
	};
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
	readonly dualWindowOpen: boolean;
	readonly snapshot?: SchemaSnapshotRef;
	readonly phases: readonly SchemaPhaseResult[];
	readonly blockedReasons: readonly string[];
	readonly violations: readonly JsonObject[];
	readonly facts: readonly MigrationFact[];
}

export interface PolicyOutcome {
	readonly ok: boolean;
	readonly findings: readonly { readonly code: string }[];
	readonly roles?: readonly string[];
}

export interface InPlaceEvolveOptions {
	readonly port: SchemaApplyPort;
	readonly plan: InPlaceEvolvePlan;
	readonly compatGate: () => Awaitable<CompatGateEvidence>;
	readonly clock?: () => string;
	readonly onFact?: (fact: MigrationFact) => void;
	readonly policy?: (phase: SchemaPhase) => Awaitable<PolicyOutcome>;
	readonly replayErasures?: (snapshot: SchemaSnapshotRef) => Awaitable<number>;
	readonly journal?: MigrationJournal;
}

const SCHEMA_PHASES = ["expand", "backfill", "contract"] as const;

function isSchemaPhase(value: JsonValue | undefined): value is SchemaPhase {
	return (
		isJsonString(value) && (SCHEMA_PHASES as readonly string[]).includes(value)
	);
}

type Recorded =
	| "new"
	| "running"
	| "held"
	| "completed"
	| "rolled-back"
	| "failed";

interface Progress {
	status: Recorded;
	planned: boolean;
	snapshot: SchemaSnapshotRef | undefined;
	readonly applied: Map<SchemaPhase, SchemaPhaseResult>;
	readonly unanswered: Set<SchemaPhase>;
	pattern: string | undefined;
	readonly verified: Set<string>;
	heldAt: string | undefined;
	reason: string | undefined;
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

// public-contract: hold code for a phase whose statements may or may not have committed.
export const PHASE_OUTCOME_UNKNOWN = "PHASE_OUTCOME_UNKNOWN";

// public-contract: hold code for a re-applied phase that failed; never answered by a restore.
export const PHASE_REAPPLY_FAILED = "PHASE_REAPPLY_FAILED";

const IN_PLACE_PATTERN = "in-place-evolve";

export async function runInPlaceEvolve(
	options: InPlaceEvolveOptions,
): Promise<InPlaceEvolveResult> {
	const clock = options.clock ?? (() => new Date().toISOString());
	const { plan, port } = options;
	const journal = options.journal ?? createMemoryMigrationJournal();
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

	const dualWindow = (): boolean =>
		applied.has("backfill") && !applied.has("contract");
	const sitsAt = (): MigrationPhase => {
		if (applied.has("backfill")) return "verify";
		return applied.has("expand") ? "prepare" : "plan";
	};

	let resuming = progress.status === "held";
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
		if (options.replayErasures === undefined) {
			return hold([reason, NO_ERASURE_REPLAY_REASON], violations, failedPhase);
		}
		await proceed();
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
			erasuresReplayed = await options.replayErasures(snapshot);
		} catch (restoreError) {
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
			...(result === undefined ? { recovered: true } : undefined),
			appliedAt: clock(),
		});
	};
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
			return hold([
				`${PHASE_REAPPLY_FAILED}: the ${phase} phase was applied again after an unrecorded attempt and failed: ${failureReason(error)}. Nothing was restored`,
			]);
		}
		await record(phase, statements, result);
		return undefined;
	};

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
			if (error instanceof Error && isSupersededError(error)) throw error;
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

	if (
		(progress.rollbackDecided || progress.status === "failed") &&
		progress.snapshot !== undefined
	) {
		return rollback(progress.snapshot, "an earlier restore did not complete");
	}

	if (!applied.has("expand")) {
		const beforeExpand = await denied("expand");
		if (beforeExpand !== undefined) return hold([beforeExpand]);
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

	if (!applied.has("expand")) {
		const stopped = await applyPhase(
			snapshot,
			"expand",
			plan.expand,
			"phase execution failed",
		);
		if (stopped !== undefined) return stopped;
	}

	if (!applied.has("backfill")) {
		const beforeBackfill = await denied("backfill");
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
