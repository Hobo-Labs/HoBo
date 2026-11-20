import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	HostingQuoteSchema,
} from "../src/budget-authority.js";
import { createPostgresBudgetAdmissionAuthority } from "../src/budget-postgres.js";

const NOW = "2026-10-30T12:00:00Z";
const URL = process.env.HOBO_TEST_POSTGRES_URL;
const pools: Pool[] = [];
afterEach(async () => {
	await Promise.all(pools.splice(0).map((pool) => pool.end()));
});
function setup() {
	const snapshot = create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "postgres-test",
			budgetId: randomUUID(),
			periodId: "p1",
			policyRevision: "v1",
		},
		limitMicros: 100,
		observedAt: NOW,
		validUntil: "2026-10-31T00:00:00Z",
	});
	const pool = new Pool({ connectionString: URL, max: 5 });
	pools.push(pool);
	const another = new Pool({ connectionString: URL, max: 5 });
	pools.push(another);
	const options = { snapshot, now: () => NOW };
	return {
		snapshot,
		pool,
		first: createPostgresBudgetAdmissionAuthority({ ...options, pool }),
		second: createPostgresBudgetAdmissionAuthority({
			...options,
			pool: another,
		}),
	};
}
async function reserve(
	authority: ReturnType<typeof createPostgresBudgetAdmissionAuthority>,
	reservationId: string,
	cost = 60,
) {
	return authority.reserve(
		input(await authority.read(NOW), reservationId, cost),
	);
}
function input(
	current: BudgetLedgerSnapshot,
	reservationId: string,
	cost = 60,
) {
	if (!current.identity) throw new Error("fixture identity missing");
	return {
		reservationId,
		requestDigest: reservationId,
		identity: current.identity,
		expectedSeq: current.seq,
		now: NOW,
		quote: create(HostingQuoteSchema, {
			quoteId: `quote:${reservationId}`,
			yardId: "yard",
			providerId: "provider",
			ownerTenantId: current.identity.tenantId,
			currency: "USD",
			totalMicros: cost,
			liabilityBoundMicros: cost,
			observedAt: NOW,
			validUntil: "2026-10-31T00:00:00Z",
			components: [{ name: "complete", costMicros: cost }],
			requestDigest: reservationId,
		}),
	};
}

/** Set HOBO_TEST_POSTGRES_URL to an isolated real server. pg-mem cannot prove row locks. */
describe.skipIf(!URL)(
	"PostgreSQL shared financial authority with independent connections",
	() => {
		it("serializes contending holds against the final100 micros", async () => {
			const { first, second } = setup();
			const results = await Promise.allSettled([
				reserve(first, "hosting:a"),
				reserve(second, "ci:b"),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect((await first.read(NOW)).reservedMicros).toBe(60);
			const loser = results[0]?.status === "rejected" ? "hosting:a" : "ci:b";
			await expect(reserve(second, loser)).rejects.toThrow("budget exhausted");
			expect((await second.read(NOW)).reservedMicros).toBe(60);
		});
		it("shares exact exhaustion and one execution claim across clients", async () => {
			const { first, second } = setup();
			await reserve(first, "ci:a", 60);
			await reserve(second, "hosting:b", 40);
			expect((await first.read(NOW)).reservedMicros).toBe(100);
			const input = {
				reservationId: "ci:a",
				requestDigest: "ci:a",
				executionDigest: "ci-execution-a",
			};
			await first.claimExecution(input);
			await second.claimExecution(input);
			await expect(
				second.claimExecution({ ...input, executionDigest: "foreign" }),
			).rejects.toThrow("another execution");
			await second.uncertain("ci:a");
			expect((await first.lookup("ci:a"))?.status).toBe("uncertain");
			expect((await first.read(NOW)).reservedMicros).toBe(100);
		});
		it("rejects a stale claim and idempotent replay after independent financial changes", async () => {
			const { first, second } = setup();
			await reserve(first, "ci:a", 60);
			const before = await first.read(NOW);
			await reserve(second, "hosting:b", 20);
			const input = {
				reservationId: "ci:a",
				requestDigest: "ci:a",
				executionDigest: "execution",
				expectedSeq: before.seq,
			};
			await expect(first.claimExecution(input)).rejects.toThrow(
				"budget sequence conflict",
			);
			const fresh = await first.read(NOW);
			await first.claimExecution({ ...input, expectedSeq: fresh.seq });
			await second.settle("hosting:b", 60, {
				usageEvidenceRef: "native:overrun",
				sourceStoppedEvidenceRef: "native:stopped",
			});
			await expect(
				first.claimExecution({ ...input, expectedSeq: fresh.seq + 1 }),
			).rejects.toThrow("budget sequence conflict");
			expect((await second.lookup("ci:a"))?.executionDigest).toBe("execution");
		});
		it("reopens the same durable journal without re-seeding a larger balance", async () => {
			const { first, snapshot } = setup();
			await reserve(first, "ci:orphan", 70);
			const pool = new Pool({ connectionString: URL });
			pools.push(pool);
			snapshot.limitMicros = 1000000;
			const reopened = createPostgresBudgetAdmissionAuthority({
				pool,
				snapshot,
				now: () => NOW,
			});
			expect(await reopened.read(NOW)).toMatchObject({
				limitMicros: 100,
				reservedMicros: 70,
			});
			await expect(
				reserve(reopened, "hosting:replacement", 40),
			).rejects.toThrow("budget exhausted");
		});
		it("rolls back a failed event insert without acknowledging a financial claim", async () => {
			const { first, second, pool, snapshot } = setup();
			await reserve(first, "ci:a", 60);
			const id = createHash("sha256")
				.update(
					JSON.stringify([
						snapshot.identity?.tenantId,
						snapshot.identity?.budgetId,
					]),
				)
				.digest("hex");
			const suffix = randomUUID().replaceAll("-", "");
			const functionName = `reject_budget_${suffix}`;
			const triggerName = `reject_budget_${suffix}`;
			await pool.query(
				`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.partition_id = '${id}' AND NEW.seq = 2 THEN RAISE EXCEPTION 'test durable write failure'; END IF; RETURN NEW; END $$`,
			);
			await pool.query(
				`CREATE TRIGGER ${triggerName} BEFORE INSERT ON hobo_budget_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
			);
			try {
				await expect(
					first.claimExecution({
						reservationId: "ci:a",
						requestDigest: "ci:a",
						executionDigest: "execution",
					}),
				).rejects.toThrow("durable write failure");
				expect((await second.lookup("ci:a"))?.executionDigest).toBe("");
				expect((await second.read(NOW)).seq).toBe(1);
			} finally {
				await pool.query(`DROP TRIGGER ${triggerName} ON hobo_budget_events`);
				await pool.query(`DROP FUNCTION ${functionName}()`);
			}
		});
		it("accounts a native proven overrun after reopening and retains the original owner", async () => {
			const { first, second } = setup();
			await reserve(first, "ci:a", 60);
			await second.claimExecution({
				reservationId: "ci:a",
				requestDigest: "ci:a",
				executionDigest: "execution",
			});
			await first.settle("ci:a", 120, {
				usageEvidenceRef: "native:final",
				sourceStoppedEvidenceRef: "native:stopped",
			});
			expect(await second.read(NOW)).toMatchObject({
				spentMicros: 120,
				reservedMicros: 0,
			});
			await expect(reserve(second, "hosting:next", 1)).rejects.toThrow(
				"budget exhausted",
			);
		});
		it("retains a committed hold when the COMMIT acknowledgement is lost", async () => {
			const { snapshot, pool, second } = setup();
			let dropAck = false;
			// Inject response loss AFTER a real PostgreSQL commit, not a simulated transaction engine.
			const lossyPool = new Proxy(pool, {
				get(target, key) {
					if (key === "connect")
						return async () => {
							const client = await target.connect();
							return new Proxy(client, {
								get(connection, method) {
									if (method === "query")
										return async (
											text: string,
											values?: (string | number | undefined)[],
										) => {
											const result = await connection.query(text, values);
											if (text === "COMMIT" && dropAck) {
												dropAck = false;
												throw new Error("COMMIT response lost");
											}
											return result;
										};
									// SAFETY: preserve the existing client's properties; only query is intercepted.
									return connection[method as keyof typeof connection];
								},
							});
						};
					// SAFETY: preserve the existing Pool's properties; only connect is intercepted.
					return target[key as keyof typeof target];
				},
			});
			const first = createPostgresBudgetAdmissionAuthority({
				pool: lossyPool,
				snapshot,
				now: () => NOW,
			});
			const current = await first.read(NOW);
			if (!current.identity) throw new Error("fixture identity missing");
			const quote = create(HostingQuoteSchema, {
				quoteId: "quote",
				yardId: "yard",
				providerId: "provider",
				ownerTenantId: current.identity.tenantId,
				currency: "USD",
				totalMicros: 60,
				liabilityBoundMicros: 60,
				requestDigest: "request",
				observedAt: NOW,
				validUntil: "2026-10-31T00:00:00Z",
				components: [{ name: "complete", costMicros: 60 }],
			});
			const input = {
				reservationId: "ci:uncertain-commit",
				requestDigest: quote.requestDigest,
				quote,
				identity: current.identity,
				expectedSeq: current.seq,
				now: NOW,
			};
			dropAck = true;
			await expect(first.reserve(input)).rejects.toThrow(
				"COMMIT response lost",
			);
			expect((await second.read(NOW)).reservedMicros).toBe(60);
			expect((await second.lookup(input.reservationId))?.status).toBe("held");
			await first.reserve(input);
			expect(await second.read(NOW)).toMatchObject({
				seq: 1,
				reservedMicros: 60,
			});
		});
		it("bounds same-pool starvation and returns a late client without SQL or a financial write", async () => {
			const { snapshot } = setup();
			const pool = new Pool({ connectionString: URL, max: 1 });
			pools.push(pool);
			let expired = false;
			const lateSql: string[] = [];
			const observedPool = new Proxy(pool, {
				get(target, key) {
					if (key === "connect")
						return async () => {
							const client = await target.connect();
							return new Proxy(client, {
								get(connection, method) {
									if (method === "query")
										return async (
											text: string,
											values?: (string | number | undefined)[],
										) => {
											if (expired) lateSql.push(text);
											return connection.query(text, values);
										};
									// SAFETY: preserve the real client's properties, intercepting only query.
									return connection[method as keyof typeof connection];
								},
							});
						};
					// SAFETY: preserve the real Pool's properties, intercepting only connect.
					return target[key as keyof typeof target];
				},
			});
			const authority = createPostgresBudgetAdmissionAuthority({
				pool: observedPool,
				snapshot,
				now: () => NOW,
				connectionTimeoutMs: 40,
			});
			const command = input(await authority.read(NOW), "ci:starved");
			const ciTransaction = await pool.connect();
			await ciTransaction.query("BEGIN");
			try {
				await expect(authority.reserve(command)).rejects.toThrow(
					"connection acquisition timed out",
				);
				expired = true;
			} finally {
				await ciTransaction.query("ROLLBACK");
				ciTransaction.release();
			}
			// Wait for this exact queued acquisition to be handed back and returned.
			for (let attempt = 0; attempt < 50 && pool.idleCount !== 1; attempt++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			expect(pool.waitingCount).toBe(0);
			expect(pool.idleCount).toBe(1);
			expect(lateSql).toEqual([]);
			expired = false;
			expect(await authority.lookup(command.reservationId)).toBeUndefined();
			expect((await authority.read(NOW)).seq).toBe(0);
			await authority.reserve(command);
			expect((await authority.read(NOW)).reservedMicros).toBe(60);
		});
		it("rolls back a row-lock timeout and permits the same stable financial intent to retry", async () => {
			const { snapshot, pool } = setup();
			const authority = createPostgresBudgetAdmissionAuthority({
				pool,
				snapshot,
				now: () => NOW,
				lockTimeoutMs: 40,
				statementTimeoutMs: 500,
			});
			const command = input(await authority.read(NOW), "ci:locked");
			const id = createHash("sha256")
				.update(
					JSON.stringify([
						snapshot.identity?.tenantId,
						snapshot.identity?.budgetId,
					]),
				)
				.digest("hex");
			const owner = await pool.connect();
			await owner.query("BEGIN");
			await owner.query(
				"SELECT id FROM hobo_budget_partitions WHERE id=$1 FOR UPDATE",
				[id],
			);
			try {
				await expect(authority.reserve(command)).rejects.toThrow(
					"lock timeout",
				);
			} finally {
				await owner.query("ROLLBACK");
				owner.release();
			}
			expect(await authority.lookup(command.reservationId)).toBeUndefined();
			expect((await authority.read(NOW)).seq).toBe(0);
			await authority.reserve(command);
			expect((await authority.read(NOW)).reservedMicros).toBe(60);
		});
		it("bounds a stalled statement, rolls it back and retries the unchanged intent", async () => {
			const { snapshot, pool } = setup();
			const authority = createPostgresBudgetAdmissionAuthority({
				pool,
				snapshot,
				now: () => NOW,
				lockTimeoutMs: 500,
				statementTimeoutMs: 40,
			});
			const command = input(await authority.read(NOW), "ci:stalled-statement");
			const id = createHash("sha256")
				.update(
					JSON.stringify([
						snapshot.identity?.tenantId,
						snapshot.identity?.budgetId,
					]),
				)
				.digest("hex");
			const suffix = randomUUID().replaceAll("-", "");
			const name = `stall_budget_${suffix}`;
			await pool.query(
				`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.partition_id = '${id}' THEN PERFORM pg_sleep(0.2); END IF; RETURN NEW; END $$`,
			);
			await pool.query(
				`CREATE TRIGGER ${name} BEFORE INSERT ON hobo_budget_events FOR EACH ROW EXECUTE FUNCTION ${name}()`,
			);
			try {
				await expect(authority.reserve(command)).rejects.toThrow(
					"statement timeout",
				);
			} finally {
				await pool.query(`DROP TRIGGER ${name} ON hobo_budget_events`);
				await pool.query(`DROP FUNCTION ${name}()`);
			}
			expect(await authority.lookup(command.reservationId)).toBeUndefined();
			await authority.reserve(command);
			expect((await authority.read(NOW)).reservedMicros).toBe(60);
		});
		it("uses the trusted server clock instead of caller time to validate prices", async () => {
			const { snapshot, pool } = setup();
			const expired = createPostgresBudgetAdmissionAuthority({
				pool,
				snapshot,
				now: () => "2026-11-01T00:00:00Z",
			});
			await expect(expired.read(NOW)).rejects.toThrow("stale");
		});
	},
);
