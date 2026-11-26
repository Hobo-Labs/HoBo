// The binding's declaration, option parsing, error mapping, the driver
// adapter, and the capture read loop — all without a server. The capture
// lane runs the real binding over a scripted executor that answers the
// decoding call with bytes recorded from a real one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	assertBindingMatchesDeclaration,
	CapturePositionError,
	canonicalEncode,
	DataCoreError,
	encodeRecordKey,
	engineDeclarationToJson,
	FencedWriteError,
	parseCanonicalRecord,
	parseEngineDeclaration,
	requirePort,
	SPI_PORTS,
	StaleApplyError,
	schemaToJson,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { rethrowWriteError } from "../src/engine/store.js";
import {
	CAPTURE_SESSION_SETTINGS,
	createPgExecutor,
	createPostgresEngine,
	formatLsn,
	LOGICAL_COPY_PROFILE,
	PG_DUMP_PROFILE,
	type PgClientLike,
	type PgPoolLike,
	type PgQueryResultLike,
	POSTGRES_IMPEDANCE_CODES,
	POSTGRES_MIGRATION_PROFILES,
	POSTGRES_SCHEMA_FIXTURE,
	POSTGRES_SCHEMA_FIXTURE_TABLE,
	PostgresDataError,
	type PostgresExecutor,
	type PostgresParameter,
	type PostgresQueryResult,
	type PostgresRow,
	parseLsn,
	postgresEngineDeclaration,
	sqlStateOf,
} from "../src/index.js";
import {
	EVERY_TYPE_RECORD,
	EVERY_TYPE_SCHEMA,
	PGOUTPUT_FIXTURE_NAMESPACE,
	type RecordedPgOutput,
} from "./engine-support.js";

/** An executor for bindings that must never reach a server in these tests. */
const UNREACHABLE: PostgresExecutor = {
	query: () => Promise.reject(new Error("no server in this lane")),
	transaction: () => Promise.reject(new Error("no server in this lane")),
};

function sqlError(code: string, message = "server said no"): Error {
	return Object.assign(new Error(message), { code });
}

describe("engine declaration", () => {
	test("the declaration is the contract's, with every port and an honest fence", () => {
		const declaration = postgresEngineDeclaration();
		// It survives its own wire form.
		assert.deepEqual(
			parseEngineDeclaration(engineDeclarationToJson(declaration)),
			declaration,
		);
		assert.equal(declaration.engine, "postgres");
		assert.equal(declaration.profile, "data.postgres/v1");
		assert.equal(declaration.paradigm, "relational");
		assert.deepEqual(declaration.ports, SPI_PORTS);
		assert.equal(declaration.captureOrdering, "global");
		assert.equal(declaration.fenceEnforcement, "store");
		assert.equal(declaration.snapshotConsistency, "fuzzy");
		assert.equal(declaration.ddlTransactional, true);
		// Only what the binding's native-transfer port can run. pg_dump is a
		// migration profile with argv builders, not a native realization: the
		// binding has no process runner to carry it out.
		assert.deepEqual(declaration.nativeProfiles, [
			{ profile: LOGICAL_COPY_PROFILE, pattern: "snapshot-and-tail" },
		]);
		assert.ok(POSTGRES_MIGRATION_PROFILES.includes(PG_DUMP_PROFILE));
		assert.equal(declaration.typeMapping.edges.length, 11);
	});

	test("the impedance list is closed: unique, named for this engine", () => {
		const declaration = postgresEngineDeclaration();
		assert.deepEqual(declaration.impedance, POSTGRES_IMPEDANCE_CODES);
		assert.equal(
			new Set(POSTGRES_IMPEDANCE_CODES).size,
			POSTGRES_IMPEDANCE_CODES.length,
		);
		for (const code of POSTGRES_IMPEDANCE_CODES) {
			assert.match(code, /^POSTGRES_[A-Z0-9_]+$/u);
		}
	});

	test("without capture the declaration drops the port and the fast path that needs it", () => {
		const declaration = postgresEngineDeclaration({ capture: false });
		assert.ok(!declaration.ports.includes("capture"));
		assert.equal(declaration.ports.length, SPI_PORTS.length - 1);
		assert.equal(declaration.captureOrdering, "none");
		assert.deepEqual(declaration.nativeProfiles, []);
		// Everything else is unchanged.
		assert.equal(declaration.fenceEnforcement, "store");
		assert.equal(declaration.snapshotConsistency, "fuzzy");
	});

	test("a binding provides exactly the ports it declares", async () => {
		const full = createPostgresEngine({ executor: UNREACHABLE });
		assertBindingMatchesDeclaration(full);
		assert.equal(full.namespace, "public");
		for (const port of SPI_PORTS) assert.ok(full[port] !== undefined, port);
		assert.deepEqual(full.nativeTransfer?.profiles, [LOGICAL_COPY_PROFILE]);

		const reduced = createPostgresEngine({
			executor: UNREACHABLE,
			namespace: "tenant_42",
			capture: false,
		});
		assertBindingMatchesDeclaration(reduced);
		assert.equal(reduced.capture, undefined);
		assert.equal(reduced.nativeTransfer, undefined);
		assert.throws(
			() => requirePort(reduced, "capture"),
			(cause) =>
				cause instanceof DataCoreError && cause.code === "PORT_MISSING",
		);
		// Closing a durable binding touches nothing — not even the server.
		await full.close();
		await reduced.close();
	});

	test("options are parsed, not trusted", () => {
		const invalid = [
			{ namespace: "Not-Valid" },
			{ namespace: "pg_temp" },
			{ pageSize: 0 },
			{ pageSize: 1.5 },
			{ schemaTables: ["hobo_data_fences"] },
			{ schemaTables: ['x"; DROP'] },
			// An ephemeral binding drops its namespace; it may not be `public`.
			{ ephemeral: true },
		];
		for (const options of invalid) {
			assert.throws(
				() => createPostgresEngine({ executor: UNREACHABLE, ...options }),
				(cause) =>
					cause instanceof PostgresDataError &&
					cause.code === "ENGINE_OPTIONS_INVALID",
				JSON.stringify(options),
			);
		}
	});

	test("the schema fixture names one table, unqualified", () => {
		const everything = [
			...POSTGRES_SCHEMA_FIXTURE.setup,
			...POSTGRES_SCHEMA_FIXTURE.plan.expand,
			...POSTGRES_SCHEMA_FIXTURE.plan.backfill,
			...POSTGRES_SCHEMA_FIXTURE.plan.contract,
			POSTGRES_SCHEMA_FIXTURE.failingStatement,
		];
		for (const statement of everything) {
			assert.ok(statement.includes(POSTGRES_SCHEMA_FIXTURE_TABLE), statement);
			assert.ok(
				!statement.includes(`.${POSTGRES_SCHEMA_FIXTURE_TABLE}`),
				"names resolve in the binding's namespace",
			);
		}
	});
});

describe("error mapping", () => {
	test("the fence trigger's SQLSTATE becomes FencedWriteError", () => {
		assert.throws(
			() => rethrowWriteError(sqlError("HB001"), "orders", "tenant-a"),
			(cause) => {
				assert.ok(cause instanceof FencedWriteError);
				assert.equal(cause.dataset, "orders");
				assert.equal(cause.tenant, "tenant-a");
				return true;
			},
		);
	});

	test("a value the server refused becomes INVALID_RECORD without the server's text", () => {
		for (const state of [
			"22021",
			"22P05",
			"22003",
			"22007",
			"22P02",
			"23502",
			"23514",
		]) {
			assert.throws(
				() =>
					rethrowWriteError(
						sqlError(state, "secret-value postgres://user:pw@host/db"),
						"orders",
						"",
					),
				(cause) => {
					assert.ok(cause instanceof DataCoreError, state);
					assert.equal(cause.code, "INVALID_RECORD");
					assert.equal(cause.detail.sqlState, state);
					// The server may quote the offending value; none of its text
					// is carried into an error that could be recorded.
					assert.ok(!cause.message.includes("secret-value"));
					assert.ok(!cause.message.includes("postgres://"));
					assert.equal(cause.cause, undefined);
					return true;
				},
			);
		}
	});

	test("anything else is rethrown untouched for the caller to retry", () => {
		for (const state of ["40001", "40P01", "23505", "57014", "08006"]) {
			const original = sqlError(state);
			assert.throws(
				() => rethrowWriteError(original, "orders", ""),
				(cause) => cause === original,
			);
		}
		const plain = new Error("socket closed");
		assert.throws(
			() => rethrowWriteError(plain, "orders", ""),
			(c) => c === plain,
		);
	});

	test("a SQLSTATE is read only from an Error that carries one", () => {
		assert.equal(sqlStateOf(sqlError("HB001")), "HB001");
		assert.equal(sqlStateOf(new Error("plain")), undefined);
		assert.equal(sqlStateOf(sqlError("ECONNREFUSED")), undefined);
		assert.equal(sqlStateOf({ code: "HB001" }), undefined);
		assert.equal(sqlStateOf(undefined), undefined);
		assert.equal(
			sqlStateOf(Object.assign(new Error("n"), { code: 42 })),
			undefined,
		);
	});
});

describe("driver adapter", () => {
	interface FakePool extends PgPoolLike {
		readonly log: string[];
		readonly released: (boolean | undefined)[];
	}

	function fakePool(
		answer: (text: string) => PgQueryResultLike | Error = () => ({
			rows: [],
			rowCount: null,
		}),
	): FakePool {
		const log: string[] = [];
		const released: (boolean | undefined)[] = [];
		const query = async (
			text: string,
			values: PostgresParameter[],
		): Promise<PgQueryResultLike> => {
			log.push(
				values.length === 0 ? text : `${text} ${JSON.stringify(values)}`,
			);
			const result = answer(text);
			if (result instanceof Error) throw result;
			return result;
		};
		const client: PgClientLike = {
			query,
			release: (destroy) => {
				released.push(destroy);
			},
		};
		return { log, released, query, connect: async () => client };
	}

	test("text and NULL pass through; anything a driver parsed is refused", async () => {
		const pool = fakePool(() => ({
			rows: [{ a: "text", b: null, c: undefined }],
			rowCount: null,
		}));
		const result = await createPgExecutor(pool).query("SELECT 1", ["x", null]);
		assert.deepEqual(result, {
			rows: [{ a: "text", b: null, c: null }],
			rowCount: 0,
		});
		assert.deepEqual(pool.log, ['SELECT 1 ["x",null]']);

		for (const cell of [1, true, 10n, new Date(0), new Uint8Array(1)]) {
			const parsed = fakePool(() => ({
				rows: [{ leaked: cell }],
				rowCount: 1,
			}));
			await assert.rejects(
				createPgExecutor(parsed).query("SELECT 1"),
				(cause) => {
					assert.ok(cause instanceof PostgresDataError);
					assert.equal(cause.code, "ENGINE_EXECUTOR_CONTRACT");
					assert.equal(cause.detail.column, "leaked");
					return true;
				},
			);
		}
	});

	test("a transaction is one session: begin, body, commit, release", async () => {
		const pool = fakePool(() => ({ rows: [], rowCount: 3 }));
		const result = await createPgExecutor(pool).transaction(async (tx) => {
			const inner = await tx.query("UPDATE t SET x = $1::text", ["1"]);
			return inner.rowCount;
		});
		assert.equal(result, 3);
		assert.deepEqual(pool.log, [
			"BEGIN",
			'UPDATE t SET x = $1::text ["1"]',
			"COMMIT",
		]);
		assert.deepEqual(pool.released, [false]);
	});

	test("a failing body rolls back, rethrows, and still releases the session", async () => {
		const failure = sqlError("HB001");
		const pool = fakePool((text) =>
			text.startsWith("INSERT") ? failure : { rows: [], rowCount: 0 },
		);
		await assert.rejects(
			createPgExecutor(pool).transaction((tx) => tx.query("INSERT INTO t")),
			(cause) => cause === failure,
		);
		assert.deepEqual(pool.log, ["BEGIN", "INSERT INTO t", "ROLLBACK"]);
		assert.deepEqual(pool.released, [false]);
	});

	test("a session whose rollback failed is destroyed, not reused", async () => {
		const failure = new Error("boom");
		const pool = fakePool((text) =>
			text === "ROLLBACK" || text.startsWith("INSERT")
				? failure
				: { rows: [], rowCount: 0 },
		);
		await assert.rejects(
			createPgExecutor(pool).transaction((tx) => tx.query("INSERT INTO t")),
			(cause) => cause === failure,
		);
		assert.deepEqual(pool.released, [true]);
	});

	test("a nested transaction is a savepoint on the same session", async () => {
		const failure = new Error("inner failed");
		const pool = fakePool((text) =>
			text === "INSERT bad" ? failure : { rows: [], rowCount: 0 },
		);
		await createPgExecutor(pool).transaction(async (tx) => {
			await tx.transaction((inner) => inner.query("INSERT good"));
			await assert.rejects(
				tx.transaction((inner) => inner.query("INSERT bad")),
				(cause) => cause === failure,
			);
		});
		assert.deepEqual(pool.log, [
			"BEGIN",
			"SAVEPOINT hobo_savepoint_1",
			"INSERT good",
			"RELEASE SAVEPOINT hobo_savepoint_1",
			"SAVEPOINT hobo_savepoint_1",
			"INSERT bad",
			"ROLLBACK TO SAVEPOINT hobo_savepoint_1",
			"COMMIT",
		]);
	});
});

// ── capture, over recorded bytes ────────────────────────────────────────────

// SAFETY: the fixture file is this repository's own recorded document.
const FIXTURE = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL("./fixtures/pgoutput-v1.recorded.json", import.meta.url),
		),
		"utf8",
	),
) as RecordedPgOutput;

/** A commit message is: tag, flags, commit position, end position, time. */
const COMMIT_END_OFFSET = 10;

/** Commit positions of the recorded transactions, read from the bytes. */
function commitEnds(messages: readonly string[]): readonly bigint[] {
	return messages
		.filter((hex) => hex.startsWith("43"))
		.map((hex) => Buffer.from(hex, "hex").readBigUInt64BE(COMMIT_END_OFFSET));
}

interface ScriptedServer {
	readonly executor: PostgresExecutor;
	readonly statements: string[];
	/** Row budgets of the decoding calls made, in order. */
	readonly budgets: number[];
	slot: { confirmed: bigint; flushed: bigint; inserted: bigint } | undefined;
}

/**
 * A stand-in server holding one dataset, one subscription, and a log made of
 * recorded messages. It answers the decoding call the way a real server does:
 * whole transactions, stopping at the first boundary past the row budget, and
 * skipping what was already acknowledged.
 */
function scriptedServer(messages: readonly string[]): ScriptedServer {
	const statements: string[] = [];
	const ends = commitEnds(messages);
	const head = ends[ends.length - 1] ?? 0n;
	const budgets: number[] = [];
	const server: ScriptedServer = {
		statements,
		budgets,
		slot: { confirmed: 0n, flushed: head, inserted: head },
		executor: {
			query: (sql, parameters = []) => answer(sql, parameters),
			transaction: (body) => body(server.executor),
		},
	};
	const rows = (...entries: PostgresRow[]): PostgresQueryResult => ({
		rows: entries,
		rowCount: entries.length,
	});
	const relation = messages.find((hex) => hex.startsWith("52"));
	const peekRows = (budget: number): PostgresQueryResult => {
		const out: PostgresRow[] = [];
		let transaction: string[] = [];
		let described = false;
		for (const hex of messages) {
			transaction.push(hex);
			if (!hex.startsWith("43")) continue;
			const end = Buffer.from(hex, "hex").readBigUInt64BE(COMMIT_END_OFFSET);
			if (end > (server.slot?.confirmed ?? 0n)) {
				// A real server describes a relation the first time a call
				// uses it, wherever in the log that call starts.
				const [begin, ...rest] = transaction;
				const sent =
					described || transaction.includes(relation ?? "")
						? transaction
						: [begin ?? "", relation ?? "", ...rest];
				described = true;
				out.push(...sent.map((data) => ({ data })));
			}
			transaction = [];
			if (out.length >= budget) break;
		}
		return rows(...out);
	};
	const answer = async (
		sql: string,
		parameters: readonly PostgresParameter[],
	): Promise<PostgresQueryResult> => {
		statements.push(sql);
		if (sql.includes("current_database()")) return rows({ database: "app" });
		if (
			sql.includes(`FROM "${PGOUTPUT_FIXTURE_NAMESPACE}"."hobo_data_datasets"`)
		) {
			return rows({
				schema_json: JSON.stringify(schemaToJson(EVERY_TYPE_SCHEMA)),
			});
		}
		if (
			sql.includes(
				`FROM "${PGOUTPUT_FIXTURE_NAMESPACE}"."hobo_data_subscriptions"`,
			)
		) {
			return rows({
				dataset: EVERY_TYPE_SCHEMA.name,
				slot_name: "hobo_s_recorded",
				publication_name: "hobo_p_recorded",
				start_position: "0/0",
			});
		}
		if (sql.includes("confirmed_flush_lsn::text")) {
			return server.slot === undefined
				? rows()
				: rows({
						confirmed: formatLsn(server.slot.confirmed),
						flushed: formatLsn(server.slot.flushed),
						inserted: formatLsn(server.slot.inserted),
					});
		}
		if (sql.includes("pg_logical_slot_peek_binary_changes")) {
			const budget =
				parameters[1] === null || parameters[1] === undefined
					? Number.POSITIVE_INFINITY
					: Number(parameters[1]);
			budgets.push(budget);
			return peekRows(budget);
		}
		if (
			sql.includes("pg_replication_slot_advance") &&
			server.slot !== undefined
		) {
			const target = parseLsn(parameters[1] ?? "");
			if (server.slot.confirmed < target) server.slot.confirmed = target;
			return rows({ advanced: "ok" });
		}
		// Bootstrap DDL, pinned settings, and a re-read of a row that is gone.
		return rows();
	};
	return server;
}

describe("capture read loop — recorded bytes, scripted server", () => {
	// The first four recorded transactions: insert, update, a three-change
	// transaction across two tenants, and a key-changing update.
	const messages = FIXTURE.messages.slice(0, 15);
	const ends = commitEnds(messages).map(formatLsn);
	const scope = scopeOf(EVERY_TYPE_SCHEMA.name);
	const reader = (server: ScriptedServer) =>
		requirePort(
			createPostgresEngine({
				executor: server.executor,
				// The recorded bytes name the namespace they were captured in.
				namespace: PGOUTPUT_FIXTURE_NAMESPACE,
			}),
			"capture",
		);

	test("the recorded slice is four transactions", () => {
		assert.equal(ends.length, 4);
	});

	test("a read returns whole transactions, strictly after the position, in order", async () => {
		const capture = reader(scriptedServer(messages));
		const all = await capture.read({
			scope,
			subscription: "s",
			after: "0/0",
			limit: 100,
		});
		assert.ok(all.caughtUp);
		assert.equal(all.position, ends[3]);
		assert.deepEqual(
			all.changes.map((c) => `${c.position} ${c.op} ${c.tenant}|${c.key}`),
			[
				`${ends[0]} upsert |["order-1"]`,
				`${ends[1]} upsert |["order-1"]`,
				`${ends[2]} upsert tenant-b|["order-2"]`,
				`${ends[2]} upsert tenant-a|["order-3"]`,
				`${ends[2]} delete tenant-a|["order-3"]`,
				`${ends[3]} delete tenant-b|["order-2"]`,
				`${ends[3]} upsert tenant-b|["order-2-moved"]`,
			],
		);
		for (const change of all.changes) {
			assert.equal(change.dataset, EVERY_TYPE_SCHEMA.name);
			assert.equal(change.schemaVersion, EVERY_TYPE_SCHEMA.version);
		}
		// Strictly after: resuming from a transaction's own position skips it.
		const rest = await capture.read({
			scope,
			subscription: "s",
			after: ends[1] ?? "",
			limit: 100,
		});
		assert.equal(rest.changes.length, 5);
		assert.ok(
			rest.changes.every((c) => parseLsn(c.position) > parseLsn(ends[1] ?? "")),
		);
		// And reading again from the start repeats: a read does not consume.
		const again = await capture.read({
			scope,
			subscription: "s",
			after: "0/0",
			limit: 100,
		});
		assert.deepEqual(again.changes, all.changes);
	});

	test("the limit cuts at a transaction boundary and says it is not caught up", async () => {
		const capture = reader(scriptedServer(messages));
		const first = await capture.read({
			scope,
			subscription: "s",
			after: "0/0",
			limit: 2,
		});
		assert.equal(first.changes.length, 2);
		assert.equal(first.caughtUp, false);
		assert.equal(first.position, ends[1]);
		// The next transaction has three changes: more than the limit, and
		// still returned whole rather than split.
		const second = await capture.read({
			scope,
			subscription: "s",
			after: first.position,
			limit: 2,
		});
		assert.equal(second.changes.length, 3);
		assert.equal(second.caughtUp, false);
		assert.equal(second.position, ends[2]);
		const third = await capture.read({
			scope,
			subscription: "s",
			after: second.position,
			limit: 2,
		});
		assert.equal(third.changes.length, 2);
		assert.ok(third.caughtUp);
		const none = await capture.read({
			scope,
			subscription: "s",
			after: third.position,
			limit: 2,
		});
		assert.deepEqual(none.changes, []);
		assert.ok(none.caughtUp);
		assert.equal(none.position, third.position);
	});

	test("a tenant-scoped read returns only that tenant, and still advances past the rest", async () => {
		const capture = reader(scriptedServer(messages));
		const batch = await capture.read({
			scope: scopeOf(EVERY_TYPE_SCHEMA.name, "tenant-a"),
			subscription: "s",
			after: "0/0",
			limit: 100,
		});
		assert.deepEqual(
			batch.changes.map((c) => `${c.op} ${c.tenant}`),
			["upsert tenant-a", "delete tenant-a"],
		);
		assert.ok(batch.caughtUp);
		assert.equal(batch.position, ends[3]);
	});

	test("the head is only offered as a resume point when the log is quiescent", async () => {
		const quiet = scriptedServer(messages);
		const beyond = parseLsn(ends[3] ?? "") + 4096n;
		quiet.slot = { confirmed: 0n, flushed: beyond, inserted: beyond };
		const idle = await reader(quiet).read({
			scope,
			subscription: "s",
			after: ends[3] ?? "",
			limit: 10,
		});
		assert.ok(idle.caughtUp);
		assert.equal(
			idle.position,
			formatLsn(beyond),
			"idle table, quiet log: skip ahead",
		);

		// Something inserted but not flushed: a commit may straddle the flush
		// point, so the position stays on the last transaction boundary.
		const busy = scriptedServer(messages);
		busy.slot = { confirmed: 0n, flushed: beyond, inserted: beyond + 64n };
		const held = await reader(busy).read({
			scope,
			subscription: "s",
			after: ends[3] ?? "",
			limit: 10,
		});
		assert.ok(held.caughtUp);
		assert.equal(held.position, ends[3]);
	});

	test("an unacknowledged backlog larger than the row budget is read past", async () => {
		// Forty more transactions, made from the recorded update by moving its
		// commit position: 120 rows, well past the first call's 64-row budget.
		const [begin, update, commit] = [messages[4], messages[5], messages[6]];
		const base = parseLsn(ends[3] ?? "");
		const long = [...messages];
		const extra: string[] = [];
		for (let index = 1; index <= 40; index += 1) {
			const moved = Buffer.from(commit ?? "", "hex");
			moved.writeBigUInt64BE(base + BigInt(index * 256), COMMIT_END_OFFSET);
			long.push(begin ?? "", update ?? "", moved.toString("hex"));
			extra.push(formatLsn(base + BigInt(index * 256)));
		}
		const server = scriptedServer(long);
		const batch = await reader(server).read({
			scope,
			subscription: "s",
			// Nothing was acknowledged, so everything before this is re-decoded.
			after: extra[29] ?? "",
			limit: 1,
		});
		assert.deepEqual(
			batch.changes.map((c) => c.position),
			[extra[30]],
		);
		assert.equal(batch.caughtUp, false);
		assert.equal(batch.position, extra[30]);
		// The first call's 64 rows all sit before the position; the second
		// call reaches past it.
		assert.deepEqual(server.budgets, [64, 128]);
	});

	test("acknowledging releases the log, and a released position is refused loudly", async () => {
		const server = scriptedServer(messages);
		const capture = reader(server);
		await capture.acknowledge({ subscription: "s", position: ends[1] ?? "" });
		assert.equal(server.slot?.confirmed, parseLsn(ends[1] ?? ""));
		const after = await capture.read({
			scope,
			subscription: "s",
			after: ends[1] ?? "",
			limit: 100,
		});
		assert.equal(after.changes.length, 5);
		await assert.rejects(
			async () =>
				capture.read({
					scope,
					subscription: "s",
					after: ends[0] ?? "",
					limit: 100,
				}),
			(cause) =>
				cause instanceof CapturePositionError &&
				cause.code === "CAPTURE_POSITION_INVALID",
		);
		await assert.rejects(
			async () =>
				capture.read({ scope, subscription: "s", after: "41", limit: 100 }),
			(cause) =>
				cause instanceof CapturePositionError &&
				cause.code === "CAPTURE_POSITION_INVALID",
		);
	});

	test("a vanished slot is reported as lost, never as an empty batch", async () => {
		const server = scriptedServer(messages);
		server.slot = undefined;
		await assert.rejects(
			async () =>
				reader(server).read({
					scope,
					subscription: "s",
					after: "0/0",
					limit: 10,
				}),
			(cause) =>
				cause instanceof PostgresDataError &&
				cause.code === "CAPTURE_SUBSCRIPTION_LOST",
		);
	});

	test("decoding runs under pinned session settings, in the same transaction", async () => {
		const server = scriptedServer(messages);
		await reader(server).read({
			scope,
			subscription: "s",
			after: "0/0",
			limit: 10,
		});
		const pin = server.statements.findIndex((sql) =>
			sql.includes("set_config('TimeZone'"),
		);
		const peek = server.statements.findIndex((sql) =>
			sql.includes("pg_logical_slot_peek_binary_changes"),
		);
		assert.ok(pin >= 0 && pin < peek);
		for (const [name, value] of Object.entries(CAPTURE_SESSION_SETTINGS)) {
			assert.ok(
				server.statements[pin]?.includes(
					`set_config('${name}', '${value}', true)`,
				),
				name,
			);
		}
		assert.equal(CAPTURE_SESSION_SETTINGS.TimeZone, "UTC");
	});
});

// ── the executor pact, replayed ─────────────────────────────────────────────

interface PactCell {
	readonly column: string;
	readonly text?: string;
}

interface PactInteraction {
	readonly description: string;
	readonly providerState?: string;
	readonly request: {
		readonly body: {
			readonly sql: string;
			readonly parameters: readonly { readonly text?: string }[];
			readonly inTransaction: boolean;
		};
	};
	readonly response: {
		readonly status: number;
		readonly body: {
			readonly rows?: readonly { readonly cells: readonly PactCell[] }[];
			readonly rowCount?: number;
			readonly sqlState?: string;
		};
	};
}

interface ExecutorPact {
	readonly consumer: { readonly name: string };
	readonly provider: { readonly name: string };
	readonly interactions: readonly PactInteraction[];
}

// SAFETY: the pact file is this repository's own contract document.
const PACT = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/postgres-engine-executor.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
) as ExecutorPact;

const FENCED_STATE = "the dataset is fenced and the session presents no token";
const MOVED_STATE = "another applier has moved the watermark";

/**
 * An executor that answers exactly as the pact says a provider does, and
 * records which interactions the binding actually exercised. Statements the
 * pact does not cover (bootstrap DDL, the subscription lookup) get the
 * minimal answers below.
 */
function pactExecutor() {
	const exercised = new Set<string>();
	let depth = 0;
	let state: string | undefined;
	const executor: PostgresExecutor = {
		async query(sql, parameters = []) {
			const request = {
				sql,
				parameters: parameters.map((value) =>
					value === null ? {} : { text: value },
				),
				inTransaction: depth > 0,
			};
			const interaction = PACT.interactions.find(
				(candidate) =>
					candidate.providerState === state &&
					JSON.stringify(candidate.request.body) === JSON.stringify(request),
			);
			if (interaction !== undefined) {
				exercised.add(interaction.description);
				const { status, body } = interaction.response;
				if (status !== 200) throw sqlError(body.sqlState ?? "");
				return {
					rows: (body.rows ?? []).map((row) =>
						Object.fromEntries(
							row.cells.map((cell) => [cell.column, cell.text ?? null]),
						),
					),
					rowCount: body.rowCount ?? 0,
				};
			}
			if (sql.includes("current_database()")) {
				return { rows: [{ database: "app" }], rowCount: 1 };
			}
			if (sql.includes("hobo_data_subscriptions")) {
				return {
					rows: [
						{
							dataset: EVERY_TYPE_SCHEMA.name,
							slot_name: "hobo_s_0123456789ab_0123456789abcdef01234567",
							publication_name: "hobo_p_0123456789ab_0123456789abcdef01234567",
							start_position: "0/387C000",
						},
					],
					rowCount: 1,
				};
			}
			return { rows: [], rowCount: 0 };
		},
		async transaction(body) {
			depth += 1;
			try {
				return await body(executor);
			} finally {
				depth -= 1;
			}
		},
	};
	return {
		executor,
		exercised,
		enter(next: string | undefined) {
			state = next;
		},
	};
}

describe("executor pact", () => {
	test("names both sides of the boundary", () => {
		assert.equal(PACT.consumer.name, "hobo-data-postgres-engine");
		assert.equal(PACT.provider.name, "hobo-postgres-executor");
		assert.equal(PACT.interactions.length, 11);
	});

	test("the binding issues every request in the pact, and reads every response as the pact means it", async () => {
		const provider = pactExecutor();
		const binding = createPostgresEngine({
			executor: provider.executor,
			namespace: PGOUTPUT_FIXTURE_NAMESPACE,
		});
		const schema = EVERY_TYPE_SCHEMA;
		const record = parseCanonicalRecord(schema, {
			...EVERY_TYPE_RECORD,
			note: null,
			card: null,
			attrs: { z: [1, 2, { nested: null }], a: "b" },
		});
		const key = encodeRecordKey(schema, record);

		// Registry lookup, then a point read: text cells become a record.
		const read = await binding.records.read({
			dataset: schema.name,
			tenant: "",
			key,
		});
		assert.equal(canonicalEncode(read ?? null), canonicalEncode(record));

		// Token, changes and watermark: three statements, one transaction.
		const applied = await requirePort(binding, "apply").apply({
			dataset: schema.name,
			changes: [upsertMutation("", key, record)],
			source: "hobo_migration_m1_forward",
			position: "41",
			fenceToken: "fence:hobo_fixture_orders::example",
		});
		assert.deepEqual(applied, { applied: 1 });

		// A conditional apply: the watermark statement runs first and takes
		// effect only from the position the applier named.
		const next = await requirePort(binding, "apply").apply({
			dataset: schema.name,
			changes: [],
			source: "hobo_migration_m1_forward",
			position: "57",
			expectedWatermark: "41",
		});
		assert.deepEqual(next, { applied: 0 });
		// The same request once another applier has moved the watermark: no
		// row matches, and that alone is the refusal.
		provider.enter(MOVED_STATE);
		await assert.rejects(
			async () =>
				requirePort(binding, "apply").apply({
					dataset: schema.name,
					changes: [upsertMutation("", key, record)],
					source: "hobo_migration_m1_forward",
					position: "57",
					expectedWatermark: "41",
				}),
			(cause) => cause instanceof StaleApplyError,
		);
		provider.enter(undefined);

		// The decoding call: hex text in, one whole transaction out.
		const batch = await requirePort(binding, "capture").read({
			scope: scopeOf(schema.name),
			subscription: "fixture_reader",
			after: "0/387C000",
			limit: 10,
		});
		assert.deepEqual(
			batch.changes.map((change) => `${change.op} ${change.key}`),
			['upsert ["order-1"]'],
		);
		assert.ok(batch.caughtUp);
		// The provider reported unflushed log, so the resume point stays on
		// the transaction boundary rather than jumping to the head.
		assert.equal(batch.position, batch.changes[0]?.position);

		// A refusal: the SQLSTATE alone is enough to name it.
		provider.enter(FENCED_STATE);
		await assert.rejects(
			async () =>
				binding.records.write({
					dataset: schema.name,
					mutations: [upsertMutation("", key, record)],
				}),
			(cause) => cause instanceof FencedWriteError,
		);

		assert.deepEqual(
			PACT.interactions
				.map((interaction) => interaction.description)
				.filter((description) => !provider.exercised.has(description)),
			[],
			"every interaction in the pact was exercised",
		);
	});

	test("no interaction carries a connection string or a credential", () => {
		const text = JSON.stringify(PACT);
		assert.doesNotMatch(text, /postgres(ql)?:\/\//u);
		assert.doesNotMatch(text, /password|secret/iu);
	});
});
