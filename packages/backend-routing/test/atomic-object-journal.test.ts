import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type AtomicJournalObject,
	createAtomicObjectJournalReplica,
} from "../src/atomic-object-journal.js";
import {
	createImmutableJournal,
	type ImmutableJournalMember,
} from "../src/immutable-journal.js";

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");

class ObjectStore implements AtomicJournalObject {
	value?: { body: string; version: string };
	sequence = 0;
	loseReply = false;
	private pause?: { enter: () => void; wait: Promise<void> };
	pauseNextReplace() {
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
	async read() {
		return this.value && { ...this.value };
	}
	async create(body: string) {
		if (this.value) return "conflict" as const;
		this.value = { body, version: `${++this.sequence}` };
		return "created" as const;
	}
	async replace(body: string, expectedVersion: string) {
		if (this.pause) {
			const paused = this.pause;
			this.pause = undefined;
			paused.enter();
			await paused.wait;
		}
		if (this.value?.version !== expectedVersion) return "conflict" as const;
		this.value = { body, version: `${++this.sequence}` };
		if (this.loseReply) {
			this.loseReply = false;
			throw new Error("lost reply");
		}
		return "written" as const;
	}
}

async function fixture(
	maxObjectBytes = 50_000,
	maxDocumentBytes = 4_000,
	maxEntries = 32,
) {
	const fleetId = "fleet";
	const members: ImmutableJournalMember[] = ["a", "b", "c"].map((id) => ({
		id,
		provider: `provider-${id}`,
		accountId: `account-${id}`,
		resourceId: `resource-${id}`,
		incarnation: `incarnation-${id}`,
	}));
	const anchorDigest = digest(
		JSON.stringify({
			contract: "hobo.immutable-journal-anchor/v1",
			fleetId,
			members,
		}),
	);
	const stores = members.map(() => new ObjectStore());
	const voters = members.map((member, index) => {
		const object = stores[index];
		if (!object) throw new Error("missing object");
		return createAtomicObjectJournalReplica({
			member,
			members,
			fleetId,
			anchorDigest,
			initializationId: `init-${member.id}`,
			maxEntries,
			maxDocumentBytes,
			maxObjectBytes,
			object,
		});
	});
	for (const voter of voters) await voter.initializeFresh(async () => {});
	const journal = createImmutableJournal({
		fleetId,
		members,
		anchorDigest,
		replicas: voters.map((voter) => voter.replica),
		maxEntryBytes: 1_000,
		maxEntries,
		authorize: async () => {},
	});
	await journal.bootstrap(async () => {});
	return { stores, voters, journal, members, anchorDigest, fleetId };
}

describe("atomic object journal replica", () => {
	it("fences a document request delayed until after the generation seal", async () => {
		const { stores, voters } = await fixture();
		const object = stores[0],
			replica = voters[0]?.replica;
		if (!object || !replica) throw new Error("missing voter");
		const genesis = (await replica.read())[0];
		const head = genesis?.reason.split(":")[2];
		if (!head) throw new Error("missing head");
		const value = "delayed document",
			key = digest(value),
			pause = object.pauseNextReplace();
		const pending = replica.writeDocument(key, value);
		await pause.started;
		expect(
			await replica.seal({
				transitionId: "takeover-1",
				epoch: 1,
				digest: head,
			}),
		).toBe("sealed");
		pause.release();
		await expect(pending).rejects.toThrow("generation-sealed");
		expect(await replica.readDocument(key)).toBeUndefined();
	});
	it("fences a delayed assignment after takeover and preserves the selected head", async () => {
		const { stores, voters } = await fixture();
		const object = stores[0],
			replica = voters[0]?.replica;
		if (!object || !replica) throw new Error("missing voter");
		const genesis = (await replica.read())[0],
			head = genesis?.reason.split(":")[2];
		if (!genesis || !head) throw new Error("missing head");
		const value = "new command",
			key = digest(value);
		await replica.writeDocument(key, value);
		const pause = object.pauseNextReplace();
		const pending = replica.accept({
			...genesis,
			epoch: 2,
			reason: `j:${head}:${key}`,
		});
		await pause.started;
		expect(
			await replica.seal({
				transitionId: "takeover-2",
				epoch: 1,
				digest: head,
			}),
		).toBe("sealed");
		pause.release();
		await expect(pending).rejects.toThrow("generation-sealed");
		expect(await replica.read()).toEqual([genesis]);
	});
	it("refuses an assignment past the retention bound and stays sealable", async () => {
		const { voters } = await fixture(50_000, 4_000, 1);
		const replica = voters[0]?.replica;
		if (!replica) throw new Error("missing voter");
		const genesis = (await replica.read())[0],
			head = genesis?.reason.split(":")[2];
		if (!genesis || !head) throw new Error("missing head");
		const first = "second command",
			firstKey = digest(first);
		await replica.writeDocument(firstKey, first);
		expect(
			await replica.accept({
				...genesis,
				epoch: 2,
				reason: `j:${head}:${firstKey}`,
			}),
		).toBe("accepted");
		const extra = "third command",
			extraKey = digest(extra);
		await replica.writeDocument(extraKey, extra);
		await expect(
			replica.accept({
				...genesis,
				epoch: 3,
				reason: `j:${firstKey}:${extraKey}`,
			}),
		).rejects.toThrow("retention-limit");
		expect(await replica.read()).toHaveLength(2);
		expect(
			await replica.seal({
				transitionId: "rollover-1",
				epoch: 2,
				digest: firstKey,
			}),
		).toBe("sealed");
	});
	it("allows an identical document retry after sealing without changing the object", async () => {
		const { stores, voters } = await fixture();
		const object = stores[0],
			replica = voters[0]?.replica;
		if (!object || !replica) throw new Error("missing voter");
		const head = (await replica.read())[0]?.reason.split(":")[2];
		if (!head) throw new Error("missing head");
		const value = "existing",
			key = digest(value);
		await replica.writeDocument(key, value);
		expect(
			await replica.seal({ transitionId: "done", epoch: 1, digest: head }),
		).toBe("sealed");
		const sealed = object.value;
		await replica.writeDocument(key, value);
		expect(object.value).toEqual(sealed);
		await expect(replica.writeDocument(digest("new"), "new")).rejects.toThrow(
			"generation-sealed",
		);
	});
	it("retries definite conflicts without losing either concurrent immutable document", async () => {
		const { stores, voters } = await fixture();
		const object = stores[0],
			replica = voters[0]?.replica;
		if (!object || !replica) throw new Error("missing voter");
		const pause = object.pauseNextReplace(),
			left = "left",
			right = "right";
		const pending = replica.writeDocument(digest(left), left);
		await pause.started;
		await replica.writeDocument(digest(right), right);
		pause.release();
		await pending;
		expect(await replica.readDocument(digest(left))).toBe(left);
		expect(await replica.readDocument(digest(right))).toBe(right);
	});
	it("reconciles an applied write whose provider acknowledgement is lost", async () => {
		const { stores, voters } = await fixture();
		const object = stores[0],
			replica = voters[0]?.replica;
		if (!object || !replica) throw new Error("missing voter");
		object.loseReply = true;
		await replica.writeDocument(digest("committed"), "committed");
		expect(await replica.readDocument(digest("committed"))).toBe("committed");
	});
	it("fences an unknown write that the provider receives only after the seal", async () => {
		const f = await fixture();
		const object = f.stores[0],
			original = f.voters[0]?.replica,
			member = f.members[0];
		if (!object || !original || !member) throw new Error("missing voter");
		const head = (await original.read())[0]?.reason.split(":")[2];
		if (!head) throw new Error("missing head");
		let deliver: (() => Promise<"written" | "conflict">) | undefined;
		let defer = true;
		const port: AtomicJournalObject = {
			read: () => object.read(),
			create: (body) => object.create(body),
			async replace(body, version) {
				if (defer) {
					defer = false;
					deliver = () => object.replace(body, version);
					throw new Error("response lost while request remains in flight");
				}
				return object.replace(body, version);
			},
		};
		const voter = createAtomicObjectJournalReplica({
			member,
			members: f.members,
			fleetId: f.fleetId,
			anchorDigest: f.anchorDigest,
			initializationId: `init-${member.id}`,
			maxEntries: 32,
			maxDocumentBytes: 4_000,
			maxObjectBytes: 50_000,
			object: port,
		});
		const value = "unknown and delayed",
			key = digest(value);
		await expect(voter.replica.writeDocument(key, value)).rejects.toThrow(
			"write-outcome-unknown",
		);
		expect(
			await original.seal({
				transitionId: "after-timeout",
				epoch: 1,
				digest: head,
			}),
		).toBe("sealed");
		if (!deliver) throw new Error("missing delayed request");
		expect(await deliver()).toBe("conflict");
		expect(await original.readDocument(key)).toBeUndefined();
	});
	it("keeps seal headroom when uncommitted documents exhaust the object", async () => {
		const { voters } = await fixture(3_000);
		const replica = voters[0]?.replica;
		if (!replica) throw new Error("missing voter");
		const head = (await replica.read())[0]?.reason.split(":")[2];
		if (!head) throw new Error("missing head");
		const value = "x".repeat(2_000);
		await expect(replica.writeDocument(digest(value), value)).rejects.toThrow(
			"object-full",
		);
		expect(
			await replica.seal({
				transitionId: "s".repeat(256),
				epoch: 1,
				digest: head,
			}),
		).toBe("sealed");
	});
	it("accepts the exact two-million-byte provider bound while reserving room to seal", async () => {
		const { stores, voters } = await fixture(2_000_000, 2_000_000);
		const object = stores[0],
			replica = voters[0]?.replica;
		if (!object?.value || !replica) throw new Error("missing voter");
		const head = (await replica.read())[0]?.reason.split(":")[2];
		if (!head) throw new Error("missing head");
		// SAFETY: this body was produced by the voter and its document shape was
		// validated on every preceding write in this fixture.
		const state = JSON.parse(object.value.body) as {
			documents: { digest: string; value: string }[];
		};
		state.documents.push({ digest: "0".repeat(64), value: "" });
		const overhead = Buffer.byteLength(JSON.stringify(state), "utf8");
		const value = "x".repeat(2_000_000 - 512 - overhead);
		await replica.writeDocument(digest(value), value);
		expect(Buffer.byteLength(object.value.body, "utf8")).toBe(2_000_000 - 512);
		await expect(
			replica.writeDocument(digest("extra"), "extra"),
		).rejects.toThrow("object-full");
		expect(
			await replica.seal({
				transitionId: "s".repeat(256),
				epoch: 1,
				digest: head,
			}),
		).toBe("sealed");
		expect(Buffer.byteLength(object.value.body, "utf8")).toBeLessThanOrEqual(
			2_000_000,
		);
	});
	it("reads exactly two million canonical bytes and rejects one more byte", async () => {
		const { stores, voters } = await fixture(2_000_000, 2_000_000);
		const object = stores[0],
			replica = voters[0]?.replica;
		if (!object?.value || !replica) throw new Error("missing voter");
		// SAFETY: this state was written and validated by the fixture voter.
		const state = JSON.parse(object.value.body) as {
			documents: { digest: string; value: string }[];
		};
		const extra = { digest: "0".repeat(64), value: "" };
		state.documents.push(extra);
		const overhead = Buffer.byteLength(JSON.stringify(state), "utf8");
		extra.value = "x".repeat(2_000_000 - overhead);
		extra.digest = digest(extra.value);
		state.documents.sort((a, b) =>
			a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0,
		);
		object.value.body = JSON.stringify(state);
		expect(Buffer.byteLength(object.value.body, "utf8")).toBe(2_000_000);
		expect(await replica.readDocument(extra.digest)).toBe(extra.value);
		object.value.body += " ";
		await expect(replica.read()).rejects.toThrow("object-too-large");
	});
	it("does not initialize or rewrite an existing split-format object", async () => {
		const { stores, voters } = await fixture();
		const object = stores[0];
		if (!object) throw new Error("missing voter");
		const old = JSON.stringify({
			contract: "hobo.vercel-blob-journal-v1",
			entries: [],
		});
		object.value = { body: old, version: "legacy" };
		await expect(voters[0]?.initializeFresh(async () => {})).rejects.toThrow(
			"identity-unverified",
		);
		expect(object.value.body).toBe(old);
	});
});
