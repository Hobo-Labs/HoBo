import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	createImmutableJournal,
	type ImmutableJournalMember,
} from "@hobo/backend-fleet";
import {
	createPostgresImmutableJournalReplica,
	type SqlExecutor,
	type SqlParameter,
	type SqlSession,
} from "@hobo/data-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	HostingQuoteSchema,
} from "../src/budget-authority.js";
import { createFleetBudgetAdmissionAuthority } from "../src/budget-fleet.js";
import { createOperationalFleetBudgetAdmissionAuthority } from "../src/budget-fleet-operational.js";
import { createRecoveryActorFixture } from "./support/recovery-actor.js";

const socket = process.env.HOBO_TEST_JOURNAL_PG_SOCKET;
const url = process.env.HOBO_TEST_POSTGRES_URL;
const live = socket || url ? describe : describe.skip;
const NOW = "2026-10-30T12:00:00Z",
	UNTIL = "2026-10-31T00:00:00Z";

live("majority Broker on PostgreSQL voter records", () => {
	it("serializes holds and recovers after an isolated voter failure and a lost acknowledgement", async () => {
		const pool = url
			? new Pool({ connectionString: url, max: 8 })
			: new Pool({
					host: socket,
					port: 25471,
					user: "hobo_test",
					database: "postgres",
					max: 8,
				});
		const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
		const members: readonly ImmutableJournalMember[] = ["a", "b", "c"].map(
			(id) => ({
				id,
				provider: `fixture-${id}`,
				accountId: `account-${id}`,
				resourceId: `resource-${id}`,
				incarnation: `generation-${id}`,
			}),
		);
		const fleetId = `broker-${suffix}`;
		const anchorDigest = createHash("sha256")
			.update(
				JSON.stringify({
					contract: "hobo.immutable-journal-anchor/v1",
					fleetId,
					members,
				}),
			)
			.digest("hex");
		const offline = new Set<string>(),
			charges: string[] = [];
		function executor(id: string): SqlExecutor {
			const session = async <T>(
				run: (session: SqlSession) => Promise<T>,
			): Promise<T> => {
				if (offline.has(id)) throw new Error("voter unavailable");
				const client = await pool.connect();
				let failed = false;
				try {
					return await run({
						async query(sql, params) {
							return {
								rows: (await client.query(sql, params ? [...params] : [])).rows,
							};
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
				async query(sql: string, params?: readonly SqlParameter[]) {
					return session((s) => s.query(sql, params));
				},
			};
		}
		const voters = members.map((member) =>
			createPostgresImmutableJournalReplica({
				member,
				backend: { id: member.id, executor: executor(member.id) },
				anchorDigest,
				initializationId: `init-${suffix}-${member.id}`,
				controlPrefix: `hjb_${suffix}_${member.id}_`,
				maxDocumentBytes: 65_536,
				authorize: async (charge) => {
					charges.push(charge.operation);
					return async () => {};
				},
			}),
		);
		const journal = () =>
			createImmutableJournal({
				fleetId,
				members,
				anchorDigest,
				replicas: voters.map((voter) => voter.replica),
				maxEntryBytes: 32_000,
				maxEntries: 100,
				authorize: async () => {},
			});
		const snapshot = create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: `budget-${suffix}`,
				periodId: "p1",
				policyRevision: "r1",
			},
			limitMicros: 100,
			observedAt: NOW,
			validUntil: UNTIL,
		});
		const recoveryIdentity = snapshot.identity;
		if (!recoveryIdentity) throw new Error("missing budget identity");
		const actor = createRecoveryActorFixture(NOW);
		const actorHost = actor.host;
		let recoveries = 0;
		const authority = (j = journal()) =>
			createFleetBudgetAdmissionAuthority({
				journal: j,
				snapshot,
				now: () => NOW,
			});
		const operational = (j = journal()) =>
			createOperationalFleetBudgetAdmissionAuthority({
				journal: j,
				snapshot,
				recoveryIdentity,
				now: () => NOW,
				actorHost,
				async authorizeRecovery() {
					recoveries++;
					return async () => {};
				},
			});
		function request(id: string, seq: number, amount: number) {
			if (!snapshot.identity) throw new Error("test identity missing");
			return {
				reservationId: id,
				requestDigest: id,
				identity: snapshot.identity,
				expectedSeq: seq,
				now: NOW,
				quote: create(HostingQuoteSchema, {
					quoteId: `quote:${id}`,
					yardId: "yard",
					providerId: "provider",
					ownerTenantId: "tenant",
					currency: "USD",
					totalMicros: amount,
					liabilityBoundMicros: amount,
					observedAt: NOW,
					validUntil: UNTIL,
					components: [{ name: "complete", costMicros: amount }],
					requestDigest: id,
				}),
			};
		}
		try {
			for (const voter of voters) await voter.initializeFresh(async () => {});
			const first = authority(),
				second = authority();
			await first.initializeFresh(async () => {});
			const initial = await Promise.all(
				voters.map((voter) => voter.replica.read()),
			);
			const longest = Math.max(...initial.map((rows) => rows.length));
			const holders = initial
				.map((rows, index) => (rows.length === longest ? index : -1))
				.filter((index) => index >= 0);
			if (holders.length < 2) throw new Error("test lacks an initial majority");
			const active = holders.slice(0, 2);
			const behind = members.findIndex((_, index) => !active.includes(index));
			const behindMember = members[behind],
				offlineHolder = members[active[0] ?? -1];
			if (!behindMember || !offlineHolder)
				throw new Error("missing test member");
			offline.add(behindMember.id);
			const competing = await Promise.allSettled([
				first.reserve(request("a", 0, 60)),
				second.reserve(request("b", 0, 60)),
			]);
			expect(
				competing.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(await second.read(NOW)).toMatchObject({
				seq: 1,
				reservedMicros: 60,
			});
			offline.delete(behindMember.id);
			offline.add(offlineHolder.id);
			await expect(authority().read(NOW)).rejects.toThrow("quorum-unavailable");
			const underlying = journal();
			let lost = true;
			const lossy = {
				...underlying,
				async append(...args: Parameters<typeof underlying.append>) {
					const result = await underlying.append(...args);
					if (lost) {
						lost = false;
						throw new Error("lost acknowledgement");
					}
					return result;
				},
			};
			await expect(
				operational(lossy).reserve(request("c", 1, 40)),
			).rejects.toThrow("lost acknowledgement");
			const reopened = operational();
			expect((await reopened.reserve(request("c", 1, 40))).status).toBe("held");
			expect(await reopened.read(NOW)).toMatchObject({
				seq: 2,
				reservedMicros: 100,
			});
			expect(charges).toEqual(
				expect.arrayContaining(["initialize", "read", "write"]),
			);
			expect(recoveries).toBeGreaterThan(0);
		} finally {
			actor.close();
			for (const { id } of members)
				for (const table of [
					"journal_documents",
					"journal_info",
					"assignments",
				])
					await pool.query(`DROP TABLE IF EXISTS hjb_${suffix}_${id}_${table}`);
			await pool.end();
		}
	});
});
