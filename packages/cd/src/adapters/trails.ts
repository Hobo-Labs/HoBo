import type { FreightRecord } from "../_generated/cd_pb.js";
import type { CampId, CdContext, Outcome } from "../ports.js";
import { reason } from "../promotion/reasons.js";

export type TrailsPhase = "expand" | "contract";

export type TrailsMigration = Readonly<{ migrationId: string }>;

export type DataMigrationRun = Readonly<{
	status: "completed" | "contract-blocked" | "held" | "rolled-back" | "failed";
	dualWindowOpen: boolean;
	blockedReasons: readonly string[];
}>;

export interface TrailsMigrations {
	migrationFor(
		input: Readonly<{ freight: FreightRecord; campId: CampId }>,
	): Promise<TrailsMigration | undefined>;
	run(
		input: Readonly<{
			migrationId: string;
			campId: CampId;
			phase: TrailsPhase;
		}>,
		ctx: CdContext,
	): Promise<Outcome<DataMigrationRun>>;
}

// public-contract: Freight manifest label naming the Trails migration its
export const MIGRATION_LABEL = "hobo.cd/data-migration" as const;

// public-contract: refusal codes of the Trails adapter.
export const TRAILS_REASON = Object.freeze({
	held: "trails-migration-held",
	failed: "trails-migration-failed",
	error: "trails-migration-error",
} as const);

export type TrailsDeps = Readonly<{
	execute: (
		input: Readonly<{
			migrationId: string;
			campId: CampId;
			phase: TrailsPhase;
		}>,
	) => Promise<DataMigrationRun>;
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
			} catch {
				return {
					ok: false,
					reasons: [
						reason(
							TRAILS_REASON.error,
							"The data migration could not run.",
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
						held ? "The data migration is held." : "The data migration failed.",
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
