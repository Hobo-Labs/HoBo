// `migration.postgres.logical-copy/v1`, live: a dataset moved between two real
// databases by PostgreSQL's own logical replication, with the executor in
// `@hobo/data-core` keeping every phase, the digests, the fence and the flip.
//
// Gated like the other live lanes on HOBO_TEST_POSTGRES_URL. The two databases
// live in one cluster here, which is the awkward case: a subscription that
// creates its own slot hangs there, so this lane is also the proof that the
// port creates the slot separately.
//
// Everything a test creates — the second database, namespaces, slots,
// publications, subscriptions — is its own and is dropped; the leak check
// counts only this file's objects, and one of them is a failure.
import assert from "node:assert/strict";
import {
	type Awaitable,
	admitAuthorityMove,
	type CopyMigrationOptions,
	CUSTODY_ROLES,
	canonicalEncode,
	compareDigests,
	createMemoryMigrationJournal,
	DataCoreError,
	type DatasetSchema,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	FencedWriteError,
	type MigrationJournal,
	type MigrationPhase,
	type MigrationRunResult,
	type MigrationRuntime,
	nativeTransferName,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	type RecordMutation,
	requirePort,
	runSnapshotAndTail,
	scopeOf,
	selectMigrationPattern,
	upsertMutation,
} from "@hobo/data-core";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import {
	createPgExecutor,
	createPostgresEngine,
	FENCED_WRITE_SQLSTATE,
	LOGICAL_COPY_PROFILE,
	NATIVE_LOGGING_STATE,
	nativeLoggingIsQuiet,
	nativeSubscriptionName,
	PostgresDataError,
	type PostgresEngine,
	type PostgresExecutor,
	type PostgresParameter,
	PRESENT_NATIVE_SOURCE,
	QUIET_NATIVE_LOGGING,
	quoteIdentifier,
	sqlStateOf,
} from "../src/index.js";
import {
	type CompanionDatabase,
	createCompanionDatabase,
	EVERY_TYPE_RECORD,
	EVERY_TYPE_SCHEMA,
	freshNamespace,
	LIVE_URL,
	leftoverCaptureObjects,
	livePool,
	liveUrlFor,
	NOW,
} from "./engine-support.js";

const ITEMS: DatasetSchema = parseDatasetSchema({
	name: "hobo_native_items",
	version: 1,
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "qty", type: "int64", nullable: false },
		{ name: "note", type: "string", nullable: true },
	],
});

function item(id: string, qty: number, note: string | null = null) {
	const record = parseCanonicalRecord(ITEMS, { id, qty, note });
	return upsertMutation("", encodeRecordKey(ITEMS, record), record);
}

const ALLOW = evaluateCustodyPath({
	path: parseCustodyPath({
		// One point per role: the selector refuses a pattern that creates a
		// copy the path does not name (a native transfer retains a change log
		// and keeps the retiring source through the soak window).
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

/**
 * A marker that makes the connection string recognisable wherever it might
 * turn up. It rides in a libpq parameter the server ignores for replication.
 */
const SECRET_MARKER = "hobo-secret-marker-7f3a";

function secretConnection(): string {
	const url = new URL(LIVE_URL ?? "");
	url.searchParams.set("application_name", SECRET_MARKER);
	return url.toString();
}

interface Seen {
	readonly sql: string;
	readonly parameters: readonly PostgresParameter[];
}

/** An executor that records every statement and parameter it is handed. */
function watched(executor: PostgresExecutor, seen: Seen[]): PostgresExecutor {
	const wrap = (inner: PostgresExecutor): PostgresExecutor => ({
		query(sql, parameters = []) {
			seen.push({ sql, parameters });
			return inner.query(sql, parameters);
		},
		transaction: (body) => inner.transaction((tx) => body(wrap(tx))),
	});
	return wrap(executor);
}

function requireNative(binding: PostgresEngine) {
	const port = binding.nativeTransfer;
	assert.ok(port, "the binding provides the native-transfer port");
	return port;
}

async function rejection<T>(action: () => Awaitable<T>): Promise<Error> {
	try {
		await action();
	} catch (cause) {
		if (cause instanceof Error) return cause;
		throw cause;
	}
	throw new Error("expected the action to be refused, but it succeeded");
}

describe.skipIf(!LIVE_URL)("PostgreSQL logical-copy — live", () => {
	let pool: pg.Pool;
	let companion: CompanionDatabase;
	const opened: PostgresEngine[] = [];
	/** The routers' durable state: the highest journal head applied, per migration. */
	const applied = new Map<string, number>();

	interface Staged {
		readonly namespace: string;
		readonly source: PostgresEngine;
		readonly target: PostgresEngine;
		readonly journal: MigrationJournal;
		/** Everything the target's executor was handed. */
		readonly seen: Seen[];
	}

	/** One namespace name in both databases; the target knows the way back. */
	const stage = (
		options: {
			readonly connection?: (() => string) | null;
			readonly targetNamespace?: string;
		} = {},
	): Staged => {
		const namespace = freshNamespace();
		const seen: Seen[] = [];
		const source = createPostgresEngine({
			executor: createPgExecutor(pool),
			namespace,
			ephemeral: true,
			clock: () => NOW,
		});
		const target = createPostgresEngine({
			executor: watched(createPgExecutor(companion.pool), seen),
			namespace: options.targetNamespace ?? namespace,
			ephemeral: true,
			clock: () => NOW,
			nativePollIntervalMs: 20,
			...(options.connection === null
				? undefined
				: { nativeSourceConnection: options.connection ?? secretConnection }),
		});
		// The target is closed first: its subscription reads from the source.
		opened.push(target, source);
		return {
			namespace,
			source,
			target,
			journal: createMemoryMigrationJournal(),
			seen,
		};
	};

	const runtime = (
		staged: Staged,
		id: string,
		extra: Partial<MigrationRuntime> = {},
	): MigrationRuntime => ({
		migrationId: id,
		journal: staged.journal,
		clock: () => NOW,
		policy: () => ALLOW,
		...extra,
	});

	const native = (
		staged: Staged,
		id: string,
		schema: DatasetSchema,
		extra: Partial<CopyMigrationOptions> = {},
		run: Partial<MigrationRuntime> = {},
	): CopyMigrationOptions => ({
		runtime: runtime(staged, id, run),
		source: staged.source,
		target: staged.target,
		schema,
		scope: scopeOf(schema.name),
		buckets: 16,
		flipAuthority: () => {},
		realization: "native",
		profile: LOGICAL_COPY_PROFILE,
		...extra,
	});

	const digestOf = (binding: EngineBinding, dataset: string) =>
		requirePort(binding, "verify").digest({
			scope: scopeOf(dataset),
			buckets: 16,
		});

	/** This file's slots, publications and subscriptions, in both databases. */
	const leftovers = () => leftoverCaptureObjects(pool, companion.pool);

	beforeAll(async () => {
		pool = livePool(8);
		companion = await createCompanionDatabase(pool);
	});

	// Every test closes what it staged, whether it passed or not. Each test
	// below asserts that nothing of this file is left on the server; with the
	// bindings of a failed test still open, its slot, publication and
	// subscription would fail every test after it for a reason that is not
	// theirs. Each binding is tried even when an earlier close throws.
	afterEach(async () => {
		const failed: Error[] = [];
		for (const binding of opened.splice(0)) {
			try {
				await binding.close();
			} catch (cause) {
				failed.push(cause instanceof Error ? cause : new Error(String(cause)));
			}
		}
		const first = failed[0];
		if (first !== undefined) throw first;
	});

	afterAll(async () => {
		const left = await leftovers();
		await companion.drop(pool);
		await pool.end();
		assert.deepEqual(left, [], "nothing of this suite may outlive the run");
	});

	test("the selector offers logical-copy between two PostgreSQL stores, and it is the profile the binding runs", () => {
		const staged = stage();
		const decision = selectMigrationPattern({
			authority: "authoritative",
			change: "placement",
			source: staged.source.declaration,
			target: staged.target.declaration,
			schema: ITEMS,
			constraints: { maxWriteFreezeMs: 5_000, requiredRollback: "to-snapshot" },
			estimates: { flipMs: 500, copyMs: 60_000 },
			verdict: ALLOW,
			evidence: [{ engine: "postgres", outcome: "pass", checkedAt: NOW }],
			now: NOW,
			evidenceMaxAgeMs: 86_400_000,
		});
		const candidate = decision.candidates.find(
			(entry) =>
				entry.pattern === "snapshot-and-tail" && entry.realization === "native",
		);
		assert.equal(candidate?.eligible, true);
		assert.equal(candidate?.profile, LOGICAL_COPY_PROFILE);
		assert.equal(candidate?.rollbackInSoak, "to-snapshot");
		assert.deepEqual(staged.source.nativeTransfer?.profiles, [
			LOGICAL_COPY_PROFILE,
		]);
		// pg_dump is not declared: nothing in the binding could run it.
		assert.ok(
			decision.candidates.every(
				(entry) =>
					entry.pattern !== "offline-copy" || entry.realization === "hub",
			),
		);
	});

	test("a dataset moves between two databases under concurrent writers: digest-equal, fenced, flipped once, nothing left behind", async () => {
		const staged = stage();
		const { source, target } = staged;
		await source.datasets.ensureDataset(ITEMS);
		await source.records.write({
			dataset: ITEMS.name,
			mutations: Array.from({ length: 3_000 }, (_, index) =>
				item(`seed-${index}`, index, index % 7 === 0 ? null : `n${index}`),
			),
		});

		// Writers on their own pool sessions: updates, inserts and deletes,
		// each a transaction of its own, until told to stop or refused.
		const acknowledged: string[] = [];
		const problems: string[] = [];
		let quiet = false;
		let racingWriteLanded: (() => void) | undefined;
		const writer = async (name: string): Promise<void> => {
			for (let round = 0; round < 2_000 && !quiet; round += 1) {
				const mutations: RecordMutation[] = [
					item(`${name}-${round}`, round, name),
					item(`seed-${(round * 13) % 3_000}`, -round, `touched by ${name}`),
				];
				if (round % 5 === 4) {
					mutations.push({
						tenant: "",
						key: canonicalEncode([`${name}-${round - 3}`]),
						op: "delete",
					});
				}
				try {
					await source.records.write({ dataset: ITEMS.name, mutations });
					acknowledged.push(`${name}-${round}`);
					if (name.startsWith("r")) racingWriteLanded?.();
				} catch (cause) {
					if (cause instanceof FencedWriteError) return;
					problems.push(`${name}-${round}: ${String(cause)}`);
					return;
				}
			}
		};
		let writers: Promise<void>[] = [];
		const start = (names: readonly string[]): void => {
			quiet = false;
			writers = names.map(writer);
		};
		const settle = async (): Promise<void> => {
			quiet = true;
			await Promise.all(writers);
			writers = [];
		};

		const flips: string[] = [];
		const phases: MigrationPhase[] = [];
		const options = (run: Partial<MigrationRuntime>) =>
			native(
				staged,
				"under-load",
				ITEMS,
				{
					flipAuthority: (flip) => {
						// The router's half of the contract: refuse a stale head.
						admitAuthorityMove(applied, flip);
						flips.push(flip.direction);
					},
				},
				run,
			);
		let held: MigrationRunResult;
		const began = performance.now();
		try {
			held = await runSnapshotAndTail(
				options({
					pauseAfter: "fence-and-flip",
					policy: (phase) => {
						phases.push(phase);
						return ALLOW;
					},
					afterPhase: async (phase) => {
						// Eight writers while the server copies and tails; quiet
						// while the two sides are compared unfenced; then six
						// writers racing the fence itself.
						if (phase === "gate") {
							start(["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
						}
						if (phase === "converge") await settle();
						if (phase === "shift-reads") {
							const landed = new Promise<void>((resolve) => {
								racingWriteLanded = resolve;
							});
							start(["r0", "r1", "r2", "r3", "r4", "r5"]);
							// The fence must meet writes already in flight. Started and
							// left alone, a loaded machine can fence before the first
							// one commits, and nothing races the fence at all; so hold
							// the fence until one has landed (or every writer stopped,
							// which the assertions below then report).
							await Promise.race([landed, Promise.all(writers)]);
						}
					},
				}),
			);
		} finally {
			await settle();
		}
		const elapsed = Math.round(performance.now() - began);
		assert.deepEqual(problems, []);
		assert.equal(held.status, "held", held.reason);
		assert.equal(held.state.heldAt, "soak");
		assert.equal(held.state.realization, "native");
		assert.equal(held.state.profile, LOGICAL_COPY_PROFILE);
		assert.equal(held.rollback, "to-snapshot");
		assert.deepEqual(flips, ["to-target"]);
		assert.deepEqual(phases, [
			"gate",
			"prepare",
			"seed",
			"converge",
			"verify",
			"shift-reads",
			"fence-and-flip",
		]);
		assert.ok(
			acknowledged.length > 100,
			`the writers landed ${acknowledged.length} transactions`,
		);
		assert.ok(
			acknowledged.some((id) => id.startsWith("r")),
			"some writers landed while racing the fence",
		);

		// Both sides are the same set of records, byte for byte.
		const a = await digestOf(source, ITEMS.name);
		const b = await digestOf(target, ITEMS.name);
		assert.deepEqual(compareDigests(a, b).mismatchedBuckets, []);
		assert.equal(a.digest, b.digest);
		assert.ok(a.count >= 3_000);
		console.info(
			`live logical-copy: ${a.count} records digest-equal after ${acknowledged.length} concurrent transactions (${acknowledged.filter((id) => id.startsWith("r")).length} landed while racing the fence), plan to cutover in ${elapsed} ms`,
		);
		// Every write the source acknowledged is on the target (unless that
		// same writer deleted it again three rounds later).
		for (const id of acknowledged.slice(-60)) {
			const [name, round] = id.split("-");
			const deleted = acknowledged.includes(`${name}-${Number(round) + 3}`)
				? (Number(round) + 3) % 5 === 4
				: false;
			const record = await target.records.read({
				dataset: ITEMS.name,
				tenant: "",
				key: canonicalEncode([id]),
			});
			assert.equal(record === undefined, deleted, id);
		}

		// The fence is the store's: a session that bypasses the binding is
		// refused too, and so is the binding.
		const direct = await rejection(() =>
			pool.query(
				`INSERT INTO ${quoteIdentifier(staged.namespace)}.${quoteIdentifier(ITEMS.name)} (tenant_id, id, qty) VALUES ('', 'late', 1)`,
			),
		);
		assert.equal(sqlStateOf(direct), FENCED_WRITE_SQLSTATE);
		const viaBinding = await rejection(() =>
			source.records.write({
				dataset: ITEMS.name,
				mutations: [item("late", 1)],
			}),
		);
		assert.ok(viaBinding instanceof FencedWriteError);

		// The transfer was closed at the cutover — by the executor, with both
		// bindings still open: no slot, no publication, no subscription.
		assert.deepEqual(await leftovers(), []);

		// The connection string went to the server as one bind parameter of
		// one statement, and appears nowhere else: not in any statement text,
		// not in the journal, not in the ticket.
		const carrying = staged.seen.filter((entry) =>
			JSON.stringify(entry).includes(SECRET_MARKER),
		);
		assert.deepEqual(
			carrying.map((entry) => entry.sql),
			[PRESENT_NATIVE_SOURCE],
		);
		assert.ok(
			staged.seen.every((entry) => !entry.sql.includes(SECRET_MARKER)),
			"no statement text carries the connection string",
		);
		const journaled = JSON.stringify(await staged.journal.load("under-load"));
		assert.ok(!journaled.includes(SECRET_MARKER));
		assert.doesNotMatch(journaled, /postgres(ql)?:\/\//u);
		const fence = await requirePort(source, "fence").raise({
			scope: scopeOf(ITEMS.name),
			reason: "read the token back",
		});
		assert.ok(!journaled.includes(fence.fenceToken), "no fence token either");
		assert.deepEqual(
			Object.keys(Object(held.state.checkpoints.prepare?.ticket)).sort(),
			[
				"dataset",
				"namespace",
				"origin",
				"profile",
				"publication",
				"slot",
				"tenant",
			],
		);

		// The new authority takes writes; finishing retires the source and
		// does not reach the target.
		await target.records.write({
			dataset: ITEMS.name,
			mutations: [item("written-after-the-flip", 1)],
		});
		const done = await runSnapshotAndTail(options({}));
		assert.equal(done.status, "completed", done.reason);
		assert.deepEqual(flips, ["to-target"]);
		assert.equal((await digestOf(source, ITEMS.name)).count, 0);
		assert.equal((await digestOf(target, ITEMS.name)).count, a.count + 1);
		assert.deepEqual(await leftovers(), []);
	}, 180_000);

	test("every canonical type crosses natively, digest-equal with the canonical digest of what was written", async () => {
		const staged = stage();
		const schema = EVERY_TYPE_SCHEMA;
		await staged.source.datasets.ensureDataset(schema);
		const edges = [
			{},
			{ id: "int-min", qty: "-9223372036854775808" },
			{ id: "float-tiny", weight: 5e-324 },
			{
				id: "decimal",
				price: "-1234567890123456789012345678901234567890.123456789",
			},
			{ id: "ts-year-1", placed_at: "0001-01-01T00:00:00Z" },
			{ id: "ts-micro", placed_at: "9999-12-31T23:59:59.999999Z" },
			{ id: "nulls", note: null, card: null },
			{ id: "astral", note: "𝒳 \u{10FFFF} tab\there" },
		];
		await staged.source.records.write({
			dataset: schema.name,
			mutations: edges.map((edge) => {
				const record = parseCanonicalRecord(schema, {
					...EVERY_TYPE_RECORD,
					...edge,
				});
				return upsertMutation("", encodeRecordKey(schema, record), record);
			}),
		});
		const before = await digestOf(staged.source, schema.name);
		const result = await runSnapshotAndTail(native(staged, "types", schema));
		assert.equal(result.status, "completed", result.reason);
		const after = await digestOf(staged.target, schema.name);
		assert.equal(after.count, edges.length);
		assert.equal(after.digest, before.digest);
		assert.deepEqual(await leftovers(), []);
	}, 120_000);

	test("a run left to a new pair of bindings resumes: the transfer is found again by name", async () => {
		const staged = stage();
		await staged.source.datasets.ensureDataset(ITEMS);
		await staged.source.records.write({
			dataset: ITEMS.name,
			mutations: Array.from({ length: 200 }, (_, index) =>
				item(`a-${index}`, index),
			),
		});
		const first = await runSnapshotAndTail(
			native(staged, "resume", ITEMS, {}, { pauseAfter: "seed" }),
		);
		assert.equal(first.status, "held");
		// The transfer is live while the run is held: one slot, one
		// publication on the source, one subscription on the target.
		assert.equal((await leftovers()).length, 3);
		await staged.source.records.write({
			dataset: ITEMS.name,
			mutations: [item("while-held", 1)],
		});
		// A different process would hold different binding objects. These two
		// are durable, so closing them drops nothing.
		const source = createPostgresEngine({
			executor: createPgExecutor(pool),
			namespace: staged.namespace,
		});
		const target = createPostgresEngine({
			executor: createPgExecutor(companion.pool),
			namespace: staged.namespace,
			nativeSourceConnection: secretConnection,
		});
		const done = await runSnapshotAndTail(
			native({ ...staged, source, target }, "resume", ITEMS),
		);
		assert.equal(done.status, "completed", done.reason);
		assert.equal((await digestOf(target, ITEMS.name)).count, 201);
		assert.equal((await digestOf(source, ITEMS.name)).count, 0);
		await source.close();
		await target.close();
		assert.deepEqual(await leftovers(), []);
	}, 120_000);

	test("a rollback from soak restores the source and drops the transfer; an abandoned run is stopped by name", async () => {
		const staged = stage();
		await staged.source.datasets.ensureDataset(ITEMS);
		await staged.source.records.write({
			dataset: ITEMS.name,
			mutations: [item("a", 1), item("b", 2), item("c", 3)],
		});
		const held = await runSnapshotAndTail(
			native(staged, "rollback", ITEMS, { soakDecision: () => "hold" }),
		);
		assert.equal(held.status, "held");
		const directions: string[] = [];
		const rolled = await runSnapshotAndTail(
			native(staged, "rollback", ITEMS, {
				soakDecision: () => "rollback",
				erasures: {
					since: () => [
						{ tenant: "", key: canonicalEncode(["b"]), op: "delete" },
					],
				},
				flipAuthority: (flip) => {
					admitAuthorityMove(applied, flip);
					directions.push(flip.direction);
				},
			}),
		);
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(directions, ["to-source"]);
		assert.deepEqual(await leftovers(), []);
		// The source writes again, and nothing copies it anywhere.
		await staged.source.records.write({
			dataset: ITEMS.name,
			mutations: [item("after-rollback", 4)],
		});
		assert.equal((await digestOf(staged.source, ITEMS.name)).count, 3);
		assert.equal((await digestOf(staged.target, ITEMS.name)).count, 3);

		// A run that fails mid-way leaves its transfer in place — that is what
		// lets it be resumed. Abandoning it instead is one `stop` on each side.
		const abandoned = stage();
		await abandoned.source.datasets.ensureDataset(ITEMS);
		await abandoned.source.records.write({
			dataset: ITEMS.name,
			mutations: [item("a", 1)],
		});
		await assert.rejects(
			runSnapshotAndTail(
				native(
					abandoned,
					"abandoned",
					ITEMS,
					{},
					{
						afterPhase: (phase) => {
							if (phase === "seed")
								throw new Error("the operator's process died");
						},
					},
				),
			),
			/process died/u,
		);
		assert.equal((await leftovers()).length, 3);
		const ref = {
			profile: LOGICAL_COPY_PROFILE,
			transfer: nativeTransferName("abandoned"),
			scope: scopeOf(ITEMS.name),
		};
		await requirePort(abandoned.target, "verify").digest({
			scope: ref.scope,
			buckets: 4,
		});
		await abandoned.target.nativeTransfer?.stop(ref);
		await abandoned.source.nativeTransfer?.stop(ref);
		// Stopping twice, and stopping what never started, are both fine.
		await abandoned.source.nativeTransfer?.stop(ref);
		await abandoned.target.nativeTransfer?.stop({ ...ref, transfer: "never" });
		assert.deepEqual(await leftovers(), []);
	}, 120_000);

	test("a native run held by a negative verdict stops delivering: nothing written to the source reaches the target until the run resumes", async () => {
		const staged = stage();
		const { source, target } = staged;
		await source.datasets.ensureDataset(ITEMS);
		await source.records.write({
			dataset: ITEMS.name,
			mutations: [item("a", 1), item("b", 2), item("c", 3)],
		});
		const deny = {
			...ALLOW,
			ok: false,
			findings: [
				{
					code: "CUSTODY_RESIDENCY_CONFLICT" as const,
					point: "target",
					role: "target" as const,
					detail: "",
					remediation: "",
				},
			],
		};
		let verdict = deny;
		const policy = (phase: MigrationPhase) =>
			phase === "converge" || phase === "verify" ? verdict : ALLOW;
		const options = () => native(staged, "paused", ITEMS, {}, { policy });
		const held = await runSnapshotAndTail(options());
		assert.equal(held.status, "held");
		assert.match(
			held.reason ?? "",
			/policy verdict is negative before converge/u,
		);
		// The initial copy ran — the transfer works — and then the run held.
		assert.equal((await digestOf(target, ITEMS.name)).count, 3);

		const read = (id: string) =>
			target.records.read({
				dataset: ITEMS.name,
				tenant: "",
				key: canonicalEncode([id]),
			});
		const subscription = nativeSubscriptionName(
			staged.namespace,
			nativeTransferName("paused"),
		);
		const state = async () => {
			const found = await companion.pool.query(
				"SELECT s.subenabled AS enabled, (SELECT count(*)::int FROM pg_stat_subscription w WHERE w.subid = s.oid AND w.pid IS NOT NULL) AS workers FROM pg_subscription s WHERE s.subname = $1",
				[subscription],
			);
			return found.rows[0];
		};
		assert.deepEqual(await state(), { enabled: false, workers: 0 });

		// The source keeps taking writes while the migration is held.
		await source.records.write({
			dataset: ITEMS.name,
			mutations: [
				item("written-while-held", 9),
				{ tenant: "", key: canonicalEncode(["a"]), op: "delete" },
			],
		});
		// Far longer than logical replication takes to deliver two changes
		// between databases of one cluster. Nothing may arrive.
		for (let look = 0; look < 30; look += 1) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(
				await read("written-while-held"),
				undefined,
				"a record written to the source reached the target while the run was held",
			);
			assert.ok(
				(await read("a")) !== undefined,
				"a delete on the source was applied on the target while the run was held",
			);
		}
		assert.deepEqual(await state(), { enabled: false, workers: 0 });

		// A second held run changes nothing: still paused.
		assert.equal((await runSnapshotAndTail(options())).status, "held");
		assert.deepEqual(await state(), { enabled: false, workers: 0 });

		// The verdict clears; the run resumes the transfer and finishes.
		verdict = ALLOW;
		const done = await runSnapshotAndTail(options());
		assert.equal(done.status, "completed", done.reason);
		assert.ok((await read("written-while-held")) !== undefined);
		assert.equal(await read("a"), undefined);
		assert.equal((await digestOf(target, ITEMS.name)).count, 3);
		assert.equal((await digestOf(source, ITEMS.name)).count, 0);
		assert.deepEqual(await leftovers(), []);
	}, 120_000);

	test("the transaction that carries the connection string turns the server's statement logging off for itself first — and a role that cannot is refused before the string is sent", async () => {
		const database = quoteIdentifier(companion.name);
		const role = `hobo_trole_${companion.name.slice(-12)}`;
		// A server that would log the string: every statement, with its
		// parameters, for every new session of this database.
		await pool.query(`ALTER DATABASE ${database} SET log_statement = 'all'`);
		await pool.query(
			`ALTER DATABASE ${database} SET log_min_duration_statement = 0`,
		);
		const logging = new pg.Pool({
			connectionString: liveUrlFor(companion.name),
			max: 2,
		});
		logging.on("error", () => {});
		let unprivileged: pg.Pool | undefined;
		try {
			// 1. As a role that may change the settings (here a superuser).
			const settings = async (client: pg.PoolClient) =>
				(await client.query(NATIVE_LOGGING_STATE)).rows[0];
			const client = await logging.connect();
			try {
				await client.query("BEGIN");
				const before = await settings(client);
				assert.equal(before.log_statement, "all");
				assert.equal(before.log_min_duration_statement, "0");
				assert.equal(nativeLoggingIsQuiet(before), false);
				await client.query(QUIET_NATIVE_LOGGING);
				assert.deepEqual(await settings(client), {
					log_statement: "none",
					log_min_duration_statement: "-1",
					log_min_duration_sample: "-1",
					log_parameter_max_length: "0",
					log_parameter_max_length_on_error: "0",
				});
				await client.query("COMMIT");
				// Local to that transaction: the session logs again after it.
				assert.equal((await settings(client)).log_statement, "all");
			} finally {
				client.release();
			}

			// The real subscribe, on that logging database: silenced and read
			// back inside the transaction, immediately before the string.
			const staged = stage();
			const seen: Seen[] = [];
			const quietTarget = createPostgresEngine({
				executor: watched(createPgExecutor(logging), seen),
				namespace: staged.namespace,
				clock: () => NOW,
				nativeSourceConnection: secretConnection,
			});
			await staged.source.datasets.ensureDataset(ITEMS);
			await quietTarget.datasets.ensureDataset(ITEMS);
			const ref = {
				profile: LOGICAL_COPY_PROFILE,
				transfer: nativeTransferName("quiet"),
				scope: scopeOf(ITEMS.name),
			};
			const ticket = await requireNative(staged.source).publish(ref);
			await requireNative(quietTarget).subscribe({ ...ref, ticket });
			const order = seen.map((entry) => entry.sql);
			const sent = order.indexOf(PRESENT_NATIVE_SOURCE);
			assert.ok(sent >= 2);
			assert.deepEqual(order.slice(sent - 2, sent), [
				QUIET_NATIVE_LOGGING,
				NATIVE_LOGGING_STATE,
			]);
			await requireNative(quietTarget).stop(ref);
			await requireNative(staged.source).stop(ref);

			// 2. As a role that may not: it can lower nothing that matters, the
			// read-back says the server still logs, and the subscribe is refused
			// with the string never handed to the server.
			await pool.query(`CREATE ROLE ${quoteIdentifier(role)}`);
			await logging.query(
				`GRANT USAGE ON SCHEMA ${quoteIdentifier(staged.namespace)} TO ${quoteIdentifier(role)}`,
			);
			await logging.query(
				`GRANT SELECT ON ALL TABLES IN SCHEMA ${quoteIdentifier(staged.namespace)} TO ${quoteIdentifier(role)}`,
			);
			unprivileged = new pg.Pool({
				connectionString: liveUrlFor(companion.name),
				max: 2,
				options: `-c role=${role}`,
			});
			unprivileged.on("error", () => {});
			const whoami = await unprivileged.query(
				"SELECT current_user::text AS role, current_setting('is_superuser') AS superuser",
			);
			assert.deepEqual(whoami.rows[0], { role, superuser: "off" });
			const lone = await unprivileged.connect();
			try {
				await lone.query("BEGIN");
				await lone.query(QUIET_NATIVE_LOGGING);
				const after = await settings(lone);
				// The one setting any role may change did change; the rest did not.
				assert.equal(after.log_parameter_max_length_on_error, "0");
				assert.equal(after.log_statement, "all");
				assert.equal(after.log_parameter_max_length, "-1");
				assert.equal(nativeLoggingIsQuiet(after), false);
				await lone.query("ROLLBACK");
			} finally {
				lone.release();
			}
			const handed: Seen[] = [];
			const refusedTarget = createPostgresEngine({
				executor: watched(createPgExecutor(unprivileged), handed),
				namespace: staged.namespace,
				clock: () => NOW,
				nativeSourceConnection: secretConnection,
			});
			const again = { ...ref, transfer: nativeTransferName("loud") };
			const second = await requireNative(staged.source).publish(again);
			const refused = await rejection(() =>
				requireNative(refusedTarget).subscribe({ ...again, ticket: second }),
			);
			assert.ok(refused instanceof DataCoreError, String(refused));
			assert.equal(refused.code, "NATIVE_TRANSFER_REFUSED");
			assert.equal(refused.detail.reason, "CONNECTION_WOULD_BE_LOGGED");
			assert.ok(!JSON.stringify(handed).includes(SECRET_MARKER));
			assert.ok(handed.every((entry) => entry.sql !== PRESENT_NATIVE_SOURCE));
			await requireNative(staged.source).stop(again);
			assert.deepEqual(await leftovers(), []);
		} finally {
			await unprivileged?.end();
			await logging.end();
			await pool.query(`ALTER DATABASE ${database} RESET log_statement`);
			await pool.query(
				`ALTER DATABASE ${database} RESET log_min_duration_statement`,
			);
			await companion.pool.query(
				`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN EXECUTE 'DROP OWNED BY ${quoteIdentifier(role)}'; END IF; END $$`,
			);
			await pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
		}
	}, 120_000);

	test("an ephemeral close drops a live transfer, whichever side closes first", async () => {
		for (const order of ["target-first", "source-first"] as const) {
			const staged = stage();
			await staged.source.datasets.ensureDataset(ITEMS);
			await staged.source.records.write({
				dataset: ITEMS.name,
				mutations: [item("a", 1)],
			});
			const held = await runSnapshotAndTail(
				native(staged, `close-${order}`, ITEMS, {}, { pauseAfter: "converge" }),
			);
			assert.equal(held.status, "held");
			assert.equal((await leftovers()).length, 3);
			const sides =
				order === "target-first"
					? [staged.target, staged.source]
					: [staged.source, staged.target];
			for (const side of sides) await side.close();
			assert.deepEqual(await leftovers(), [], order);
		}
	}, 120_000);

	test("what logical-copy cannot do faithfully is refused by name, and leaves nothing behind", async () => {
		const reasonOf = async <T>(action: () => Promise<T>): Promise<string> => {
			const refused = await rejection(action);
			assert.ok(refused instanceof DataCoreError, String(refused));
			assert.equal(refused.code, "NATIVE_TRANSFER_REFUSED");
			return String(refused.detail.reason);
		};
		const prepared = async (staged: Staged): Promise<void> => {
			await staged.source.datasets.ensureDataset(ITEMS);
			await staged.source.records.write({
				dataset: ITEMS.name,
				mutations: [item("a", 1)],
			});
		};

		// One tenant of a pooled table: refused before anything is created.
		const tenant = stage();
		await prepared(tenant);
		assert.equal(
			await reasonOf(() =>
				runSnapshotAndTail(
					native(tenant, "tenant", ITEMS, {
						scope: scopeOf(ITEMS.name, "tenant-a"),
					}),
				),
			),
			"TENANT_SCOPE",
		);
		const failed = (await tenant.journal.load("tenant")).at(-1);
		assert.equal(failed?.data.reason, "DataCoreError: NATIVE_TRANSFER_REFUSED");
		assert.deepEqual(await leftovers(), []);

		// A target namespace of another name: the table would land elsewhere.
		const renamed = stage({ targetNamespace: freshNamespace() });
		await prepared(renamed);
		assert.equal(
			await reasonOf(() =>
				runSnapshotAndTail(native(renamed, "renamed", ITEMS)),
			),
			"NAMESPACE_MISMATCH",
		);

		// A target that already holds rows: a copy cannot merge.
		const occupied = stage();
		await prepared(occupied);
		await occupied.target.datasets.ensureDataset(ITEMS);
		await occupied.target.records.write({
			dataset: ITEMS.name,
			mutations: [item("already-here", 9)],
		});
		assert.equal(
			await reasonOf(() =>
				runSnapshotAndTail(native(occupied, "occupied", ITEMS)),
			),
			"TARGET_NOT_EMPTY",
		);
		assert.equal((await digestOf(occupied.target, ITEMS.name)).count, 1);

		// A target given no way to reach the source.
		const unreachable = stage({ connection: null });
		await prepared(unreachable);
		assert.equal(
			await reasonOf(() =>
				runSnapshotAndTail(native(unreachable, "unreachable", ITEMS)),
			),
			"SOURCE_CONNECTION_MISSING",
		);

		// The source database itself as the target.
		const self = stage();
		await prepared(self);
		const sameDatabase = createPostgresEngine({
			executor: createPgExecutor(pool),
			namespace: self.namespace,
			nativeSourceConnection: secretConnection,
		});
		const ref = {
			profile: LOGICAL_COPY_PROFILE,
			transfer: "same-database",
			scope: scopeOf(ITEMS.name),
		};
		const ticket = await self.source.nativeTransfer?.publish(ref);
		assert.ok(ticket);
		// Empty the table so the emptiness check is not what refuses it.
		await pool.query(
			`DELETE FROM ${quoteIdentifier(self.namespace)}.${quoteIdentifier(ITEMS.name)}`,
		);
		assert.equal(
			await reasonOf(async () =>
				sameDatabase.nativeTransfer?.subscribe({ ...ref, ticket }),
			),
			"SAME_DATABASE",
		);
		// A ticket whose names are not this package's is not put in a statement.
		assert.equal(
			await reasonOf(async () =>
				self.target.nativeTransfer?.subscribe({
					...ref,
					ticket: { ...ticket, slot: "x'; DROP TABLE users; --" },
				}),
			),
			"TICKET_INVALID",
		);

		// Each refused run left its source half published: stop them.
		for (const [staged, id] of [
			[renamed, "renamed"],
			[occupied, "occupied"],
			[unreachable, "unreachable"],
		] as const) {
			await staged.source.nativeTransfer?.stop({
				...ref,
				transfer: nativeTransferName(id),
			});
		}
		await self.source.nativeTransfer?.stop(ref);
		assert.deepEqual(await leftovers(), []);
	}, 120_000);

	test("a connection the server cannot use fails with a SQLSTATE and nothing of the connection string", async () => {
		const bad = [
			// Does not parse as a connection string.
			`not a conninfo ${SECRET_MARKER}`,
			// Parses, and nothing listens there.
			`postgres://user:${SECRET_MARKER}@127.0.0.1:1/nowhere`,
		];
		for (const [index, connection] of bad.entries()) {
			const staged = stage({ connection: () => connection });
			await staged.source.datasets.ensureDataset(ITEMS);
			const failure = await rejection(() =>
				runSnapshotAndTail(native(staged, `bad-${index}`, ITEMS)),
			);
			assert.ok(failure instanceof PostgresDataError, String(failure));
			assert.equal(failure.code, "NATIVE_SUBSCRIBE_FAILED");
			assert.match(String(failure.detail.sqlState), /^[0-9A-Z]{5}$/u);
			// Nothing of the secret: not in the message, not in a cause, not
			// anywhere in what the error serialises to, not in the journal.
			assert.equal(failure.cause, undefined);
			const shown = `${failure.stack ?? ""} ${JSON.stringify(failure.detail)} ${String(failure)}`;
			assert.ok(!shown.includes(SECRET_MARKER));
			assert.doesNotMatch(shown, /postgres(ql)?:\/\//u);
			const journaled = JSON.stringify(
				await staged.journal.load(`bad-${index}`),
			);
			assert.ok(!journaled.includes(SECRET_MARKER));
			assert.equal(
				(await staged.journal.load(`bad-${index}`)).at(-1)?.data.reason,
				"PostgresDataError",
			);
			await staged.source.nativeTransfer?.stop({
				profile: LOGICAL_COPY_PROFILE,
				transfer: nativeTransferName(`bad-${index}`),
				scope: scopeOf(ITEMS.name),
			});
		}
		assert.deepEqual(await leftovers(), []);
	}, 120_000);

	test("a resolver that throws is not echoed either", async () => {
		const staged = stage({
			connection: () => {
				throw new Error(`vault says: ${SECRET_MARKER}`);
			},
		});
		await staged.source.datasets.ensureDataset(ITEMS);
		const failure = await rejection(() =>
			runSnapshotAndTail(native(staged, "resolver", ITEMS)),
		);
		assert.ok(failure instanceof PostgresDataError);
		assert.equal(failure.code, "NATIVE_SUBSCRIBE_FAILED");
		assert.equal(failure.cause, undefined);
		assert.ok(!String(failure.stack).includes(SECRET_MARKER));
		await staged.source.nativeTransfer?.stop({
			profile: LOGICAL_COPY_PROFILE,
			transfer: nativeTransferName("resolver"),
			scope: scopeOf(ITEMS.name),
		});
		assert.deepEqual(await leftovers(), []);
	}, 60_000);
});
