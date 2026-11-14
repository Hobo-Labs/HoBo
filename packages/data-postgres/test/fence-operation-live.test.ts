import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	canonicalFenceOperationReceipt,
	encodeRecordKey,
	type FenceOperationClaim,
	parseCanonicalRecord,
	parseDatasetSchema,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
	createPgExecutor,
	createPostgresEngine,
	type PostgresExecutor,
	quoteIdentifier,
} from "../src/index.js";

const socket = process.env.HOBO_TEST_FENCE_PG_SOCKET;
const port = Number(process.env.HOBO_TEST_FENCE_PG_PORT ?? 25579);
const liveUrl = process.env.HOBO_TEST_POSTGRES_URL;
const live = socket !== undefined || liveUrl !== undefined;
function openPool(max: number): pg.Pool {
	return new pg.Pool(
		socket
			? { host: socket, port, user: "hobo_test", database: "postgres", max }
			: { connectionString: liveUrl, max },
	);
}
const schema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [{ name: "id", type: "string" }],
});
const scope = scopeOf("orders");
const keys = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const receivers = new Map([["router", keys.publicKey]]);
const routeDigest = `sha256:${"a".repeat(64)}`;
function receipt(claim: FenceOperationClaim, key = keys.privateKey) {
	const body = {
		...claim,
		contract: "hobo.fence-operation-receipt/v1" as const,
		outcome: "committed" as const,
	};
	return {
		...body,
		signature: sign(
			null,
			Buffer.from(canonicalFenceOperationReceipt(body)),
			key,
		).toString("base64url"),
	};
}
function latch() {
	let release: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe.skipIf(!live)("PostgreSQL native fence operation — live", () => {
	it("persists the source hold across restart and accepts only its enrolled receiver's exact receipt", async () => {
		const pool = openPool(8);
		const executor = createPgExecutor(pool);
		const namespace = `hobo_lock_${randomUUID().replaceAll("-", "")}`;
		const open = (operationReceivers = receivers) =>
			createPostgresEngine({
				executor,
				namespace,
				capture: false,
				operationReceivers,
			});
		const a = open();
		try {
			await a.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "1" });
			await a.records.write({
				dataset: schema.name,
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record), record),
				],
			});
			if (!a.fence?.operation || !a.retire || !a.verify || !a.apply)
				throw new Error("fixture missing ports");
			const { fenceToken } = await a.fence.raise({ scope, reason: "cutover" });
			const request = {
				scope,
				fenceToken,
				operationId: "cutover-one",
				routeDigest,
				receiverKeyId: "router",
			};
			const claim = await a.fence.operation.claim(request);
			const reopened = open();
			if (!reopened.fence?.operation)
				throw new Error("fixture missing operation");
			expect(await reopened.fence.operation.claim(request)).toEqual(claim);
			await expect(
				reopened.fence.release({ scope, fenceToken }),
			).rejects.toThrow(/operation is still held/u);
			await expect(
				reopened.records.write({
					dataset: schema.name,
					fenceToken,
					mutations: [
						upsertMutation("", encodeRecordKey(schema, record), record),
					],
				}),
			).rejects.toThrow();
			await expect(
				a.apply.apply({
					dataset: schema.name,
					source: "old",
					position: "0/1",
					changes: [],
				}),
			).rejects.toThrow(/operation is still held/u);
			const expected = await a.verify.digest({ scope, buckets: 1 });
			await expect(
				a.retire.retire({ scope, fenceToken, expected }),
			).rejects.toThrow(/operation is still held/u);
			if (!a.schema) throw new Error("fixture missing schema port");
			await expect(
				a.schema.applyPhase("expand", ["CREATE TABLE disallowed (id integer)"]),
			).rejects.toThrow(/schema mutations are unavailable/u);
			await expect(
				a.schema.restore({ ref: "untrusted", takenAt: "" }),
			).rejects.toThrow(/schema mutations are unavailable/u);
			const ephemeral = createPostgresEngine({
				executor,
				namespace,
				capture: false,
				ephemeral: true,
			});
			await ephemeral.datasets.describeDataset(schema.name);
			await expect(ephemeral.close()).rejects.toThrow(/cannot be dropped/u);
			await expect(
				a.fence.operation.complete(receipt(claim, other.privateKey)),
			).rejects.toThrow(/untrusted/u);
			const signed = receipt(claim);
			const noncanonical = `${signed.signature.slice(0, -1)}${String.fromCharCode(signed.signature.charCodeAt(signed.signature.length - 1) + 1)}`;
			expect(Buffer.from(noncanonical, "base64url")).toEqual(
				Buffer.from(signed.signature, "base64url"),
			);
			await expect(
				a.fence.operation.complete({ ...signed, signature: noncanonical }),
			).rejects.toThrow(/untrusted/u);
			const unsignedExtra = { ...signed, untrusted: true };
			await expect(a.fence.operation.complete(unsignedExtra)).rejects.toThrow(
				/invalid native fence operation receipt/u,
			);
			await expect(
				a.fence.operation.complete(
					receipt({ ...claim, routeDigest: `sha256:${"b".repeat(64)}` }),
				),
			).rejects.toThrow(/foreign scope/u);
			const wrong = open(new Map([["router", other.publicKey]]));
			await expect(wrong.fence?.operation?.claim(request)).rejects.toThrow(
				/policy differs/u,
			);
			expect(await reopened.fence.operation.inspect(scope)).toMatchObject({
				status: "held",
				claim,
			});
			await reopened.fence.operation.complete(receipt(claim));
			await reopened.fence.operation.complete(receipt(claim));
			expect(
				await reopened.fence.operation.inspect(scope, claim.operationId),
			).toEqual({ status: "completed", claim });
			await reopened.fence.release({ scope, fenceToken });
			const later = await reopened.fence.raise({ scope, reason: "next" });
			await expect(
				reopened.fence.operation.claim({
					...request,
					fenceToken: later.fenceToken,
				}),
			).rejects.toThrow(/already used/u);
		} finally {
			await pool.query(
				`DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`,
			);
			await pool.end();
		}
	});

	it("fences a release and token-bearing write dispatched before the claim commits", async () => {
		const pool = openPool(8);
		const base = createPgExecutor(pool);
		const namespace = `hobo_lock_${randomUUID().replaceAll("-", "")}`;
		const inserted = latch(),
			finish = latch();
		let armed = false;
		const executor: PostgresExecutor = {
			query: (sql, args) => base.query(sql, args),
			transaction: (body) =>
				base.transaction((tx) =>
					body({
						...tx,
						async query(sql, args) {
							const result = await tx.query(sql, args);
							if (
								armed &&
								sql.includes("INSERT INTO") &&
								sql.includes("hobo_data_fence_operations")
							) {
								armed = false;
								inserted.release();
								await finish.promise;
							}
							return result;
						},
					}),
				),
		};
		const a = createPostgresEngine({
			executor,
			namespace,
			capture: false,
			operationReceivers: receivers,
		});
		const b = createPostgresEngine({
			executor: base,
			namespace,
			capture: false,
			operationReceivers: receivers,
		});
		try {
			await a.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "1" });
			const mutation = upsertMutation(
				"",
				encodeRecordKey(schema, record),
				record,
			);
			await a.records.write({ dataset: schema.name, mutations: [mutation] });
			if (!a.fence?.operation || !b.fence)
				throw new Error("fixture missing operation");
			const { fenceToken } = await a.fence.raise({ scope, reason: "cutover" });
			await a.records.write({
				dataset: schema.name,
				fenceToken,
				mutations: [mutation],
			});
			armed = true;
			const claimed = a.fence.operation.claim({
				scope,
				fenceToken,
				operationId: "delayed",
				routeDigest,
				receiverKeyId: "router",
			});
			await inserted.promise;
			const release = b.fence.release({ scope, fenceToken }).then(
				() => undefined,
				(error: Error) => error,
			);
			const write = b.records
				.write({ dataset: schema.name, fenceToken, mutations: [mutation] })
				.then(
					() => undefined,
					(error: Error) => error,
				);
			let waiting = 0;
			for (let attempt = 0; attempt < 200 && waiting < 2; attempt++) {
				const observed = await pool.query(
					"SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND position($1::text IN query) > 0 AND (query LIKE 'DELETE FROM %' OR query LIKE 'INSERT INTO %')",
					[namespace],
				);
				waiting = Number(observed.rows[0]?.waiting ?? 0);
				if (waiting < 2)
					await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBeGreaterThanOrEqual(2);
			finish.release();
			const claim = await claimed;
			expect(await release).toBeInstanceOf(Error);
			expect(String(await release)).toMatch(/operation is still held/u);
			expect(await write).toBeInstanceOf(Error);
			await a.fence.operation.complete(receipt(claim));
			await b.fence.release({ scope, fenceToken });
		} finally {
			finish.release();
			await pool.query(
				`DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`,
			);
			await pool.end();
		}
	});

	it("does not enroll a claim after an earlier fence release commits", async () => {
		const pool = openPool(6);
		const namespace = `hobo_lock_${randomUUID().replaceAll("-", "")}`;
		const engine = createPostgresEngine({
			executor: createPgExecutor(pool),
			namespace,
			capture: false,
			operationReceivers: receivers,
		});
		const client = await pool.connect();
		try {
			await engine.datasets.ensureDataset(schema);
			if (!engine.fence?.operation)
				throw new Error("fixture missing operation");
			const { fenceToken } = await engine.fence.raise({
				scope,
				reason: "cutover",
			});
			await client.query("BEGIN");
			await client.query(
				`DELETE FROM ${quoteIdentifier(namespace)}."hobo_data_fences" WHERE dataset = $1 AND tenant = $2 AND token = $3`,
				[scope.dataset, scope.tenant, fenceToken],
			);
			const claim = engine.fence.operation
				.claim({
					scope,
					fenceToken,
					operationId: "too-late",
					routeDigest,
					receiverKeyId: "router",
				})
				.then(
					() => undefined,
					(error: Error) => error,
				);
			let waiting = false;
			for (let attempt = 0; attempt < 200 && !waiting; attempt++) {
				const observed = await pool.query(
					"SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND position($1::text IN query) > 0 AND query LIKE 'UPDATE %hobo_data_datasets%'",
					[namespace],
				);
				waiting = Number(observed.rows[0]?.waiting ?? 0) > 0;
				if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waiting).toBe(true);
			await client.query("COMMIT");
			const failure = await claim;
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).toMatch(/token is no longer current/u);
			const policy = await pool.query(
				`SELECT count(*)::integer AS count FROM ${quoteIdentifier(namespace)}."hobo_data_fence_policy"`,
			);
			expect(policy.rows[0]?.count).toBe(0);
		} finally {
			await client.query("ROLLBACK").catch(() => undefined);
			client.release();
			await pool.query(
				`DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`,
			);
			await pool.end();
		}
	});

	it("upgrades a prior namespace without losing its records or existing fence", async () => {
		const pool = openPool(6);
		const namespace = `hobo_lock_${randomUUID().replaceAll("-", "")}`;
		const executor = createPgExecutor(pool);
		const before = createPostgresEngine({
			executor,
			namespace,
			capture: false,
		});
		try {
			await before.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "existing" });
			const key = encodeRecordKey(schema, record);
			await before.records.write({
				dataset: schema.name,
				mutations: [upsertMutation("", key, record)],
			});
			if (!before.fence) throw new Error("fixture missing fence");
			const { fenceToken } = await before.fence.raise({
				scope,
				reason: "previous version",
			});
			const q = quoteIdentifier(namespace);
			await pool.query(
				`DROP TRIGGER "hobo_fence_operation_release_guard" ON ${q}."hobo_data_fences"`,
			);
			await pool.query(
				`DROP FUNCTION ${q}."hobo_fence_operation_release_guard"()`,
			);
			await pool.query(
				`DROP TABLE ${q}."hobo_data_fence_operations", ${q}."hobo_data_fence_policy", ${q}."hobo_data_fence_receivers"`,
			);
			await pool.query(
				`COMMENT ON FUNCTION ${q}."hobo_truncate_guard"() IS 'hobo-data-postgres bootstrap 2'`,
			);
			const after = createPostgresEngine({
				executor,
				namespace,
				capture: false,
				operationReceivers: receivers,
			});
			expect(
				await after.records.read({ dataset: schema.name, tenant: "", key }),
			).toEqual(record);
			if (!after.fence?.operation) throw new Error("fixture missing operation");
			const claim = await after.fence.operation.claim({
				scope,
				fenceToken,
				operationId: "after-upgrade",
				routeDigest,
				receiverKeyId: "router",
			});
			await expect(after.fence.release({ scope, fenceToken })).rejects.toThrow(
				/operation is still held/u,
			);
			await after.fence.operation.complete(receipt(claim));
			await after.fence.release({ scope, fenceToken });
		} finally {
			await pool.query(
				`DROP SCHEMA IF EXISTS ${quoteIdentifier(namespace)} CASCADE`,
			);
			await pool.end();
		}
	});

	it("fences stale repeatable-read transactions that began before the claim", async () => {
		const pool = openPool(8);
		const namespace = `hobo_lock_${randomUUID().replaceAll("-", "")}`;
		const q = quoteIdentifier(namespace);
		const engine = createPostgresEngine({
			executor: createPgExecutor(pool),
			namespace,
			capture: false,
			operationReceivers: receivers,
		});
		const releaseClient = await pool.connect(),
			writeClient = await pool.connect();
		try {
			await engine.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "existing" });
			await engine.records.write({
				dataset: schema.name,
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record), record),
				],
			});
			if (!engine.fence?.operation)
				throw new Error("fixture missing operation");
			const { fenceToken } = await engine.fence.raise({
				scope,
				reason: "cutover",
			});
			await releaseClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
			await releaseClient.query(`SELECT token FROM ${q}."hobo_data_fences"`);
			await writeClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
			await writeClient.query(
				"SELECT set_config('hobo.fence_token', $1, true)",
				[fenceToken],
			);
			await writeClient.query(`SELECT id FROM ${q}."orders"`);
			const claim = await engine.fence.operation.claim({
				scope,
				fenceToken,
				operationId: "snapshot",
				routeDigest,
				receiverKeyId: "router",
			});
			await expect(
				releaseClient.query(
					`DELETE FROM ${q}."hobo_data_fences" WHERE dataset = $1 AND tenant = $2`,
					[scope.dataset, scope.tenant],
				),
			).rejects.toMatchObject({ code: "40001" });
			await expect(
				writeClient.query(`UPDATE ${q}."orders" SET id = id`),
			).rejects.toMatchObject({ code: "40001" });
			await releaseClient.query("ROLLBACK");
			await writeClient.query("ROLLBACK");
			await engine.fence.operation.complete(receipt(claim));
			await engine.fence.release({ scope, fenceToken });
		} finally {
			await releaseClient.query("ROLLBACK").catch(() => undefined);
			await writeClient.query("ROLLBACK").catch(() => undefined);
			releaseClient.release();
			writeClient.release();
			await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`);
			await pool.end();
		}
	});

	it("blocks an independently connected non-owner role even when it has the old token", async () => {
		const pool = openPool(6);
		const suffix = randomUUID().replaceAll("-", ""),
			namespace = `hobo_lock_${suffix}`,
			role = `hobo_writer_${suffix}`;
		const q = quoteIdentifier(namespace),
			user = quoteIdentifier(role);
		const engine = createPostgresEngine({
			executor: createPgExecutor(pool),
			namespace,
			capture: false,
			operationReceivers: receivers,
		});
		let restricted: pg.PoolClient | undefined;
		try {
			await engine.datasets.ensureDataset(schema);
			const record = parseCanonicalRecord(schema, { id: "existing" });
			await engine.records.write({
				dataset: schema.name,
				mutations: [
					upsertMutation("", encodeRecordKey(schema, record), record),
				],
			});
			await pool.query(`CREATE ROLE ${user} LOGIN`);
			await pool.query(`GRANT USAGE ON SCHEMA ${q} TO ${user}`);
			await pool.query(
				`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q}."orders" TO ${user}`,
			);
			restricted = await pool.connect();
			await restricted.query(`SET ROLE ${user}`);
			if (!engine.fence?.operation)
				throw new Error("fixture missing operation");
			const { fenceToken } = await engine.fence.raise({
				scope,
				reason: "cutover",
			});
			await restricted.query(
				"SELECT set_config('hobo.fence_token', $1, false)",
				[fenceToken],
			);
			await restricted.query(`UPDATE ${q}."orders" SET id = id`);
			const claim = await engine.fence.operation.claim({
				scope,
				fenceToken,
				operationId: "restricted",
				routeDigest,
				receiverKeyId: "router",
			});
			await expect(
				restricted.query(`UPDATE ${q}."orders" SET id = id`),
			).rejects.toMatchObject({ code: "HB001" });
			await expect(
				restricted.query(`DELETE FROM ${q}."hobo_data_fence_operations"`),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				restricted.query(`ALTER TABLE ${q}."orders" DISABLE TRIGGER ALL`),
			).rejects.toMatchObject({ code: "42501" });
			await expect(
				restricted.query("SET session_replication_role = 'replica'"),
			).rejects.toMatchObject({ code: "42501" });
			await engine.fence.operation.complete(receipt(claim));
			await engine.fence.release({ scope, fenceToken });
		} finally {
			if (restricted) {
				await restricted.query("RESET ROLE").catch(() => undefined);
				restricted.release(true);
			}
			await pool.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`);
			await pool.query(`DROP ROLE IF EXISTS ${user}`);
			await pool.end();
		}
	});
});
