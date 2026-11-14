import { createHash, randomUUID } from "node:crypto";
import {
	createImmutableJournal,
	type ImmutableJournalMember,
} from "@hobo/backend-fleet";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createPostgresImmutableJournalReplica } from "../src/fleet/immutable-journal.js";
import type {
	SqlExecutor,
	SqlParameter,
	SqlSession,
} from "../src/fleet/sql.js";

const socket = process.env.HOBO_TEST_JOURNAL_PG_SOCKET;
const url = process.env.HOBO_TEST_JOURNAL_PG_URL;
const port = Number(process.env.HOBO_TEST_JOURNAL_PG_PORT ?? "25471");
const user = process.env.HOBO_TEST_JOURNAL_PG_USER ?? "hobo_test";
const live = socket || url ? describe : describe.skip;
function testPool(max: number): pg.Pool {
	if (url)
		return new pg.Pool({
			connectionString: url,
			ssl: { rejectUnauthorized: true },
			max,
		});
	if (!socket) throw new Error("test PostgreSQL connection required");
	return new pg.Pool({ host: socket, port, user, database: "postgres", max });
}
async function waitForBlockedBackend(pool: pg.Pool, blocker: number) {
	for (let attempt = 0; attempt < 200; attempt++) {
		const result = await pool.query(
			"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
			[blocker],
		);
		if (result.rows[0]?.blocked === true) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("expected PostgreSQL lock contention was not observed");
}

live("PostgreSQL immutable journal voter", () => {
	it("persists ordered majority history, recovers a voter, and refuses lost state", async () => {
		const pool = testPool(8);
		const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
		const members: readonly ImmutableJournalMember[] = ["a", "b", "c"].map(
			(id) => ({
				id,
				provider: `provider-${id}`,
				accountId: `account-${id}`,
				resourceId: `resource-${id}`,
				incarnation: `incarnation-${id}`,
			}),
		);
		const anchor = JSON.stringify({
			contract: "hobo.immutable-journal-anchor/v1",
			fleetId: "test-fleet",
			members,
		});
		const anchorDigest = createHash("sha256").update(anchor).digest("hex");
		const offline = new Set<string>();
		const charges: string[] = [];
		function executor(id: string): SqlExecutor {
			const session = async <T>(
				run: (session: SqlSession) => Promise<T>,
			): Promise<T> => {
				if (offline.has(id)) throw new Error("offline provider");
				const client = await pool.connect();
				let failed = false;
				try {
					return await run({
						async query(sql, params) {
							const result = await client.query(sql, params ? [...params] : []);
							return { rows: result.rows };
						},
					});
				} catch (error) {
					failed = true;
					throw error;
				} finally {
					client.release(failed);
				}
			};
			return {
				session,
				async query(sql: string, parameters?: readonly SqlParameter[]) {
					return session((s) => s.query(sql, parameters));
				},
			};
		}
		const voters = members.map((member) =>
			createPostgresImmutableJournalReplica({
				member,
				backend: { id: member.id, executor: executor(member.id) },
				anchorDigest,
				initializationId: `init-${suffix}-${member.id}`,
				controlPrefix: `hjr_${suffix}_${member.id}_`,
				maxDocumentBytes: 65_536,
				authorize: async (charge) => {
					charges.push(charge.operation);
					return async () => {};
				},
			}),
		);
		const journal = () =>
			createImmutableJournal({
				fleetId: "test-fleet",
				members,
				anchorDigest,
				replicas: voters.map((voter) => voter.replica),
				maxEntryBytes: 4096,
				maxEntries: 100,
				authorize: async () => {},
			});
		try {
			for (const voter of voters) {
				await voter.initializeFresh(async () => {});
				// The same fresh operation can recover an ambiguous COMMIT safely.
				await voter.initializeFresh(async () => {});
			}
			const firstMember = members[0];
			if (!firstMember) throw new Error("missing fixture member");
			const denied = createPostgresImmutableJournalReplica({
				member: firstMember,
				backend: { id: firstMember.id, executor: executor(firstMember.id) },
				anchorDigest,
				initializationId: `init-${suffix}-${firstMember.id}`,
				controlPrefix: `hjr_${suffix}_${firstMember.id}_`,
				maxDocumentBytes: 65_536,
				authorize: async (charge) => {
					if (charge.operation === "initialize")
						throw new Error("private credential");
					return async () => {};
				},
			});
			await expect(denied.initializeFresh(async () => {})).rejects.toThrow(
				"authorization-unavailable",
			);
			await expect(
				denied.initializeFresh(async () => {
					throw new Error("private credential");
				}),
			).rejects.toThrow("freshness-unverified");
			await journal().bootstrap(async () => {});
			const first = await journal().append(
				"operation-one",
				"events-and-effects-one",
				0,
			);
			offline.add("a");
			const second = await journal().append(
				"operation-two",
				"events-and-effects-two",
				1,
			);
			expect((await journal().read()).map((entry) => entry.digest)).toEqual([
				first.digest,
				second.digest,
			]);
			offline.delete("a");
			offline.add("b");
			await expect(journal().read()).rejects.toThrow("quorum-unavailable");
			expect((await journal().recover()).map((entry) => entry.value)).toEqual([
				"events-and-effects-one",
				"events-and-effects-two",
			]);
			expect(
				await journal().append("operation-two", "events-and-effects-two", 1),
			).toEqual(second);
			const sealedVoter = voters[0]?.replica;
			if (!sealedVoter) throw new Error("missing voter");
			const head = (await sealedVoter.read(1))[0];
			const digest = head?.reason.split(":")[2];
			if (!head || !digest) throw new Error("missing journal head");
			const seal = { transitionId: "rollover-1", epoch: head.epoch, digest };
			expect(await sealedVoter.seal(seal)).toBe("sealed");
			expect(await sealedVoter.seal(seal)).toBe("duplicate");
			expect(await sealedVoter.seal({ ...seal, transitionId: "other" })).toBe(
				"conflict",
			);
			// This raw insert emulates an older writer that does not know about
			// seals; the database trigger fences it at the actual receiver.
			await expect(
				pool.query(
					`INSERT INTO hjr_${suffix}_a_assignments(epoch,active,sealed,target,reason,loss_window_ms,decided_at,decided_by) VALUES ($1,NULL,false,NULL,$2,NULL,timestamptz 'epoch','journal')`,
					[head.epoch + 1, `j:${digest}:${"a".repeat(64)}`],
				),
			).rejects.toThrow("journal generation sealed");
			await expect(
				sealedVoter.writeDocument(
					createHash("sha256").update("late").digest("hex"),
					"late",
				),
			).rejects.toThrow();
			expect(await sealedVoter.read(1)).toHaveLength(1);
			const table = `hjr_${suffix}_a_assignments`;
			const trigger = `hjr_${suffix}_a_journal_seal_trigger`;
			const guard = `hjr_${suffix}_a_journal_seal_guard()`;
			await pool.query(`DROP TRIGGER ${trigger} ON ${table}`);
			await pool.query(
				`CREATE TRIGGER ${trigger} AFTER INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${guard}`,
			);
			await expect(sealedVoter.read()).rejects.toThrow(
				"seal-trigger-unverified",
			);
			await pool.query(`DROP TRIGGER ${trigger} ON ${table}`);
			await pool.query(
				`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (false) EXECUTE FUNCTION ${guard}`,
			);
			await expect(sealedVoter.read()).rejects.toThrow(
				"seal-trigger-unverified",
			);
			await pool.query(`DROP TRIGGER ${trigger} ON ${table}`);
			await pool.query(
				`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${guard}`,
			);
			expect(await sealedVoter.read(1)).toHaveLength(1);
			const replicaSession = await pool.connect();
			try {
				await replicaSession.query("SET session_replication_role = replica");
				const switched: SqlExecutor = {
					async query(sql, params) {
						const result = await replicaSession.query(
							sql,
							params ? [...params] : [],
						);
						return { rows: result.rows };
					},
					async session(run) {
						return run(this);
					},
				};
				const voter = createPostgresImmutableJournalReplica({
					member: firstMember,
					backend: { id: firstMember.id, executor: switched },
					anchorDigest,
					initializationId: `init-${suffix}-${firstMember.id}`,
					controlPrefix: `hjr_${suffix}_${firstMember.id}_`,
					maxDocumentBytes: 65_536,
					authorize: async () => async () => {},
				});
				await expect(voter.replica.read()).rejects.toThrow(
					"seal-trigger-unverified",
				);
			} finally {
				await replicaSession.query("RESET session_replication_role");
				replicaSession.release();
			}
			await pool.query(
				`ALTER TABLE hjr_${suffix}_a_assignments DISABLE TRIGGER hjr_${suffix}_a_journal_seal_trigger`,
			);
			await expect(sealedVoter.read()).rejects.toThrow(
				"seal-trigger-unverified",
			);
			await pool.query(`DROP TABLE hjr_${suffix}_a_assignments`);
			await expect(voters[0]?.replica.read()).rejects.toThrow(
				"read-unavailable",
			);
			expect(charges).toContain("initialize");
			expect(charges).toContain("read");
			expect(charges).toContain("write");
		} finally {
			for (const { id } of members) {
				for (const table of [
					"journal_documents",
					"journal_info",
					"assignments",
				]) {
					await pool.query(`DROP TABLE IF EXISTS hjr_${suffix}_${id}_${table}`);
				}
				await pool.query(
					`DROP FUNCTION IF EXISTS hjr_${suffix}_${id}_journal_seal_guard()`,
				);
			}
			await pool.end();
		}
	});
	it("serializes an in-flight old writer against the receiver-side seal in both orders", async () => {
		const pool = testPool(6);
		const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
		let releaseSeal!: () => void;
		let reportSealPid!: (pid: number) => void;
		const sealPaused = new Promise<number>((resolve) => {
			reportSealPid = resolve;
		});
		const sealGate = new Promise<void>((resolve) => {
			releaseSeal = resolve;
		});
		function voter(id: string) {
			const prefix = `hjl_${suffix}_${id}_`;
			const executor: SqlExecutor = {
				async session(run) {
					const client = await pool.connect();
					let failed = false;
					try {
						return await run({
							async query(sql, params) {
								const result = await client.query(
									sql,
									params ? [...params] : [],
								);
								if (
									id === "b" &&
									sql.startsWith(
										`UPDATE ${prefix}journal_info SET sealed_epoch=`,
									)
								) {
									const pid = await client.query(
										"SELECT pg_backend_pid() AS pid",
									);
									reportSealPid(pid.rows[0].pid);
									await sealGate;
								}
								return { rows: result.rows };
							},
						});
					} catch (error) {
						failed = true;
						throw error;
					} finally {
						client.release(failed);
					}
				},
				async query(sql, params) {
					return this.session((session) => session.query(sql, params));
				},
			};
			return createPostgresImmutableJournalReplica({
				member: {
					id,
					provider: `provider-${id}`,
					accountId: `account-${id}`,
					resourceId: `resource-${id}`,
					incarnation: `inc-${id}`,
				},
				backend: { id, executor },
				anchorDigest: "f".repeat(64),
				initializationId: `test-${suffix}-${id}`,
				controlPrefix: prefix,
				maxDocumentBytes: 4096,
				authorize: async () => async () => {},
			});
		}
		const a = voter("a"),
			b = voter("b");
		const digest = "a".repeat(64),
			nextDigest = "b".repeat(64);
		const initial = {
			epoch: 1,
			active: undefined,
			sealed: false,
			target: undefined,
			reason: `j:${"0".repeat(64)}:${digest}`,
			lossWindowMs: undefined,
			decidedAtMs: 0,
			decidedBy: "journal",
		};
		const insert = (id: string) =>
			`INSERT INTO hjl_${suffix}_${id}_assignments(epoch,active,sealed,target,reason,loss_window_ms,decided_at,decided_by) VALUES (2,NULL,false,NULL,$1,NULL,timestamptz 'epoch','journal')`;
		try {
			for (const instance of [a, b]) {
				await instance.initializeFresh(async () => {});
				expect(await instance.replica.accept(initial)).toBe("accepted");
			}
			const writer = await pool.connect();
			try {
				await writer.query("BEGIN");
				const pid = await writer.query("SELECT pg_backend_pid() AS pid");
				await writer.query(insert("a"), [`j:${digest}:${nextDigest}`]);
				const sealing = a.replica.seal({
					transitionId: "old",
					epoch: 1,
					digest,
				});
				void sealing.catch(() => {});
				await waitForBlockedBackend(pool, pid.rows[0].pid);
				await writer.query("COMMIT");
				expect(await sealing).toBe("conflict");
				expect((await a.replica.read(1))[0]?.epoch).toBe(2);
			} finally {
				await writer.query("ROLLBACK").catch(() => {});
				writer.release();
			}
			const sealing = b.replica.seal({ transitionId: "new", epoch: 1, digest });
			const sealPid = await Promise.race([
				sealPaused,
				sealing.then(() => {
					throw new Error("seal did not reach its protected transaction");
				}),
			]);
			const late = pool.query(insert("b"), [`j:${digest}:${nextDigest}`]).then(
				() => undefined,
				(error: Error) => error,
			);
			try {
				await waitForBlockedBackend(pool, sealPid);
			} finally {
				releaseSeal();
			}
			expect(await sealing).toBe("sealed");
			expect(await late).toBeInstanceOf(Error);
			expect(String(await late)).toContain("journal generation sealed");
			expect((await b.replica.read(1))[0]?.epoch).toBe(1);
		} finally {
			releaseSeal();
			for (const id of ["a", "b"]) {
				for (const table of [
					"journal_documents",
					"journal_info",
					"assignments",
				])
					await pool.query(`DROP TABLE IF EXISTS hjl_${suffix}_${id}_${table}`);
				await pool.query(
					`DROP FUNCTION IF EXISTS hjl_${suffix}_${id}_journal_seal_guard()`,
				);
			}
			await pool.end();
		}
	}, 15_000);
});

const roleLive = socket ? describe : describe.skip;
roleLive("PostgreSQL journal role boundary", () => {
	it("keeps workload writes fenced by the separate schema owner in both lock orders", async () => {
		if (!socket) throw new Error("test socket required");
		const admin = testPool(6);
		const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
		const role = `hjr_runtime_${suffix}`;
		const schema = `hjr_schema_${suffix}`;
		const runtimePool = new pg.Pool({
			host: socket,
			port,
			user: role,
			database: "postgres",
			max: 6,
		});
		let holdSeal = false;
		let releaseSeal!: () => void;
		let reportPid!: (pid: number) => void;
		const paused = new Promise<number>((resolve) => {
			reportPid = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseSeal = resolve;
		});
		function executor(pool: pg.Pool, intercept = false): SqlExecutor {
			const session: SqlExecutor["session"] = async (run) => {
				const client = await pool.connect();
				let failed = false;
				try {
					return await run({
						async query(sql, params) {
							const result = await client.query(sql, params ? [...params] : []);
							if (
								intercept &&
								holdSeal &&
								sql.startsWith(
									`UPDATE ${schema}.b_journal_info SET sealed_epoch=`,
								)
							) {
								const pid = await client.query(
									"SELECT pg_backend_pid() AS pid",
								);
								reportPid(pid.rows[0].pid);
								await gate;
							}
							return { rows: result.rows };
						},
					});
				} catch (error) {
					failed = true;
					throw error;
				} finally {
					client.release(failed);
				}
			};
			return {
				session,
				async query(sql, params) {
					return session((client) => client.query(sql, params));
				},
			};
		}
		const ownerExecutor = executor(admin, true),
			workloadExecutor = executor(runtimePool);
		const digest = "a".repeat(64),
			next = "b".repeat(64);
		const initial = {
			epoch: 1,
			active: undefined,
			sealed: false,
			target: undefined,
			reason: `j:${"0".repeat(64)}:${digest}`,
			lossWindowMs: undefined,
			decidedAtMs: 0,
			decidedBy: "journal",
		};
		function voter(id: string, management: boolean) {
			return createPostgresImmutableJournalReplica({
				member: {
					id,
					provider: `provider-${id}`,
					accountId: `account-${id}`,
					resourceId: `resource-${id}`,
					incarnation: `inc-${id}`,
				},
				backend: { id, executor: workloadExecutor },
				anchorDigest: "f".repeat(64),
				initializationId: `init-${id}`,
				controlPrefix: `${id}_`,
				maxDocumentBytes: 4096,
				roleBoundary: {
					schema,
					ownerRole: user,
					runtimeRole: role,
					...(management ? { managementExecutor: ownerExecutor } : undefined),
				},
				authorize: async () => async () => {},
			});
		}
		const a = voter("a", true),
			b = voter("b", true),
			workload = voter("b", false);
		const insert = (id: string) =>
			`INSERT INTO ${schema}.${id}_assignments(epoch,active,sealed,target,reason,loss_window_ms,decided_at,decided_by) VALUES (2,NULL,false,NULL,$1,NULL,timestamptz 'epoch','journal')`;
		try {
			await admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT`);
			await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${user}`);
			for (const instance of [a, b]) {
				await instance.initializeFresh(async () => {});
				expect(await instance.replica.accept(initial)).toBe("accepted");
			}
			await expect(workload.initializeFresh(async () => {})).rejects.toThrow(
				"owner-custody-unavailable",
			);
			await expect(
				workload.replica.seal({ transitionId: "no-owner", epoch: 1, digest }),
			).rejects.toThrow("owner-custody-unavailable");
			await expect(
				runtimePool.query(
					`UPDATE ${schema}.b_journal_info SET sealed_epoch=1,seal_digest=$1,seal_transition='forged'`,
					[digest],
				),
			).rejects.toThrow(/permission denied/u);
			await expect(
				runtimePool.query(
					`ALTER TABLE ${schema}.b_assignments DISABLE TRIGGER ALL`,
				),
			).rejects.toThrow();
			await expect(
				runtimePool.query("SET session_replication_role = replica"),
			).rejects.toThrow();
			await expect(
				runtimePool.query(`CREATE TABLE ${schema}.foreign_table(id int)`),
			).rejects.toThrow();
			const writer = await runtimePool.connect();
			try {
				await writer.query("BEGIN");
				const pid = await writer.query("SELECT pg_backend_pid() AS pid");
				await writer.query(insert("a"), [`j:${digest}:${next}`]);
				const sealing = a.replica.seal({
					transitionId: "old",
					epoch: 1,
					digest,
				});
				void sealing.catch(() => {});
				await waitForBlockedBackend(admin, pid.rows[0].pid);
				await writer.query("COMMIT");
				expect(await sealing).toBe("conflict");
			} finally {
				await writer.query("ROLLBACK").catch(() => {});
				writer.release();
			}
			holdSeal = true;
			const sealing = b.replica.seal({
				transitionId: "winner",
				epoch: 1,
				digest,
			});
			const pid = await Promise.race([
				paused,
				sealing.then(() => {
					throw new Error("seal did not pause");
				}),
			]);
			const late = runtimePool.query(insert("b"), [`j:${digest}:${next}`]).then(
				() => undefined,
				(error: Error) => error,
			);
			try {
				await waitForBlockedBackend(admin, pid);
			} finally {
				releaseSeal();
			}
			expect(await sealing).toBe("sealed");
			expect(String(await late)).toContain("journal generation sealed");
			expect((await workload.replica.read(1))[0]?.epoch).toBe(1);
			await expect(
				runtimePool.query(
					`UPDATE ${schema}.b_journal_info SET sealed_epoch=NULL,seal_digest=NULL,seal_transition=NULL`,
				),
			).rejects.toThrow(/permission denied/u);
			await expect(
				workload.replica.writeDocument(
					createHash("sha256").update("late").digest("hex"),
					"late",
				),
			).rejects.toThrow();
			await admin.query(`GRANT ${user} TO ${role}`);
			await expect(workload.replica.read()).rejects.toThrow(
				"runtime-role-unverified",
			);
			await admin.query(`REVOKE ${user} FROM ${role}`);
			await admin.query(
				`GRANT UPDATE(sealed_epoch) ON ${schema}.b_journal_info TO ${role}`,
			);
			await expect(workload.replica.read()).rejects.toThrow(
				"runtime-role-unverified",
			);
		} finally {
			releaseSeal();
			await runtimePool.end();
			await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
			await admin.query(`DROP ROLE IF EXISTS ${role}`);
			await admin.end();
		}
	}, 30_000);
});

live("PostgreSQL fleet control migration", () => {
	it("upgrades the old null-writer constraint atomically and idempotently", async () => {
		const pool = testPool(2);
		const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
		const controlPrefix = `hjm_${suffix}_`;
		const table = `${controlPrefix}assignments`;
		const backend: SqlExecutor = {
			async query(sql, parameters) {
				const result = await pool.query(sql, parameters ? [...parameters] : []);
				return { rows: result.rows };
			},
			async session(run) {
				const client = await pool.connect();
				let failed = false;
				try {
					return await run({
						async query(sql, parameters) {
							const result = await client.query(
								sql,
								parameters ? [...parameters] : [],
							);
							return { rows: result.rows };
						},
					});
				} catch (error) {
					failed = true;
					throw error;
				} finally {
					client.release(failed);
				}
			},
		};
		try {
			await pool.query(
				`CREATE TABLE ${table} (epoch bigint PRIMARY KEY CHECK (epoch >= 1), active text, sealed boolean NOT NULL, target text, reason text NOT NULL, loss_window_ms bigint CHECK (loss_window_ms >= 0), decided_at timestamptz NOT NULL, decided_by text NOT NULL, CHECK (sealed = (target IS NOT NULL)), CHECK (target IS DISTINCT FROM active))`,
			);
			await pool.query(
				`INSERT INTO ${table} VALUES (1,'a',false,NULL,'bootstrap',NULL,now(),'tester')`,
			);
			const { ensureFleetControlTables } = await import(
				"../src/fleet/control.js"
			);
			const { parseFleetLayout } = await import("../src/fleet/layout.js");
			const layout = parseFleetLayout({
				dataPrefix: `hjd_${suffix}_`,
				controlPrefix,
			});
			await ensureFleetControlTables({ id: "a", executor: backend }, layout);
			await ensureFleetControlTables({ id: "a", executor: backend }, layout);
			await pool.query(
				`INSERT INTO ${table} VALUES (2,NULL,false,NULL,'paused',NULL,now(),'tester')`,
			);
			expect(
				(
					await pool.query(`SELECT epoch FROM ${table} ORDER BY epoch`)
				).rows.map((row) => row.epoch),
			).toEqual(["1", "2"]);
			await expect(
				pool.query(
					`INSERT INTO ${table} VALUES (3,'a',true,'a','invalid',NULL,now(),'tester')`,
				),
			).rejects.toMatchObject({ code: "23514" });
			const constraints = await pool.query(
				"SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='c'",
				[table],
			);
			expect(
				constraints.rows.filter(
					(row) =>
						row.definition === "CHECK ((target IS DISTINCT FROM active))",
				),
			).toHaveLength(0);
			expect(
				constraints.rows.filter(
					(row) =>
						row.definition ===
						"CHECK (((NOT sealed) OR (target IS DISTINCT FROM active)))",
				),
			).toHaveLength(1);
		} finally {
			for (const tableName of ["assignments", "watermarks", "usage"])
				await pool.query(`DROP TABLE IF EXISTS ${controlPrefix}${tableName}`);
			await pool.end();
		}
	});
});
