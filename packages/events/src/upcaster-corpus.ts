/**
 * Platform golden-replay corpus: the pinned wire bodies of the `migration.*`
 * event family (ADR-0032, extended by ADR-0177). Append-only — bumping any of
 * these event bodies requires (a) a total upcaster from the version before and
 * (b) a NEW corpus entry for the new version; removing or editing a pinned
 * entry fails the gate. The CI test in `test/upcaster-gate.test.ts` runs
 * `runCanDeployUpcasterGate` over every contract here, so an unliftable body
 * fails the test lane (and with it can-deploy).
 *
 * Two kinds of change are made here, and they are not interchangeable:
 *
 * - **An optional field is added to the current version** when nothing that
 *   was valid stops being valid and nothing changes meaning: a count beside a
 *   verification, a flag beside a hold. An old body is still a body of that
 *   version.
 * - **A new version, with an upcaster,** when a body really changed: a
 *   required field stopped being required, a field changed type, a field was
 *   withdrawn. `migration.CutOver` is the clearest case — the fence token it
 *   once carried is a write-authority credential, so v2 has only its digest
 *   and the upcaster computes one and drops the other.
 *
 * `test/migration-fact-contracts.test.ts` runs every `@hobo/data-core`
 * executor and validates each fact it emits against the current version here,
 * so the two cannot drift apart unnoticed.
 *
 * v1 is what was written, not what was first pinned. The first pins of
 * `migration.Planned` and `migration.PhaseApplied` described bodies no
 * executor emitted — `phases` as one comma-joined string, a `PhaseApplied`
 * that always had `statements` and never a checkpoint. Their v1 schemas now
 * read the bodies the 65a46a72 executors appended (recorded in
 * `test/fixtures/journal-65a46a72.json`), with one of each pinned beside the
 * original. The original pins are untouched on the wire: a string and a
 * one-element list of strings are the same bytes, so their digests stand.
 */
import { createHash } from "node:crypto";
import {
	boolField,
	type CorpusBaseline,
	createCorpusBaseline,
	createCorpusEntry,
	type EventBody,
	type EventBodySchema,
	type EventBodyUpcaster,
	type EventEvolutionContract,
	type EventFieldSpec,
	type EventJsonObject,
	eventSchema,
	jsonField,
	stringField,
	stringsField,
	u32Field,
} from "./upcaster.js";

interface PinnedBody {
	/** Suffix of the corpus id; the entry is `<type>-v<n>` or `<type>-v<n>-<id>`. */
	readonly id?: string;
	readonly body: EventBody;
}

interface PinnedVersion {
	readonly fields: readonly EventFieldSpec[];
	/** At least one real body per version; never edited once pinned. */
	readonly pinned: readonly PinnedBody[];
	/** How a body of the version before becomes one of this version. */
	readonly from?: Pick<EventBodyUpcaster, "reason" | "upcast">;
}

/** A contract over consecutive versions, the first being v1. */
function contract(
	type: string,
	versions: readonly PinnedVersion[],
): EventEvolutionContract {
	const schemas: EventBodySchema[] = [];
	const upcasters: EventBodyUpcaster[] = [];
	const goldenCorpus = versions.flatMap((entry, index) => {
		const version = index + 1;
		const schema = eventSchema(type, version, entry.fields);
		schemas.push(schema);
		if (entry.from !== undefined) {
			upcasters.push(
				Object.freeze({ type, from: version - 1, to: version, ...entry.from }),
			);
		}
		return entry.pinned.map((pinned) =>
			createCorpusEntry(
				schema,
				`${type.replaceAll(".", "-")}-v${version}${pinned.id === undefined ? "" : `-${pinned.id}`}`,
				pinned.body,
			),
		);
	});
	return Object.freeze({
		type,
		currentVersion: versions.length,
		schemas: Object.freeze(schemas),
		upcasters: Object.freeze(upcasters),
		goldenCorpus: Object.freeze(goldenCorpus),
	});
}

function v1Contract(
	type: string,
	fields: readonly EventFieldSpec[],
	sampleBody: EventBody,
): EventEvolutionContract {
	return contract(type, [{ fields, pinned: [{ body: sampleBody }] }]);
}

const OPTIONAL = { required: false } as const;

/**
 * What a journal keeps of a fence token: `sha256:<hex of the token>`. The
 * same digest `@hobo/data-core`'s `fenceTokenDigest` computes; the contract
 * test holds the two together.
 */
function fenceTokenDigest(fenceToken: string): string {
	return `sha256:${createHash("sha256").update(fenceToken, "utf8").digest("hex")}`;
}

/** The phases only the in-place executor plans. */
const IN_PLACE_PHASES = ["expand", "backfill", "contract"];

/**
 * `phases` as the list it stands for. The first v1 pin wrote it as one
 * comma-joined string, which on the wire is a list of one.
 */
function phaseList(phases: EventBody[string]): readonly string[] {
	const listed = Array.isArray(phases) ? phases : [phases];
	return listed.flatMap((entry) => String(entry).split(","));
}

/** A checkpoint with its fence token replaced by the token's digest. */
function withoutFenceToken(checkpoint: EventJsonObject): EventJsonObject {
	const { fenceToken, ...kept } = checkpoint;
	return fenceToken === undefined
		? checkpoint
		: { ...kept, fenceTokenDigest: fenceTokenDigest(String(fenceToken)) };
}

function isJsonObject(value: EventBody[string]): value is EventJsonObject {
	return (
		value !== undefined &&
		Object(value) === value &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** One evolution contract per `migration.*` event type. */
export const MIGRATION_EVENT_CONTRACTS: readonly EventEvolutionContract[] =
	Object.freeze([
		contract("migration.Planned", [
			{
				// What v1 executors wrote: `phases` as a list, and — from the
				// pattern executors — the pattern, the decision and custody
				// digests, and the two engines and the dataset.
				fields: [
					stringField("migrationId", 1),
					stringsField("phases", 2),
					stringField("plannedAt", 3),
					stringField("pattern", 5, OPTIONAL),
					stringField("decisionDigest", 8, OPTIONAL),
					stringField("custodyDigest", 9, OPTIONAL),
					stringField("source", 10, OPTIONAL),
					stringField("target", 11, OPTIONAL),
					stringField("dataset", 12, OPTIONAL),
				],
				pinned: [
					{
						// The first pin: one comma-joined string, which is these
						// same bytes read as a list of one.
						body: {
							migrationId: "mig-001",
							phases: ["expand,backfill,contract"],
							plannedAt: "2026-08-03T00:00:00.000Z",
						},
					},
					{
						// Recorded from a 65a46a72 snapshot-and-tail run.
						id: "executor",
						body: {
							migrationId: "m",
							pattern: "snapshot-and-tail",
							phases: [
								"plan",
								"gate",
								"prepare",
								"seed",
								"converge",
								"verify",
								"shift-reads",
								"fence-and-flip",
								"soak",
								"finalize",
							],
							decisionDigest:
								"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
							custodyDigest:
								"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
							source: "src",
							target: "tgt",
							dataset: "orders",
							plannedAt: "2026-01-01T00:00:00Z",
						},
					},
				],
			},
			{
				// `phases` is the list the executors emit, under a new tag: v1
				// pinned it as one comma-joined string, which nothing ever wrote.
				// The rest says what was planned — the pattern, the realization
				// that runs (binding on every resume), and the decision and
				// custody digests when the caller supplied them.
				fields: [
					stringField("migrationId", 1),
					stringField("plannedAt", 3),
					stringsField("phases", 4),
					stringField("pattern", 5, OPTIONAL),
					stringField("realization", 6, OPTIONAL),
					stringField("profile", 7, OPTIONAL),
					stringField("decisionDigest", 8, OPTIONAL),
					stringField("custodyDigest", 9, OPTIONAL),
					stringField("source", 10, OPTIONAL),
					stringField("target", 11, OPTIONAL),
					stringField("dataset", 12, OPTIONAL),
				],
				from: {
					reason:
						"phases moved to its own tag as a list of phase names, and a plan names its pattern: one that planned expand, backfill and contract was the in-place executor's",
					// Everything a v1 plan said is carried: the pattern above all,
					// which is what a resume is checked against, and the digests
					// that tie the run to its decision.
					upcast: ({ phases, ...kept }) => {
						const listed = phaseList(phases);
						const inPlace =
							kept.pattern === undefined &&
							listed.length === IN_PLACE_PHASES.length &&
							listed.every((phase, index) => phase === IN_PLACE_PHASES[index]);
						return {
							...kept,
							phases: listed,
							...(inPlace ? { pattern: "in-place-evolve" } : undefined),
						};
					},
				},
				pinned: [
					{
						body: {
							migrationId: "mig-002",
							pattern: "snapshot-and-tail",
							phases: [
								"plan",
								"gate",
								"prepare",
								"seed",
								"converge",
								"verify",
								"shift-reads",
								"fence-and-flip",
								"soak",
								"finalize",
							],
							realization: "hub",
							source: "postgres",
							target: "mongodb",
							dataset: "orders",
							plannedAt: "2026-11-10T00:00:00.000Z",
						},
					},
				],
			},
		]),
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
		contract("migration.PhaseApplied", [
			{
				// What v1 executors wrote: an in-place phase its statement count,
				// a phase of the uniform model a checkpoint — which, for the
				// fence-and-flip phase, carried the fence token itself.
				fields: [
					stringField("migrationId", 1),
					stringField("phase", 2),
					u32Field("statements", 3, OPTIONAL),
					u32Field("changes", 4, OPTIONAL),
					stringField("appliedAt", 5),
					jsonField("checkpoint", 6, OPTIONAL),
				],
				pinned: [
					{
						body: {
							migrationId: "mig-001",
							phase: "expand",
							statements: 2,
							appliedAt: "2026-08-03T00:00:02.000Z",
						},
					},
					{
						// Recorded from a 65a46a72 snapshot-and-tail run.
						id: "fence-token",
						body: {
							migrationId: "m",
							phase: "fence-and-flip",
							checkpoint: {
								migrationId: "m",
								fenceToken: "fence:orders::1",
								count: 3,
								digest:
									"9d97301592dcb87bcb7d57f003c02d9da7e766814a9d8abc27c8d8c3b5e6661c",
								reverseTail: true,
								reversePosition: "3",
								cutOverAt: "2026-01-01T00:00:00Z",
							},
							appliedAt: "2026-01-01T00:00:00Z",
						},
					},
				],
			},
			{
				// A checkpoint holds positions, counts and digests. v2 withdraws
				// the one thing a v1 checkpoint held that is none of those: the
				// fence token, a write-authority credential, replaced by its
				// digest. `recovered` marks an in-place phase the plan's probe
				// found already in effect.
				fields: [
					stringField("migrationId", 1),
					stringField("phase", 2),
					u32Field("statements", 3, OPTIONAL),
					u32Field("changes", 4, OPTIONAL),
					stringField("appliedAt", 5),
					jsonField("checkpoint", 6, OPTIONAL),
					boolField("recovered", 7, OPTIONAL),
				],
				from: {
					reason:
						"a checkpoint's fenceToken was withdrawn — it is a credential — and replaced by fenceTokenDigest",
					upcast: ({ checkpoint, ...kept }) => ({
						...kept,
						...(isJsonObject(checkpoint)
							? { checkpoint: withoutFenceToken(checkpoint) }
							: undefined),
					}),
				},
				pinned: [
					{
						body: {
							migrationId: "mig-002",
							phase: "converge",
							checkpoint: { position: "0/16B3748", applied: 12 },
							appliedAt: "2026-11-10T00:00:02.000Z",
						},
					},
				],
			},
		]),
		v1Contract(
			"migration.Verified",
			[
				stringField("migrationId", 1),
				stringField("point", 2),
				stringField("verifiedAt", 3),
				// Optional additions (ADR-0177): what was verified, and whether a
				// comparison was actually made. Never a record.
				u32Field("count", 4, OPTIONAL),
				stringField("digest", 5, OPTIONAL),
				boolField("compared", 6, OPTIONAL),
			],
			{
				migrationId: "mig-001",
				point: "after-backfill",
				verifiedAt: "2026-08-03T00:00:03.000Z",
			},
		),
		contract("migration.CutOver", [
			{
				fields: [
					stringField("migrationId", 1),
					stringField("cutOverAt", 2),
					// What the copy and log executors wrote at v1 before the
					// token was kept out of the journal. Declared so that such
					// a body can be read, and lifted, at all.
					stringField("fenceToken", 3, OPTIONAL),
					u32Field("count", 4, OPTIONAL),
					stringField("digest", 5, OPTIONAL),
					boolField("reverseTail", 6, OPTIONAL),
					stringField("reversePosition", 7, OPTIONAL),
					stringField("authority", 8, OPTIONAL),
					stringField("logPosition", 9, OPTIONAL),
				],
				pinned: [
					{
						body: {
							migrationId: "mig-001",
							cutOverAt: "2026-08-03T00:00:04.000Z",
						},
					},
					{
						id: "fence-token",
						body: {
							migrationId: "mig-002",
							fenceToken: "fence:orders::1",
							count: 42,
							digest:
								"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
							reverseTail: true,
							reversePosition: "17",
							cutOverAt: "2026-11-10T00:00:04.000Z",
						},
					},
				],
			},
			{
				// No `fenceToken`: a fence token is a write-authority credential
				// and a journal is evidence. v2 carries its digest, and the
				// instant the source was first fenced from — where a rollback's
				// erasure replay is windowed from.
				fields: [
					stringField("migrationId", 1),
					stringField("cutOverAt", 2),
					u32Field("count", 4, OPTIONAL),
					stringField("digest", 5, OPTIONAL),
					boolField("reverseTail", 6, OPTIONAL),
					stringField("reversePosition", 7, OPTIONAL),
					stringField("authority", 8, OPTIONAL),
					stringField("logPosition", 9, OPTIONAL),
					stringField("fenceTokenDigest", 10, OPTIONAL),
					stringField("fencedFrom", 11, OPTIONAL),
				],
				from: {
					reason:
						"fenceToken was withdrawn — it is a credential — and replaced by fenceTokenDigest",
					upcast: ({ fenceToken, ...kept }) => ({
						...kept,
						...(fenceToken === undefined
							? undefined
							: { fenceTokenDigest: fenceTokenDigest(String(fenceToken)) }),
					}),
				},
				pinned: [
					{
						body: {
							migrationId: "mig-002",
							fenceTokenDigest:
								"sha256:eca55ad89a60a18a449cd4da50a108405ee0824b7c596696c25a0d9ba8340859",
							count: 42,
							digest:
								"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
							reverseTail: true,
							reversePosition: "17",
							fencedFrom: "2026-11-10T00:00:03.000Z",
							cutOverAt: "2026-11-10T00:00:04.000Z",
						},
					},
				],
			},
		]),
		contract("migration.RolledBack", [
			{
				fields: [
					stringField("migrationId", 1),
					stringField("reason", 2),
					stringField("snapshotRef", 3),
					stringField("rolledBackAt", 4),
				],
				pinned: [
					{
						body: {
							migrationId: "mig-001",
							reason: "backfill verification failed",
							snapshotRef: "/data/store.db.snapshot-1",
							rolledBackAt: "2026-08-03T00:00:05.000Z",
						},
					},
				],
			},
			{
				// A copy pattern rolls back to the old store, not to a snapshot,
				// so `snapshotRef` is no longer required. `lossless` says whether
				// the old store was current; `erasuresReplayed` how many erasures
				// were re-applied to a store that was not.
				fields: [
					stringField("migrationId", 1),
					stringField("reason", 2),
					stringField("snapshotRef", 3, OPTIONAL),
					stringField("rolledBackAt", 4),
					boolField("lossless", 5, OPTIONAL),
					u32Field("erasuresReplayed", 6, OPTIONAL),
				],
				from: {
					reason:
						"snapshotRef stopped being required: a copy pattern rolls back to the old store, not to a snapshot",
					upcast: (body) => ({ ...body }),
				},
				pinned: [
					{
						body: {
							migrationId: "mig-002",
							reason: "rolled back from soak under a reverse tail",
							lossless: true,
							rolledBackAt: "2026-11-10T00:00:05.000Z",
						},
					},
				],
			},
		]),
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
				// Optional additions. `compensated`: the hold followed a failed
				// verification under a fence, and write authority was given
				// back. `before`: the phase the run was about to enter, for a
				// hold that fell between two phases.
				boolField("compensated", 5, OPTIONAL),
				stringField("before", 6, OPTIONAL),
				// The in-place phase whose statements the port reported as
				// failed: an answer to that phase's intent.
				stringField("failedPhase", 7, OPTIONAL),
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
		// Two of the write-ahead facts: each is journaled, as a compare-and-set,
		// before the side effect it names.
		v1Contract(
			"migration.FenceRequested",
			[
				stringField("migrationId", 1),
				// `source` or `target`: the store about to be fenced.
				stringField("side", 2),
				stringField("phase", 3),
				stringField("requestedAt", 4),
			],
			{
				migrationId: "mig-002",
				side: "source",
				phase: "fence-and-flip",
				requestedAt: "2026-11-10T00:00:03.000Z",
			},
		),
		v1Contract(
			"migration.RollbackDecided",
			[
				stringField("migrationId", 1),
				boolField("lossless", 2),
				stringField("decidedAt", 3),
				// Where erasure replay is windowed from, for a rollback to a
				// stale store.
				stringField("erasuresFrom", 4, OPTIONAL),
				// What both sides digested to, for a rollback under a reverse tail.
				u32Field("count", 5, OPTIONAL),
				stringField("digest", 6, OPTIONAL),
				// Optional additions. `targetFenced`: whether the target was
				// fenced before authority went back — a rollback to a stale
				// source does not wait for a target that cannot be reached.
				// `policyFindings`: the finding codes of the negative verdict
				// the rollback was asked for under.
				boolField("targetFenced", 7, OPTIONAL),
				stringsField("policyFindings", 8, OPTIONAL),
			],
			{
				migrationId: "mig-002",
				lossless: false,
				erasuresFrom: "2026-11-10T00:00:03.000Z",
				decidedAt: "2026-11-10T00:30:00.000Z",
			},
		),
		// Written after a fence is raised: the digest of the token the raise
		// answered — never the token — so a later run can prove a fence it
		// finds standing is this migration's own.
		v1Contract(
			"migration.FenceRaised",
			[
				stringField("migrationId", 1),
				stringField("side", 2),
				stringField("phase", 3),
				stringField("fenceTokenDigest", 4),
				stringField("raisedAt", 5),
			],
			{
				migrationId: "mig-003",
				side: "source",
				phase: "fence-and-flip",
				fenceTokenDigest:
					"sha256:eca55ad89a60a18a449cd4da50a108405ee0824b7c596696c25a0d9ba8340859",
				raisedAt: "2026-11-10T00:00:03.500Z",
			},
		),
		// The third write-ahead fact: journaled, as a compare-and-set, before
		// an in-place phase runs its statements.
		v1Contract(
			"migration.PhaseIntended",
			[
				stringField("migrationId", 1),
				// `expand`, `backfill` or `contract`.
				stringField("phase", 2),
				u32Field("statements", 3),
				stringField("intendedAt", 4),
				// The phase is applied again after its probe found it not in
				// effect.
				boolField("retry", 5, OPTIONAL),
			],
			{
				migrationId: "mig-003",
				phase: "contract",
				statements: 1,
				intendedAt: "2026-11-10T00:00:02.500Z",
			},
		),
	]);

/** The schema a `migration.*` body of this type is written against today. */
export function currentMigrationEventSchema(
	type: string,
): EventBodySchema | undefined {
	const found = MIGRATION_EVENT_CONTRACTS.find((entry) => entry.type === type);
	return found?.schemas.find(
		(schema) => schema.version === found.currentVersion,
	);
}

/**
 * Append-only baseline over every pinned entry across all contracts: the
 * first body pinned for each type, then every later one, so an addition comes
 * after what was already pinned rather than between.
 */
export function migrationCorpusBaseline(): CorpusBaseline {
	return createCorpusBaseline([
		...MIGRATION_EVENT_CONTRACTS.flatMap((entry) =>
			entry.goldenCorpus.slice(0, 1),
		),
		...MIGRATION_EVENT_CONTRACTS.flatMap((entry) =>
			entry.goldenCorpus.slice(1),
		),
	]);
}
