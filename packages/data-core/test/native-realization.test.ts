// The `native` realization of the copy patterns, run with the reference
// engine's opt-in native profile. What is proven here: the engine's own
// transport carries the records and the hub ports are never touched; the run
// holds while the engine is slow and resumes from its facts; a native
// realization that cannot run is an error and never a quiet hub run; and the
// journal carries neither a record nor the fence token.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type CopyMigrationOptions,
	CUSTODY_ROLES,
	createMemoryMigrationJournal,
	createReferenceEngine,
	createReferenceNativeLink,
	DataCoreError,
	type DatasetSchema,
	deleteMutation,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	fenceTokenDigest,
	MIGRATION_EVENTS,
	type MigrationJournal,
	type MigrationPhase,
	type MigrationRuntime,
	nativeTransferName,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	REFERENCE_NATIVE_PROFILE,
	type RecordMutation,
	type ReferenceNativeLink,
	requirePort,
	runOfflineCopy,
	runSnapshotAndTail,
	scopeOf,
	upsertMutation,
} from "../src/index.js";

const NOW = "2026-11-10T00:00:00.000Z";

const ORDERS: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "total", type: "decimal", nullable: false },
	],
});

const ALLOW = evaluateCustodyPath({
	// One point per role: a run holds on a path that leaves out a copy it
	// creates — the relay, the retained log, the retiring source.
	path: parseCustodyPath({
		points: CUSTODY_ROLES.map((role) => ({
			id: role,
			role,
			region: "eu-west-1",
			protections: [],
			...(role === "source" || role === "target" || role === "event-log"
				? undefined
				: { retainUntil: "2026-11-17T00:00:00.000Z" }),
		})),
	}),
	policy: { classification: "public" },
	now: NOW,
});

function order(id: string, total: string, tenant = ""): RecordMutation {
	const record = parseCanonicalRecord(ORDERS, { id, total });
	return upsertMutation(tenant, encodeRecordKey(ORDERS, record), record);
}

function keyOf(id: string): string {
	return encodeRecordKey(
		ORDERS,
		parseCanonicalRecord(ORDERS, { id, total: "0" }),
	);
}

interface Staged {
	readonly link: ReferenceNativeLink;
	readonly source: EngineBinding;
	readonly target: EngineBinding;
	readonly journal: MigrationJournal;
}

/**
 * A linked pair. Neither side has the ports the hub would need — no scan and
 * no capture on the source, no apply on the target — so a run that completes
 * here cannot have gone through the hub.
 */
async function staged(rows: number): Promise<Staged> {
	const link = createReferenceNativeLink();
	const source = createReferenceEngine({
		native: link,
		omit: ["snapshot", "capture", "apply"],
	});
	const target = createReferenceEngine({
		native: link,
		omit: ["snapshot", "capture", "apply"],
	});
	await source.datasets.ensureDataset(ORDERS);
	await source.records.write({
		dataset: "orders",
		mutations: Array.from({ length: rows }, (_, index) =>
			order(`o-${index}`, String(index)),
		),
	});
	return { link, source, target, journal: createMemoryMigrationJournal() };
}

function runtime(
	journal: MigrationJournal,
	extra: Partial<MigrationRuntime> = {},
): MigrationRuntime {
	return {
		migrationId: "m1",
		journal,
		clock: () => NOW,
		policy: () => ALLOW,
		...extra,
	};
}

function native(
	stage: Staged,
	extra: Partial<CopyMigrationOptions> = {},
	run: Partial<MigrationRuntime> = {},
): CopyMigrationOptions {
	return {
		runtime: runtime(stage.journal, run),
		source: stage.source,
		target: stage.target,
		schema: ORDERS,
		scope: scopeOf("orders"),
		maxTailRounds: 3,
		buckets: 4,
		flipAuthority: () => {},
		realization: "native",
		profile: REFERENCE_NATIVE_PROFILE,
		...extra,
	};
}

async function count(binding: EngineBinding): Promise<number> {
	const digest = await requirePort(binding, "verify").digest({
		scope: scopeOf("orders"),
		buckets: 4,
	});
	return digest.count;
}

async function sameDigest(left: EngineBinding, right: EngineBinding) {
	const scope = scopeOf("orders");
	const a = await requirePort(left, "verify").digest({ scope, buckets: 4 });
	const b = await requirePort(right, "verify").digest({ scope, buckets: 4 });
	return a.digest === b.digest && a.count === b.count;
}

async function refusal<T>(action: () => Promise<T>): Promise<DataCoreError> {
	try {
		await action();
	} catch (cause) {
		assert.ok(cause instanceof DataCoreError, String(cause));
		return cause;
	}
	throw new Error("expected a refusal");
}

describe("native realization — snapshot-and-tail", () => {
	test("the engine moves the records, the executor keeps every phase, and the plan says which ran", async () => {
		const stage = await staged(20);
		const phases: MigrationPhase[] = [];
		const result = await runSnapshotAndTail(
			native(
				stage,
				{},
				{
					policy: (phase) => {
						phases.push(phase);
						return ALLOW;
					},
					afterPhase: async (phase) => {
						// Writes between phases, as an application would make them.
						if (
							phase === "fence-and-flip" ||
							phase === "soak" ||
							phase === "finalize"
						) {
							return;
						}
						await stage.source.records.write({
							dataset: "orders",
							mutations: [
								order(`during-${phase}`, "1"),
								deleteMutation("", keyOf(`o-${phase.length}`)),
							],
						});
					},
				},
			),
		);
		assert.equal(result.status, "completed", result.reason);
		// The verdict was recomputed before every phase, as it is for the hub.
		assert.deepEqual(phases, [
			"gate",
			"prepare",
			"seed",
			"converge",
			"verify",
			"shift-reads",
			"fence-and-flip",
			"soak",
			"finalize",
		]);
		assert.equal(result.state.realization, "native");
		assert.equal(result.state.profile, REFERENCE_NATIVE_PROFILE);
		const planned = result.facts[0];
		assert.equal(planned?.type, MIGRATION_EVENTS.Planned);
		assert.equal(planned?.data.realization, "native");
		assert.equal(planned?.data.profile, REFERENCE_NATIVE_PROFILE);
		// 20 seeded, 6 written between phases, 6 deleted — 5 distinct, since
		// two phase names are the same length.
		assert.equal(await count(stage.target), 21);
		assert.equal(await count(stage.source), 0, "the source is retired");
		assert.deepEqual(stage.link.open(), [], "the transfer was closed");
		// The prepare checkpoint names the transfer and carries its ticket.
		assert.deepEqual(result.state.checkpoints.prepare, {
			realization: "native",
			profile: REFERENCE_NATIVE_PROFILE,
			transfer: nativeTransferName("m1"),
			ticket: {
				profile: REFERENCE_NATIVE_PROFILE,
				origin: result.state.checkpoints.prepare?.ticket
					? Object(result.state.checkpoints.prepare.ticket).origin
					: "",
				dataset: "orders",
				tenant: "",
			},
		});
	});

	test("a hub run records hub, and its facts are otherwise what they were", async () => {
		const source = createReferenceEngine({ engine: "source" });
		const target = createReferenceEngine({ engine: "target" });
		await source.datasets.ensureDataset(ORDERS);
		await source.records.write({
			dataset: "orders",
			mutations: [order("o-1", "1")],
		});
		const result = await runSnapshotAndTail({
			runtime: runtime(createMemoryMigrationJournal()),
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
		});
		assert.equal(result.status, "completed");
		assert.equal(result.state.realization, "hub");
		assert.equal(result.state.profile, undefined);
		assert.equal(result.facts[0]?.data.realization, "hub");
		assert.deepEqual(Object.keys(result.state.checkpoints.prepare ?? {}), [
			"startPosition",
		]);
	});

	test("while the engine's copy lags the run holds at a safe phase, and resumes when it has caught up", async () => {
		const stage = await staged(10);
		stage.link.stall(true);
		const held = await runSnapshotAndTail(native(stage));
		assert.equal(held.status, "held");
		assert.equal(held.phase, "prepare");
		assert.match(held.reason ?? "", /native initial copy has not finished/u);
		assert.equal(held.rollback, "lossless");
		assert.equal(await count(stage.target), 0);
		// A hold is not an outage: the source keeps taking writes.
		await stage.source.records.write({
			dataset: "orders",
			mutations: [order("while-held", "1")],
		});

		// The copy finishes, then the tail lags.
		stage.link.stall(false);
		const lagging = await runSnapshotAndTail(
			native(
				stage,
				{},
				{
					afterPhase: async (phase) => {
						if (phase !== "seed") return;
						await stage.source.records.write({
							dataset: "orders",
							mutations: [order("after-seed", "2")],
						});
						stage.link.stall(true);
					},
				},
			),
		);
		assert.equal(lagging.status, "held");
		assert.equal(lagging.phase, "seed");
		assert.match(lagging.reason ?? "", /lag did not fall within bound/u);
		assert.equal(await count(stage.target), 11);

		stage.link.stall(false);
		const done = await runSnapshotAndTail(native(stage));
		assert.equal(done.status, "completed", done.reason);
		assert.equal(await count(stage.target), 12);
		assert.equal(await count(stage.source), 0);
		assert.deepEqual(stage.link.open(), []);
		assert.deepEqual(
			done.facts
				.filter((fact) => fact.type === MIGRATION_EVENTS.Held)
				.map((fact) => fact.data.phase),
			["prepare", "seed"],
		);
	});

	test("a lagging engine under the fence compensates: the fence is released and the source stays the authority", async () => {
		const stage = await staged(5);
		let flips = 0;
		const options = (run: Partial<MigrationRuntime>) =>
			native(
				stage,
				{
					flipAuthority: () => {
						flips += 1;
					},
				},
				run,
			);
		const held = await runSnapshotAndTail(
			options({
				afterPhase: async (phase) => {
					if (phase !== "shift-reads") return;
					await stage.source.records.write({
						dataset: "orders",
						mutations: [order("just-before-the-fence", "9")],
					});
					stage.link.stall(true);
				},
			}),
		);
		assert.equal(held.status, "held");
		assert.equal(held.phase, "shift-reads");
		assert.equal(flips, 0);
		assert.equal(held.state.cutOver, false);
		const fence = requirePort(stage.source, "fence");
		assert.equal((await fence.status(scopeOf("orders"))).fenced, false);
		await stage.source.records.write({
			dataset: "orders",
			mutations: [order("after-compensation", "1")],
		});
		stage.link.stall(false);
		const done = await runSnapshotAndTail(options({}));
		assert.equal(done.status, "completed", done.reason);
		assert.equal(flips, 1);
		assert.equal(await count(stage.target), 7);
	});

	test("a crash between the cutover decision and the flip is resumed by finishing it, with the transfer closed first", async () => {
		const stage = await staged(6);
		const flips: string[] = [];
		let crash = true;
		const options = () =>
			native(stage, {
				flipAuthority: (flip) => {
					// By the time authority moves, the engine's transport is gone.
					assert.deepEqual(stage.link.open(), []);
					if (crash) {
						crash = false;
						throw new Error("crashed while moving authority");
					}
					flips.push(flip.direction);
				},
			});
		await assert.rejects(
			runSnapshotAndTail(options()),
			/crashed while moving/u,
		);
		const done = await runSnapshotAndTail(options());
		assert.equal(done.status, "completed", done.reason);
		assert.deepEqual(flips, ["to-target"]);
		assert.equal(
			done.facts.filter((fact) => fact.type === MIGRATION_EVENTS.CutOver)
				.length,
			1,
			"the cutover is decided once",
		);
		assert.equal(await count(stage.target), 6);
		assert.equal(await count(stage.source), 0);
	});

	test("a rollback from soak is to-snapshot, re-applies erasures, and leaves no transfer copying the restored source", async () => {
		const stage = await staged(6);
		const held = await runSnapshotAndTail(
			native(stage, { soakDecision: () => "hold" }),
		);
		assert.equal(held.status, "held");
		assert.equal(held.state.heldAt, "soak");
		assert.equal(
			held.rollback,
			"to-snapshot",
			"no reverse tail: the old side went stale at the flip",
		);
		assert.deepEqual(stage.link.open(), [], "closed at the cutover");
		// The target is the authority now; an erasure lands there.
		await stage.target.records.write({
			dataset: "orders",
			mutations: [
				deleteMutation("", keyOf("o-2")),
				order("only-on-target", "5"),
			],
		});
		const directions: string[] = [];
		const rolled = await runSnapshotAndTail(
			native(stage, {
				soakDecision: () => "rollback",
				erasures: { since: () => [deleteMutation("", keyOf("o-2"))] },
				flipAuthority: (flip) => {
					directions.push(flip.direction);
				},
			}),
		);
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(directions, ["to-source"]);
		assert.match(rolled.reason ?? "", /are lost, 1 erasure\(s\) re-applied/u);
		assert.equal(
			await stage.source.records.read({
				dataset: "orders",
				tenant: "",
				key: keyOf("o-2"),
			}),
			undefined,
			"an erased subject stays erased",
		);
		// The source takes writes again, and nothing carries them anywhere.
		await stage.source.records.write({
			dataset: "orders",
			mutations: [order("after-rollback", "1")],
		});
		assert.equal(await count(stage.source), 6);
		assert.equal(await count(stage.target), 6);
		assert.equal(
			await stage.target.records.read({
				dataset: "orders",
				tenant: "",
				key: keyOf("after-rollback"),
			}),
			undefined,
		);
		assert.deepEqual(stage.link.open(), []);
	});

	test("a tenant moves natively when the engine can do it faithfully", async () => {
		const stage = await staged(0);
		await stage.source.records.write({
			dataset: "orders",
			mutations: [
				order("a-1", "1", "tenant-a"),
				order("b-1", "2", "tenant-b"),
				order("a-2", "3", "tenant-a"),
			],
		});
		const result = await runSnapshotAndTail(
			native(stage, { scope: scopeOf("orders", "tenant-a") }),
		);
		assert.equal(result.status, "completed", result.reason);
		assert.equal(await count(stage.target), 2);
		assert.equal(await count(stage.source), 1, "the other tenant is untouched");
	});
});

describe("native realization — no silent downgrade", () => {
	const expectUnavailable = async (
		options: CopyMigrationOptions,
		journal: MigrationJournal,
		target: EngineBinding,
	): Promise<DataCoreError> => {
		const refused = await refusal(() => runSnapshotAndTail(options));
		assert.equal(refused.code, "NATIVE_REALIZATION_UNAVAILABLE");
		assert.match(refused.message, /hub realization is not substituted/u);
		// Nothing was planned, and nothing was copied by any other route.
		assert.deepEqual(await journal.load("m1"), []);
		assert.equal(await target.datasets.describeDataset("orders"), undefined);
		return refused;
	};

	test("a target without the port is an error, though the hub could have run", async () => {
		const link = createReferenceNativeLink();
		// Both sides have every hub port: a fallback would succeed silently.
		const source = createReferenceEngine({ native: link });
		const target = createReferenceEngine();
		await source.datasets.ensureDataset(ORDERS);
		await source.records.write({
			dataset: "orders",
			mutations: [order("o-1", "1")],
		});
		const journal = createMemoryMigrationJournal();
		const refused = await expectUnavailable(
			{
				runtime: runtime(journal),
				source,
				target,
				schema: ORDERS,
				scope: scopeOf("orders"),
				flipAuthority: () => {},
				realization: "native",
				profile: REFERENCE_NATIVE_PROFILE,
			},
			journal,
			target,
		);
		assert.match(refused.message, /the target does not declare/u);
		assert.equal(refused.detail.profile, REFERENCE_NATIVE_PROFILE);
		assert.equal(await count(source), 1, "the source was not touched");
	});

	test("an unnamed profile, an undeclared profile, and two different engines are each refused", async () => {
		const link = createReferenceNativeLink();
		const source = createReferenceEngine({ native: link });
		await source.datasets.ensureDataset(ORDERS);
		const base = (target: EngineBinding, journal: MigrationJournal) => ({
			runtime: runtime(journal),
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
			realization: "native" as const,
		});
		const same = createReferenceEngine({ native: link });
		const j1 = createMemoryMigrationJournal();
		assert.match(
			(await expectUnavailable(base(same, j1), j1, same)).message,
			/no native profile was named/u,
		);
		const j2 = createMemoryMigrationJournal();
		assert.match(
			(
				await expectUnavailable(
					{ ...base(same, j2), profile: "migration.reference.other/v1" },
					j2,
					same,
				)
			).message,
			/the source does not declare migration\.reference\.other\/v1/u,
		);
		const other = createReferenceEngine({ engine: "other", native: link });
		const j3 = createMemoryMigrationJournal();
		assert.match(
			(
				await expectUnavailable(
					{ ...base(other, j3), profile: REFERENCE_NATIVE_PROFILE },
					j3,
					other,
				)
			).message,
			/only within one engine/u,
		);
	});

	test("a port the executor still drives itself is required up front, by name", async () => {
		const link = createReferenceNativeLink();
		const source = createReferenceEngine({ native: link, omit: ["retire"] });
		const target = createReferenceEngine({ native: link });
		await source.datasets.ensureDataset(ORDERS);
		const journal = createMemoryMigrationJournal();
		const refused = await refusal(() =>
			runSnapshotAndTail({
				runtime: runtime(journal),
				source,
				target,
				schema: ORDERS,
				scope: scopeOf("orders"),
				flipAuthority: () => {},
				realization: "native",
				profile: REFERENCE_NATIVE_PROFILE,
			}),
		);
		assert.equal(refused.code, "PORT_MISSING");
		assert.equal(refused.detail.port, "retire");
		assert.deepEqual(await journal.load("m1"), []);
	});

	test("a profile named for a hub realization is a contradiction, refused", async () => {
		const stage = await staged(1);
		const refused = await refusal(() =>
			runSnapshotAndTail(native(stage, { realization: "hub" })),
		);
		assert.equal(refused.code, "INVALID_MIGRATION_PLAN");
		assert.deepEqual(await stage.journal.load("m1"), []);
	});

	test("a run planned native cannot be resumed through the hub, nor the other way round", async () => {
		const link = createReferenceNativeLink();
		const source = createReferenceEngine({ native: link });
		const target = createReferenceEngine({ native: link });
		await source.datasets.ensureDataset(ORDERS);
		await source.records.write({
			dataset: "orders",
			mutations: [order("o-1", "1")],
		});
		const journal = createMemoryMigrationJournal();
		const options = (
			realization: "native" | "hub",
			pauseAfter?: MigrationPhase,
		): CopyMigrationOptions => ({
			runtime: runtime(journal, pauseAfter === undefined ? {} : { pauseAfter }),
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
			realization,
			...(realization === "native"
				? { profile: REFERENCE_NATIVE_PROFILE }
				: undefined),
		});
		const held = await runSnapshotAndTail(options("native", "seed"));
		assert.equal(held.status, "held");
		const facts = (await journal.load("m1")).length;
		const refused = await refusal(() => runSnapshotAndTail(options("hub")));
		assert.equal(refused.code, "INVALID_MIGRATION_PLAN");
		assert.match(refused.message, /planned with the native realization/u);
		assert.equal((await journal.load("m1")).length, facts, "nothing was added");
		// The hub's forward subscription was never started behind its back.
		assert.equal(
			await requirePort(target, "apply").watermark({
				dataset: "orders",
				source: "hobo_migration_m1_forward",
			}),
			undefined,
		);
		const done = await runSnapshotAndTail(options("native"));
		assert.equal(done.status, "completed", done.reason);

		// And the other way round, on a fresh pair and a fresh migration.
		const other = createMemoryMigrationJournal();
		const from = createReferenceEngine({ native: link });
		const to = createReferenceEngine({ native: link });
		await from.datasets.ensureDataset(ORDERS);
		const hub = (
			realization: "native" | "hub",
			pauseAfter?: MigrationPhase,
		) => ({
			...options(realization, pauseAfter),
			runtime: runtime(other, pauseAfter === undefined ? {} : { pauseAfter }),
			source: from,
			target: to,
		});
		assert.equal((await runSnapshotAndTail(hub("hub", "seed"))).status, "held");
		const upgraded = await refusal(() => runSnapshotAndTail(hub("native")));
		assert.equal(upgraded.code, "INVALID_MIGRATION_PLAN");
		assert.match(upgraded.message, /planned with the hub realization/u);
		assert.deepEqual(link.open(), [], "no transfer was opened for it");
	});

	test("a transfer the engine refuses fails the run with its code in the journal, and the hub is not tried", async () => {
		const stage = await staged(3);
		// A target that already holds records: a native copy cannot merge.
		await stage.target.datasets.ensureDataset(ORDERS);
		await stage.target.records.write({
			dataset: "orders",
			mutations: [order("already-here", "1")],
		});
		const refused = await refusal(() => runSnapshotAndTail(native(stage)));
		assert.equal(refused.code, "NATIVE_TRANSFER_REFUSED");
		assert.equal(refused.detail.reason, "TARGET_NOT_EMPTY");
		const facts = await stage.journal.load("m1");
		assert.equal(facts[0]?.data.realization, "native");
		const failed = facts[facts.length - 1];
		assert.equal(failed?.type, MIGRATION_EVENTS.Failed);
		assert.equal(failed?.data.reason, "DataCoreError: NATIVE_TRANSFER_REFUSED");
		assert.equal(await count(stage.target), 1, "nothing was copied");
		assert.equal(await count(stage.source), 3);
		// Abandoning the migration: the half-opened transfer is stopped by name.
		assert.deepEqual(stage.link.open(), [nativeTransferName("m1")]);
		const ref = {
			profile: REFERENCE_NATIVE_PROFILE,
			transfer: nativeTransferName("m1"),
			scope: scopeOf("orders"),
		};
		await stage.target.nativeTransfer?.stop(ref);
		await stage.source.nativeTransfer?.stop(ref);
		assert.deepEqual(stage.link.open(), []);
	});

	test("the port refuses what it cannot do faithfully: a renamed scope, itself as a source, an unknown profile", async () => {
		const stage = await staged(1);
		const sourcePort = stage.source.nativeTransfer;
		const targetPort = stage.target.nativeTransfer;
		assert.ok(sourcePort && targetPort);
		await stage.target.datasets.ensureDataset(ORDERS);
		const ref = {
			profile: REFERENCE_NATIVE_PROFILE,
			transfer: "t1",
			scope: scopeOf("orders"),
		};
		const ticket = await sourcePort.publish(ref);
		assert.deepEqual(await sourcePort.publish(ref), ticket, "idempotent");
		assert.ok(!JSON.stringify(ticket).includes("o-0"), "no record in a ticket");
		const reasonOf = async <T>(action: () => Promise<T>) =>
			(await refusal(action)).detail.reason;
		assert.equal(
			await reasonOf(async () =>
				targetPort.subscribe({
					...ref,
					scope: scopeOf("orders", "tenant-a"),
					ticket,
				}),
			),
			"SCOPE_MISMATCH",
		);
		assert.equal(
			await reasonOf(async () => sourcePort.subscribe({ ...ref, ticket })),
			"SAME_STORE",
		);
		assert.equal(
			await reasonOf(async () =>
				sourcePort.publish({ ...ref, profile: "migration.reference.x/v1" }),
			),
			"PROFILE_UNKNOWN",
		);
		const unlinked = createReferenceEngine({
			native: createReferenceNativeLink(),
		});
		await unlinked.datasets.ensureDataset(ORDERS);
		assert.equal(
			await reasonOf(async () =>
				unlinked.nativeTransfer?.subscribe({ ...ref, ticket }),
			),
			"SOURCE_UNREACHABLE",
		);
		// A transfer that was never opened, or was stopped, is lost — loudly.
		const lostCodes = [
			await refusal(async () => targetPort.seeded(ref)),
			await refusal(async () => sourcePort.mark({ ...ref, transfer: "never" })),
			await refusal(async () =>
				sourcePort.reached({ ...ref, transfer: "never", mark: "1" }),
			),
		].map((refused) => refused.code);
		assert.deepEqual(lostCodes, [
			"NATIVE_TRANSFER_LOST",
			"NATIVE_TRANSFER_LOST",
			"NATIVE_TRANSFER_LOST",
		]);
		await sourcePort.stop(ref);
		await sourcePort.stop(ref);
		assert.deepEqual(stage.link.open(), []);
	});
});

describe("native realization — offline-copy", () => {
	test("under the fence the engine copies, the executor verifies and flips", async () => {
		const stage = await staged(9);
		const result = await runOfflineCopy(native(stage));
		assert.equal(result.status, "completed", result.reason);
		assert.equal(result.state.realization, "native");
		assert.equal(await count(stage.target), 9);
		assert.equal(await count(stage.source), 0);
		assert.deepEqual(stage.link.open(), []);
	});

	test("a copy that does not finish inside the fence window releases the fence and is continued, not restarted", async () => {
		const stage = await staged(9);
		stage.link.stall(true);
		const held = await runOfflineCopy(native(stage));
		assert.equal(held.status, "held");
		assert.equal(held.phase, "prepare");
		assert.match(held.reason ?? "", /did not finish inside the fence window/u);
		const fence = requirePort(stage.source, "fence");
		assert.equal((await fence.status(scopeOf("orders"))).fenced, false);
		await stage.source.records.write({
			dataset: "orders",
			mutations: [order("between-attempts", "1")],
		});
		// The transfer was left in place for the next attempt.
		assert.deepEqual(stage.link.open(), [nativeTransferName("m1")]);
		stage.link.stall(false);
		const done = await runOfflineCopy(native(stage));
		assert.equal(done.status, "completed", done.reason);
		assert.equal(await count(stage.target), 10);
		assert.deepEqual(stage.link.open(), []);
	});
});

describe("the journal carries no fence token", () => {
	const raw = async (source: EngineBinding): Promise<string> =>
		(
			await requirePort(source, "fence").raise({
				scope: scopeOf("orders"),
				reason: "read the token back",
			})
		).fenceToken;

	async function hubPair(): Promise<Staged> {
		const source = createReferenceEngine({ engine: "source" });
		const target = createReferenceEngine({ engine: "target" });
		await source.datasets.ensureDataset(ORDERS);
		await source.records.write({
			dataset: "orders",
			mutations: [order("o-1", "1"), order("o-2", "2")],
		});
		return {
			link: createReferenceNativeLink(),
			source,
			target,
			journal: createMemoryMigrationJournal(),
		};
	}

	const hub = (
		stage: Staged,
		extra: Partial<CopyMigrationOptions> = {},
	): CopyMigrationOptions => ({
		runtime: runtime(stage.journal),
		source: stage.source,
		target: stage.target,
		schema: ORDERS,
		scope: scopeOf("orders"),
		flipAuthority: () => {},
		...extra,
	});

	test("the cutover journals a digest of the token, and every later phase works from it", async () => {
		for (const run of [runSnapshotAndTail, runOfflineCopy]) {
			for (const make of [hubPair, () => staged(2)]) {
				const stage = await make();
				const options = (extra: Partial<CopyMigrationOptions>) =>
					stage.source.nativeTransfer === undefined
						? hub(stage, extra)
						: native(stage, extra);
				const seen: string[] = [];
				const held = await run(
					options({
						soakDecision: () => "hold",
						flipAuthority: (flip) => {
							seen.push(flip.fenceToken);
						},
					}),
				);
				assert.equal(held.status, "held", held.reason);
				const token = await raw(stage.source);
				assert.deepEqual(seen, [token], "the flip is handed the real token");
				const journaled = JSON.stringify(await stage.journal.load("m1"));
				assert.ok(!journaled.includes(token), "no fact carries the token");
				assert.ok(journaled.includes(fenceTokenDigest(token)));
				const cutOver = held.facts.find(
					(fact) => fact.type === MIGRATION_EVENTS.CutOver,
				);
				assert.equal(cutOver?.data.fenceToken, undefined);
				assert.equal(cutOver?.data.fenceTokenDigest, fenceTokenDigest(token));
				// Soak and finalize find the fence again from the digest.
				const done = await run(options({}));
				assert.equal(done.status, "completed", done.reason);
				assert.ok(
					!JSON.stringify(await stage.journal.load("m1")).includes(token),
				);
				assert.equal(await count(stage.source), 0);
			}
		}
	});

	test("a fence swapped behind the migration is noticed: the run holds instead of retiring the source", async () => {
		const stage = await hubPair();
		const held = await runSnapshotAndTail(
			hub(stage, { soakDecision: () => "hold" }),
		);
		assert.equal(held.status, "held");
		const scope = scopeOf("orders");
		const fence = requirePort(stage.source, "fence");
		// Someone lifts the fence, the old authority takes a write, and a
		// different fence goes up.
		await fence.release({ scope, fenceToken: await raw(stage.source) });
		await stage.source.records.write({
			dataset: "orders",
			mutations: [order("split-brain", "1")],
		});
		await fence.raise({ scope, reason: "someone else" });
		const stopped = await runSnapshotAndTail(hub(stage));
		assert.equal(stopped.status, "held");
		assert.match(
			stopped.reason ?? "",
			/not the one the cutover was decided under/u,
		);
		assert.equal(await count(stage.source), 3, "nothing was retired");
	});

	test("a journal written before tokens were kept out of it still resumes", async () => {
		const stage = await hubPair();
		const held = await runSnapshotAndTail(
			hub(stage, { soakDecision: () => "hold" }),
		);
		assert.equal(held.status, "held");
		const token = await raw(stage.source);
		// Rewrite the journal into the form it used to have.
		const legacy = createMemoryMigrationJournal();
		for (const [index, fact] of (await stage.journal.load("m1")).entries()) {
			const { fenceTokenDigest: digest, ...rest } = fact.data;
			const carried =
				fact.type === MIGRATION_EVENTS.CutOver ||
				(fact.type === MIGRATION_EVENTS.PhaseApplied &&
					fact.data.phase === "fence-and-flip");
			let data = fact.data;
			if (fact.type === MIGRATION_EVENTS.CutOver) {
				data = digest === undefined ? rest : { ...rest, fenceToken: token };
			} else if (carried) {
				data = {
					...fact.data,
					checkpoint: {
						...Object(fact.data.checkpoint),
						fenceToken: token,
						fenceTokenDigest: "sha256:ignored-when-the-token-is-there",
					},
				};
			}
			await legacy.append("m1", { type: fact.type, data }, index);
		}
		const done = await runSnapshotAndTail(hub({ ...stage, journal: legacy }));
		assert.equal(done.status, "completed", done.reason);
	});
});

describe("retirement cannot reach the new authority", () => {
	test("the forward channel is dropped before the source is emptied, and is never read after the cutover", async () => {
		const real = createReferenceEngine({ engine: "source" });
		const target = createReferenceEngine({ engine: "target" });
		await real.datasets.ensureDataset(ORDERS);
		await real.records.write({
			dataset: "orders",
			mutations: [order("o-1", "1"), order("o-2", "2"), order("o-3", "3")],
		});
		const capture = requirePort(real, "capture");
		const retire = requirePort(real, "retire");
		const calls: string[] = [];
		let cutOver = false;
		const source: EngineBinding = {
			...real,
			capture: {
				start: (request) => capture.start(request),
				read: (request) => {
					if (cutOver) calls.push(`read ${request.subscription}`);
					return capture.read(request);
				},
				acknowledge: (request) => capture.acknowledge(request),
				stop: (subscription) => {
					calls.push(`stop ${subscription}`);
					return capture.stop(subscription);
				},
			},
			retire: {
				retire: (request) => {
					calls.push("retire");
					return retire.retire(request);
				},
			},
		};
		const result = await runSnapshotAndTail({
			runtime: runtime(createMemoryMigrationJournal(), {
				onFact: (fact) => {
					if (fact.type === MIGRATION_EVENTS.CutOver) cutOver = true;
				},
			}),
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
		});
		assert.equal(result.status, "completed", result.reason);
		// After the cutover the forward subscription is stopped, then the
		// source retired. It is never read in between or afterwards, so an
		// engine that logs the retirement as deletes has nobody to hand them to.
		assert.deepEqual(calls, ["stop hobo_migration_m1_forward", "retire"]);
		assert.equal(await count(target), 3, "the target keeps every record");
		assert.equal(await count(real), 0);
		// And a write the new authority takes afterwards is not disturbed.
		await target.records.write({
			dataset: "orders",
			mutations: [order("o-4", "4")],
		});
		assert.equal(await count(target), 4);
		assert.equal(await sameDigest(real, target), false);
	});

	test("a rollback stops the forward subscription too, so a durable source's log is not pinned for ever", async () => {
		const real = createReferenceEngine({ engine: "source" });
		// No capture on the target: no reverse tail, a to-snapshot rollback.
		const target = createReferenceEngine({
			engine: "target",
			omit: ["capture"],
		});
		await real.datasets.ensureDataset(ORDERS);
		await real.records.write({
			dataset: "orders",
			mutations: [order("o-1", "1")],
		});
		const capture = requirePort(real, "capture");
		const stopped: string[] = [];
		const source: EngineBinding = {
			...real,
			capture: {
				start: (request) => capture.start(request),
				read: (request) => capture.read(request),
				acknowledge: (request) => capture.acknowledge(request),
				stop: (subscription) => {
					stopped.push(subscription);
					return capture.stop(subscription);
				},
			},
		};
		const journal = createMemoryMigrationJournal();
		const options = (decision: "hold" | "rollback"): CopyMigrationOptions => ({
			runtime: runtime(journal),
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
			soakDecision: () => decision,
			// A to-snapshot rollback needs the ledger; here nothing was erased.
			erasures: { since: () => [] },
		});
		assert.equal((await runSnapshotAndTail(options("hold"))).status, "held");
		assert.deepEqual(stopped, []);
		const rolled = await runSnapshotAndTail(options("rollback"));
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(stopped, ["hobo_migration_m1_forward"]);
		// The source writes again.
		await source.records.write({
			dataset: "orders",
			mutations: [order("o-2", "2")],
		});
		assert.equal(await count(real), 2);
	});
});
