// Shared support for the engine-binding lanes. Nothing here runs unless a
// test calls it; the live helpers are only reached when
// HOBO_TEST_POSTGRES_URL names a real server.
import {
	type DatasetSchema,
	type EngineConformanceResult,
	type EngineHarness,
	parseDatasetSchema,
} from "@hobo/data-core";
import pg from "pg";
import {
	captureObjectNames,
	createPgExecutor,
	createPostgresEngine,
	decodePgOutputTransactions,
	type PgOutputTuple,
	POSTGRES_SCHEMA_FIXTURE,
	POSTGRES_SCHEMA_FIXTURE_TABLE,
	type PostgresEngine,
	type PostgresExecutor,
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

/** A pool sized for the concurrency lane. The caller ends it. */
export function livePool(): pg.Pool {
	const pool = new pg.Pool({ connectionString: LIVE_URL, max: 12 });
	// An idle client dropped by the server is not a test failure.
	pool.on("error", () => {});
	return pool;
}

let namespaceCounter = 0;
const RUN_ID = `${Date.now().toString(36)}${process.pid.toString(36)}`;

/** A namespace no other binding in this run, or any other run, uses. */
export function freshNamespace(): string {
	namespaceCounter += 1;
	return `hobo_t_${RUN_ID}_${namespaceCounter}`;
}

export interface LiveHarness extends EngineHarness {
	readonly executor: PostgresExecutor;
	/** A binding in its own namespace, dropped on close. */
	open(options?: {
		readonly namespace?: string;
		readonly capture?: boolean;
	}): PostgresEngine;
}

/** One namespace per binding, so no two conformance cases can collide. */
export function postgresHarness(pool: pg.Pool): LiveHarness {
	const executor = createPgExecutor(pool);
	const open: LiveHarness["open"] = (options = {}) =>
		createPostgresEngine({
			executor,
			namespace: options.namespace ?? freshNamespace(),
			capture: options.capture ?? true,
			schemaTables: [POSTGRES_SCHEMA_FIXTURE_TABLE],
			ephemeral: true,
			clock: () => NOW,
		});
	return {
		executor,
		open,
		schemaFixture: POSTGRES_SCHEMA_FIXTURE,
		create: () => open(),
	};
}

/** Replication slots and publications this package's bindings own. */
export async function leftoverCaptureObjects(pool: pg.Pool): Promise<number> {
	const slots = await pool.query(
		"SELECT count(*)::text AS n FROM pg_replication_slots WHERE slot_name LIKE 'hobo\\_s\\_%'",
	);
	const publications = await pool.query(
		"SELECT count(*)::text AS n FROM pg_publication WHERE pubname LIKE 'hobo\\_p\\_%'",
	);
	return Number(slots.rows[0]?.n ?? 0) + Number(publications.rows[0]?.n ?? 0);
}

// ── the recorded pgoutput scenario ──────────────────────────────────────────

// public-contract: namespace the recorded pgoutput fixture was captured in; the bytes carry it.
export const PGOUTPUT_FIXTURE_NAMESPACE = "hobo_fixture_capture";
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
export async function recordPgOutputScenario(
	pool: pg.Pool,
): Promise<readonly string[]> {
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
