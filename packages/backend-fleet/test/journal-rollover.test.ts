import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type AssignmentAcceptOutcome,
	assignmentKey,
	type FleetAssignment,
} from "../src/assignment.js";
import {
	createImmutableJournal,
	type ImmutableJournalMember,
	type ImmutableJournalOptions,
	type ImmutableJournalSeal,
	type SealableImmutableJournalReplica,
} from "../src/immutable-journal.js";
import { createImmutableJournalRollover } from "../src/journal-rollover.js";

class Replica implements SealableImmutableJournalReplica {
	readonly entries: FleetAssignment[] = [];
	readonly documents = new Map<string, string>();
	available = true;
	failSeal = false;
	loseSealReply = false;
	beforeSeal?: (input: ImmutableJournalSeal) => Promise<void>;
	sealed?: ImmutableJournalSeal;
	constructor(readonly id: string) {}
	async read(limit?: number) {
		if (!this.available) throw new Error("offline");
		return this.entries.slice(-(limit ?? this.entries.length));
	}
	async readDocument(digest: string) {
		if (!this.available) throw new Error("offline");
		return this.documents.get(digest);
	}
	async writeDocument(digest: string, value: string) {
		if (!this.available) throw new Error("offline");
		if (this.sealed) throw new Error("sealed");
		const current = this.documents.get(digest);
		if (current !== undefined && current !== value) throw new Error("conflict");
		this.documents.set(digest, value);
	}
	async accept(entry: FleetAssignment): Promise<AssignmentAcceptOutcome> {
		if (!this.available) throw new Error("offline");
		const old = this.entries.find((row) => row.epoch === entry.epoch);
		if (old)
			return assignmentKey(old) === assignmentKey(entry)
				? "duplicate"
				: "conflict";
		if (this.sealed) throw new Error("sealed");
		if ((this.entries.at(-1)?.epoch ?? 0) !== entry.epoch - 1) return "gap";
		this.entries.push(entry);
		return "accepted";
	}
	async seal(
		input: ImmutableJournalSeal,
	): Promise<"sealed" | "duplicate" | "conflict"> {
		if (!this.available || this.failSeal) throw new Error("offline");
		if (this.beforeSeal) await this.beforeSeal(input);
		if (this.sealed)
			return JSON.stringify(this.sealed) === JSON.stringify(input)
				? "duplicate"
				: "conflict";
		const head = this.entries.at(-1);
		if (
			!head ||
			head.epoch !== input.epoch ||
			head.reason.split(":")[2] !== input.digest
		)
			return "conflict";
		this.sealed = { ...input };
		if (this.loseSealReply) {
			this.loseSealReply = false;
			throw new Error("lost response");
		}
		return "sealed";
	}
}
function fleet(name: string, maxEntryBytes = 64_000) {
	const members: ImmutableJournalMember[] = ["a", "b", "c"].map((id) => ({
		id: `${name}-${id}`,
		provider: `provider-${name}-${id}`,
		accountId: `account-${name}-${id}`,
		resourceId: `resource-${name}-${id}`,
		incarnation: `inc-${name}-${id}`,
	}));
	const replicas = members.map((member) => new Replica(member.id));
	const anchorDigest = createHash("sha256")
		.update(
			JSON.stringify({
				contract: "hobo.immutable-journal-anchor/v1",
				fleetId: name,
				members,
			}),
		)
		.digest("hex");
	let denyAppend = false;
	const options: ImmutableJournalOptions & { replicas: readonly Replica[] } = {
		fleetId: name,
		members,
		replicas,
		anchorDigest,
		maxEntryBytes,
		maxEntries: 100,
		async authorize(action) {
			if (action === "append" && denyAppend) throw new Error("funding denied");
		},
	};
	return {
		options,
		replicas,
		journal: createImmutableJournal(options),
		denyAppend(value: boolean) {
			denyAppend = value;
		},
	};
}
async function fixture(controlMax = 64_000, nextMax = 64_000) {
	const old = fleet("old"),
		next = fleet("next", nextMax),
		control = fleet("control", controlMax);
	for (const item of [old, next, control])
		await item.journal.bootstrap(async () => {});
	const open = () =>
		createImmutableJournalRollover({
			old: old.options,
			next: next.options,
			control: control.options,
			timeoutMs: 50,
			authorize: async () => {},
		});
	return { old, next, control, open };
}

describe("majority-sealed journal rollover", () => {
	it("preserves old operations and appends through the new generation after restart", async () => {
		const f = await fixture();
		await f.old.journal.append("first", "one", 0);
		await f.old.journal.append("second", "two", 1);
		const outcome = await f.open().cutover();
		expect(outcome.historyEntries).toBe(2);
		expect((await outcome.journal.read()).map((entry) => entry.value)).toEqual([
			"one",
			"two",
		]);
		await expect(f.old.journal.append("late", "bad", 2)).rejects.toThrow();
		const result = await outcome.journal.append("third", "three", 2);
		expect(result.position).toBe(3);
		expect((await outcome.journal.append("first", "one", 0)).position).toBe(1);
		await expect(outcome.journal.append("first", "changed", 3)).rejects.toThrow(
			"operation-conflict",
		);
		const restarted = await f.open().open();
		expect((await restarted.read()).map((entry) => entry.value)).toEqual([
			"one",
			"two",
			"three",
		]);
	});
	it("carries a concurrent majority write through the same in-flight cutover", async () => {
		const f = await fixture();
		await f.old.journal.append("first", "one", 0);
		const first = f.old.replicas[0],
			second = f.old.replicas[1],
			third = f.old.replicas[2];
		if (!first || !second || !third) throw new Error("missing voters");
		let release!: () => void;
		let signalStarted!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		let waiting = 0;
		second.beforeSeal = third.beforeSeal = async () => {
			if (++waiting === 2) signalStarted();
			await gate;
		};
		const coordinator = createImmutableJournalRollover({
			old: f.old.options,
			next: f.next.options,
			control: f.control.options,
			timeoutMs: 1000,
			authorize: async () => {},
		});
		const cutover = coordinator.cutover();
		try {
			await started;
			expect(first.sealed?.epoch).toBe(2);
			await f.old.journal.append("second", "two", 1);
		} finally {
			delete second.beforeSeal;
			delete third.beforeSeal;
			release();
		}
		const result = await cutover;
		expect(result.oldHead.epoch).toBe(3);
		expect((await result.journal.read()).map((entry) => entry.value)).toEqual([
			"one",
			"two",
		]);
	});
	it("retains the full command and operation-id history across consecutive generations", async () => {
		const f = await fixture();
		await f.old.journal.append("first", "one", 0);
		const first = await f.open().cutover();
		await first.journal.append("second", "two", 1);
		const third = fleet("third");
		await third.journal.bootstrap(async () => {});
		const second = createImmutableJournalRollover({
			old: f.next.options,
			next: third.options,
			control: f.control.options,
			timeoutMs: 50,
			authorize: async () => {},
		});
		const moved = await second.cutover();
		expect((await moved.journal.read()).map((entry) => entry.value)).toEqual([
			"one",
			"two",
		]);
		expect((await moved.journal.append("first", "one", 0)).position).toBe(1);
		await moved.journal.append("third", "three", 2);
		expect(
			(await (await second.open()).read()).map((entry) => entry.value),
		).toEqual(["one", "two", "three"]);
	});
	it("recovers a lost seal response and resumes after checkpoint funding fails", async () => {
		const f = await fixture();
		await f.old.journal.append("job", "payload", 0);
		const firstVoter = f.old.replicas[0];
		if (!firstVoter) throw new Error("missing voter");
		firstVoter.loseSealReply = true;
		f.next.denyAppend(true);
		await expect(f.open().cutover()).rejects.toThrow(
			"authorization-unavailable",
		);
		expect(
			f.old.replicas.filter((replica) => replica.sealed).length,
		).toBeGreaterThanOrEqual(f.old.journal.quorum);
		await expect(f.old.journal.append("late", "bad", 1)).rejects.toThrow();
		f.next.denyAppend(false);
		const resumed = await f.open().cutover();
		expect((await resumed.journal.read()).map((entry) => entry.value)).toEqual([
			"payload",
		]);
	});
	it("does not count a retried seal twice when no other voter sealed", async () => {
		const f = await fixture();
		await f.old.journal.append("job", "payload", 0);
		const [first, second, third] = f.old.replicas;
		if (!first || !second || !third) throw new Error("missing voters");
		first.loseSealReply = true;
		second.failSeal = true;
		third.failSeal = true;
		await expect(f.open().cutover()).rejects.toThrow("seal-unconfirmed");
		expect(f.old.replicas.filter((replica) => replica.sealed)).toHaveLength(1);
	});
	it("supersedes a partial seal only after a newer head is majority-chosen", async () => {
		const f = await fixture();
		await f.old.journal.append("first", "one", 0);
		const secondVoter = f.old.replicas[1],
			thirdVoter = f.old.replicas[2];
		if (!secondVoter || !thirdVoter) throw new Error("missing voters");
		secondVoter.failSeal = true;
		thirdVoter.failSeal = true;
		await expect(f.open().cutover()).rejects.toThrow("seal-unconfirmed");
		secondVoter.failSeal = false;
		thirdVoter.failSeal = false;
		await f.old.journal.append("second", "two", 1);
		const result = await f.open().cutover();
		expect(result.historyEntries).toBe(2);
		expect((await result.journal.read()).map((entry) => entry.value)).toEqual([
			"one",
			"two",
		]);
		const firstVoter = f.old.replicas[0];
		if (!firstVoter?.sealed || !secondVoter.sealed || !thirdVoter.sealed)
			throw new Error("missing seals");
		expect(firstVoter.sealed.epoch).toBeLessThan(result.oldHead.epoch);
		expect(secondVoter.sealed).toEqual(result.oldHead);
		expect(thirdVoter.sealed).toEqual(result.oldHead);
		await expect(f.old.journal.append("late", "bad", 2)).rejects.toThrow();
		const intents = (await f.control.journal.read()).filter((entry) =>
			entry.operationId.startsWith("hobo:rollover:intent:"),
		);
		expect(intents).toHaveLength(2);
		const restarted = await f.open().open();
		expect((await restarted.read()).map((entry) => entry.value)).toEqual([
			"one",
			"two",
		]);
	});
	it("does not supersede a partial seal when a newer head cannot be proven", async () => {
		const f = await fixture();
		await f.old.journal.append("first", "one", 0);
		const secondVoter = f.old.replicas[1],
			thirdVoter = f.old.replicas[2];
		if (!secondVoter || !thirdVoter) throw new Error("missing voters");
		secondVoter.failSeal = true;
		thirdVoter.failSeal = true;
		await expect(f.open().cutover()).rejects.toThrow("seal-unconfirmed");
		secondVoter.available = false;
		thirdVoter.available = false;
		await expect(f.open().cutover()).rejects.toThrow();
		await expect(f.open().open()).rejects.toThrow("generation-not-active");
		expect(
			(await f.control.journal.read()).filter((entry) =>
				entry.operationId.startsWith("hobo:rollover:intent:"),
			),
		).toHaveLength(1);
	});
	it("chooses only one destination when coordinators race to supersede a stale seal", async () => {
		const f = await fixture();
		await f.old.journal.append("first", "one", 0);
		const secondVoter = f.old.replicas[1],
			thirdVoter = f.old.replicas[2];
		if (!secondVoter || !thirdVoter) throw new Error("missing voters");
		secondVoter.failSeal = true;
		thirdVoter.failSeal = true;
		await expect(f.open().cutover()).rejects.toThrow("seal-unconfirmed");
		secondVoter.failSeal = false;
		thirdVoter.failSeal = false;
		await f.old.journal.append("second", "two", 1);
		const alternate = fleet("alternate");
		await alternate.journal.bootstrap(async () => {});
		const rival = createImmutableJournalRollover({
			old: f.old.options,
			next: alternate.options,
			control: f.control.options,
			timeoutMs: 50,
			authorize: async () => {},
		});
		const outcomes = await Promise.allSettled([
			f.open().cutover(),
			rival.cutover(),
		]);
		const winners = outcomes.filter((result) => result.status === "fulfilled");
		expect(winners).toHaveLength(1);
		const winner = winners[0];
		if (winner?.status !== "fulfilled") throw new Error("no winner");
		expect(
			(await winner.value.journal.read()).map((entry) => entry.value),
		).toEqual(["one", "two"]);
		expect(
			(await f.control.journal.read()).filter((entry) =>
				entry.operationId.startsWith("hobo:rollover:intent:"),
			),
		).toHaveLength(2);
	});
	it("durably chooses one destination before competing coordinators can seal", async () => {
		const f = await fixture();
		const alternate = fleet("alternate");
		await alternate.journal.bootstrap(async () => {});
		const rival = createImmutableJournalRollover({
			old: f.old.options,
			next: alternate.options,
			control: f.control.options,
			timeoutMs: 50,
			authorize: async () => {},
		});
		const outcomes = await Promise.allSettled([
			f.open().cutover(),
			rival.cutover(),
		]);
		expect(
			outcomes.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(
			(await f.control.journal.read()).filter((entry) =>
				entry.operationId.startsWith("hobo:rollover:intent:"),
			),
		).toHaveLength(1);
	});
	it("refuses an oversized checkpoint before sealing any voter", async () => {
		const f = await fixture(1024, 1024);
		await f.old.journal.append("large", "x".repeat(900), 0);
		await expect(f.open().cutover()).rejects.toThrow("checkpoint-too-large");
		expect(f.old.replicas.some((replica) => replica.sealed)).toBe(false);
		await f.old.journal.append("still-live", "ok", 1);
	});
});
