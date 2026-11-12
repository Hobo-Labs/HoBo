// Trails sequencing for data-shape changes (D11). A promotion whose Freight
// changes data shape runs Trails `expand` before apply and `contract` after
// soak; rollback past a completed `contract` is refused naming the
// compensating `expand`. `@hobo/trails` is bound by composition (WP18): its
// `executeDataMigration` resumes from its journal, so the expand pass runs
// with a compatibility gate that still names the predecessor as a legacy
// consumer (the run stops at `contract-blocked` with the dual window open),
// and the contract pass runs with an empty one.
import type { FreightRecord } from "../_generated/cd_pb.js";
import { reason } from "../promotion/reasons.js";
import type { CampId, CdContext, Outcome } from "../ports.js";

export type TrailsPhase = "expand" | "contract";

export type TrailsMigration = Readonly<{ migrationId: string }>;

/** Structural mirror of `@hobo/trails` `DataMigrationResult` (the fields read here). */
export type DataMigrationRun = Readonly<{
	status: "completed" | "contract-blocked" | "held" | "rolled-back" | "failed";
	dualWindowOpen: boolean;
	blockedReasons: readonly string[];
}>;

export interface TrailsMigrations {
	/** The migration this Freight needs at a Camp; undefined when its data shape is unchanged. */
	migrationFor(
		input: Readonly<{ freight: FreightRecord; campId: CampId }>,
	): Promise<TrailsMigration | undefined>;
	run(
		input: Readonly<{ migrationId: string; campId: CampId; phase: TrailsPhase }>,
		ctx: CdContext,
	): Promise<Outcome<DataMigrationRun>>;
}

// public-contract: Freight manifest label naming the Trails migration its
// declaration requires (set by the build that changed the data shape).
export const MIGRATION_LABEL = "hobo.cd/data-migration" as const;

// public-contract: refusal codes of the Trails adapter.
export const TRAILS_REASON = Object.freeze({
	held: "trails-migration-held",
	failed: "trails-migration-failed",
	error: "trails-migration-error",
} as const);

export type TrailsDeps = Readonly<{
	/** Bound to `@hobo/trails` `executeDataMigration` by composition. */
	execute: (
		input: Readonly<{ migrationId: string; campId: CampId; phase: TrailsPhase }>,
	) => Promise<DataMigrationRun>;
	/** Defaults to the Freight manifest label `hobo.cd/data-migration`. */
	migrationFor?: TrailsMigrations["migrationFor"];
}>;

function phaseSucceeded(phase: TrailsPhase, run: DataMigrationRun): boolean {
	if (phase === "contract") return run.status === "completed";
	return run.status === "completed" || run.dualWindowOpen;
}

export function createTrailsMigrations(d: TrailsDeps): TrailsMigrations {
	const migrationFor =
		d.migrationFor ??
		(async ({ freight }) => {
			const id = freight.manifest?.labels[MIGRATION_LABEL] ?? "";
			return id === "" ? undefined : { migrationId: id };
		});
	return {
		migrationFor,
		async run(input) {
			let run: DataMigrationRun;
			try {
				run = await d.execute(input);
			} catch (error) {
				return {
					ok: false,
					reasons: [
						reason(
							TRAILS_REASON.error,
							`Trails ${input.phase} for ${input.migrationId} threw: ${error instanceof Error ? error.message : String(error)}`,
							"Inspect the Trails migration journal; fix the store, then the promotion retries on its next tick.",
							input.campId,
						),
					],
				};
			}
			if (phaseSucceeded(input.phase, run)) return { ok: true, value: run };
			const held = run.status === "held" || run.status === "contract-blocked";
			return {
				ok: false,
				reasons: [
					reason(
						held ? TRAILS_REASON.held : TRAILS_REASON.failed,
						`Trails ${input.phase} for ${input.migrationId} ended ${run.status}${run.blockedReasons.length > 0 ? `: ${run.blockedReasons.join("; ")}` : ""}`,
						held
							? "Resolve the blocking consumers or policy finding; the promotion resumes the migration from its journal."
							: "The migration restored its snapshot; fix the migration plan and promote new Freight.",
						input.campId,
					),
				],
			};
		},
	};
}
