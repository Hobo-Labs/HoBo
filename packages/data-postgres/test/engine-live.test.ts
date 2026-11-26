// The engine binding against a real PostgreSQL server. Gated: every test here
// is skipped unless HOBO_TEST_POSTGRES_URL names one (PostgreSQL 14 or later
// with wal_level = logical, and a role allowed to create schemas, publications
// and replication slots). CI's `Live data engines` job provides one.
//
// No simulation: datasets are real tables, the fence is a real trigger, and
// capture is real logical decoding. Every binding gets its own namespace and
// drops it — and its replication slots — on close.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	type Awaitable,
	assertBindingMatchesDeclaration,
	CapturePositionError,
	type ChangeEnvelope,
	canonicalEncode,
	compareDigests,
	createReferenceEngine,
	DataCoreError,
	DatasetDigestBuilder,
	type DatasetSchema,
	deleteMutation,
	ENGINE_CONFORMANCE_CASE_IDS,
	type EngineBinding,
	encodeRecordKey,
	FencedWriteError,
	type JsonObject,
	NATIVE_CONFORMANCE_CASE_IDS,
	parseCanonicalRecord,
	parseDatasetSchema,
	type RecordMutation,
	referenceEngineHarness,
	requirePort,
	runEngineConformance,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	createPostgresEngine,
	FENCED_WRITE_SQLSTATE,
	POSTGRES_SCHEMA_FIXTURE,
	PostgresDataError,
	type PostgresEngine,
	type PostgresExecutor,
	parseLsn,
	quoteIdentifier,
	sqlStateOf,
	TRUNCATE_REFUSED_SQLSTATE,
} from "../src/index.js";
import {
	type CompanionDatabase,
	conformanceFailureSink,
	createCompanionDatabase,
	EVERY_TYPE_RECORD,
	EVERY_TYPE_SCHEMA,
	failures,
	freshNamespace,
	LARGE_NOTE,
	LIVE_URL,
	type LiveHarness,
	leftoverCaptureObjects,
	livePool,
	NOW,
	postgresHarness,
	type RecordedPgOutput,
	recordPgOutputScenario,
	summarizePgOutput,
} from "./engine-support.js";

const FIXTURE_PATH = fileURLToPath(
	new URL("./fixtures/pgoutput-v1.recorded.json", import.meta.url),
);

/** Skipped by an engine whose declaration states no record bound; PostgreSQL states none. */
const SIZE_CASE_ID = "records.oversize-record-refuses-the-batch";

/** Skipped by an engine with no `schema` port. */
const SCHEMA_CASE_IDS = [
	"pattern.in-place-evolve.gated-and-restorable",
	"pattern.in-place-evolve.failure-restores",
	"schema.snapshots-are-per-binding",
	"schema.multi-statement-entry-is-whole-or-refused",
	"schema.verify-refuses-a-trailing-statement",
];

const SMALL_SCHEMA: DatasetSchema = parseDatasetSchema({
	name: "hobo_live_items",
	version: 1,
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "qty", type: "int64", nullable: false },
		{ name: "note", type: "string", nullable: true },
	],
});

function item(
	tenant: string,
	id: string,
	qty: number,
	note: string | null = null,
): RecordMutation {
	const record = parseCanonicalRecord(SMALL_SCHEMA, { id, qty, note });
	return upsertMutation(tenant, encodeRecordKey(SMALL_SCHEMA, record), record);
}

function itemKey(id: string): string {
	return canonicalEncode([id]);
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

/** Read a subscription to its head, in batches, returning batches in order. */
async function drain(
	binding: EngineBinding,
	subscription: string,
	dataset: string,
	start: string,
	limit: number,
	tenant = "",
): Promise<readonly (readonly ChangeEnvelope[])[]> {
	const capture = requirePort(binding, "capture");
	const batches: (readonly ChangeEnvelope[])[] = [];
	let position = start;
	for (let round = 0; round < 10_000; round += 1) {
		const batch = await capture.read({
			scope: scopeOf(dataset, tenant),
			subscription,
			after: position,
			limit,
		});
		assert.ok(
			parseLsn(batch.position) >= parseLsn(position),
			"a read never moves the position backwards",
		);
		if (batch.changes.length > 0) batches.push(batch.changes);
		position = batch.position;
		if (batch.caughtUp) return batches;
	}
	throw new Error("capture never caught up");
}

async function replayOnReference(
	schema: DatasetSchema,
	batches: readonly (readonly ChangeEnvelope[])[],
): Promise<EngineBinding> {
	const reference = createReferenceEngine();
	await reference.datasets.ensureDataset(schema);
	const apply = requirePort(reference, "apply");
	for (const batch of batches) {
		await apply.apply({
			dataset: schema.name,
			changes: batch,
			source: "replay",
			position: batch[batch.length - 1]?.position ?? "0/0",
		});
	}
	return reference;
}

async function assertSameDigest(
	left: EngineBinding,
	right: EngineBinding,
	dataset: string,
): Promise<number> {
	const scope = scopeOf(dataset);
	const a = await requirePort(left, "verify").digest({ scope, buckets: 16 });
	const b = await requirePort(right, "verify").digest({ scope, buckets: 16 });
	assert.deepEqual(compareDigests(a, b).mismatchedBuckets, []);
	assert.equal(a.digest, b.digest);
	return a.count;
}

describe.skipIf(!LIVE_URL)("PostgreSQL engine binding — live", () => {
	let pool: pg.Pool;
	let harness: LiveHarness;
	const opened: PostgresEngine[] = [];

	const open = (
		options?: Parameters<LiveHarness["open"]>[0],
	): PostgresEngine => {
		const binding = harness.open(options);
		opened.push(binding);
		return binding;
	};
	const table = (binding: PostgresEngine, name: string): string =>
		`${quoteIdentifier(binding.namespace)}.${quoteIdentifier(name)}`;

	let companion: CompanionDatabase;

	beforeAll(async () => {
		pool = livePool();
		companion = await createCompanionDatabase(pool);
		harness = postgresHarness(pool, companion);
	});

	afterAll(async () => {
		for (const binding of opened) await binding.close();
		const leftovers = await leftoverCaptureObjects(pool, companion.pool);
		await companion.drop(pool);
		await pool.end();
		assert.deepEqual(
			leftovers,
			[],
			"no replication slot, publication or subscription of this suite may outlive the run",
		);
	});

	// ── the conformance kit, three ways ───────────────────────────────────────

	test("PostgreSQL passes every conformance case against itself", async () => {
		const report = await runEngineConformance({
			engine: harness,
			now: NOW,
			onFailure: conformanceFailureSink(),
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "postgres");
		// PostgreSQL declares every port and logical-copy, so the native cases
		// run too — between two databases, over logical replication. The one
		// case skipped is the size probe: the declaration states no record
		// bound, and the kit invents none.
		assert.deepEqual(report.skipped, [SIZE_CASE_ID]);
		assert.equal(report.results.length, 51);
		assert.equal(
			report.results.length + report.skipped.length,
			ENGINE_CONFORMANCE_CASE_IDS.length,
		);
		assert.deepEqual(report.only, []);
		for (const id of NATIVE_CONFORMANCE_CASE_IDS) {
			assert.equal(
				report.results.find((result) => result.caseId === id)?.status,
				"pass",
				id,
			);
		}
	}, 600_000);

	test("PostgreSQL → reference engine: cross-engine through the hub", async () => {
		const report = await runEngineConformance({
			engine: harness,
			peer: referenceEngineHarness(),
			now: NOW,
			onFailure: conformanceFailureSink(),
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		// A native fast path exists only within one engine.
		assert.deepEqual(report.skipped, [
			SIZE_CASE_ID,
			...NATIVE_CONFORMANCE_CASE_IDS,
		]);
		assert.equal(
			report.results.length + report.skipped.length,
			ENGINE_CONFORMANCE_CASE_IDS.length,
		);
	}, 300_000);

	test("reference engine → PostgreSQL: the other direction", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
			peer: harness,
			now: NOW,
			onFailure: conformanceFailureSink(),
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		// The reference engine states no record bound, has no schema port and
		// shares no native profile with PostgreSQL; nothing else is skipped.
		assert.deepEqual(report.skipped, [
			SIZE_CASE_ID,
			...NATIVE_CONFORMANCE_CASE_IDS,
			...SCHEMA_CASE_IDS,
		]);
	}, 300_000);

	test("without capture the declaration says so, and capture-free patterns still pass", async () => {
		// The live harness with capture left out of every binding it creates.
		const withoutCapture = {
			...harness,
			schemaFixture: POSTGRES_SCHEMA_FIXTURE,
			create: () => harness.open({ capture: false }),
		};
		const probe = open({ capture: false });
		assertBindingMatchesDeclaration(probe);
		assert.equal(probe.capture, undefined);
		assert.equal(probe.declaration.captureOrdering, "none");
		const report = await runEngineConformance({
			engine: withoutCapture,
			now: NOW,
			onFailure: conformanceFailureSink(),
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.ok(report.skipped.includes("capture.ordered-and-resumable"));
		assert.ok(
			report.results.some(
				(result) =>
					result.caseId === "pattern.offline-copy.exact" &&
					result.status === "pass",
			),
		);
	}, 300_000);

	// ── capture under concurrency ─────────────────────────────────────────────

	test("concurrent transactions on the same keys replay to the same state", async () => {
		const binding = open();
		await binding.datasets.ensureDataset(SMALL_SCHEMA);
		const capture = requirePort(binding, "capture");
		await binding.records.write({
			dataset: SMALL_SCHEMA.name,
			mutations: [item("", "before-start", 0)],
		});
		const start = await capture.start({
			scope: scopeOf(SMALL_SCHEMA.name),
			subscription: "concurrency",
		});

		// Eight writers, forty transactions each, all fighting over six keys
		// in two tenants. Every transaction tags its rows with its own id and
		// how many rows it wrote, so a batch holding part of one is detectable.
		const keys = ["k0", "k1", "k2", "k3", "k4", "k5"];
		const tenants = ["", "tenant-a"];
		let committed = 0;
		const writer = async (worker: number): Promise<void> => {
			for (let round = 0; round < 40; round += 1) {
				const size = 1 + ((worker + round) % 3);
				const tenant = tenants[(worker + round) % tenants.length] ?? "";
				// Sorted, so two transactions never lock the same keys in
				// opposite orders.
				const chosen = [
					...new Set(
						Array.from(
							{ length: size },
							(_, index) =>
								keys[(worker * 7 + round * 3 + index * 5) % keys.length] ??
								"k0",
						),
					),
				].sort();
				const removes = chosen.map(
					(_, index) => (worker + round + index) % 5 === 0,
				);
				const upserts = removes.filter((remove) => !remove).length;
				const tag = `w${worker}-r${round}-u${upserts}`;
				const mutations = chosen.map((key, index) =>
					removes[index] === true
						? deleteMutation(tenant, itemKey(key))
						: item(tenant, key, worker * 1000 + round, tag),
				);
				await binding.records.write({ dataset: SMALL_SCHEMA.name, mutations });
				committed += 1;
			}
		};
		await Promise.all(Array.from({ length: 8 }, (_, worker) => writer(worker)));
		assert.equal(committed, 320);

		const batches = await drain(
			binding,
			"concurrency",
			SMALL_SCHEMA.name,
			start,
			7,
		);
		const all = batches.flat();
		assert.ok(all.length > 300, `captured ${all.length} changes`);
		assert.ok(
			all.every((change) => change.key !== itemKey("before-start")),
			"a change committed before start is never captured",
		);
		// Positions never go backwards across the whole stream.
		for (let index = 1; index < all.length; index += 1) {
			assert.ok(
				parseLsn(all[index]?.position ?? "0/0") >=
					parseLsn(all[index - 1]?.position ?? "0/0"),
			);
		}
		// No batch holds part of a transaction: every tagged upsert arrives
		// together with every other upsert its transaction made. (A delete of
		// an absent record changes nothing and is rightly not in the log.)
		for (const batch of batches) {
			const byPosition = new Map<string, ChangeEnvelope[]>();
			for (const change of batch) {
				const group = byPosition.get(change.position) ?? [];
				group.push(change);
				byPosition.set(change.position, group);
			}
			for (const group of byPosition.values()) {
				const upserts = group.filter((change) => change.op === "upsert");
				const tags = new Set(upserts.map((change) => change.record?.note));
				assert.ok(tags.size <= 1, "one position is one transaction");
				const declared = /-u([0-9]+)$/u.exec(String([...tags][0] ?? ""))?.[1];
				if (declared !== undefined) {
					assert.equal(upserts.length, Number(declared), [...tags].join());
				}
			}
		}
		// The decoded order, replayed, is the store's own final state.
		const reference = await replayOnReference(SMALL_SCHEMA, batches);
		await binding.records.write({
			dataset: SMALL_SCHEMA.name,
			mutations: [deleteMutation("", itemKey("before-start"))],
		});
		await assertSameDigest(binding, reference, SMALL_SCHEMA.name);
		await capture.stop("concurrency");
	}, 120_000);

	test("capture follows commit order, not the order transactions began", async () => {
		const binding = open();
		await binding.datasets.ensureDataset(SMALL_SCHEMA);
		const capture = requirePort(binding, "capture");
		const start = await capture.start({
			scope: scopeOf(SMALL_SCHEMA.name),
			subscription: "commit_order",
		});
		const items = table(binding, SMALL_SCHEMA.name);
		const upsert = `INSERT INTO ${items} (tenant_id, id, qty) VALUES ('', $1, $2) ON CONFLICT (tenant_id, id) DO UPDATE SET qty = EXCLUDED.qty`;
		// Native writers on their own sessions: A begins first and commits
		// last, B begins second and commits first. Both write `shared`.
		const a = await pool.connect();
		const b = await pool.connect();
		try {
			await a.query("BEGIN");
			await a.query(upsert, ["only-a", 1]);
			await b.query("BEGIN");
			await b.query(upsert, ["shared", 200]);
			await b.query("COMMIT");
			await a.query(upsert, ["shared", 100]);
			await a.query("COMMIT");
		} finally {
			a.release();
			b.release();
		}
		const batches = await drain(
			binding,
			"commit_order",
			SMALL_SCHEMA.name,
			start,
			50,
		);
		const seen = batches
			.flat()
			.map((change) => `${change.record?.id}=${change.record?.qty}`);
		assert.deepEqual(seen, ["shared=200", "only-a=1", "shared=100"]);
		await assertSameDigest(
			binding,
			await replayOnReference(SMALL_SCHEMA, batches),
			SMALL_SCHEMA.name,
		);
		const stored = await binding.records.read({
			dataset: SMALL_SCHEMA.name,
			tenant: "",
			key: itemKey("shared"),
		});
		assert.equal(stored?.qty, "100");
	}, 60_000);

	test("an update that leaves a large value untouched is completed, not corrupted", async () => {
		const binding = open();
		await binding.datasets.ensureDataset(SMALL_SCHEMA);
		const items = table(binding, SMALL_SCHEMA.name);
		await pool.query(
			`ALTER TABLE ${items} ALTER COLUMN note SET STORAGE EXTERNAL`,
		);
		const capture = requirePort(binding, "capture");
		const start = await capture.start({
			scope: scopeOf(SMALL_SCHEMA.name),
			subscription: "toast",
		});
		await binding.records.write({
			dataset: SMALL_SCHEMA.name,
			mutations: [item("", "big", 1, LARGE_NOTE)],
		});
		// A native writer changes one column; the server does not resend the
		// out-of-line value.
		await pool.query(`UPDATE ${items} SET qty = 2 WHERE id = 'big'`);
		const batches = await drain(binding, "toast", SMALL_SCHEMA.name, start, 10);
		const changes = batches.flat();
		assert.equal(changes.length, 2);
		assert.equal(changes[1]?.record?.qty, "2");
		assert.equal(changes[1]?.record?.note, LARGE_NOTE);
		await assertSameDigest(
			binding,
			await replayOnReference(SMALL_SCHEMA, batches),
			SMALL_SCHEMA.name,
		);
	}, 60_000);

	test("a subscription is durable across bindings, and loud once its log is gone", async () => {
		const namespace = freshNamespace();
		// The first binding is not ephemeral: closing it keeps the subscription.
		const first = createPostgresEngine({
			executor: harness.executor,
			namespace,
		});
		await first.datasets.ensureDataset(SMALL_SCHEMA);
		const scope = scopeOf(SMALL_SCHEMA.name);
		const start = await requirePort(first, "capture").start({
			scope,
			subscription: "durable",
		});
		await first.records.write({
			dataset: SMALL_SCHEMA.name,
			mutations: [item("", "a", 1)],
		});
		await first.close();

		const second = open({ namespace });
		const capture = requirePort(second, "capture");
		assert.equal(
			await capture.start({ scope, subscription: "durable" }),
			start,
			"a second binding finds the original start position",
		);
		const batch = await capture.read({
			scope,
			subscription: "durable",
			after: start,
			limit: 10,
		});
		assert.equal(batch.changes.length, 1);
		assert.ok(batch.caughtUp);
		// A subscription carries one dataset; asking it for another is an
		// error, not an empty batch.
		const wrong = await rejection(() =>
			capture.read({
				scope: scopeOf("hobo_another_dataset"),
				subscription: "durable",
				after: start,
				limit: 10,
			}),
		);
		assert.ok(wrong instanceof PostgresDataError);
		await capture.acknowledge({
			subscription: "durable",
			position: batch.position,
		});
		// Acknowledging an older position again is a no-op, not an error.
		await capture.acknowledge({ subscription: "durable", position: start });
		const released = await rejection(() =>
			capture.read({ scope, subscription: "durable", after: start, limit: 10 }),
		);
		// The shared refusal from `@hobo/data-core`, not a package-local copy.
		assert.ok(released instanceof CapturePositionError);
		assert.equal(released.code, "CAPTURE_POSITION_INVALID");

		// The slot vanishing underneath the subscription is reported, never
		// papered over with an empty batch.
		await pool.query(
			"SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name LIKE 'hobo\\_s\\_%' AND slot_name IN (SELECT slot_name FROM " +
				`${quoteIdentifier(namespace)}.hobo_data_subscriptions)`,
		);
		const gone = await rejection(() =>
			capture.read({
				scope,
				subscription: "durable",
				after: batch.position,
				limit: 10,
			}),
		);
		assert.ok(gone instanceof PostgresDataError);
		assert.equal(gone.code, "CAPTURE_SUBSCRIPTION_LOST");
		await capture.stop("durable");
		await capture.stop("durable");
		const stopped = await rejection(() =>
			capture.read({
				scope,
				subscription: "durable",
				after: batch.position,
				limit: 10,
			}),
		);
		assert.ok(stopped instanceof PostgresDataError);
		assert.equal(stopped.code, "CAPTURE_SUBSCRIPTION_LOST");
		const foreign = await rejection(() =>
			capture.acknowledge({ subscription: "durable", position: "41" }),
		);
		assert.ok(foreign instanceof CapturePositionError);
		assert.equal(foreign.code, "CAPTURE_POSITION_INVALID");
	}, 60_000);

	test("the recorded pgoutput fixture still describes what a live server sends", async () => {
		const messages = await recordPgOutputScenario(pool);
		if (process.env.HOBO_RECORD_PGOUTPUT === "1") {
			const version = await pool.query("SHOW server_version");
			const recorded: RecordedPgOutput = {
				recordedFrom: `PostgreSQL ${String(version.rows[0]?.server_version)}`,
				scenario: "recordPgOutputScenario in test/engine-support.ts",
				messages,
			};
			writeFileSync(FIXTURE_PATH, `${JSON.stringify(recorded, null, "\t")}\n`);
		}
		// SAFETY: the fixture file is this repository's own recorded document.
		const fixture = JSON.parse(
			readFileSync(FIXTURE_PATH, "utf8"),
		) as RecordedPgOutput;
		assert.deepEqual(
			summarizePgOutput(messages),
			summarizePgOutput(fixture.messages),
		);
	}, 60_000);

	// ── the fence is enforced by the store ────────────────────────────────────

	test("a writer that bypasses the binding is still refused by the fence", async () => {
		const binding = open();
		await binding.datasets.ensureDataset(SMALL_SCHEMA);
		const items = table(binding, SMALL_SCHEMA.name);
		const fence = requirePort(binding, "fence");
		const scope = scopeOf(SMALL_SCHEMA.name, "tenant-a");
		await binding.records.write({
			dataset: SMALL_SCHEMA.name,
			mutations: [item("tenant-a", "seed", 1), item("tenant-b", "seed", 1)],
		});
		const grant = await fence.raise({ scope, reason: "live" });

		const insert = `INSERT INTO ${items} (tenant_id, id, qty) VALUES ($1, $2, 1)`;
		const direct = await rejection(() => pool.query(insert, ["tenant-a", "x"]));
		assert.equal(sqlStateOf(direct), FENCED_WRITE_SQLSTATE);
		for (const statement of [
			`UPDATE ${items} SET qty = 9 WHERE tenant_id = 'tenant-a'`,
			`DELETE FROM ${items} WHERE tenant_id = 'tenant-a'`,
			// Moving a row into, or out of, the fenced tenant.
			`UPDATE ${items} SET tenant_id = 'tenant-a', id = 'moved' WHERE tenant_id = 'tenant-b'`,
		]) {
			const refused = await rejection(() => pool.query(statement));
			assert.equal(sqlStateOf(refused), FENCED_WRITE_SQLSTATE, statement);
		}
		// Replica mode disables ordinary triggers; the fence is ALWAYS.
		const replica = await pool.connect();
		try {
			await replica.query("BEGIN");
			await replica.query("SET LOCAL session_replication_role = replica");
			const refused = await rejection(() =>
				replica.query(insert, ["tenant-a", "replica"]),
			);
			assert.equal(sqlStateOf(refused), FENCED_WRITE_SQLSTATE);
			await replica.query("ROLLBACK");
		} finally {
			replica.release();
		}
		// Another tenant is untouched, and the token holder writes through.
		await pool.query(insert, ["tenant-b", "free"]);
		const holder = await pool.connect();
		try {
			await holder.query("BEGIN");
			await holder.query("SELECT set_config('hobo.fence_token', $1, true)", [
				grant.fenceToken,
			]);
			await holder.query(insert, ["tenant-a", "authority"]);
			await holder.query("COMMIT");
		} finally {
			holder.release();
		}
		// The token does not leak to the session's next transaction.
		const truncate = await rejection(() => pool.query(`TRUNCATE ${items}`));
		assert.equal(sqlStateOf(truncate), TRUNCATE_REFUSED_SQLSTATE);
		const viaBinding = await rejection(() =>
			binding.records.write({
				dataset: SMALL_SCHEMA.name,
				mutations: [item("tenant-a", "late", 1)],
			}),
		);
		assert.ok(viaBinding instanceof FencedWriteError);
		assert.equal(viaBinding.tenant, "tenant-a");

		// A dataset-wide fence covers every tenant.
		const wide = await fence.raise({
			scope: scopeOf(SMALL_SCHEMA.name),
			reason: "live",
		});
		const covered = await rejection(() =>
			pool.query(insert, ["tenant-b", "y"]),
		);
		assert.equal(sqlStateOf(covered), FENCED_WRITE_SQLSTATE);
		await fence.release({
			scope: scopeOf(SMALL_SCHEMA.name),
			fenceToken: wide.fenceToken,
		});
		const mismatch = await rejection(() =>
			fence.release({ scope, fenceToken: "not-the-token" }),
		);
		assert.ok(mismatch instanceof DataCoreError);
		assert.equal(mismatch.code, "FENCE_TOKEN_MISMATCH");
		await fence.release({ scope, fenceToken: grant.fenceToken });
		await pool.query(insert, ["tenant-a", "after-release"]);
	}, 60_000);

	test("raising a fence waits for a writer already in flight", async () => {
		const binding = open();
		await binding.datasets.ensureDataset(SMALL_SCHEMA);
		const items = table(binding, SMALL_SCHEMA.name);
		const fence = requirePort(binding, "fence");
		const scope = scopeOf(SMALL_SCHEMA.name);
		const writer = await pool.connect();
		let raised = false;
		try {
			await writer.query("BEGIN");
			await writer.query(
				`INSERT INTO ${items} (tenant_id, id, qty) VALUES ('', 'in-flight', 1)`,
			);
			// The writer passed the fence check and has not committed. A fence
			// raised now must not return until that write is settled.
			const raising = Promise.resolve(
				fence.raise({ scope, reason: "live" }),
			).then((grant) => {
				raised = true;
				return grant;
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			assert.equal(raised, false, "the fence returned over an open write");
			await writer.query("COMMIT");
			const grant = await raising;
			assert.ok(raised);
			// Everything that got in before the fence is visible under it.
			const digest = await requirePort(binding, "verify").digest({
				scope,
				buckets: 4,
			});
			assert.equal(digest.count, 1);
			await fence.release({ scope, fenceToken: grant.fenceToken });
		} finally {
			writer.release();
		}
	}, 60_000);

	// ── the type mapping is honest ────────────────────────────────────────────

	test("every canonical type round-trips byte for byte, at its edges", async () => {
		const binding = open();
		const schema = EVERY_TYPE_SCHEMA;
		await binding.datasets.ensureDataset(schema);
		const edges: readonly JsonObject[] = [
			{},
			{ id: "edge-int-min", qty: "-9223372036854775808" },
			{ id: "edge-int-max", qty: "9223372036854775807" },
			{ id: "edge-float-max", weight: 1.7976931348623157e308 },
			{ id: "edge-float-min", weight: 5e-324 },
			{ id: "edge-float-neg-zero", weight: -0 },
			{ id: "edge-float-third", weight: 1 / 3 },
			{
				id: "edge-decimal",
				price: "-1234567890123456789012345678901234567890.123456789000",
			},
			{ id: "edge-decimal-zero", price: "-0.000" },
			{ id: "edge-ts-micro", placed_at: "9999-12-31T23:59:59.999999Z" },
			{ id: "edge-ts-early", placed_at: "0100-01-01T00:00:00.000001-11:59" },
			{ id: "edge-date", due: "0100-03-01" },
			// The first century: years the server writes with leading zeros.
			{ id: "edge-ts-year-1", placed_at: "0001-01-01T00:00:00Z" },
			{ id: "edge-ts-year-99", placed_at: "0099-12-31T23:59:59.999999Z" },
			{ id: "edge-date-year-1", due: "0001-01-01" },
			{ id: "edge-date-year-99", due: "0099-12-31" },
			{ id: "edge-bytes-empty", blob: "" },
			{ id: "edge-string-empty", note: "" },
			{ id: "edge-string-astral", note: "𝒳 \u{10FFFF} tab\there \\x00 %s $1" },
			{
				id: "edge-json",
				attrs: {
					"": [],
					deep: { a: [true, false, null, "x", -1.5e-7, 9007199254740992] },
					text: 'line\nbreak "quoted" \\ back',
				},
			},
			{ id: "edge-json-scalar", attrs: "just a string" },
			// jsonb stores numbers as exact decimals; these must come back as
			// the same doubles.
			{
				id: "edge-json-numbers",
				attrs: [1.7976931348623157e308, 5e-324, 0.1, 1e21, -1e-7, 2 ** 53],
			},
			{ id: "edge-nulls", note: null, card: null },
		];
		const expected = new DatasetDigestBuilder(schema.name, "", 8);
		const mutations: RecordMutation[] = [];
		for (const edge of edges) {
			const record = parseCanonicalRecord(schema, {
				...EVERY_TYPE_RECORD,
				...edge,
			});
			const key = encodeRecordKey(schema, record);
			mutations.push(upsertMutation("", key, record));
			expected.add("", key, record);
		}
		await binding.records.write({ dataset: schema.name, mutations });
		for (const mutation of mutations) {
			const read = await binding.records.read({
				dataset: schema.name,
				tenant: "",
				key: mutation.key,
			});
			assert.equal(
				canonicalEncode(read ?? null),
				canonicalEncode(mutation.record ?? null),
				mutation.key,
			);
		}
		const digest = await requirePort(binding, "verify").digest({
			scope: scopeOf(schema.name),
			buckets: 8,
		});
		assert.ok(compareDigests(expected.finish(), digest).equal);
	}, 60_000);

	test("a value the server cannot hold is refused, and nothing is stored", async () => {
		const binding = open();
		const schema = EVERY_TYPE_SCHEMA;
		await binding.datasets.ensureDataset(schema);
		const refusals: readonly JsonObject[] = [
			{ note: "nul \u0000 inside" },
			{ note: "lone \ud800 surrogate" },
			{ attrs: { text: "nul \u0000 inside json" } },
			{ price: `0.${"1".repeat(20_000)}` },
		];
		for (const [index, refusal] of refusals.entries()) {
			// Built by hand: a lone surrogate must reach the binding intact.
			const record = { ...parseCanonicalRecord(schema, EVERY_TYPE_RECORD) };
			const raw = { ...record, ...refusal, id: `refused-${index}` };
			const key = canonicalEncode([raw.id]);
			const refused = await rejection(() =>
				binding.records.write({
					dataset: schema.name,
					// A good record first: the refusal must roll it back too.
					mutations: [
						upsertMutation("", canonicalEncode([`good-${index}`]), {
							...record,
							id: `good-${index}`,
						}),
						upsertMutation("", key, raw),
					],
				}),
			);
			assert.ok(refused instanceof DataCoreError, Object.keys(refusal).join());
			assert.equal(refused.code, "INVALID_RECORD");
		}
		const digest = await requirePort(binding, "verify").digest({
			scope: scopeOf(schema.name),
			buckets: 4,
		});
		assert.equal(digest.count, 0, "a refused write leaves nothing behind");
	}, 60_000);

	test("a natively written value with no canonical form is refused on read", async () => {
		const binding = open();
		const schema = EVERY_TYPE_SCHEMA;
		await binding.datasets.ensureDataset(schema);
		const orders = table(binding, schema.name);
		const record = parseCanonicalRecord(schema, EVERY_TYPE_RECORD);
		const key = encodeRecordKey(schema, record);
		const natives = [
			"weight = 'NaN'",
			"weight = '-Infinity'",
			"price = 'NaN'",
			"placed_at = 'infinity'",
			"placed_at = '0044-03-15 12:00:00+00 BC'",
			"placed_at = '10000-01-01 00:00:00+00'",
			"due = '0044-03-15 BC'",
			'card = \'{"alg": "x"}\'::jsonb',
		];
		const read = () =>
			binding.records.read({ dataset: schema.name, tenant: "", key });
		for (const assignment of natives) {
			await binding.records.write({
				dataset: schema.name,
				mutations: [upsertMutation("", key, record)],
			});
			await pool.query(`UPDATE ${orders} SET ${assignment}`);
			const refused = await rejection(read);
			assert.ok(refused instanceof DataCoreError, assignment);
			assert.equal(refused.code, "INVALID_RECORD", assignment);
			const digest = await rejection(() =>
				requirePort(binding, "verify").digest({
					scope: scopeOf(schema.name),
					buckets: 4,
				}),
			);
			assert.ok(digest instanceof DataCoreError, assignment);
		}
	}, 60_000);

	test("an open schema keeps undeclared fields, and a composite key pages in order", async () => {
		const schema = parseDatasetSchema({
			name: "hobo_live_events",
			version: 2,
			open: true,
			keyFields: ["region", "seq", "ref"],
			fields: [
				{ name: "region", type: "string", nullable: false },
				{ name: "seq", type: "int64", nullable: false },
				{ name: "ref", type: "uuid", nullable: false },
				{ name: "body", type: "json", nullable: true },
			],
		});
		const binding = createPostgresEngine({
			executor: harness.executor,
			namespace: freshNamespace(),
			ephemeral: true,
			pageSize: 7,
		});
		opened.push(binding);
		await binding.datasets.ensureDataset(schema);
		assert.deepEqual(
			await binding.datasets.describeDataset(schema.name),
			schema,
		);
		const expected = new DatasetDigestBuilder(schema.name, "", 8);
		const mutations: RecordMutation[] = [];
		for (let index = 0; index < 53; index += 1) {
			const tenant = ["", "tenant-a", "tenant-b"][index % 3] ?? "";
			const record = parseCanonicalRecord(schema, {
				region: ["eu", "EU", "us-east", "é"][index % 4] ?? "eu",
				seq: String((index % 2 === 0 ? -1 : 1) * index * 1_000_000_007),
				ref: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				body: index % 5 === 0 ? null : { index },
				undeclared: { nested: [index, "ü"] },
				flag: index % 2 === 0,
			});
			const key = encodeRecordKey(schema, record);
			mutations.push(upsertMutation(tenant, key, record));
			expected.add(tenant, key, record);
		}
		await binding.records.write({ dataset: schema.name, mutations });
		const sample = mutations[17];
		const read = await binding.records.read({
			dataset: schema.name,
			tenant: sample?.tenant ?? "",
			key: sample?.key ?? "",
		});
		assert.equal(
			canonicalEncode(read ?? null),
			canonicalEncode(sample?.record ?? null),
		);
		const digest = await requirePort(binding, "verify").digest({
			scope: scopeOf(schema.name),
			buckets: 8,
		});
		assert.ok(compareDigests(expected.finish(), digest).equal);
		const cursor = await requirePort(binding, "snapshot").openSnapshot({
			scope: scopeOf(schema.name),
			chunkSize: 5,
		});
		const seen = new Set<string>();
		for (;;) {
			const chunk = await cursor.next();
			if (chunk === undefined) break;
			assert.ok(chunk.length <= 5);
			for (const mutation of chunk)
				seen.add(`${mutation.tenant}|${mutation.key}`);
		}
		await cursor.close();
		assert.equal(seen.size, 53);
	}, 60_000);

	test("a dataset schema is persisted, and a differing or squatted one is refused", async () => {
		const binding = open();
		assert.equal(
			(await binding.datasets.ensureDataset(SMALL_SCHEMA)).created,
			true,
		);
		// A second binding on the same namespace sees the same dataset — and,
		// finding the namespace already bootstrapped, runs no DDL at all.
		const issued: string[] = [];
		const watched: PostgresExecutor = {
			query(sql, parameters) {
				issued.push(sql);
				return harness.executor.query(sql, parameters);
			},
			transaction: (body) => harness.executor.transaction(body),
		};
		const again = createPostgresEngine({
			executor: watched,
			namespace: binding.namespace,
		});
		assert.equal(
			(await again.datasets.ensureDataset(SMALL_SCHEMA)).created,
			false,
		);
		assert.deepEqual(
			issued.filter((sql) => /^\s*(CREATE|ALTER|COMMENT|DROP)\b/u.test(sql)),
			[],
		);
		// A tenant the driver would silently alter is refused like any text.
		const tenant = await rejection(() =>
			again.records.write({
				dataset: SMALL_SCHEMA.name,
				mutations: [item("lone \ud800 surrogate", "a", 1)],
			}),
		);
		assert.ok(tenant instanceof DataCoreError);
		assert.equal(tenant.code, "INVALID_RECORD");
		const widened = parseDatasetSchema({
			name: SMALL_SCHEMA.name,
			version: 2,
			keyFields: ["id"],
			fields: [
				{ name: "id", type: "string", nullable: false },
				{ name: "qty", type: "decimal", nullable: false },
			],
		});
		const differs = await rejection(() =>
			again.datasets.ensureDataset(widened),
		);
		assert.ok(differs instanceof DataCoreError);
		assert.equal(differs.code, "INVALID_DATASET_SCHEMA");
		// A table that already exists under the name is not adopted.
		await pool.query(
			`CREATE TABLE ${quoteIdentifier(binding.namespace)}.hobo_squatter (id text)`,
		);
		const squatted = await rejection(() =>
			binding.datasets.ensureDataset(
				parseDatasetSchema({
					name: "hobo_squatter",
					keyFields: ["id"],
					fields: [{ name: "id", type: "string", nullable: false }],
				}),
			),
		);
		assert.ok(squatted instanceof DataCoreError);
		assert.equal(squatted.code, "INVALID_DATASET_SCHEMA");
		const reserved = await rejection(() =>
			binding.datasets.ensureDataset(
				parseDatasetSchema({
					name: "hobo_reserved",
					keyFields: ["id"],
					fields: [
						{ name: "id", type: "string", nullable: false },
						{ name: "tenant_id", type: "string", nullable: true },
					],
				}),
			),
		);
		assert.ok(reserved instanceof DataCoreError);
		const absent = await rejection(() =>
			binding.records.read({ dataset: "hobo_nowhere", tenant: "", key: "[1]" }),
		);
		assert.ok(absent instanceof DataCoreError);
	}, 60_000);

	// ── schema apply ──────────────────────────────────────────────────────────

	test("a schema snapshot restores structure and data, and a failed phase leaves nothing", async () => {
		const binding = createPostgresEngine({
			executor: harness.executor,
			namespace: freshNamespace(),
			ephemeral: true,
			schemaTables: ["hobo_live_accounts", "hobo_live_added_later"],
			clock: () => NOW,
		});
		opened.push(binding);
		const port = requirePort(binding, "schema");
		const accounts = table(binding, "hobo_live_accounts");
		const columns = async (): Promise<readonly JsonObject[]> =>
			port.verify(
				"SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hobo_live_accounts' ORDER BY ordinal_position;",
			);
		const rows = async (): Promise<readonly JsonObject[]> =>
			port.verify("SELECT * FROM hobo_live_accounts ORDER BY id");

		await port.applyPhase("expand", [
			"CREATE TABLE hobo_live_accounts (id bigint PRIMARY KEY, email text NOT NULL UNIQUE, balance numeric(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0), doubled numeric GENERATED ALWAYS AS (balance * 2) STORED, born timestamptz)",
			"CREATE INDEX hobo_live_accounts_born ON hobo_live_accounts (born)",
			"INSERT INTO hobo_live_accounts (id, email, balance, born) VALUES (1, 'a@example.test', 10.50, '2026-01-02T03:04:05.678901Z'), (2, 'b@example.test', 0, NULL)",
		]);
		const columnsBefore = await columns();
		const rowsBefore = await rows();
		assert.equal(rowsBefore.length, 2);

		// One transaction per phase: the failing statement undoes the first.
		const failed = await rejection(() =>
			port.applyPhase("expand", [
				"ALTER TABLE hobo_live_accounts ADD COLUMN nickname text",
				"ALTER TABLE hobo_live_accounts DROP COLUMN no_such_column",
			]),
		);
		assert.equal(sqlStateOf(failed), "42703");
		assert.deepEqual(await columns(), columnsBefore);

		const snapshot = await port.snapshot();
		assert.equal(snapshot.takenAt, NOW);
		const destroyed = await port.applyPhase("contract", [
			"ALTER TABLE hobo_live_accounts DROP COLUMN email",
			"ALTER TABLE hobo_live_accounts DROP CONSTRAINT hobo_live_accounts_balance_check",
			"DROP INDEX hobo_live_accounts_born",
			"DELETE FROM hobo_live_accounts WHERE id = 1",
			"UPDATE hobo_live_accounts SET balance = -5",
			"CREATE TABLE hobo_live_added_later (id integer)",
		]);
		assert.equal(destroyed.changes, 2);
		assert.notDeepEqual(await columns(), columnsBefore);

		await port.restore(snapshot);
		assert.deepEqual(await columns(), columnsBefore);
		assert.deepEqual(await rows(), rowsBefore);
		// Constraints came back with the structure.
		for (const [statement, state] of [
			[
				`INSERT INTO ${accounts} (id, email) VALUES (1, 'dup@example.test')`,
				"23505",
			],
			[
				`INSERT INTO ${accounts} (id, email) VALUES (3, 'a@example.test')`,
				"23505",
			],
			[
				`INSERT INTO ${accounts} (id, email, balance) VALUES (4, 'c@example.test', -1)`,
				"23514",
			],
			[`INSERT INTO ${accounts} (id) VALUES (5)`, "23502"],
		] as const) {
			const refused = await rejection(() => pool.query(statement));
			assert.equal(sqlStateOf(refused), state, statement);
		}
		// Three indexes again: the key, the unique email, and the plain one.
		assert.deepEqual(
			await port.verify(
				"SELECT count(*) AS n FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'hobo_live_accounts'",
			),
			[{ n: 3 }],
		);
		// A table that did not exist at the snapshot does not exist after it.
		const later = await port.verify(
			"SELECT 1 AS present FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'hobo_live_added_later'",
		);
		assert.deepEqual(later, []);
		// A snapshot can be restored more than once, then dropped.
		await port.restore(snapshot);
		await binding.dropSchemaSnapshot(snapshot);
		const missing = await rejection(() => port.restore(snapshot));
		assert.ok(missing instanceof DataCoreError);
	}, 60_000);

	test("a snapshot refuses a table it could not faithfully restore", async () => {
		const binding = createPostgresEngine({
			executor: harness.executor,
			namespace: freshNamespace(),
			ephemeral: true,
			schemaTables: ["hobo_live_child"],
		});
		opened.push(binding);
		const port = requirePort(binding, "schema");
		await port.applyPhase("expand", [
			"CREATE TABLE hobo_live_parent (id bigint PRIMARY KEY)",
			"CREATE TABLE hobo_live_child (id bigint PRIMARY KEY, parent bigint REFERENCES hobo_live_parent (id))",
		]);
		const refused = await rejection(() => port.snapshot());
		assert.ok(refused instanceof DataCoreError);
		assert.equal(refused.code, "INVALID_MIGRATION_PLAN");
		assert.match(refused.message, /NO_FOREIGN_KEYS/u);
		const unconfigured = createPostgresEngine({
			executor: harness.executor,
			namespace: binding.namespace,
		});
		const empty = await rejection(async () =>
			requirePort(unconfigured, "schema").snapshot(),
		);
		assert.ok(empty instanceof DataCoreError);
	}, 60_000);
});
