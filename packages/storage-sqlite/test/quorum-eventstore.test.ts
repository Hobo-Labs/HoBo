import { createHash } from "node:crypto";
import {
	type AssignmentAcceptOutcome,
	assignmentKey,
	createImmutableJournal,
	type FleetAssignment,
	type ImmutableJournalMember,
	type ImmutableJournalReplica,
} from "@hobo/backend-fleet";
import { describe, expect, it } from "vitest";
import {
	assertQuorumEventStore,
	assertQuorumEventStoreJournal,
	createQuorumEventStore,
	type QuorumEventStoreOptions,
	quorumEventStoreIdentity,
} from "../src/quorum-eventstore.js";

class Replica implements ImmutableJournalReplica {
	readonly entries: FleetAssignment[] = [];
	readonly documents = new Map<string, string>();
	available = true;
	loseReply = false;
	failAccept = false;
	constructor(readonly id: string) {}
	async read(limit?: number) {
		if (!this.available) throw new Error("offline");
		return this.entries.slice(-(limit ?? this.entries.length));
	}
	async accept(entry: FleetAssignment): Promise<AssignmentAcceptOutcome> {
		if (!this.available) throw new Error("offline");
		if (this.failAccept) throw new Error("accept unavailable");
		const old = this.entries.find((value) => value.epoch === entry.epoch);
		if (old)
			return assignmentKey(old) === assignmentKey(entry)
				? "duplicate"
				: "conflict";
		if ((this.entries.at(-1)?.epoch ?? 0) !== entry.epoch - 1) return "gap";
		this.entries.push(entry);
		if (this.loseReply) {
			this.loseReply = false;
			throw new Error("lost response");
		}
		return "accepted";
	}
	async readDocument(digest: string) {
		if (!this.available) throw new Error("offline");
		return this.documents.get(digest);
	}
	async writeDocument(digest: string, value: string) {
		if (!this.available) throw new Error("offline");
		const old = this.documents.get(digest);
		if (old !== undefined && old !== value) throw new Error("conflict");
		this.documents.set(digest, value);
	}
}
async function fixture() {
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
		fleetId: "events",
		members,
	});
	const anchorDigest = createHash("sha256").update(anchor).digest("hex");
	const replicas = [
		new Replica("a"),
		new Replica("b"),
		new Replica("c"),
	] as const;
	const journal = createImmutableJournal({
		fleetId: "events",
		members,
		anchorDigest,
		replicas,
		maxEntryBytes: 64_000,
		maxEntries: 100,
		authorize: async () => {},
	});
	await journal.bootstrap(async () => {});
	let now = 1_800_000_000_000;
	return {
		replicas,
		journal,
		open: (
			operationalRecovery?: QuorumEventStoreOptions["operationalRecovery"],
		) =>
			createQuorumEventStore({
				journal,
				nowMs: () => now,
				maxReplayEntries: 100,
				maxReplayBytes: 1_000_000,
				pollIntervalMs: 100,
				...(operationalRecovery ? { operationalRecovery } : undefined),
			}),
		openClaims: (
			overrides: Partial<NonNullable<QuorumEventStoreOptions["claims"]>> = {},
			operationalRecovery?: QuorumEventStoreOptions["operationalRecovery"],
		) =>
			createQuorumEventStore({
				journal,
				nowMs: () => now,
				maxReplayEntries: 100,
				maxReplayBytes: 1_000_000,
				...(operationalRecovery ? { operationalRecovery } : undefined),
				claims: {
					contractId: "test:verified-stop/v1",
					protectedStreamPrefixes: ["deployment:"],
					async verifyRelease({ evidence }) {
						if (evidence !== "test:source-stopped")
							throw new Error("source has not stopped");
					},
					...overrides,
				},
			}),
		setNow: (value: number) => {
			now = value;
		},
	};
}
const actor = { kind: "service", id: "test" } as const;
const append = { actor, tenant: "tenant", expectedSeq: 0 };

describe("quorum transactional event store", () => {
	it("attests only stores created by the quorum implementation", async () => {
		const f = await fixture();
		const store = f.open();
		expect(() => assertQuorumEventStore(store)).not.toThrow();
		expect(() => assertQuorumEventStore({ ...store })).toThrow();
		expect(() => assertQuorumEventStore(new Proxy(store, {}))).toThrow();
		expect(() => assertQuorumEventStore(null)).toThrow();
		expect(() => assertQuorumEventStoreJournal(store, f.journal)).not.toThrow();
		expect(() =>
			assertQuorumEventStoreJournal(store, { ...f.journal }),
		).toThrow();
		const identity = quorumEventStoreIdentity(store);
		expect(identity).toEqual({
			fleetId: "events",
			anchorDigest: f.journal.anchorDigest,
			quorum: 2,
			members: f.journal.members,
			hasNonExpiringClaims: false,
			hasOperationalRecovery: false,
		});
		expect(Object.isFrozen(identity)).toBe(true);
		expect(Object.isFrozen(identity.members)).toBe(true);
		expect(identity.members.every(Object.isFrozen)).toBe(true);
		const configured = f.openClaims({}, { authorize: async () => {} });
		expect(quorumEventStoreIdentity(configured)).toMatchObject({
			hasNonExpiringClaims: true,
			hasOperationalRecovery: true,
		});
		await Promise.all([store.close(), configured.close()]);
	});

	it("requires funded operational authority for explicit recovery", async () => {
		const f = await fixture();
		const first = f.open();
		f.replicas[2].available = false;
		await first.commit({
			streamId: "stream",
			append,
			events: [{ type: "test.Created" }],
		});
		f.replicas[2].available = true;
		f.replicas[0].available = false;
		const before = f.replicas[2].entries.length;
		const readonly = f.open();
		await expect(readonly.recover()).rejects.toThrow(/recovery authority/u);
		expect(f.replicas[2].entries).toHaveLength(before);
		const denied = f.open({
			authorize: async () => {
				throw new Error("funding denied");
			},
		});
		await expect(denied.recover()).rejects.toThrow(/funding denied/u);
		expect(f.replicas[2].entries).toHaveLength(before);
		const checks: string[] = [];
		const live = f.open({
			authorize: async ({ fleetId, anchorDigest }) => {
				checks.push(`${fleetId}:${anchorDigest}`);
			},
		});
		await live.recover();
		expect(checks).toEqual([
			`events:${f.journal.anchorDigest}`,
			`events:${f.journal.anchorDigest}`,
		]);
		expect(f.replicas[2].entries.length).toBeGreaterThan(before);
		await Promise.all([
			first.close(),
			readonly.close(),
			denied.close(),
			live.close(),
		]);
	});

	it("keeps an actor claim when release authority is lost before append", async () => {
		const f = await fixture();
		let checks = 0;
		const store = f.openClaims({
			verifyRelease: async () => {
				if (++checks === 2) throw new Error("release authority revoked");
			},
		});
		const claims = store.nonExpiringClaims;
		if (!claims) throw new Error("claims unavailable");
		const claim = await claims.claimActor({
			key: "deployment:one",
			holderId: "worker",
			requestId: "claim-one",
		});
		await expect(
			claims.releaseActor({
				...claim,
				requestId: "release-one",
				evidence: "test:source-stopped",
			}),
		).rejects.toThrow(/authority revoked/u);
		await expect(claims.verifyActor(claim)).resolves.toBeUndefined();
		await expect(
			claims.claimActor({
				key: "deployment:one",
				holderId: "other",
				requestId: "claim-two",
			}),
		).rejects.toThrow(/already held/u);
		await store.close();
	});

	it("binds release to the exact claims presented before verifier callbacks", async () => {
		const f = await fixture();
		let changeInput = () => {};
		const store = f.openClaims({ verifyRelease: async () => changeInput() });
		const claims = store.nonExpiringClaims;
		if (!claims) throw new Error("claims unavailable");
		const first = await claims.claimActor({
			key: "deployment:one",
			holderId: "one",
			requestId: "actor-one",
		});
		const second = await claims.claimActor({
			key: "deployment:two",
			holderId: "two",
			requestId: "actor-two",
		});
		const actorRelease = {
			...first,
			requestId: "release-one",
			evidence: "stopped",
		};
		changeInput = () => {
			Object.assign(actorRelease, second);
		};
		await claims.releaseActor(actorRelease);
		await expect(claims.verifyActor(first)).rejects.toThrow(/stale/u);
		await expect(claims.verifyActor(second)).resolves.toBeUndefined();

		const subOne = await claims.claimSubscription({
			subscriptionId: "sub-one",
			partitionId: "p0",
			holderId: "one",
			requestId: "sub-claim-one",
		});
		const subTwo = await claims.claimSubscription({
			subscriptionId: "sub-two",
			partitionId: "p0",
			holderId: "two",
			requestId: "sub-claim-two",
		});
		const subRelease = {
			...subOne,
			requestId: "sub-release-one",
			evidence: "stopped",
		};
		changeInput = () => {
			Object.assign(subRelease, subTwo);
		};
		await claims.releaseSubscription(subRelease);
		await expect(
			claims.claimSubscription({
				subscriptionId: "sub-one",
				partitionId: "p0",
				holderId: "new",
				requestId: "sub-new-one",
			}),
		).resolves.toMatchObject({ holderId: "new" });
		await expect(
			claims.claimSubscription({
				subscriptionId: "sub-two",
				partitionId: "p0",
				holderId: "new",
				requestId: "sub-new-two",
			}),
		).rejects.toThrow(/already held/u);
		await store.close();
	});

	it("captures claim evidence once before validation and callbacks", async () => {
		const f = await fixture();
		const seen: string[] = [];
		const store = f.openClaims({
			verifyRelease: async ({ evidence }) => {
				seen.push(evidence);
			},
		});
		const claims = store.nonExpiringClaims;
		if (!claims) throw new Error("claims unavailable");
		const claim = await claims.claimActor({
			key: "deployment:one",
			holderId: "worker",
			requestId: "claim-one",
		});
		let reads = 0;
		const request = {
			...claim,
			requestId: "release-one",
			get evidence() {
				return ++reads === 1 ? "stopped" : "different";
			},
		};
		await claims.releaseActor(request);
		expect(reads).toBe(1);
		expect(seen).toEqual(["stopped", "stopped"]);
		await store.close();
	});

	it("rejects trailing line terminators in claim and policy identities", async () => {
		const f = await fixture();
		for (const suffix of ["\n", "\r", "\u2028", "\u2029"]) {
			expect(() =>
				f.openClaims({ contractId: `test:verified-stop/v1${suffix}` }),
			).toThrow();
			expect(() =>
				f.openClaims({ protectedStreamPrefixes: [`deployment:${suffix}`] }),
			).toThrow();
			const store = f.openClaims();
			if (!store.nonExpiringClaims) throw new Error("claims unavailable");
			await expect(
				store.nonExpiringClaims.claimActor({
					key: "deployment:one",
					holderId: `worker${suffix}`,
					requestId: "claim-one",
				}),
			).rejects.toThrow();
			await expect(
				store.nonExpiringClaims.claimActor({
					key: "deployment:one",
					holderId: "worker",
					requestId: `claim-one${suffix}`,
				}),
			).rejects.toThrow();
			await store.close();
		}
	});

	it("repairs a lagging survivor only under explicit operational authority", async () => {
		const f = await fixture(),
			first = f.open();
		// C misses both commands while A and B decide; later A fails.
		f.replicas[2].available = false;
		const result = await first.commit({
			streamId: "stream",
			append,
			events: [{ type: "test.Created" }],
		});
		await first.snapshot("stream", { n: 1 }, 1);
		f.replicas[2].available = true;
		f.replicas[0].available = false;
		const before = f.replicas[2].entries.length;
		const readonly = f.open();
		const collect = async (store: ReturnType<typeof f.open>) => {
			const events = [];
			for await (const event of store.read("stream")) events.push(event);
			return events;
		};
		await expect(collect(readonly)).rejects.toThrow(/quorum-unavailable/u);
		expect(f.replicas[2].entries).toHaveLength(before);
		const denied = f.open({
			authorize: async () => {
				throw new Error("actor or funding unavailable");
			},
		});
		await expect(collect(denied)).rejects.toThrow(
			/actor or funding unavailable/u,
		);
		expect(f.replicas[2].entries).toHaveLength(before);
		const calls: string[] = [];
		const live = f.open({
			authorize: async ({ fleetId, anchorDigest }) => {
				calls.push(`${fleetId}:${anchorDigest}`);
			},
		});
		expect(await collect(live)).toEqual(result.appended);
		expect(calls).toEqual([
			`events:${f.journal.anchorDigest}`,
			`events:${f.journal.anchorDigest}`,
		]);
		expect(f.replicas[2].entries.length).toBeGreaterThan(before);
		await Promise.all([
			first.close(),
			readonly.close(),
			denied.close(),
			live.close(),
		]);
	});

	it("does not repair after the store closes during authorization", async () => {
		const f = await fixture();
		const first = f.open();
		f.replicas[2].available = false;
		await first.commit({
			streamId: "stream",
			append,
			events: [{ type: "test.Created" }],
		});
		f.replicas[2].available = true;
		f.replicas[0].available = false;
		const before = f.replicas[2].entries.length;
		const closing = f.open({
			authorize: async () => closing.close(),
		});
		const observed = [];
		await expect(
			(async () => {
				for await (const event of closing.read("stream")) observed.push(event);
			})(),
		).rejects.toThrow(/closed/u);
		expect(observed).toEqual([]);
		expect(f.replicas[2].entries).toHaveLength(before);
		await first.close();
	});

	it("withholds recovered data if the actor loses authority during repair", async () => {
		const f = await fixture(),
			first = f.open();
		f.replicas[2].available = false;
		const result = await first.commit({
			streamId: "stream",
			append,
			events: [{ type: "test.Created" }],
		});
		f.replicas[2].available = true;
		f.replicas[0].available = false;
		let checks = 0;
		const lost = f.open({
			authorize: async () => {
				if (++checks === 2) throw new Error("actor lost during recovery");
			},
		});
		const observed = [];
		await expect(
			(async () => {
				for await (const event of lost.read("stream")) observed.push(event);
			})(),
		).rejects.toThrow(/actor lost during recovery/u);
		expect(observed).toEqual([]);
		const restarted = f.open();
		for await (const event of restarted.read("stream")) observed.push(event);
		expect(observed).toEqual(result.appended);
		await Promise.all([first.close(), lost.close(), restarted.close()]);
	});

	it("recovers identical events, effects, positions, and snapshots across a provider outage", async () => {
		const f = await fixture();
		const first = f.open();
		const result = await first.commit({
			streamId: "stream",
			append,
			events: [{ type: "test.Created", data: { value: 1 } }],
			effects: [
				{
					kind: "queue",
					queueName: "jobs",
					idempotencyKey: "job-1",
					body: { action: "run" },
				},
			],
		});
		expect(result.effects).toEqual([
			expect.objectContaining({
				kind: "queue",
				idempotencyKey: "job-1",
				deduped: false,
			}),
		]);
		await first.snapshot("stream", { value: 1 }, 1);
		f.replicas[0].available = false;
		const second = f.open({ authorize: async () => {} });
		const events = [];
		for await (const event of second.read("stream")) events.push(event);
		expect(events).toEqual(result.appended);
		expect(await second.loadSnapshot("stream")).toEqual(
			expect.objectContaining({ seq: 1, state: { value: 1 } }),
		);
		const deduped = await second.commit({
			streamId: "stream",
			append: { ...append, expectedSeq: 1 },
			events: [],
			effects: [
				{
					kind: "queue",
					queueName: "jobs",
					idempotencyKey: "job-1",
					body: { action: "run" },
				},
			],
		});
		expect(deduped.effects).toEqual([
			expect.objectContaining({ idempotencyKey: "job-1", deduped: true }),
		]);
		expect(second.claimSubscription).toBeUndefined();
		await first.close();
		await second.close();
	});

	it("serializes competing writers and leaves stale stream appends uncommitted", async () => {
		const f = await fixture();
		const first = f.open(),
			second = f.open();
		const results = await Promise.allSettled([
			first.append("stream", [{ type: "test.OneRecorded" }], append),
			second.append("stream", [{ type: "test.TwoRecorded" }], append),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(await f.journal.read()).toHaveLength(1);
		const events = [];
		for await (const item of first.readAll()) events.push(item);
		expect(events).toHaveLength(1);
		expect(events[0]?.position).toBe(1n);
		await first.close();
		await second.close();
	});

	it("recovers a lost majority acknowledgement without duplicating the event", async () => {
		const f = await fixture();
		const store = f.open();
		for (const replica of f.replicas) replica.loseReply = true;
		const result = await store.append(
			"stream",
			[{ type: "test.OnceRecorded" }],
			append,
		);
		expect(result.appended).toHaveLength(1);
		expect(await f.journal.read()).toHaveLength(1);
		await store.close();
	});

	it("does not commit a command when the clock goes backward or the snapshot is ahead", async () => {
		const f = await fixture();
		const store = f.open();
		await store.append("stream", [{ type: "test.Created" }], append);
		await expect(store.snapshot("stream", {}, 2)).rejects.toThrow();
		f.setNow(1);
		await expect(
			store.append("stream", [{ type: "test.LaterRecorded" }], {
				...append,
				expectedSeq: 1,
			}),
		).rejects.toThrow();
		expect(await f.journal.read()).toHaveLength(1);
		await store.close();
	});

	it("refuses a write before exceeding replay bounds, keeping the existing history readable", async () => {
		const f = await fixture();
		const store = createQuorumEventStore({
			journal: f.journal,
			nowMs: () => 1_800_000_000_000,
			maxReplayEntries: 1,
			maxReplayBytes: 1024,
		});
		await store.append("stream", [{ type: "test.Created" }], append);
		await expect(
			store.append("stream", [{ type: "test.SecondRecorded" }], {
				...append,
				expectedSeq: 1,
			}),
		).rejects.toThrow("replay limit");
		expect(await f.journal.read()).toHaveLength(1);
		const events = [];
		for await (const event of store.read("stream")) events.push(event);
		expect(events).toHaveLength(1);
		await store.close();
	});

	it("serializes nonexpiring actors, fences stale writes, and survives restart with one provider unavailable", async () => {
		const f = await fixture();
		const first = f.openClaims(),
			second = f.openClaims();
		const a = first.nonExpiringClaims,
			b = second.nonExpiringClaims;
		if (!a || !b) throw new Error("claims unavailable");
		const attempts = await Promise.allSettled([
			a.claimActor({
				key: "deployment:one",
				holderId: "host-a",
				requestId: "acquire-a",
			}),
			b.claimActor({
				key: "deployment:one",
				holderId: "host-b",
				requestId: "acquire-b",
			}),
		]);
		const won = attempts.filter((attempt) => attempt.status === "fulfilled");
		expect(won).toHaveLength(1);
		expect(
			attempts.filter((attempt) => attempt.status === "rejected"),
		).toHaveLength(1);
		const claim = won[0]?.value;
		if (!claim) throw new Error("no winning claim");
		await expect(
			first.append("deployment:one", [{ type: "test.MissingFence" }], append),
		).rejects.toThrow("current quorum claim");
		await first.append("deployment:one", [{ type: "test.First" }], {
			...append,
			fenceToken: claim.fenceToken,
		});
		await expect(first.snapshot("deployment:one", {}, 1)).rejects.toThrow(
			"fenced claim",
		);
		f.replicas[0].available = false;
		await first.close();
		const reopened = f.openClaims({}, { authorize: async () => {} });
		const claims = reopened.nonExpiringClaims;
		if (!claims) throw new Error("claims unavailable");
		await claims.verifyActor(claim);
		await expect(
			claims.releaseActor({
				...claim,
				requestId: "release-a",
				evidence: "unknown",
			}),
		).rejects.toThrow("source has not stopped");
		await expect(
			claims.claimActor({
				key: claim.key,
				holderId: "host-c",
				requestId: "acquire-c",
			}),
		).rejects.toThrow("already held");
		await claims.releaseActor({
			...claim,
			requestId: "release-a",
			evidence: "test:source-stopped",
		});
		await expect(
			claims.claimActor({
				key: claim.key,
				holderId: claim.holderId,
				requestId: claim.claimId,
			}),
		).rejects.toThrow("stale");
		const next = await claims.claimActor({
			key: claim.key,
			holderId: "host-c",
			requestId: "acquire-c",
		});
		expect(next.fenceToken).toBeGreaterThan(claim.fenceToken);
		await expect(claims.verifyActor(claim)).rejects.toThrow("stale");
		await expect(
			reopened.append(claim.key, [{ type: "test.Stale" }], {
				...append,
				expectedSeq: 1,
				fenceToken: claim.fenceToken,
			}),
		).rejects.toThrow("current quorum claim");
		await expect(
			claims.releaseActor({
				...claim,
				requestId: "release-old",
				evidence: "test:source-stopped",
			}),
		).rejects.toThrow("current owner");
		await reopened.append(claim.key, [{ type: "test.NewOwner" }], {
			...append,
			expectedSeq: 1,
			fenceToken: next.fenceToken,
		});
		await reopened.append(
			"unprotected",
			[{ type: "test.Unprotected" }],
			append,
		);
		await second.close();
		await reopened.close();
	});

	it("recovers ambiguous claim acknowledgement without reacquiring or reusing an operation identity", async () => {
		const f = await fixture();
		const store = f.openClaims();
		const claims = store.nonExpiringClaims;
		if (!claims) throw new Error("claims unavailable");
		for (const replica of f.replicas) replica.loseReply = true;
		const requested = {
			key: "deployment:job",
			holderId: "host",
			requestId: "claim-unique",
		};
		const claim = await claims.claimActor(requested);
		await store.close();
		const reopened = f.openClaims();
		if (!reopened.nonExpiringClaims) throw new Error("claims unavailable");
		f.setNow(1_800_000_000_001);
		expect(await reopened.nonExpiringClaims.claimActor(requested)).toEqual(
			claim,
		);
		await expect(
			reopened.nonExpiringClaims.claimActor({
				...requested,
				holderId: "impostor",
			}),
		).rejects.toThrow("identity changed");
		expect(await f.journal.read()).toHaveLength(1);
		await reopened.close();
	});

	it("recovers a partly accepted claim after the caller crashes", async () => {
		const f = await fixture();
		const store = f.openClaims();
		const claims = store.nonExpiringClaims;
		if (!claims) throw new Error("claims unavailable");
		const requested = {
			key: "deployment:partial",
			holderId: "host",
			requestId: "partial-claim",
		};
		f.replicas[1].failAccept = true;
		f.replicas[2].failAccept = true;
		await expect(claims.claimActor(requested)).rejects.toThrow();
		expect(f.replicas.map((replica) => replica.entries.length)).toEqual([
			2, 1, 1,
		]);
		await store.close();
		f.replicas[1].failAccept = false;
		f.replicas[2].failAccept = false;
		const restarted = f.openClaims();
		if (!restarted.nonExpiringClaims) throw new Error("claims unavailable");
		const claim = await restarted.nonExpiringClaims.claimActor(requested);
		await restarted.nonExpiringClaims.verifyActor(claim);
		expect(await f.journal.read()).toHaveLength(1);
		await expect(
			restarted.nonExpiringClaims.claimActor({
				...requested,
				holderId: "other",
				requestId: "other-claim",
			}),
		).rejects.toThrow("already held");
		await restarted.close();
	});

	it("orders a concurrent release and stale write in the same journal", async () => {
		const f = await fixture();
		const one = f.openClaims(),
			two = f.openClaims();
		if (!one.nonExpiringClaims || !two.nonExpiringClaims)
			throw new Error("claims unavailable");
		const claim = await one.nonExpiringClaims.claimActor({
			key: "deployment:race",
			holderId: "host",
			requestId: "race-claim",
		});
		const [write, release] = await Promise.allSettled([
			one.append(claim.key, [{ type: "test.InFlight" }], {
				...append,
				fenceToken: claim.fenceToken,
			}),
			two.nonExpiringClaims.releaseActor({
				...claim,
				requestId: "race-release",
				evidence: "test:source-stopped",
			}),
		]);
		expect(release.status).toBe("fulfilled");
		const history = await f.journal.read();
		const kinds = history.map((entry) => JSON.parse(entry.value).kind);
		if (write.status === "fulfilled")
			expect(kinds).toEqual(["actor-claim", "commit", "actor-release"]);
		else expect(kinds).toEqual(["actor-claim", "actor-release"]);
		await expect(
			one.append(claim.key, [{ type: "test.TooLate" }], {
				...append,
				expectedSeq: write.status === "fulfilled" ? 1 : 0,
				fenceToken: claim.fenceToken,
			}),
		).rejects.toThrow("current quorum claim");
		await one.close();
		await two.close();
	});

	it("checkpoints a replay history larger than one event read page", async () => {
		const f = await fixture();
		const store = f.openClaims();
		if (!store.nonExpiringClaims) throw new Error("claims unavailable");
		for (let batch = 0; batch < 5; batch++) {
			await store.append(
				"bulk",
				Array.from({ length: 256 }, () => ({ type: "test.Event" })),
				{ ...append, expectedSeq: batch * 256 },
			);
		}
		const claim = await store.nonExpiringClaims.claimSubscription({
			subscriptionId: "large",
			partitionId: "p0",
			holderId: "host",
			requestId: "large-claim",
		});
		expect(
			(
				await store.nonExpiringClaims.commitCheckpoint({
					...claim,
					position: 1280n,
					requestId: "large-checkpoint",
				})
			).position,
		).toBe(1280n);
		await store.close();
	}, 20_000);

	it("keeps subscription checkpoints monotonic and fenced by a nonexpiring claim", async () => {
		const f = await fixture();
		const store = f.openClaims(),
			claims = store.nonExpiringClaims;
		if (!claims) throw new Error("claims unavailable");
		await store.append(
			"events",
			[{ type: "test.One" }, { type: "test.Two" }],
			append,
		);
		const claim = await claims.claimSubscription({
			subscriptionId: "deployments",
			partitionId: "p0",
			holderId: "host-a",
			requestId: "sub-a",
		});
		const checkpoint = await claims.commitCheckpoint({
			...claim,
			requestId: "checkpoint-1",
			position: 1n,
		});
		expect(checkpoint.position).toBe(1n);
		await expect(
			claims.commitCheckpoint({
				...claim,
				requestId: "checkpoint-future",
				position: 3n,
			}),
		).rejects.toThrow("ahead");
		await expect(
			claims.commitCheckpoint({
				...claim,
				requestId: "checkpoint-back",
				position: 0n,
			}),
		).rejects.toThrow("backwards");
		await expect(
			claims.releaseSubscription({
				...claim,
				requestId: "sub-release",
				evidence: "",
			}),
		).rejects.toThrow("invalid claim release evidence");
		await claims.releaseSubscription({
			...claim,
			requestId: "sub-release",
			evidence: "test:source-stopped",
		});
		await expect(
			claims.claimSubscription({
				subscriptionId: claim.subscriptionId,
				partitionId: claim.partitionId,
				holderId: claim.holderId,
				requestId: claim.claimId,
			}),
		).rejects.toThrow("stale");
		const next = await claims.claimSubscription({
			subscriptionId: claim.subscriptionId,
			partitionId: claim.partitionId,
			holderId: "host-b",
			requestId: "sub-b",
		});
		expect(next.fenceToken).toBeGreaterThan(claim.fenceToken);
		await expect(
			claims.commitCheckpoint({
				...claim,
				requestId: "stale-checkpoint",
				position: 2n,
			}),
		).rejects.toThrow("stale");
		f.replicas[2].available = false;
		await store.close();
		const reopened = f.openClaims();
		const recovered = reopened.nonExpiringClaims;
		if (!recovered) throw new Error("claims unavailable");
		expect(
			await recovered.loadCheckpoint({
				subscriptionId: "deployments",
				partitionId: "p0",
			}),
		).toEqual(checkpoint);
		expect(
			(
				await recovered.commitCheckpoint({
					...next,
					requestId: "checkpoint-2",
					position: 2n,
				})
			).position,
		).toBe(2n);
		expect(reopened.claimSubscription).toBeUndefined();
		await reopened.close();
	});

	it("rejects a weaker protected-stream policy or different release-verifier contract on restart", async () => {
		const f = await fixture();
		const store = f.openClaims();
		if (!store.nonExpiringClaims) throw new Error("claims unavailable");
		await store.nonExpiringClaims.claimActor({
			key: "deployment:one",
			holderId: "host",
			requestId: "claim",
		});
		const weakened = f.open();
		await expect(
			weakened.append("deployment:one", [{ type: "test.Bypass" }], append),
		).rejects.toThrow("replay failed");
		const changed = f.openClaims({ contractId: "other:verifier/v1" });
		await expect(
			changed.nonExpiringClaims?.verifyActor({
				key: "deployment:one",
				holderId: "host",
				claimId: "claim",
				fenceToken: 1n,
			}),
		).rejects.toThrow("replay failed");
		await store.close();
		await weakened.close();
		await changed.close();
	});
});
