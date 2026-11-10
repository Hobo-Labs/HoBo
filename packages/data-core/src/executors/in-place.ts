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
 * Two additions over the original Trails executor this was promoted from:
 * policy is re-evaluated before every phase, and a restore re-applies the
 * erasures recorded since the snapshot, so a rollback can never resurrect an
 * erased subject.
 */
import { MIGRATION_EVENTS, type MigrationFact } from "../facts.js";
import type { JsonObject } from "../json.js";
import type {
	Awaitable,
	SchemaApplyPort,
	SchemaPhase,
	SchemaPhaseResult,
	SchemaSnapshotRef,
} from "../spi.js";

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
	readonly facts: readonly MigrationFact[];
}

/**
 * The part of a policy verdict this executor reads. A full `PolicyVerdict`
 * satisfies it; so does a caller that has only an outcome and finding codes.
 */
export interface PolicyOutcome {
	readonly ok: boolean;
	readonly findings: readonly { readonly code: string }[];
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
	 */
	readonly replayErasures?: (snapshot: SchemaSnapshotRef) => Awaitable<number>;
}

export async function runInPlaceEvolve(
	options: InPlaceEvolveOptions,
): Promise<InPlaceEvolveResult> {
	const clock = options.clock ?? (() => new Date().toISOString());
	const { plan, port } = options;
	const facts: MigrationFact[] = [];
	const phases: SchemaPhaseResult[] = [];
	const emit = (type: string, data: JsonObject) => {
		const fact = Object.freeze({ type, data: Object.freeze({ ...data }) });
		facts.push(fact);
		options.onFact?.(fact);
	};
	const finish = (input: {
		status: InPlaceEvolveStatus;
		dualWindowOpen: boolean;
		snapshot?: SchemaSnapshotRef;
		blockedReasons?: readonly string[];
		violations?: readonly JsonObject[];
	}): InPlaceEvolveResult =>
		Object.freeze({
			contract: IN_PLACE_EVOLVE_CONTRACT,
			migrationId: plan.migrationId,
			status: input.status,
			dualWindowOpen: input.dualWindowOpen,
			...(input.snapshot === undefined
				? undefined
				: { snapshot: input.snapshot }),
			phases: Object.freeze([...phases]),
			blockedReasons: Object.freeze([...(input.blockedReasons ?? [])]),
			violations: Object.freeze([...(input.violations ?? [])]),
			facts: Object.freeze([...facts]),
		});

	const denied = async (phase: SchemaPhase): Promise<string | undefined> => {
		const verdict = await options.policy?.(phase);
		if (verdict === undefined || verdict.ok) return undefined;
		return `policy verdict is negative before ${phase}: ${verdict.findings
			.map((finding) => finding.code)
			.join(", ")}`;
	};

	emit(MIGRATION_EVENTS.Planned, {
		migrationId: plan.migrationId,
		phases: ["expand", "backfill", "contract"],
		plannedAt: clock(),
	});

	const beforeExpand = await denied("expand");
	if (beforeExpand !== undefined) {
		emit(MIGRATION_EVENTS.Held, {
			migrationId: plan.migrationId,
			phase: "plan",
			reason: beforeExpand,
			heldAt: clock(),
		});
		return finish({
			status: "held",
			dualWindowOpen: false,
			blockedReasons: [beforeExpand],
		});
	}

	// Snapshot BEFORE any mutation: rollback is snapshot-restore, so a
	// migration without a snapshot must never touch the store.
	const snapshot = await port.snapshot();
	emit(MIGRATION_EVENTS.SnapshotTaken, {
		migrationId: plan.migrationId,
		snapshotRef: snapshot.ref,
		takenAt: snapshot.takenAt,
	});

	const rollback = async (
		reason: string,
		violations: readonly JsonObject[] = [],
	): Promise<InPlaceEvolveResult> => {
		let erasuresReplayed: number | undefined;
		try {
			await port.restore(snapshot);
			// A restored snapshot predates every erasure since it was taken.
			erasuresReplayed = await options.replayErasures?.(snapshot);
		} catch (restoreError) {
			emit(MIGRATION_EVENTS.Failed, {
				migrationId: plan.migrationId,
				reason: `restore failed after ${reason}: ${String(restoreError)}`,
				failedAt: clock(),
			});
			return finish({
				status: "failed",
				dualWindowOpen: false,
				snapshot,
				blockedReasons: [reason],
				violations,
			});
		}
		emit(MIGRATION_EVENTS.RolledBack, {
			migrationId: plan.migrationId,
			reason,
			snapshotRef: snapshot.ref,
			...(erasuresReplayed === undefined ? undefined : { erasuresReplayed }),
			rolledBackAt: clock(),
		});
		return finish({
			status: "rolled-back",
			dualWindowOpen: false,
			snapshot,
			blockedReasons: [reason],
			violations,
		});
	};

	try {
		// Expand: additive, never destructive.
		phases.push(await port.applyPhase("expand", plan.expand));
		emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase: "expand",
			statements: plan.expand.length,
			appliedAt: clock(),
		});

		const beforeBackfill = await denied("backfill");
		if (beforeBackfill !== undefined) {
			// Expand is additive, so sitting here is a safe hold.
			emit(MIGRATION_EVENTS.Held, {
				migrationId: plan.migrationId,
				phase: "prepare",
				reason: beforeBackfill,
				heldAt: clock(),
			});
			return finish({
				status: "held",
				dualWindowOpen: false,
				snapshot,
				blockedReasons: [beforeBackfill],
			});
		}

		// Backfill: fill the new shape from the old.
		const backfillResult = await port.applyPhase("backfill", plan.backfill);
		phases.push(backfillResult);
		emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase: "backfill",
			statements: plan.backfill.length,
			changes: backfillResult.changes,
			appliedAt: clock(),
		});
	} catch (error) {
		return rollback(`phase execution failed: ${String(error)}`);
	}

	// Verify the dual window before anything destructive.
	const backfillViolations = await port.verify(plan.verify.afterBackfill);
	if (backfillViolations.length > 0) {
		return rollback("backfill verification failed", backfillViolations);
	}
	emit(MIGRATION_EVENTS.Verified, {
		migrationId: plan.migrationId,
		point: "after-backfill",
		verifiedAt: clock(),
	});

	// Gate the destructive contract phase: consumers still reading the old
	// shape BLOCK the drop. Blocked is not failure — the dual window stays
	// open (expand + backfill retained) until consumers move.
	const gate = await options.compatGate();
	if (gate.consumersOnLegacySchema.length > 0) {
		return finish({
			status: "contract-blocked",
			dualWindowOpen: true,
			snapshot,
			blockedReasons: [
				`compat gate ${gate.gateId}: ${gate.consumersOnLegacySchema.join(", ")} still read the old shape`,
			],
		});
	}

	const beforeContract = await denied("contract");
	if (beforeContract !== undefined) {
		emit(MIGRATION_EVENTS.Held, {
			migrationId: plan.migrationId,
			phase: "verify",
			reason: beforeContract,
			heldAt: clock(),
		});
		return finish({
			status: "held",
			dualWindowOpen: true,
			snapshot,
			blockedReasons: [beforeContract],
		});
	}

	try {
		phases.push(await port.applyPhase("contract", plan.contract));
		emit(MIGRATION_EVENTS.PhaseApplied, {
			migrationId: plan.migrationId,
			phase: "contract",
			statements: plan.contract.length,
			appliedAt: clock(),
		});
	} catch (error) {
		return rollback(`contract phase failed: ${String(error)}`);
	}

	if (plan.verify.afterContract) {
		const contractViolations = await port.verify(plan.verify.afterContract);
		if (contractViolations.length > 0) {
			return rollback("contract verification failed", contractViolations);
		}
		emit(MIGRATION_EVENTS.Verified, {
			migrationId: plan.migrationId,
			point: "after-contract",
			verifiedAt: clock(),
		});
	}

	emit(MIGRATION_EVENTS.CutOver, {
		migrationId: plan.migrationId,
		cutOverAt: clock(),
	});
	return finish({ status: "completed", dualWindowOpen: false, snapshot });
}
