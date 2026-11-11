// Shared support for the engine-binding lanes. Nothing here runs unless a
// test calls it; the live helpers are only reached when
// HOBO_TEST_POSTGRES_URL names a real server.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
	type DatasetSchema,
	type EngineBinding,
	type EngineConformanceResult,
	type EngineHarness,
	type NativePair,
	parseDatasetSchema,
} from "@hobo/data-core";
import pg from "pg";
import {
	captureObjectNames,
	captureObjectPrefixes,
	createPgExecutor,
	createPostgresEngine,
	decodePgOutputTransactions,
	nativeSubscriptionPrefix,
	type PgOutputTuple,
	POSTGRES_SCHEMA_FIXTURE,
	POSTGRES_SCHEMA_FIXTURE_TABLE,
	type PostgresEngine,
	type PostgresExecutor,
	parseLsn,
	quoteIdentifier,
} from "../src/index.js";

export const NOW = "2026-11-10T00:00:00.000Z";

/** The live lane's connection string; absent in CI, which has no database. */
export const LIVE_URL = process.env.HOBO_TEST_POSTGRES_URL;

export function failures(results: readonly EngineConformanceResult[]): string {
	return results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}

/** One field of every canonical type, plus a nullable of each awkward one. */
export const EVERY_TYPE_SCHEMA: DatasetSchema = parseDatasetSchema({
	name: "hobo_fixture_orders",
	version: 3,
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "qty", type: "int64", nullable: false },
		{ name: "price", type: "decimal", nullable: false },
		{ name: "weight", type: "float64", nullable: false },
		{ name: "active", type: "bool", nullable: false },
		{ name: "note", type: "string", nullable: true },
		{ name: "blob", type: "bytes", nullable: false },
		{ name: "placed_at", type: "timestamp", nullable: false },
		{ name: "due", type: "date", nullable: false },
		{ name: "ref", type: "uuid", nullable: false },
		{ name: "attrs", type: "json", nullable: false },
		{ name: "card", type: "encrypted", nullable: true },
	],
});

export const EVERY_TYPE_RECORD = Object.freeze({
	id: "order-1",
	qty: "9007199254740993",
	price: "001234.5600",
	weight: 0.1,
	active: true,
	note: 'quote \' "double" and ünïcödé — 雪',
	blob: "AAECA/8=",
	placed_at: "2026-01-02T05:04:05.678901+02:00",
	due: "2026-02-28",
	ref: "0F8FAD5B-D9CB-469F-A165-70867728950E",
	attrs: { z: [1, 2, { nested: null }], a: "b", n: 1e21 },
	card: {
		alg: "AES-256-GCM",
		keyRef: "key://subject/1",
		ciphertext: "3q2+7w==",
	},
});

/**
 * A pool sized for the concurrency lane. The caller ends it. Test files run in
 * parallel against one server other suites share, so a file that needs fewer
 * sessions asks for fewer.
 */
export function livePool(max = 12): pg.Pool {
	const pool = new pg.Pool({ connectionString: LIVE_URL, max });
	// An idle client dropped by the server is not a test failure.
	pool.on("error", () => {});
	return pool;
}

/** The one namespace with a fixed name; declared here because the leak check below needs it. */
const FIXTURE_NAMESPACE = "hobo_fixture_capture";

let namespaceCounter = 0;
// Random, not derived from the clock and the process id: two test files can
// start in the same millisecond, and a worker thread shares its parent's pid.
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);

/**
 * Every namespace this test file has used. Each test file gets its own copy
 * of this module, so this is exactly the set of namespaces whose server
 * objects this file — and nobody else — could have created.
 */
const OWN_NAMESPACES = new Set<string>();

/** A namespace no other binding in this run, or any other run, uses. */
export function freshNamespace(): string {
	namespaceCounter += 1;
	const namespace = `hobo_t_${RUN_ID}_${namespaceCounter}`;
	OWN_NAMESPACES.add(namespace);
	return namespace;
}

/** The connection string of another database on the live server. */
export function liveUrlFor(database: string): string {
	const url = new URL(LIVE_URL ?? "");
	url.pathname = `/${database}`;
	return url.toString();
}

/**
 * A second database on the live server, for a native transfer to land in:
 * logical replication needs the same schema-qualified table name on both
 * sides, so the target has to be another database.
 */
export interface CompanionDatabase {
	readonly name: string;
	readonly pool: pg.Pool;
	/** End the pool and drop the database. */
	drop(admin: pg.Pool): Promise<void>;
}

export async function createCompanionDatabase(
	admin: pg.Pool,
): Promise<CompanionDatabase> {
	const name = `hobo_tdb_${RUN_ID}`;
	await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
	const pool = new pg.Pool({ connectionString: liveUrlFor(name), max: 4 });
	pool.on("error", () => {});
	return {
		name,
		pool,
		async drop(owner) {
			await pool.end();
			await owner.query(
				`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`,
			);
		},
	};
}

/**
 * A well-formed write-ahead-log location past `head`: 4 GiB further on, which
 * no test run writes. Positions are opaque to the conformance kit, so the
 * harness is what makes one.
 */
export function postgresPositionPastHead(head: string): string {
	const ahead = parseLsn(head) + (1n << 32n);
	return `${(ahead >> 32n).toString(16).toUpperCase()}/${(ahead & 0xffff_ffffn).toString(16).toUpperCase()}`;
}

/** Where a conformance run sends the raw error of a case that failed. */
export function conformanceFailureSink(): (
	caseId: string,
	error: Error,
) => void {
	const file = process.env.HOBO_TEST_CONFORMANCE_ERRORS;
	return (caseId, error) => {
		if (file === undefined || file === "") return;
		appendFileSync(
			file,
			`${JSON.stringify({
				at: new Date().toISOString(),
				caseId,
				name: error.name,
				sqlState: "code" in error ? String(error.code) : undefined,
				message: error.message,
				stack: error.stack?.split("\n").slice(0, 8),
			})}\n`,
		);
	};
}

export interface LiveHarness extends EngineHarness {
	readonly executor: PostgresExecutor;
	/** A binding in its own namespace, dropped on close. */
	open(options?: {
		readonly namespace?: string;
		readonly capture?: boolean;
	}): PostgresEngine;
}

/**
 * One namespace per binding, so no two conformance cases can collide. Given a
 * companion database, the harness can also stage a native pair: one namespace
 * name, in the live database and in the companion, with the companion's
 * binding told how its server reaches the live one.
 */
export function postgresHarness(
	pool: pg.Pool,
	companion?: CompanionDatabase,
): LiveHarness {
	const executor = createPgExecutor(pool);
	const opened = new WeakMap<EngineBinding, string>();
	const open: LiveHarness["open"] = (options = {}) => {
		const namespace = options.namespace ?? freshNamespace();
		OWN_NAMESPACES.add(namespace);
		const binding = createPostgresEngine({
			executor,
			namespace,
			capture: options.capture ?? true,
			schemaTables: [POSTGRES_SCHEMA_FIXTURE_TABLE],
			ephemeral: true,
			clock: () => NOW,
		});
		opened.set(binding, namespace);
		return binding;
	};
	const base = {
		executor,
		open,
		schemaFixture: POSTGRES_SCHEMA_FIXTURE,
		positionPastHead: postgresPositionPastHead,
		create: () => open(),
		// A second binding on the same namespace. Not ephemeral: the first
		// binding owns the namespace and drops it.
		attach(binding: EngineBinding): EngineBinding {
			const first = opened.get(binding);
			if (first === undefined) {
				throw new Error("the binding was not created by this harness");
			}
			return createPostgresEngine({
				executor,
				namespace: first,
				schemaTables: [POSTGRES_SCHEMA_FIXTURE_TABLE],
				clock: () => NOW,
			});
		},
	};
	if (companion === undefined) return base;
	const companionExecutor = createPgExecutor(companion.pool);
	return {
		...base,
		createNativePair(): NativePair {
			const namespace = freshNamespace();
			return {
				source: open({ namespace }),
				target: createPostgresEngine({
					executor: companionExecutor,
					namespace,
					ephemeral: true,
					clock: () => NOW,
					nativeSourceConnection: () => LIVE_URL ?? "",
				}),
			};
		},
	};
}

/** Note a namespace a test named itself, so the leak check covers it. */
export function claimNamespace(namespace: string): string {
	OWN_NAMESPACES.add(namespace);
	return namespace;
}

/**
 * Replication slots, publications and subscriptions left behind by this test
 * file — and only by this test file.
 *
 * Slot names are cluster-wide and other suites, and other processes, share
 * the server, so counting every `hobo_s_%` slot would fail one suite for
 * another's work in progress. Every name this package derives starts with a
 * digest of the database and the namespace that own it; the check lists the
 * objects carrying the digests of the namespaces this file used, in each of
 * the databases it used. It is still strict: one object of its own is a leak.
 */
export async function leftoverCaptureObjects(
	...pools: readonly pg.Pool[]
): Promise<readonly string[]> {
	const first = pools[0];
	// The fixture namespace has one name for every run (see below). While
	// another run is recording into it, its slot is that run's work in
	// progress and not this file's leak, so the count waits its turn.
	if (first !== undefined && OWN_NAMESPACES.has(FIXTURE_NAMESPACE)) {
		return withFixtureLock(first, () => listCaptureObjects(pools));
	}
	return listCaptureObjects(pools);
}

async function listCaptureObjects(
	pools: readonly pg.Pool[],
): Promise<readonly string[]> {
	const found: string[] = [];
	for (const pool of pools) {
		const current = await pool.query(
			"SELECT current_database()::text AS database",
		);
		const database = String(current.rows[0]?.database ?? "");
		const namespaces = [...OWN_NAMESPACES];
		const prefixes = namespaces.map((namespace) =>
			captureObjectPrefixes(database, namespace),
		);
		const slotPrefixes = prefixes.map((prefix) => prefix.slot);
		const publicationPrefixes = prefixes.map((prefix) => prefix.publication);
		const subscriptionPrefixes = namespaces.map(nativeSubscriptionPrefix);
		// Every prefix of one kind has the same length; compare on that.
		const slots = await pool.query(
			"SELECT slot_name::text AS name FROM pg_replication_slots WHERE left(slot_name::text, $2::integer) = ANY($1::text[])",
			[slotPrefixes, slotPrefixes[0]?.length ?? 0],
		);
		const publications = await pool.query(
			"SELECT pubname::text AS name FROM pg_publication WHERE left(pubname::text, $2::integer) = ANY($1::text[])",
			[publicationPrefixes, publicationPrefixes[0]?.length ?? 0],
		);
		const subscriptions = await pool.query(
			"SELECT s.subname::text AS name FROM pg_subscription s WHERE s.subdbid = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database()) AND left(s.subname::text, $2::integer) = ANY($1::text[])",
			[subscriptionPrefixes, subscriptionPrefixes[0]?.length ?? 0],
		);
		for (const row of [
			...slots.rows,
			...publications.rows,
			...subscriptions.rows,
		]) {
			found.push(`${database}: ${String(row.name)}`);
		}
	}
	return found;
}

// ── the recorded pgoutput scenario ──────────────────────────────────────────

// public-contract: namespace the recorded pgoutput fixture was captured in; the bytes carry it.
export const PGOUTPUT_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;

/**
 * Run `body` holding the server-wide lock on the fixture namespace.
 *
 * Every other namespace a test uses is random, so two runs against one server
 * never meet. The fixture's cannot be: the recorded bytes carry its name. Two
 * runs recording at once would drop each other's tables and slot, and each
 * would count the other's as a leak. A session advisory lock, held on one
 * connection for as long as `body` runs, takes them in turn.
 */
async function withFixtureLock<T>(
	pool: pg.Pool,
	body: () => Promise<T>,
): Promise<T> {
	const key = `hobo-test:${FIXTURE_NAMESPACE}`;
	const session = await pool.connect();
	try {
		await session.query("SELECT pg_advisory_lock(hashtext($1::text))", [key]);
		try {
			return await body();
		} finally {
			await session.query("SELECT pg_advisory_unlock(hashtext($1::text))", [
				key,
			]);
		}
	} finally {
		session.release();
	}
}
// public-contract: subscription name used to record the pgoutput fixture.
export const PGOUTPUT_FIXTURE_SUBSCRIPTION = "fixture_reader";

/** A value long enough to be stored out of line once compression is off. */
export const LARGE_NOTE = Array.from(
	{ length: 60 },
	(_, index) =>
		`chunk-${String(index).padStart(4, "0")}-abcdefghijklmnopqrstuvwxyz`,
).join("|");

/**
 * Drive a fixed sequence of writes against a live server and return the raw
 * `pgoutput` messages it emitted, as hex. This is how the checked-in fixture
 * was recorded, and the live lane re-runs it to prove the fixture still
 * describes what a real server sends.
 *
 * Some steps go around the binding on purpose — a key-changing UPDATE, an
 * UPDATE that leaves a large value untouched, a full replica identity, a
 * TRUNCATE with the guard disabled — because those are exactly the messages
 * a binding-only workload never produces and a decoder still has to survive.
 */
export function recordPgOutputScenario(
	pool: pg.Pool,
): Promise<readonly string[]> {
	claimNamespace(PGOUTPUT_FIXTURE_NAMESPACE);
	return withFixtureLock(pool, () => recordScenario(pool));
}

async function recordScenario(pool: pg.Pool): Promise<readonly string[]> {
	const namespace = PGOUTPUT_FIXTURE_NAMESPACE;
	const executor = createPgExecutor(pool);
	await pool.query(
		`DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`,
	);
	const engine = createPostgresEngine({
		executor,
		namespace,
		ephemeral: true,
		clock: () => NOW,
	});
	try {
		const schema = EVERY_TYPE_SCHEMA;
		const table = `${quoteIdentifier(namespace)}.${quoteIdentifier(schema.name)}`;
		await engine.datasets.ensureDataset(schema);
		// Store `note` out of line without compression, so a modest value is
		// enough to exercise the unchanged-value placeholder.
		await pool.query(
			`ALTER TABLE ${table} ALTER COLUMN note SET STORAGE EXTERNAL`,
		);
		const capture = engine.capture;
		if (capture === undefined) throw new Error("capture port missing");
		await capture.stop(PGOUTPUT_FIXTURE_SUBSCRIPTION);
		await capture.start({
			scope: { dataset: schema.name, tenant: "" },
			subscription: PGOUTPUT_FIXTURE_SUBSCRIPTION,
		});
		const write = (mutations: readonly ScenarioUpsert[]) =>
			engine.records.write({
				dataset: schema.name,
				mutations: mutations.map(upsertOf),
			});
		// 1. insert through the binding: every canonical type.
		await write([{ tenant: "", overrides: {} }]);
		// 2. update through the binding.
		await write([{ tenant: "", overrides: { qty: "-9223372036854775808" } }]);
		// 3. one transaction, three changes, two tenants, with NULLs.
		await engine.records.write({
			dataset: schema.name,
			mutations: [
				upsertOf({
					tenant: "tenant-b",
					overrides: { id: "order-2", note: null, card: null },
				}),
				upsertOf({ tenant: "tenant-a", overrides: { id: "order-3" } }),
				{ tenant: "tenant-a", key: '["order-3"]', op: "delete" },
			],
		});
		// 4. a write to another table: the server sends nothing for it.
		await pool.query(
			`CREATE TABLE ${quoteIdentifier(namespace)}.unrelated (x integer)`,
		);
		await pool.query(
			`INSERT INTO ${quoteIdentifier(namespace)}.unrelated VALUES (1)`,
		);
		// 5. a native key-changing update: old key image, then the new row.
		await pool.query(
			`UPDATE ${table} SET id = 'order-2-moved' WHERE tenant_id = 'tenant-b' AND id = 'order-2'`,
		);
		// 6. a large out-of-line value, then a native update that leaves it
		//    untouched: the new row carries a placeholder instead of the value.
		await write([
			{ tenant: "", overrides: { id: "order-4", note: LARGE_NOTE } },
		]);
		await pool.query(
			`UPDATE ${table} SET qty = 41 WHERE tenant_id = '' AND id = 'order-4'`,
		);
		// 7. full replica identity: the old image now carries every column.
		await pool.query(`ALTER TABLE ${table} REPLICA IDENTITY FULL`);
		await pool.query(
			`UPDATE ${table} SET qty = 42 WHERE tenant_id = '' AND id = 'order-4'`,
		);
		await pool.query(
			`DELETE FROM ${table} WHERE tenant_id = '' AND id = 'order-4'`,
		);
		await pool.query(`ALTER TABLE ${table} REPLICA IDENTITY DEFAULT`);
		// 8. delete through the binding: key image only.
		await engine.records.write({
			dataset: schema.name,
			mutations: [{ tenant: "", key: '["order-1"]', op: "delete" }],
		});
		// 9. a truncate, possible only with the guard disabled.
		await pool.query(
			`ALTER TABLE ${table} DISABLE TRIGGER hobo_truncate_guard`,
		);
		await pool.query(`TRUNCATE ${table}`);

		const database = await pool.query(
			"SELECT current_database()::text AS database",
		);
		const objects = captureObjectNames(
			String(database.rows[0]?.database ?? ""),
			namespace,
			PGOUTPUT_FIXTURE_SUBSCRIPTION,
		);
		const client = await pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT set_config('TimeZone', 'UTC', true), set_config('DateStyle', 'ISO, YMD', true), set_config('extra_float_digits', '1', true), set_config('bytea_output', 'hex', true)",
			);
			const changes = await client.query(
				"SELECT encode(data, 'hex') AS data FROM pg_logical_slot_peek_binary_changes($1::name, NULL, NULL, 'proto_version', '1', 'publication_names', $2::text)",
				[objects.slot, objects.publication],
			);
			await client.query("COMMIT");
			return changes.rows.map((row) => String(row.data));
		} finally {
			client.release();
		}
	} finally {
		await engine.close();
	}
}

interface ScenarioUpsert {
	readonly tenant: string;
	readonly overrides: { readonly [field: string]: string | number | null };
}

function upsertOf(input: ScenarioUpsert) {
	const raw = { ...EVERY_TYPE_RECORD, ...input.overrides };
	return {
		tenant: input.tenant,
		key: JSON.stringify([raw.id]),
		op: "upsert" as const,
		record: raw,
	};
}

/** The fixture file's contents: where the bytes came from, and the bytes. */
export interface RecordedPgOutput {
	readonly recordedFrom: string;
	readonly scenario: string;
	readonly messages: readonly string[];
}

function plain(tuple: PgOutputTuple | undefined) {
	if (tuple === undefined) return undefined;
	return Object.fromEntries(
		[...tuple].map(([column, cell]) => [
			column,
			cell.kind === "text" ? cell.text : `<${cell.kind}>`,
		]),
	);
}

/**
 * What a message stream means, with everything that differs between two
 * recordings of the same scenario (positions, transaction ids, object ids,
 * commit times) left out.
 */
export function summarizePgOutput(messages: readonly string[]) {
	const decoded = decodePgOutputTransactions(
		messages.map((hex) => Buffer.from(hex, "hex")),
	);
	return decoded.transactions.map((transaction) =>
		transaction.changes.map((change) =>
			change.op === "truncate"
				? { op: change.op, relations: change.relations.map((r) => r.name) }
				: {
						op: change.op,
						relation: `${change.relation.namespace}.${change.relation.name}`,
						replicaIdentity: change.relation.replicaIdentity,
						oldImage: change.op === "insert" ? undefined : change.oldImage,
						old: change.op === "insert" ? undefined : plain(change.old),
						row: change.op === "delete" ? undefined : plain(change.row),
					},
		),
	);
}
