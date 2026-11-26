// Live regressions for defects a review confirmed in the binding. Gated on
// HOBO_TEST_POSTGRES_URL like the other live lanes; the pure halves are in
// engine-hardening.test.ts. Each test names the failure it prevents.
//
// Roles are cluster-wide, so the ones created here carry a random suffix and
// are dropped — with everything granted to them — when the suite ends.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	type Awaitable,
	CUSTODY_ROLES,
	canonicalEncode,
	createMemoryMigrationJournal,
	DataCoreError,
	type DatasetSchema,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	FencedWriteError,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	requirePort,
	runSnapshotAndTail,
	scopeOf,
	sha256Hex,
	upsertMutation,
} from "@hobo/data-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	createPgExecutor,
	createPostgresEngine,
	FENCED_WRITE_SQLSTATE,
	type PostgresEngine,
	type PostgresExecutor,
	quoteIdentifier,
	SCHEMA_SNAPSHOT_REFUSALS,
	SLOT_PROBE,
	SLOT_SETTLED,
	sqlStateOf,
} from "../src/index.js";
import {
	freshNamespace,
	LIVE_URL,
	type LiveHarness,
	leftoverCaptureObjects,
	livePool,
	NOW,
	postgresHarness,
} from "./engine-support.js";

const EVENTS: DatasetSchema = parseDatasetSchema({
	name: "hobo_hard_events",
	version: 1,
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "at", type: "timestamp", nullable: false },
		{ name: "on_day", type: "date", nullable: false },
		{ name: "attrs", type: "json", nullable: true },
	],
});

function event(id: string, at: string, onDay = "2026-01-01") {
	const record = parseCanonicalRecord(EVENTS, {
		id,
		at,
		on_day: onDay,
		attrs: null,
	});
	return upsertMutation("", encodeRecordKey(EVENTS, record), record);
}

const INSUFFICIENT_PRIVILEGE = "42501";

async function rejection<T>(action: () => Awaitable<T>): Promise<Error> {
	try {
		await action();
	} catch (cause) {
		if (cause instanceof Error) return cause;
		throw cause;
	}
	throw new Error("expected the action to be refused, but it succeeded");
}

describe.skipIf(!LIVE_URL)(
	"PostgreSQL engine binding — hardening, live",
	() => {
		let pool: pg.Pool;
		let harness: LiveHarness;
		const opened: PostgresEngine[] = [];
		const roles: string[] = [];
		const schemas: string[] = [];
		const suffix = randomUUID().replaceAll("-", "").slice(0, 10);

		const open = (): PostgresEngine => {
			const binding = harness.open();
			opened.push(binding);
			return binding;
		};
		const table = (binding: PostgresEngine, name: string): string =>
			`${quoteIdentifier(binding.namespace)}.${quoteIdentifier(name)}`;

		/** A role that can write one dataset table and nothing else. */
		const writerRole = async (
			binding: PostgresEngine,
			dataset: string,
		): Promise<string> => {
			const role = `hobo_role_${suffix}_${roles.length}`;
			await pool.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN`);
			roles.push(role);
			await pool.query(
				`GRANT USAGE ON SCHEMA ${quoteIdentifier(binding.namespace)} TO ${quoteIdentifier(role)}`,
			);
			await pool.query(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table(binding, dataset)} TO ${quoteIdentifier(role)}`,
			);
			return role;
		};

		/** Run statements on one session, as a role, inside a rolled-back transaction. */
		const asRole = async <T>(
			role: string,
			body: (client: pg.PoolClient) => Promise<T>,
		): Promise<T> => {
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query(`SET LOCAL ROLE ${quoteIdentifier(role)}`);
				return await body(client);
			} finally {
				await client.query("ROLLBACK").catch(() => undefined);
				client.release();
			}
		};

		beforeAll(() => {
			pool = livePool(4);
			harness = postgresHarness(pool);
		});

		afterAll(async () => {
			for (const binding of opened) await binding.close();
			for (const schema of schemas) {
				await pool.query(
					`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
				);
			}
			for (const role of roles) {
				await pool.query(`DROP OWNED BY ${quoteIdentifier(role)}`);
				await pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
			}
			const leftovers = await leftoverCaptureObjects(pool);
			await pool.end();
			assert.deepEqual(leftovers, []);
		});

		// ── 1. years 0001–0099 ──────────────────────────────────────────────────

		test("a first-century timestamp round-trips through every port that reads (one such record made the dataset unreadable)", async () => {
			const binding = open();
			await binding.datasets.ensureDataset(EVENTS);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(EVENTS.name);
			const start = await capture.start({ scope, subscription: "early" });
			const written = [
				event("y1", "0001-01-01T00:00:00Z", "0001-01-01"),
				event("y99", "0099-12-31T23:59:59.999999Z", "0099-12-31"),
				// Normalises to 0001-01-01T00:00:00Z: still inside year 1.
				event("y1-offset", "0001-01-01T02:00:00+02:00", "0042-02-28"),
				event("modern", "2026-01-02T03:04:05.678901Z"),
			];
			await binding.records.write({ dataset: EVENTS.name, mutations: written });
			// records.read
			for (const mutation of written) {
				const read = await binding.records.read({
					dataset: EVENTS.name,
					tenant: "",
					key: mutation.key,
				});
				assert.equal(
					canonicalEncode(read ?? null),
					canonicalEncode(mutation.record ?? null),
					mutation.key,
				);
			}
			// openSnapshot
			const cursor = await requirePort(binding, "snapshot").openSnapshot({
				scope,
				chunkSize: 10,
			});
			const scanned = (await cursor.next()) ?? [];
			await cursor.close();
			assert.equal(scanned.length, 4);
			// verify.digest
			const digest = await requirePort(binding, "verify").digest({
				scope,
				buckets: 4,
			});
			assert.equal(digest.count, 4);
			// capture.read: the decoded text of the same values.
			const batch = await capture.read({
				scope,
				subscription: "early",
				after: start,
				limit: 10,
			});
			assert.deepEqual(
				batch.changes.map((change) => change.record?.at),
				written.map((mutation) => mutation.record?.at),
			);
			await capture.stop("early");
			// apply, then retire: both read the scope back.
			await requirePort(binding, "apply").apply({
				dataset: EVENTS.name,
				changes: [event("applied", "0007-07-07T07:07:07.000007Z")],
				source: "s",
				position: "1",
			});
			const fence = requirePort(binding, "fence");
			const grant = await fence.raise({ scope, reason: "live" });
			const receipt = await requirePort(binding, "retire").retire({
				scope,
				fenceToken: grant.fenceToken,
				expected: await requirePort(binding, "verify").digest({
					scope,
					buckets: 4,
				}),
			});
			assert.equal(receipt.removed, 5);
		}, 60_000);

		test("year 0000 has no place in PostgreSQL: it is refused when written, and nothing is stored", async () => {
			const binding = open();
			await binding.datasets.ensureDataset(EVENTS);
			for (const mutation of [
				event("zero", "0000-06-15T12:00:00Z"),
				// One second into year 1 at +02:00 is still year 0000 in UTC.
				event("zero-by-offset", "0001-01-01T00:00:01+02:00"),
				event("zero-date", "2026-01-01T00:00:00Z", "0000-03-01"),
			]) {
				const refused = await rejection(() =>
					binding.records.write({
						dataset: EVENTS.name,
						mutations: [event("good", "2026-01-01T00:00:00Z"), mutation],
					}),
				);
				assert.ok(refused instanceof DataCoreError, mutation.key);
				assert.equal(refused.code, "INVALID_RECORD", mutation.key);
			}
			const digest = await requirePort(binding, "verify").digest({
				scope: scopeOf(EVENTS.name),
				buckets: 4,
			});
			assert.equal(digest.count, 0, "a refused write leaves nothing behind");
		}, 60_000);

		// ── 2. a key stored out of line ─────────────────────────────────────────

		test("capture survives an update of a row whose key is stored out of line (it threw for ever after)", async () => {
			const binding = open();
			await binding.datasets.ensureDataset(EVENTS);
			const capture = requirePort(binding, "capture");
			const scope = scopeOf(EVENTS.name);
			const start = await capture.start({ scope, subscription: "large" });
			// 2,500 characters with no repetition to compress away.
			const id = Array.from({ length: 40 }, (_, index) =>
				sha256Hex(`large-key-${index}`),
			)
				.join("")
				.slice(0, 2_500);
			const external = await pool.query(
				`SELECT 1 AS toasted FROM pg_class c WHERE c.oid = '${table(binding, EVENTS.name)}'::regclass AND c.reltoastrelid <> 0`,
			);
			assert.equal(
				external.rows.length,
				1,
				"the table has out-of-line storage",
			);
			await binding.records.write({
				dataset: EVENTS.name,
				mutations: [event(id, "2026-01-01T00:00:00Z")],
			});
			// An update of a non-key field: the server sends a placeholder for the
			// key in the new row and the value in the old-key image.
			await binding.records.write({
				dataset: EVENTS.name,
				mutations: [event(id, "2026-02-02T00:00:00Z")],
			});
			await binding.records.write({
				dataset: EVENTS.name,
				mutations: [event("after", "2026-03-03T00:00:00Z")],
			});
			const batch = await capture.read({
				scope,
				subscription: "large",
				after: start,
				limit: 10,
			});
			assert.deepEqual(
				batch.changes.map((change) => [
					change.key === canonicalEncode([id]) ? "large" : change.key,
					change.record?.at,
				]),
				[
					["large", "2026-01-01T00:00:00.000000Z"],
					["large", "2026-02-02T00:00:00.000000Z"],
					['["after"]', "2026-03-03T00:00:00.000000Z"],
				],
			);
			await capture.stop("large");
		}, 60_000);

		// ── 3. the fence and a role that only writes ────────────────────────────

		test("a writing role needs nothing on the metadata tables, and cannot read a token, shadow an operator, or lock the registry", async () => {
			const binding = open();
			await binding.datasets.ensureDataset(EVENTS);
			const items = table(binding, EVENTS.name);
			const metadata = (name: string): string =>
				`${quoteIdentifier(binding.namespace)}.${quoteIdentifier(name)}`;
			const role = await writerRole(binding, EVENTS.name);
			const insert = (id: string): string =>
				`INSERT INTO ${items} (tenant_id, id, at, on_day) VALUES ('', '${id}', now(), current_date)`;

			// Unfenced, the role writes — with no grant on any metadata table.
			await asRole(role, (client) => client.query(insert("free")));

			const fence = requirePort(binding, "fence");
			const scope = scopeOf(EVENTS.name);
			const grant = await fence.raise({ scope, reason: "live" });

			// Fenced, it is refused.
			const refused = await rejection(() =>
				asRole(role, (client) => client.query(insert("fenced"))),
			);
			assert.equal(sqlStateOf(refused), FENCED_WRITE_SQLSTATE);

			// It cannot read the token it would need to present…
			const read = await rejection(() =>
				asRole(role, (client) =>
					client.query(`SELECT token FROM ${metadata("hobo_data_fences")}`),
				),
			);
			assert.equal(sqlStateOf(read), INSUFFICIENT_PRIVILEGE);
			// …and a token it guesses is not the token.
			const guessed = await rejection(() =>
				asRole(role, async (client) => {
					await client.query(
						"SELECT set_config('hobo.fence_token', 'fence:guess', true)",
					);
					return client.query(insert("guessed"));
				}),
			);
			assert.equal(sqlStateOf(guessed), FENCED_WRITE_SQLSTATE);

			// It cannot make the trigger's comparisons mean something else.
			const evil = `hobo_evil_${suffix}`;
			schemas.push(evil);
			await pool.query(`CREATE SCHEMA ${quoteIdentifier(evil)}`);
			await pool.query(
				`CREATE FUNCTION ${quoteIdentifier(evil)}.never(text, name) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT false'`,
			);
			await pool.query(
				`CREATE OPERATOR ${quoteIdentifier(evil)}.= (LEFTARG = text, RIGHTARG = name, FUNCTION = ${quoteIdentifier(evil)}.never)`,
			);
			await pool.query(
				`GRANT USAGE ON SCHEMA ${quoteIdentifier(evil)} TO ${quoteIdentifier(role)}`,
			);
			const shadowed = await rejection(() =>
				asRole(role, async (client) => {
					await client.query(
						`SET LOCAL search_path = ${quoteIdentifier(evil)}, pg_catalog`,
					);
					// The shadow really is in effect for the session's own SQL.
					const own = await client.query(
						"SELECT ('a'::text = 'a'::name)::text AS same",
					);
					assert.equal(own.rows[0]?.same, "false");
					return client.query(insert("shadowed"));
				}),
			);
			assert.equal(sqlStateOf(shadowed), FENCED_WRITE_SQLSTATE);

			// It cannot hold the lock `raise` waits on.
			const locked = await rejection(() =>
				asRole(role, (client) =>
					client.query(
						`SELECT dataset FROM ${metadata("hobo_data_datasets")} FOR SHARE`,
					),
				),
			);
			assert.equal(sqlStateOf(locked), INSUFFICIENT_PRIVILEGE);
			// Nor lift the fence, nor plant one.
			for (const statement of [
				`DELETE FROM ${metadata("hobo_data_fences")}`,
				`INSERT INTO ${metadata("hobo_data_fences")} (dataset, tenant, token, reason) VALUES ('x', '', 't', 'r')`,
			]) {
				const denied = await rejection(() =>
					asRole(role, (client) => client.query(statement)),
				);
				assert.equal(sqlStateOf(denied), INSUFFICIENT_PRIVILEGE, statement);
			}

			// The token holder still writes through, and the binding still refuses.
			await binding.records.write({
				dataset: EVENTS.name,
				mutations: [event("authority", "2026-01-01T00:00:00Z")],
				fenceToken: grant.fenceToken,
			});
			const viaBinding = await rejection(() =>
				binding.records.write({
					dataset: EVENTS.name,
					mutations: [event("late", "2026-01-01T00:00:00Z")],
				}),
			);
			assert.ok(viaBinding instanceof FencedWriteError);
			await fence.release({ scope, fenceToken: grant.fenceToken });
			await asRole(role, (client) => client.query(insert("after-release")));
		}, 60_000);

		test("a namespace bootstrapped before the hardening is brought up to it by the next binding", async () => {
			const namespace = freshNamespace();
			const first = createPostgresEngine({
				executor: harness.executor,
				namespace,
				ephemeral: true,
			});
			opened.push(first);
			await first.datasets.ensureDataset(EVENTS);
			const guard = `${quoteIdentifier(namespace)}.hobo_fence_guard()`;
			const fences = `${quoteIdentifier(namespace)}.hobo_data_fences`;
			// Put the namespace back the way an older binding left it.
			await pool.query(`ALTER FUNCTION ${guard} SECURITY INVOKER`);
			await pool.query(`ALTER FUNCTION ${guard} RESET search_path`);
			await pool.query(`GRANT SELECT ON ${fences} TO PUBLIC`);
			await pool.query(
				`COMMENT ON FUNCTION ${quoteIdentifier(namespace)}.hobo_truncate_guard() IS 'hobo-data-postgres bootstrap 1'`,
			);
			const state = async () => {
				const found = await pool.query(
					`SELECT p.prosecdef::text AS definer, coalesce(array_to_string(p.proconfig, ','), '') AS config, has_table_privilege('public', '${fences}', 'SELECT')::text AS readable FROM pg_proc p WHERE p.oid = '${guard}'::regprocedure`,
				);
				return found.rows[0];
			};
			assert.deepEqual(await state(), {
				definer: "false",
				config: "",
				readable: "true",
			});
			const second = createPostgresEngine({
				executor: harness.executor,
				namespace,
			});
			assert.equal(
				(await second.datasets.ensureDataset(EVENTS)).created,
				false,
			);
			assert.deepEqual(await state(), {
				definer: "true",
				config: "search_path=pg_catalog, pg_temp",
				readable: "false",
			});
		}, 60_000);

		// ── 4. schema snapshots ─────────────────────────────────────────────────

		test("a snapshot refuses a table another role owns, and a table in a publication (a restore silently changed both)", async () => {
			const namespace = freshNamespace();
			const binding = createPostgresEngine({
				executor: harness.executor,
				namespace,
				ephemeral: true,
				schemaTables: ["hobo_hard_accounts"],
				clock: () => NOW,
			});
			opened.push(binding);
			const port = requirePort(binding, "schema");
			await port.applyPhase("expand", [
				"CREATE TABLE hobo_hard_accounts (id bigint PRIMARY KEY, email text NOT NULL)",
				"INSERT INTO hobo_hard_accounts VALUES (1, 'a@example.test')",
			]);
			const accounts = `${quoteIdentifier(namespace)}.hobo_hard_accounts`;
			// An ordinary table of the binding's own snapshots and restores.
			const plain = await port.snapshot();
			await port.restore(plain);
			await binding.dropSchemaSnapshot(plain);

			// Published: a restore would recreate it outside the publication.
			const publication = `hobo_hard_pub_${suffix}`;
			await pool.query(
				`CREATE PUBLICATION ${quoteIdentifier(publication)} FOR TABLE ${accounts}`,
			);
			try {
				const published = await rejection(() =>
					Promise.resolve(port.snapshot()),
				);
				assert.ok(published instanceof DataCoreError);
				assert.equal(published.code, "INVALID_MIGRATION_PLAN");
				assert.ok(
					published.message.includes(
						SCHEMA_SNAPSHOT_REFUSALS.publication.split(":")[0] ?? "",
					),
					published.message,
				);
			} finally {
				await pool.query(
					`DROP PUBLICATION IF EXISTS ${quoteIdentifier(publication)}`,
				);
			}

			// Published through its schema (PostgreSQL 15 and later): the same.
			await pool.query(
				`CREATE PUBLICATION ${quoteIdentifier(publication)} FOR TABLES IN SCHEMA ${quoteIdentifier(namespace)}`,
			);
			try {
				const bySchema = await rejection(() =>
					Promise.resolve(port.snapshot()),
				);
				assert.ok(bySchema instanceof DataCoreError);
				assert.ok(
					bySchema.message.includes(
						SCHEMA_SNAPSHOT_REFUSALS.publication.split(":")[0] ?? "",
					),
					bySchema.message,
				);
			} finally {
				await pool.query(
					`DROP PUBLICATION IF EXISTS ${quoteIdentifier(publication)}`,
				);
			}
			// Not published any more: it snapshots again.
			await binding.dropSchemaSnapshot(await port.snapshot());

			// Owned by another role: a restore would hand it to the restoring role.
			const owner = `hobo_role_${suffix}_owner`;
			await pool.query(`CREATE ROLE ${quoteIdentifier(owner)} NOLOGIN`);
			roles.push(owner);
			await pool.query(
				`GRANT USAGE, CREATE ON SCHEMA ${quoteIdentifier(namespace)} TO ${quoteIdentifier(owner)}`,
			);
			await pool.query(
				`ALTER TABLE ${accounts} OWNER TO ${quoteIdentifier(owner)}`,
			);
			const foreign = await rejection(() => Promise.resolve(port.snapshot()));
			assert.ok(foreign instanceof DataCoreError);
			assert.ok(
				foreign.message.includes(
					SCHEMA_SNAPSHOT_REFUSALS.owner.split(":")[0] ?? "",
				),
				foreign.message,
			);
			// Nothing was copied for either refusal.
			const copies = await pool.query(
				"SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'hobo_snap_%' AND nspname IN (SELECT snapshot_ref FROM " +
					`${quoteIdentifier(namespace)}.hobo_data_schema_snapshots)`,
			);
			assert.equal(copies.rows[0]?.n, 0);
			await pool.query(`ALTER TABLE ${accounts} OWNER TO CURRENT_USER`);
		}, 60_000);

		// ── 5 and 6. open fields and jsonb numbers ──────────────────────────────

		test("an undeclared field named __proto__ is stored and read back (it was dropped both ways)", async () => {
			const schema = parseDatasetSchema({
				name: "hobo_hard_open",
				version: 1,
				open: true,
				keyFields: ["id"],
				fields: [{ name: "id", type: "string", nullable: false }],
			});
			const binding = open();
			await binding.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(
				schema,
				Object.fromEntries([
					["id", "a"],
					["__proto__", { nested: [1, "two"] }],
					["constructor", "c"],
				]),
			);
			const key = encodeRecordKey(schema, record);
			await binding.records.write({
				dataset: schema.name,
				mutations: [upsertMutation("", key, record)],
			});
			const stored = await pool.query(
				`SELECT hobo_extra::text AS extra FROM ${table(binding, schema.name)}`,
			);
			assert.deepEqual(JSON.parse(String(stored.rows[0]?.extra)), {
				["__proto__"]: { nested: [1, "two"] },
				constructor: "c",
			});
			const read = await binding.records.read({
				dataset: schema.name,
				tenant: "",
				key,
			});
			assert.ok(read !== undefined && Object.hasOwn(read, "__proto__"));
			assert.equal(canonicalEncode(read), canonicalEncode(record));
		}, 60_000);

		test("a natively written jsonb number beyond float64 is refused on read (it read as null)", async () => {
			const binding = open();
			await binding.datasets.ensureDataset(EVENTS);
			const written = event("n", "2026-01-01T00:00:00Z");
			await binding.records.write({
				dataset: EVENTS.name,
				mutations: [written],
			});
			const read = async () =>
				binding.records.read({
					dataset: EVENTS.name,
					tenant: "",
					key: written.key,
				});
			// A number float64 holds only approximately reads as the nearest one.
			await pool.query(
				`UPDATE ${table(binding, EVENTS.name)} SET attrs = '{"n": 0.1000000000000000000000001}'::jsonb`,
			);
			assert.deepEqual(Object(await read()).attrs, { n: 0.1 });
			// One beyond its range has no canonical form at all.
			await pool.query(
				`UPDATE ${table(binding, EVENTS.name)} SET attrs = '{"n": 1e400}'::jsonb`,
			);
			const refused = await rejection(read);
			assert.ok(refused instanceof DataCoreError);
			assert.equal(refused.code, "INVALID_RECORD");
			const digest = await rejection(() =>
				Promise.resolve(
					requirePort(binding, "verify").digest({
						scope: scopeOf(EVENTS.name),
						buckets: 4,
					}),
				),
			);
			assert.ok(digest instanceof DataCoreError);
		}, 60_000);

		// ── 7. retirement and the log ───────────────────────────────────────────

		test("retiring the source is logged as deletes, and a migration's own target never receives them", async () => {
			const source = open();
			const target = open();
			await source.datasets.ensureDataset(EVENTS);
			await source.records.write({
				dataset: EVENTS.name,
				mutations: Array.from({ length: 25 }, (_, index) =>
					event(`e-${index}`, "2026-01-01T00:00:00Z"),
				),
			});
			// Somebody else's subscription on the same dataset, alive throughout.
			const scope = scopeOf(EVENTS.name);
			const audit = requirePort(source, "capture");
			const start = await audit.start({ scope, subscription: "audit" });
			const result = await runSnapshotAndTail({
				runtime: {
					migrationId: "retire",
					journal: createMemoryMigrationJournal(),
					clock: () => NOW,
					policy: () =>
						evaluateCustodyPath({
							// One point per role: the run holds on a path that leaves out
							// a copy it creates.
							path: parseCustodyPath({
								points: CUSTODY_ROLES.map((role) => ({
									id: role,
									role,
									region: "eu-west-1",
									protections: [],
									...(role === "source" ||
									role === "target" ||
									role === "event-log"
										? undefined
										: { retainUntil: "2099-01-01T00:00:00.000Z" }),
								})),
							}),
							policy: { classification: "public" },
							now: NOW,
						}),
				},
				source,
				target,
				schema: EVENTS,
				scope,
				flipAuthority: () => {},
			});
			assert.equal(result.status, "completed", result.reason);
			const count = async (binding: EngineBinding): Promise<number> =>
				(await requirePort(binding, "verify").digest({ scope, buckets: 4 }))
					.count;
			assert.equal(await count(source), 0);
			// The new authority holds every record: the retirement did not follow
			// the data across.
			assert.equal(await count(target), 25);
			// The log did record it, as the engine declares
			// (POSTGRES_RETIRE_IS_LOGGED_AS_DELETES): a reader that is still
			// subscribed sees 25 deletes.
			let position = start;
			let deletes = 0;
			for (let round = 0; round < 100; round += 1) {
				const batch = await audit.read({
					scope,
					subscription: "audit",
					after: position,
					limit: 50,
				});
				deletes += batch.changes.filter(
					(change) => change.op === "delete",
				).length;
				position = batch.position;
				if (batch.caughtUp) break;
			}
			assert.equal(deletes, 25);
			await audit.stop("audit");
			// The migration's own forward subscription is gone: the registry holds
			// nothing for it.
			const remaining = await pool.query(
				`SELECT subscription FROM ${quoteIdentifier(source.namespace)}.hobo_data_subscriptions`,
			);
			assert.deepEqual(remaining.rows, []);
		}, 120_000);

		// ── 8. a slot created at a bad moment ───────────────────────────────────

		test("a slot created while another session creates a table and writes to it is replaced before anyone reads it (every read of it failed for ever: could not map filenumber)", async () => {
			// The choreography below is the whole cause, on tables this binding
			// has nothing to do with. While the slot is being created:
			//   C creates a table and stays open past the point where the slot
			//     starts tracking catalog changes, so the slot never learns of it;
			//   T writes to that table before the slot is consistent, and commits
			//     after — so the slot decodes T, with a catalog that has no such
			//     table, and the server gives up: SQLSTATE XX000.
			// A and D are only there to hold the slot in each stage long enough.
			const bindingPool = livePool(1);
			const sessions = livePool(4);
			const foreign = `hobo_meanwhile_${suffix}`;
			schemas.push(foreign);
			const made = `${quoteIdentifier(foreign)}.made_meanwhile`;
			const other = `${quoteIdentifier(foreign)}.other`;
			const issued: string[] = [];
			const watch = (inner: PostgresExecutor): PostgresExecutor => ({
				query(sql, parameters = []) {
					issued.push(sql);
					return inner.query(sql, parameters);
				},
				transaction: (body) => inner.transaction((tx) => body(watch(tx))),
			});
			const times = (sql: string): number =>
				issued.filter((entry) => entry === sql || entry.includes(sql)).length;
			const until = async (
				what: string,
				holds: () => Promise<boolean>,
			): Promise<void> => {
				for (let round = 0; round < 400; round += 1) {
					if (await holds()) return;
					await new Promise((resolve) => {
						setTimeout(resolve, 25);
					});
				}
				throw new Error(`timed out waiting until ${what}`);
			};
			const binding = createPostgresEngine({
				executor: watch(createPgExecutor(bindingPool)),
				namespace: freshNamespace(),
				ephemeral: true,
				clock: () => NOW,
				nativePollIntervalMs: 10,
			});
			const [a, c, d, t] = await Promise.all([
				sessions.connect(),
				sessions.connect(),
				sessions.connect(),
				sessions.connect(),
			]);
			const xidOf = async (session: pg.PoolClient): Promise<string> => {
				const result = await session.query(
					"SELECT pg_current_xact_id()::text AS xid",
				);
				return String(result.rows[0]?.xid ?? "");
			};
			try {
				await pool.query(`CREATE SCHEMA ${quoteIdentifier(foreign)}`);
				await pool.query(`CREATE TABLE ${other} (id integer)`);
				await binding.datasets.ensureDataset(EVENTS);
				const backend = await bindingPool.query(
					"SELECT pg_backend_pid()::text AS pid",
				);
				const pid = String(backend.rows[0]?.pid ?? "");
				const waitingOn = async (xids: readonly string[]): Promise<boolean> => {
					const found = await pool.query(
						"SELECT 1 FROM pg_locks WHERE pid = $1::integer AND NOT granted AND locktype = 'transactionid' AND transactionid::text = ANY($2::text[])",
						[pid, xids],
					);
					return found.rows.length > 0;
				};

				await a.query("BEGIN");
				await a.query(`INSERT INTO ${other} VALUES (1)`);
				const scope = scopeOf(EVENTS.name);
				const capture = requirePort(binding, "capture");
				const starting = capture.start({ scope, subscription: "meanwhile" });
				// A failure below must not leave this as an unhandled rejection.
				starting.catch(() => undefined);
				await until("the slot waits for the first open transaction", async () =>
					waitingOn([await xidOf(a)]),
				);
				await c.query("BEGIN");
				await c.query(`CREATE TABLE ${made} (id integer PRIMARY KEY)`);
				await d.query("BEGIN");
				await d.query(`INSERT INTO ${other} VALUES (2)`);
				const later = [await xidOf(c), await xidOf(d)];
				await a.query("COMMIT");
				// The slot now has a full snapshot and waits for C and D — the
				// transactions that were open when it got one.
				await until(
					"the slot waits for the transactions open at its snapshot",
					() => waitingOn(later),
				);
				await c.query("COMMIT");
				await t.query("BEGIN");
				await t.query(`INSERT INTO ${made} VALUES (1)`);
				await d.query("COMMIT");
				// The slot is consistent and the server has answered. The binding
				// now waits for T, which was open at that moment, before it
				// decodes anything.
				await until(
					"the binding asks whether open transactions have ended",
					async () => times(SLOT_SETTLED) > 0,
				);
				assert.equal(
					times(SLOT_PROBE),
					0,
					"nothing is decoded while T is open",
				);
				await t.query("COMMIT");

				const position = await starting;
				const created = times("pg_create_logical_replication_slot");
				const probes = times(SLOT_PROBE);
				assert.ok(probes >= 1, "the slot was proven before being answered");
				assert.equal(created, probes, "every slot created was probed");
				console.info(
					`live slot proof: ${created} slot(s) created, ${probes} decoding probe(s); ${probes > 1 ? "the first slot could not decode and was replaced" : "this server decoded the first slot"}`,
				);
				// The subscription that was answered works: it reads a write made
				// after it, and keeps reading. Unproven, this read threw XX000 —
				// and so did every read after it.
				await binding.records.write({
					dataset: EVENTS.name,
					mutations: [event("after-start", "2026-01-01T00:00:00Z")],
				});
				for (let round = 0; round < 2; round += 1) {
					const batch = await capture.read({
						scope,
						subscription: "meanwhile",
						after: position,
						limit: 10,
					});
					assert.deepEqual(
						batch.changes.map((change) => change.key),
						[canonicalEncode(["after-start"])],
					);
					assert.equal(batch.caughtUp, true);
				}
				await capture.stop("meanwhile");
			} finally {
				for (const session of [a, c, d, t]) {
					await session.query("ROLLBACK").catch(() => undefined);
					session.release();
				}
				await binding.close();
				await sessions.end();
				await bindingPool.end();
			}
		}, 120_000);
	},
);
