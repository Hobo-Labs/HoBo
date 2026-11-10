/**
 * Platform golden-replay corpus: pinned v1 wire shapes for the `migration.*`
 * event family (ADR-0032, extended by ADR-0177). Append-only — bumping any of these event bodies to
 * v2 requires (a) a total v1→v2 upcaster and (b) a NEW corpus entry for v2;
 * removing or editing a pinned entry fails the gate. The CI test in
 * `test/upcaster-gate.test.ts` runs `runCanDeployUpcasterGate` over every
 * contract here, so an unliftable body fails the test lane (and with it
 * can-deploy).
 */
import {
	type CorpusBaseline,
	createCorpusBaseline,
	createCorpusEntry,
	type EventBody,
	type EventEvolutionContract,
	eventSchema,
	stringField,
	u32Field,
} from "./upcaster.js";

function v1Contract(
	type: string,
	fields: Parameters<typeof eventSchema>[2],
	sampleBody: EventBody,
): EventEvolutionContract {
	const schema = eventSchema(type, 1, fields);
	return Object.freeze({
		type,
		currentVersion: 1,
		schemas: Object.freeze([schema]),
		upcasters: Object.freeze([]),
		goldenCorpus: Object.freeze([
			createCorpusEntry(schema, `${type.replaceAll(".", "-")}-v1`, sampleBody),
		]),
	});
}

/** One evolution contract per `migration.*` event type, currently at v1. */
export const MIGRATION_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		v1Contract(
			"migration.Planned",
			[
				stringField("migrationId", 1),
				stringField("phases", 2),
				stringField("plannedAt", 3),
			],
			{
				migrationId: "mig-001",
				phases: "expand,backfill,contract",
				plannedAt: "2026-08-03T00:00:00.000Z",
			},
		),
		v1Contract(
			"migration.SnapshotTaken",
			[
				stringField("migrationId", 1),
				stringField("snapshotRef", 2),
				stringField("takenAt", 3),
			],
			{
				migrationId: "mig-001",
				snapshotRef: "/data/store.db.snapshot-1",
				takenAt: "2026-08-03T00:00:01.000Z",
			},
		),
		v1Contract(
			"migration.PhaseApplied",
			[
				stringField("migrationId", 1),
				stringField("phase", 2),
				u32Field("statements", 3),
				u32Field("changes", 4, { required: false }),
				stringField("appliedAt", 5),
			],
			{
				migrationId: "mig-001",
				phase: "expand",
				statements: 2,
				appliedAt: "2026-08-03T00:00:02.000Z",
			},
		),
		v1Contract(
			"migration.Verified",
			[
				stringField("migrationId", 1),
				stringField("point", 2),
				stringField("verifiedAt", 3),
			],
			{
				migrationId: "mig-001",
				point: "after-backfill",
				verifiedAt: "2026-08-03T00:00:03.000Z",
			},
		),
		v1Contract(
			"migration.CutOver",
			[stringField("migrationId", 1), stringField("cutOverAt", 2)],
			{
				migrationId: "mig-001",
				cutOverAt: "2026-08-03T00:00:04.000Z",
			},
		),
		v1Contract(
			"migration.RolledBack",
			[
				stringField("migrationId", 1),
				stringField("reason", 2),
				stringField("snapshotRef", 3),
				stringField("rolledBackAt", 4),
			],
			{
				migrationId: "mig-001",
				reason: "backfill verification failed",
				snapshotRef: "/data/store.db.snapshot-1",
				rolledBackAt: "2026-08-03T00:00:05.000Z",
			},
		),
		v1Contract(
			"migration.Failed",
			[
				stringField("migrationId", 1),
				stringField("reason", 2),
				stringField("failedAt", 3),
			],
			{
				migrationId: "mig-001",
				reason: "restore failed after contract phase failed",
				failedAt: "2026-08-03T00:00:06.000Z",
			},
		),
		v1Contract(
			"migration.Exported",
			[
				stringField("tenant", 1),
				stringField("exportId", 2),
				u32Field("headSeq", 3),
				u32Field("streamCount", 4),
				stringField("exportedAt", 5),
			],
			{
				tenant: "tenant-a",
				exportId: "export:tenant-a:1",
				headSeq: 42,
				streamCount: 7,
				exportedAt: "2026-08-03T00:00:07.000Z",
			},
		),
		v1Contract(
			"migration.Imported",
			[
				stringField("tenant", 1),
				stringField("exportId", 2),
				u32Field("importedHeadSeq", 3),
				u32Field("streamCount", 4),
				stringField("importedAt", 5),
			],
			{
				tenant: "tenant-a",
				exportId: "export:tenant-a:1",
				importedHeadSeq: 42,
				streamCount: 7,
				importedAt: "2026-08-03T00:00:08.000Z",
			},
		),
		// ADR-0177: the uniform phase model's hold / resume / complete facts,
		// emitted by the `@hobo/data-core` pattern executors.
		v1Contract(
			"migration.Held",
			[
				stringField("migrationId", 1),
				stringField("phase", 2),
				stringField("reason", 3),
				stringField("heldAt", 4),
			],
			{
				migrationId: "mig-001",
				phase: "converge",
				reason:
					"policy verdict is negative before verify: CUSTODY_RESIDENCY_CONFLICT",
				heldAt: "2026-11-10T00:00:00.000Z",
			},
		),
		v1Contract(
			"migration.Resumed",
			[
				stringField("migrationId", 1),
				stringField("phase", 2),
				stringField("resumedAt", 3),
			],
			{
				migrationId: "mig-001",
				phase: "verify",
				resumedAt: "2026-11-10T00:05:00.000Z",
			},
		),
		v1Contract(
			"migration.Completed",
			[
				stringField("migrationId", 1),
				stringField("pattern", 2),
				stringField("completedAt", 3),
			],
			{
				migrationId: "mig-001",
				pattern: "snapshot-and-tail",
				completedAt: "2026-11-10T01:00:00.000Z",
			},
		),
	]);

/** Append-only baseline over every pinned entry across all contracts. */
export function migrationCorpusBaseline(): CorpusBaseline {
	return createCorpusBaseline(
		MIGRATION_EVENT_CONTRACTS.flatMap((contract) => contract.goldenCorpus),
	);
}
