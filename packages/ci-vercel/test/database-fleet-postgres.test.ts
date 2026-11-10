import {
	bootstrapAssignment,
	type PostgresFleetAssignment,
	proposeAssignment,
	readCurrentAssignment,
	readDataDigests,
	readSequencePositions,
	readWatermark,
	replicateSnapshot,
	sqlAssignmentRegister,
	sqlAssignmentReplica,
	standbyLagMs,
} from "@hobo/data-postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	backendAt,
	createTestFleet,
	fleetServersAvailable,
	type TestBackend,
	testLayout,
} from "./database-fleet-harness.js";

/** Real PostgreSQL. Set HOBO_CI_TEST_FLEET_POSTGRES to three servers. */
const TYPES_TABLE = `CREATE TABLE hobo_ci_types (
	id bigserial PRIMARY KEY,
	blob bytea, big bigint, seen timestamptz, key uuid, doc jsonb, raw json,
	amount numeric(20,6), ratio double precision, note text, flag boolean,
	tags text[], span interval
)`;
const TYPES_ROWS = `INSERT INTO hobo_ci_types
	(blob, big, seen, key, doc, raw, amount, ratio, note, flag, tags, span) VALUES
	(decode('00ff10deadbeef', 'hex'), 9223372036854775807, '2026-03-29 01:30:00.123456+00',
	 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"b": [1, 2, {"c": null}], "a": "x"}',
	 '{ "spaced" :  [1,2] ,"dup":1,"dup":2 }', 12345678901234.654321, 0.1,
	 E'quote " backslash \\\\ newline \\n tab \\t snowman \\u2603', true, ARRAY['a,b', 'c"d', NULL], '1 day 02:03:04.5'),
	(NULL, -9223372036854775808, '1999-12-31 23:59:59.999999-11', NULL, 'null', 'null',
	 -0.000001, 'NaN', '', false, '{}', NULL),
	(''::bytea, 0, 'infinity', 'ffffffff-ffff-ffff-ffff-ffffffffffff', '[]', '[]', 0, -1e308, NULL, NULL, NULL, '-00:00:01')`;

async function dataTables(backend: TestBackend) {
	await backend.pool.query(TYPES_TABLE);
	await backend.pool.query(
		"CREATE TABLE hobo_ci_plain (name text PRIMARY KEY, body text NOT NULL)",
	);
	await backend.pool.query(
		"CREATE TABLE hobo_ci_migrations (id integer PRIMARY KEY, name text)",
	);
}

async function typesText(backend: TestBackend) {
	const result = await backend.pool.query(
		`SELECT id::text, encode(blob, 'hex') AS blob, big::text, (seen AT TIME ZONE 'UTC')::text AS seen,
			key::text, doc::text, raw::text, amount::text, ratio::text, note, flag::text, tags::text, span::text
		FROM hobo_ci_types ORDER BY id`,
	);
	return result.rows;
}

function current(
	resolution: Awaited<ReturnType<typeof readCurrentAssignment>>,
): PostgresFleetAssignment {
	if (resolution.status !== "current")
		throw new Error(`assignment is ${resolution.status}`);
	return resolution.assignment;
}

describe.skipIf(!fleetServersAvailable)("database fleet on PostgreSQL", () => {
	let fleet: Awaited<ReturnType<typeof createTestFleet>>;
	let backends: TestBackend[];
	let writer: TestBackend;
	let standby: TestBackend;
	let third: TestBackend;
	beforeEach(async () => {
		fleet = await createTestFleet(3);
		backends = fleet.backends;
		writer = backendAt(backends, 0);
		standby = backendAt(backends, 1);
		third = backendAt(backends, 2);
	});
	afterEach(async () => {
		await fleet.close();
	});

	it("takes an epoch only directly after the previous one, atomically", async () => {
		const replica = sqlAssignmentReplica(writer, testLayout);
		const entry = (epoch: number, decidedBy: string) => ({
			epoch,
			active: "b0",
			sealed: false,
			target: undefined,
			reason: "test",
			lossWindowMs: undefined,
			decidedAtMs: 1_731_234_567_891,
			decidedBy,
		});
		expect(await replica.accept(entry(2, "gap"))).toBe("gap");
		const racing = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				replica.accept(entry(1, `racer-${index}`)),
			),
		);
		expect(racing.filter((outcome) => outcome === "accepted")).toHaveLength(1);
		expect(racing.filter((outcome) => outcome === "conflict")).toHaveLength(11);
		const held = await replica.read();
		expect(held).toHaveLength(1);
		expect(held[0]?.decidedAtMs).toBe(1_731_234_567_891);
		const winner = held[0];
		if (!winner) throw new Error("no entry was taken");
		expect(await replica.accept(winner)).toBe("duplicate");
		expect(await replica.accept(entry(3, "gap"))).toBe("gap");
		expect(await replica.accept(entry(2, "next"))).toBe("accepted");
	});

	it("decides at most one of many concurrent proposals for an epoch", async () => {
		const register = sqlAssignmentRegister(backends, testLayout);
		expect((await bootstrapAssignment(register, "b0")).status).toBe("decided");
		const outcomes = await Promise.all(
			Array.from({ length: 9 }, (_, index) =>
				proposeAssignment(register, {
					expectedEpoch: 1,
					value: {
						active: `b${index % 3}`,
						sealed: false,
						target: undefined,
						reason: "race",
						lossWindowMs: undefined,
					},
					decidedBy: `racer-${index}`,
					nowMs: 1000 + index,
				}),
			),
		);
		expect(
			outcomes.filter((outcome) => outcome.status === "decided").length,
		).toBeLessThanOrEqual(1);
		const logs = await Promise.all(
			backends.map((backend) =>
				sqlAssignmentReplica(backend, testLayout).read(),
			),
		);
		for (const log of logs)
			expect(log.map((row) => row.epoch)).toEqual(
				log.map((_, index) => index + 1),
			);
	});

	it("copies every type byte for byte, advances sequences and records a watermark", async () => {
		for (const backend of backends) await dataTables(backend);
		// A standby whose server writes timestamps in another zone and bytea in
		// another format must still digest identically.
		await standby.pool.query(
			"ALTER DATABASE CURRENT_DATABASE SET timezone = 'Asia/Tokyo'".replace(
				"CURRENT_DATABASE",
				new URL(standby.url).pathname.slice(1),
			),
		);
		await standby.pool.query(
			"ALTER ROLE CURRENT_USER SET bytea_output = 'escape'",
		);
		await fleet.reconnect(standby);
		const retargeted = standby;
		try {
			await writer.pool.query(TYPES_ROWS);
			await writer.pool.query(
				"INSERT INTO hobo_ci_plain VALUES ('a', 'one'), ('b', 'two')",
			);
			await writer.pool.query(
				"INSERT INTO hobo_ci_migrations VALUES (1, 'writer-only')",
			);
			// Stale standby content, and a sequence already ahead of the source.
			await retargeted.pool.query(
				"INSERT INTO hobo_ci_plain VALUES ('stale', 'gone')",
			);
			await retargeted.pool.query(
				"INSERT INTO hobo_ci_migrations VALUES (7, 'standby-only')",
			);
			const register = sqlAssignmentRegister(backends, testLayout);
			await bootstrapAssignment(register, "b0");
			const assignment = current(await readCurrentAssignment(register));
			const before = Date.now();
			const outcome = await replicateSnapshot({
				source: writer,
				target: retargeted,
				layout: testLayout,
				assignment,
				limits: { batchRows: 2 },
			});
			expect(outcome).toMatchObject({ status: "replicated" });
			if (outcome.status !== "replicated") return;
			expect(outcome.watermark).toMatchObject({
				source: "b0",
				sourceEpoch: 1,
				rowCount: 5,
			});
			expect(outcome.watermark.tables.map((table) => table.name)).toEqual([
				"hobo_ci_plain",
				"hobo_ci_types",
			]);
			expect(await typesText(retargeted)).toEqual(await typesText(writer));
			expect(await readDataDigests(retargeted, testLayout)).toEqual(
				await readDataDigests(writer, testLayout),
			);
			expect(await readDataDigests(retargeted, testLayout)).toEqual(
				outcome.watermark.tables,
			);
			// The excluded table and the control tables are not copied.
			const excluded = await retargeted.pool.query(
				"SELECT name FROM hobo_ci_migrations",
			);
			expect(excluded.rows).toEqual([{ name: "standby-only" }]);
			const sequences = await readSequencePositions(retargeted, testLayout);
			expect(sequences).toEqual([
				{ table: "hobo_ci_types", column: "id", value: 3 },
			]);
			const next = await retargeted.pool.query(
				"INSERT INTO hobo_ci_types (note) VALUES ('after') RETURNING id::text",
			);
			expect(next.rows).toEqual([{ id: "4" }]);
			const watermark = await readWatermark(retargeted, testLayout);
			expect(watermark).toEqual(outcome.watermark);
			if (!watermark) return;
			expect(watermark.snapshotAtMs).toBeGreaterThan(before - 60_000);
			expect(standbyLagMs(watermark, watermark.snapshotAtMs + 1500)).toBe(1500);
			expect(await readWatermark(writer, testLayout)).toBeUndefined();
		} finally {
			await retargeted.pool.query("ALTER ROLE CURRENT_USER RESET bytea_output");
		}
	});

	it("never moves a sequence backwards on the target", async () => {
		for (const backend of backends) await dataTables(backend);
		await writer.pool.query("INSERT INTO hobo_ci_types (note) VALUES ('one')");
		await standby.pool.query("SELECT setval('hobo_ci_types_id_seq', 500)");
		const register = sqlAssignmentRegister(backends, testLayout);
		await bootstrapAssignment(register, "b0");
		const outcome = await replicateSnapshot({
			source: writer,
			target: standby,
			layout: testLayout,
			assignment: current(await readCurrentAssignment(register)),
		});
		expect(outcome.status).toBe("replicated");
		expect(await readSequencePositions(standby, testLayout)).toEqual([
			{ table: "hobo_ci_types", column: "id", value: 500 },
		]);
	});

	it("refuses to overwrite the writer, a backend with a different log, or a different schema", async () => {
		for (const backend of backends) await dataTables(backend);
		await writer.pool.query("INSERT INTO hobo_ci_plain VALUES ('keep', 'me')");
		const register = sqlAssignmentRegister(backends, testLayout);
		await bootstrapAssignment(register, "b0");
		const first = current(await readCurrentAssignment(register));
		// A caller with a wrong idea of who the writer is cannot overwrite it.
		const forged = { ...first, active: "b1" };
		expect(
			await replicateSnapshot({
				source: standby,
				target: writer,
				layout: testLayout,
				assignment: forged,
			}),
		).toMatchObject({ status: "refused", refusal: "target-is-writer" });
		expect(
			await replicateSnapshot({
				source: standby,
				target: third,
				layout: testLayout,
				assignment: first,
			}),
		).toMatchObject({ status: "refused", refusal: "source-is-not-writer" });
		expect(
			await replicateSnapshot({
				source: writer,
				target: writer,
				layout: testLayout,
				assignment: first,
			}),
		).toMatchObject({ status: "refused", refusal: "same-backend" });
		// A standby whose own log is not the resolved assignment is left alone.
		expect(
			await replicateSnapshot({
				source: writer,
				target: standby,
				layout: testLayout,
				assignment: { ...first, decidedBy: "somebody-else" },
			}),
		).toMatchObject({ status: "refused", refusal: "target-log-differs" });
		await third.pool.query(
			"ALTER TABLE hobo_ci_plain ADD COLUMN extra integer",
		);
		expect(
			await replicateSnapshot({
				source: writer,
				target: third,
				layout: testLayout,
				assignment: first,
			}),
		).toMatchObject({
			status: "refused",
			refusal: "schema-mismatch",
			detail: "table hobo_ci_plain has extra columns on target",
		});
		await third.pool.query(
			"ALTER TABLE hobo_ci_plain DROP COLUMN extra, ALTER COLUMN body TYPE varchar(20)",
		);
		expect(
			await replicateSnapshot({
				source: writer,
				target: third,
				layout: testLayout,
				assignment: first,
			}),
		).toMatchObject({
			status: "refused",
			refusal: "schema-mismatch",
			detail:
				"column hobo_ci_plain.body is text on source and character varying(20) on target",
		});
		const kept = await writer.pool.query("SELECT name FROM hobo_ci_plain");
		expect(kept.rows).toEqual([{ name: "keep" }]);
	});

	it("reports an oversized database and leaves the standby as it was", async () => {
		for (const backend of backends) await dataTables(backend);
		await writer.pool.query(
			"INSERT INTO hobo_ci_plain SELECT 'k' || n, repeat('x', 200) FROM generate_series(1, 50) n",
		);
		await standby.pool.query(
			"INSERT INTO hobo_ci_plain VALUES ('old', 'copy')",
		);
		const register = sqlAssignmentRegister(backends, testLayout);
		await bootstrapAssignment(register, "b0");
		const assignment = current(await readCurrentAssignment(register));
		expect(
			await replicateSnapshot({
				source: writer,
				target: standby,
				layout: testLayout,
				assignment,
				limits: { maxRows: 10 },
			}),
		).toMatchObject({ status: "refused", refusal: "oversized" });
		expect(
			await replicateSnapshot({
				source: writer,
				target: standby,
				layout: testLayout,
				assignment,
				limits: { maxBytes: 2000, batchRows: 5 },
			}),
		).toMatchObject({ status: "refused", refusal: "oversized" });
		const kept = await standby.pool.query("SELECT name FROM hobo_ci_plain");
		expect(kept.rows).toEqual([{ name: "old" }]);
		expect(await readWatermark(standby, testLayout)).toBeUndefined();
	});

	it("does not let an entry arrive on a backend while it is being overwritten", async () => {
		for (const backend of backends) await dataTables(backend);
		const register = sqlAssignmentRegister(backends, testLayout);
		await bootstrapAssignment(register, "b0");
		const replica = sqlAssignmentReplica(standby, testLayout);
		const client = await standby.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock($1::int, hashtext($2))",
				[1_212_112_710, testLayout.assignmentTable],
			);
			expect(
				await replica.accept({
					epoch: 2,
					active: "b1",
					sealed: false,
					target: undefined,
					reason: "promotion",
					lossWindowMs: 0,
					decidedAtMs: 5,
					decidedBy: "test",
				}),
			).toBe("busy");
			// And a second copy into the same target does not queue behind it.
			expect(
				await replicateSnapshot({
					source: writer,
					target: standby,
					layout: testLayout,
					assignment: current(await readCurrentAssignment(register)),
				}),
			).toMatchObject({ status: "refused", refusal: "busy" });
		} finally {
			await client.query("ROLLBACK");
			client.release();
		}
	});
});
