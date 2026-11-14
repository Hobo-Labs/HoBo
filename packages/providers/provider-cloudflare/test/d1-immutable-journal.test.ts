import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
	createImmutableJournal,
	type ImmutableJournalMember,
} from "@hobo/backend-fleet";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	assertD1ImmutableJournalReplicaWiring,
	createD1ImmutableJournalReplica,
	type D1ImmutableJournalCharge,
	type D1ImmutableJournalOptions,
	d1ImmutableJournalReplicaIdentity,
} from "../src/d1-immutable-journal.js";

class D1Provider {
	readonly databases = new Map<string, DatabaseSync>();
	readonly charges: D1ImmutableJournalCharge[] = [];
	readonly offline = new Set<string>();
	primary = true;
	deny = false;
	loseUpdate = false;
	loseCreate = false;
	private pause: { enter: () => void; wait: Promise<void> } | undefined;
	private pauseDocument: { enter: () => void; wait: Promise<void> } | undefined;
	pauseUpdate() {
		let enter = () => {},
			release = () => {};
		const started = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.pause = { enter, wait };
		return { started, release };
	}
	pauseDocumentInsert() {
		let enter = () => {},
			release = () => {};
		const started = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.pauseDocument = { enter, wait };
		return { started, release };
	}
	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const databaseId = url.pathname.split("/").at(-2) ?? "";
		const db = this.databases.get(databaseId);
		if (!db || this.offline.has(databaseId)) throw new Error("D1 unavailable");
		const body = z.string().safeParse(init?.body);
		if (init?.redirect !== "manual" || !body.success)
			throw new Error("unsafe request");
		const request = z
			.object({ sql: z.string(), params: z.array(z.string()) })
			.parse(JSON.parse(body.data));
		if (
			/^INSERT\b/u.test(request.sql) &&
			request.params[0]?.startsWith("doc:") &&
			this.pauseDocument
		) {
			const pause = this.pauseDocument;
			this.pauseDocument = undefined;
			pause.enter();
			await pause.wait;
		}
		if (/^UPDATE\b/u.test(request.sql) && this.pause) {
			const pause = this.pause;
			this.pause = undefined;
			pause.enter();
			await pause.wait;
		}
		try {
			const stmt = db.prepare(request.sql);
			stmt.setReturnArrays(true);
			const rows = stmt.all(...request.params);
			if (/^CREATE TABLE\b/u.test(request.sql) && this.loseCreate) {
				this.loseCreate = false;
				throw new Error("lost response");
			}
			if (/^UPDATE\b/u.test(request.sql) && this.loseUpdate) {
				this.loseUpdate = false;
				throw new Error("lost response");
			}
			return new Response(
				JSON.stringify({
					success: true,
					result: [
						{
							success: true,
							meta: {
								served_by_primary: this.primary,
								rows_read: 1,
								rows_written: /^SELECT\b/u.test(request.sql) ? 0 : 1,
							},
							results: { rows },
						},
					],
				}),
				{ status: 200 },
			);
		} catch (error) {
			if (error instanceof Error && error.message === "lost response")
				throw error;
			return new Response(JSON.stringify({ success: false }), { status: 400 });
		}
	};
	close() {
		for (const db of this.databases.values()) db.close();
	}
}
async function fixture(options: { loseCreate?: boolean } = {}) {
	const provider = new D1Provider();
	provider.loseCreate = options.loseCreate ?? false;
	const accountId = "0123456789abcdef0123456789abcdef";
	const members: ImmutableJournalMember[] = ["1", "2", "3"].map((id) => ({
		id: `d${id}`,
		provider: "cloudflare",
		accountId,
		resourceId: `${id.repeat(8)}-2222-4333-8444-555555555555`,
		incarnation: `inc-${id}`,
	}));
	const anchor = JSON.stringify({
		contract: "hobo.immutable-journal-anchor/v1",
		fleetId: "journal",
		members,
	});
	const anchorDigest = createHash("sha256").update(anchor).digest("hex");
	const wirings: D1ImmutableJournalOptions[] = [];
	const voters = members.map((member) => {
		provider.databases.set(member.resourceId, new DatabaseSync(":memory:"));
		const wiring: D1ImmutableJournalOptions = {
			member,
			fleetId: "journal",
			members,
			anchorDigest,
			initializationId: `init-${member.id}`,
			accountId,
			databaseId: member.resourceId,
			maxEntries: 32,
			maxLogBytes: 16_000,
			maxDocumentBytes: 32_000,
			maxRequestBytes: 100_000,
			maxResponseBytes: 100_000,
			maxRowsPerQuery: 32,
			maxStorageOverheadBytes: 4096,
			fetchImpl: provider.fetch,
			resolveToken: async () => "scoped-token",
			authorize: async (charge) => {
				provider.charges.push(charge);
				if (provider.deny) throw new Error("budget denied");
				return async () => {};
			},
		};
		wirings.push(wiring);
		return createD1ImmutableJournalReplica(wiring);
	});
	for (const voter of voters) await voter.initializeFresh(async () => {});
	const journal = createImmutableJournal({
		fleetId: "journal",
		members,
		anchorDigest,
		replicas: voters.map((voter) => voter.replica),
		maxEntryBytes: 1024,
		maxEntries: 32,
		authorize: async () => {},
	});
	await journal.bootstrap(async () => {});
	return { provider, members, voters, journal, wirings, anchorDigest };
}

describe("bounded D1 immutable journal voter", () => {
	it("pins provider identity and its exact credential, transport and budget callbacks", async () => {
		const f = await fixture();
		try {
			const voter = f.voters[0],
				wiring = f.wirings[0];
			if (!voter || !wiring) throw new Error("missing voter");
			expect(d1ImmutableJournalReplicaIdentity(voter.replica)).toMatchObject({
				member: f.members[0],
				anchorDigest: f.anchorDigest,
				table: expect.stringMatching(/^hobo_journal_/u),
			});
			expect(() =>
				assertD1ImmutableJournalReplicaWiring(voter.replica, wiring),
			).not.toThrow();
			expect(() =>
				assertD1ImmutableJournalReplicaWiring(voter.replica, {
					...wiring,
					authorize: async () => async () => {},
				}),
			).toThrow();
			expect(() =>
				d1ImmutableJournalReplicaIdentity({ ...voter.replica }),
			).toThrow();
		} finally {
			f.provider.close();
		}
	});
	it("uses primary SQL and a majority when one provider database is unavailable", async () => {
		const f = await fixture();
		try {
			await f.journal.append("first", "one", 0);
			f.provider.offline.add(f.members[0]?.resourceId ?? "");
			await f.journal.append("second", "two", 1);
			expect((await f.journal.read()).map((entry) => entry.value)).toEqual([
				"one",
				"two",
			]);
			expect(
				f.provider.charges.some(
					(charge) =>
						charge.operation === "write" &&
						charge.maxAdditionalStorageBytes > 4096,
				),
			).toBe(true);
		} finally {
			f.provider.close();
		}
	});
	it("recovers a committed update after its response is lost", async () => {
		const f = await fixture();
		try {
			f.provider.loseUpdate = true;
			await f.journal.append("once", "payload", 0);
			expect((await f.journal.read()).map((entry) => entry.value)).toEqual([
				"payload",
			]);
		} finally {
			f.provider.close();
		}
	});
	it("resumes a fresh table after the create response was lost", async () => {
		const f = await fixture({ loseCreate: true });
		try {
			expect(f.provider.loseCreate).toBe(false);
			await f.journal.append("after-restart", "payload", 0);
			expect(await f.journal.read()).toHaveLength(1);
		} finally {
			f.provider.close();
		}
	});
	it("rejects a persisted log that omits a required scalar field", async () => {
		const f = await fixture();
		try {
			const replica = f.voters[0]?.replica;
			const database = f.provider.databases.get(f.members[0]?.resourceId ?? "");
			if (!replica || !database) throw new Error("missing voter");
			const table = d1ImmutableJournalReplicaIdentity(replica).table;
			database
				.prepare(
					`UPDATE ${table} SET value=json_remove(value, '$.entries[0].sealed') WHERE key='log'`,
				)
				.run();
			await expect(replica.read()).rejects.toThrow("identity-unverified");
		} finally {
			f.provider.close();
		}
	});
	it("fences a delayed conditional write after another entry wins", async () => {
		const f = await fixture();
		try {
			const replica = f.voters[0]?.replica;
			if (!replica) throw new Error("missing voter");
			const genesis = (await replica.read())[0];
			if (!genesis) throw new Error("missing genesis");
			const previous = genesis.reason.split(":")[2];
			const a = "left-document",
				b = "right-document";
			const da = createHash("sha256").update(a).digest("hex"),
				db = createHash("sha256").update(b).digest("hex");
			await replica.writeDocument(da, a);
			await replica.writeDocument(db, b);
			const late = { ...genesis, epoch: 2, reason: `j:${previous}:${da}` };
			const winner = { ...genesis, epoch: 2, reason: `j:${previous}:${db}` };
			const pause = f.provider.pauseUpdate();
			const pending = replica.accept(late);
			await pause.started;
			expect(await replica.accept(winner)).toBe("accepted");
			pause.release();
			expect(await pending).toBe("conflict");
			expect((await replica.read()).at(-1)?.reason).toBe(winner.reason);
		} finally {
			f.provider.close();
		}
	});
	it("rejects a document INSERT delayed until after the receiver seals the generation", async () => {
		const f = await fixture();
		let release = () => {};
		try {
			const replica = f.voters[0]?.replica;
			if (!replica) throw new Error("missing voter");
			const head = (await replica.read()).at(-1);
			const digest = head?.reason.split(":")[2];
			if (!head || !digest) throw new Error("missing journal head");
			const body = "delayed-document";
			const documentDigest = createHash("sha256").update(body).digest("hex");
			const paused = f.provider.pauseDocumentInsert();
			release = paused.release;
			const pending = replica.writeDocument(documentDigest, body);
			await paused.started;
			expect(
				await replica.seal({ transitionId: "stop", epoch: head.epoch, digest }),
			).toBe("sealed");
			paused.release();
			await expect(pending).rejects.toThrow("generation-sealed");
			expect(await replica.readDocument(documentDigest)).toBeUndefined();
		} finally {
			release();
			f.provider.close();
		}
	});
	it("seals an exact head and fences a delayed append across a lost seal response", async () => {
		const f = await fixture();
		try {
			const replica = f.voters[0]?.replica;
			if (!replica) throw new Error("missing voter");
			const genesis = (await replica.read())[0];
			if (!genesis) throw new Error("missing genesis");
			const previous = genesis.reason.split(":")[2];
			if (!previous) throw new Error("missing digest");
			const body = "delayed-document",
				nextDigest = createHash("sha256").update(body).digest("hex");
			await replica.writeDocument(nextDigest, body);
			const delayed = {
				...genesis,
				epoch: 2,
				reason: `j:${previous}:${nextDigest}`,
			};
			const seal = { transitionId: "rollover-1", epoch: 1, digest: previous };
			const pause = f.provider.pauseUpdate();
			const pending = replica.accept(delayed);
			await pause.started;
			f.provider.loseUpdate = true;
			expect(await replica.seal(seal)).toBe("duplicate");
			pause.release();
			await expect(pending).rejects.toThrow();
			expect(await replica.seal(seal)).toBe("duplicate");
			expect(
				await replica.seal({ ...seal, transitionId: "rollover-other" }),
			).toBe("conflict");
			await expect(replica.accept(delayed)).rejects.toThrow(
				"generation-sealed",
			);
			await expect(
				replica.writeDocument(nextDigest, body),
			).resolves.toBeUndefined();
			const absent = "new-after-seal";
			await expect(
				replica.writeDocument(
					createHash("sha256").update(absent).digest("hex"),
					absent,
				),
			).rejects.toThrow("generation-sealed");
			expect(await replica.read()).toHaveLength(1);
		} finally {
			f.provider.close();
		}
	});
	it("refuses lost state, unverified primary, and denied funding", async () => {
		const f = await fixture();
		try {
			const replica = f.voters[0]?.replica,
				database = f.provider.databases.get(f.members[0]?.resourceId ?? "");
			if (!replica || !database) throw new Error("missing voter");
			f.provider.primary = false;
			await expect(replica.read()).rejects.toThrow("primary-unverified");
			f.provider.primary = true;
			f.provider.deny = true;
			await expect(replica.read()).rejects.toThrow("authorization-unavailable");
			f.provider.deny = false;
			const names = database
				.prepare("SELECT name FROM sqlite_master WHERE type='table'")
				.all();
			const table = z
				.string()
				.regex(/^hobo_journal_[a-f0-9]{32}$/u)
				.safeParse(names[0]?.name);
			if (!table.success) throw new Error("missing table");
			database.exec(`DELETE FROM ${table.data} WHERE key='log'`);
			await expect(replica.read()).rejects.toThrow("identity-unverified");
			await expect(
				f.voters[0]?.initializeFresh(async () => {
					throw new Error("already enrolled");
				}),
			).rejects.toThrow("freshness-unverified");
		} finally {
			f.provider.close();
		}
	});
});
