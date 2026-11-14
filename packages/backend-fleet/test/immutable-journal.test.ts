import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
	AssignmentAcceptOutcome,
	FleetAssignment,
} from "../src/assignment.js";
import { assignmentKey } from "../src/assignment.js";
import {
	createImmutableJournal,
	type ImmutableJournalMember,
	type ImmutableJournalReplica,
} from "../src/immutable-journal.js";

class Replica implements ImmutableJournalReplica {
	readonly rows: FleetAssignment[] = [];
	readonly documents = new Map<string, string>();
	available = true;
	loseNextReply = false;
	refuseAfterGenesis = false;
	hangRead = false;
	hangDocument = false;
	truncateHistory = false;
	corruptHistory = false;
	delayAccept = false;
	readonly pendingAccepts: (() => void)[] = [];
	constructor(readonly id: string) {}
	async read(limit?: number) {
		if (!this.available) throw new Error("provider offline");
		if (this.hangRead) await new Promise<never>(() => {});
		if (this.truncateHistory && limit !== 1) return this.rows.slice(-1);
		if (this.corruptHistory && limit !== 1 && this.rows.length > 1) {
			const [first, ...rest] = this.rows;
			if (first)
				return [
					{ ...first, reason: `j:${"0".repeat(64)}:${"f".repeat(64)}` },
					...rest,
				];
		}
		return this.rows.slice(-(limit ?? this.rows.length));
	}
	async accept(value: FleetAssignment): Promise<AssignmentAcceptOutcome> {
		if (!this.available) throw new Error("provider offline");
		if (this.refuseAfterGenesis && value.epoch > 1)
			throw new Error("provider unavailable");
		if (this.delayAccept && value.epoch > 1)
			await new Promise<void>((resolve) => this.pendingAccepts.push(resolve));
		const existing = this.rows.find((entry) => entry.epoch === value.epoch);
		if (existing)
			return assignmentKey(existing) === assignmentKey(value)
				? "duplicate"
				: "conflict";
		if ((this.rows.at(-1)?.epoch ?? 0) !== value.epoch - 1) return "gap";
		this.rows.push(value);
		if (this.loseNextReply) {
			this.loseNextReply = false;
			throw new Error("lost response");
		}
		return "accepted";
	}
	async readDocument(digest: string) {
		if (!this.available) throw new Error("provider offline");
		if (this.hangDocument) await new Promise<never>(() => {});
		return this.documents.get(digest);
	}
	async writeDocument(digest: string, value: string) {
		if (!this.available) throw new Error("provider offline");
		const previous = this.documents.get(digest);
		if (previous !== undefined && previous !== value)
			throw new Error("immutable conflict");
		this.documents.set(digest, value);
	}
}
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
	fleetId: "cd-journal",
	members,
});
const anchorDigest = createHash("sha256").update(anchor).digest("hex");
function fixture(replicaTimeoutMs = 100) {
	const replicas = [
		new Replica("a"),
		new Replica("b"),
		new Replica("c"),
	] as const;
	let permitted = true;
	const authorizations: string[] = [];
	function open() {
		return createImmutableJournal({
			fleetId: "cd-journal",
			members,
			anchorDigest,
			replicas,
			maxEntryBytes: 4096,
			maxEntries: 100,
			replicaTimeoutMs,
			authorize: async (operation) => {
				authorizations.push(operation);
				if (!permitted) throw new Error("funding revoked");
			},
		});
	}
	return {
		replicas,
		open,
		authorizations,
		deny: () => {
			permitted = false;
		},
	};
}

describe("immutable majority journal", () => {
	it("reads and writes from a healthy majority while another voter never answers", async () => {
		const f = fixture(1_000);
		const journal = f.open();
		await journal.bootstrap(async () => {});
		f.replicas[0].hangRead = true;
		f.replicas[0].hangDocument = true;
		const result = await Promise.race([
			journal.append("healthy-majority", "event", 0),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("waited for hung voter")), 500),
			),
		]);
		expect(result.position).toBe(1);
		expect((await f.open().read()).map((entry) => entry.operationId)).toEqual([
			"healthy-majority",
		]);
	});
	it("uses a complete majority holder when the first holder's history is truncated", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		await journal.append("first", "event", 0);
		f.replicas[0].truncateHistory = true;
		expect((await f.open().read()).map((entry) => entry.operationId)).toEqual([
			"first",
		]);
		f.replicas[0].truncateHistory = false;
		f.replicas[0].corruptHistory = true;
		expect((await f.open().read()).map((entry) => entry.operationId)).toEqual([
			"first",
		]);
	});
	it("continues past a hung accept and safely handles its delayed completion", async () => {
		const f = fixture(25);
		const journal = f.open();
		await journal.bootstrap(async () => {});
		f.replicas[0].delayAccept = true;
		const first = await journal.append("first", "one", 0);
		const second = await journal.append("second", "two", 1);
		expect(f.replicas[0].pendingAccepts.length).toBeGreaterThan(0);
		f.replicas[0].delayAccept = false;
		for (const release of f.replicas[0].pendingAccepts.splice(0)) release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		f.replicas[1].available = false;
		expect((await f.open().recover()).map((entry) => entry.digest)).toEqual([
			first.digest,
			second.digest,
		]);
	});
	it("does not let an ambiguous late accept replace a competing majority", async () => {
		const f = fixture(25);
		const journal = f.open();
		await journal.bootstrap(async () => {});
		f.replicas[0].delayAccept = true;
		f.replicas[1].refuseAfterGenesis = true;
		f.replicas[2].refuseAfterGenesis = true;
		await expect(journal.append("late", "old", 0)).rejects.toThrow();
		f.replicas[1].refuseAfterGenesis = false;
		f.replicas[2].refuseAfterGenesis = false;
		const winner = await journal.append("winner", "new", 0);
		f.replicas[0].delayAccept = false;
		for (const release of f.replicas[0].pendingAccepts.splice(0)) release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect((await f.open().read()).map((entry) => entry.digest)).toEqual([
			winner.digest,
		]);
		await expect(f.open().append("late", "old", 0)).rejects.toThrow(
			"head-conflict",
		);
	});
	it("bounds a read when fewer than a majority can answer", async () => {
		const f = fixture(25);
		const journal = f.open();
		await journal.bootstrap(async () => {});
		f.replicas[0].hangRead = true;
		f.replicas[1].hangRead = true;
		await expect(journal.read()).rejects.toThrow("quorum-unavailable");
	});
	it("retains the same committed history through restart and a provider outage", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		const first = await journal.append(
			"op-1",
			JSON.stringify({ events: [1], effects: ["one"] }),
			0,
		);
		f.replicas[0].available = false;
		const second = await journal.append(
			"op-2",
			JSON.stringify({ events: [2], effects: ["two"] }),
			1,
		);
		expect((await f.open().read()).map((entry) => entry.digest)).toEqual([
			first.digest,
			second.digest,
		]);
		expect(await f.open().append("op-1", first.value, 0)).toEqual(first);
		await expect(f.open().append("op-1", "different", 0)).rejects.toThrow(
			"operation-conflict",
		);
		expect(journal.quorum).toBe(2);
	});

	it("recovers a lost acknowledgement without creating a second operation", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		for (const replica of f.replicas) replica.loseNextReply = true;
		const entry = await journal.append("op-lost", "committed", 0);
		expect(entry.position).toBe(1);
		expect((await f.open().read()).map((item) => item.operationId)).toEqual([
			"op-lost",
		]);
		expect(await f.open().append("op-lost", "committed", 0)).toEqual(entry);
	});

	it("requires the caller to recompute after a different command wins the expected head", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		await journal.append("winner", "reserved", 0);
		await expect(
			journal.append("stale", "computed-from-old-budget", 0),
		).rejects.toThrow("head-conflict");
		expect((await journal.read()).map((entry) => entry.operationId)).toEqual([
			"winner",
		]);
	});

	it("recovers bootstrap only after every voter proves its own anchored prefix", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		f.replicas[1].refuseAfterGenesis = true;
		f.replicas[2].refuseAfterGenesis = true;
		await expect(journal.append("base", "initial-budget", 0)).rejects.toThrow();
		f.replicas[1].refuseAfterGenesis = false;
		f.replicas[2].refuseAfterGenesis = false;
		f.replicas[2].available = false;
		await expect(journal.recoverBootstrap(async () => {})).rejects.toThrow(
			"bootstrap-recovery-unverified",
		);
		f.replicas[2].available = true;
		const genesis = f.replicas[2].rows[0];
		if (!genesis) throw new Error("missing fixture genesis");
		f.replicas[2].rows[0] = {
			...genesis,
			reason: `j:${"0".repeat(64)}:${"f".repeat(64)}`,
		};
		await expect(journal.recoverBootstrap(async () => {})).rejects.toThrow(
			"bootstrap-recovery-unverified",
		);
		f.replicas[2].rows[0] = genesis;
		await expect(
			journal.recoverBootstrap(async () => {}, {
				operationId: "other",
				value: "foreign",
			}),
		).rejects.toThrow("bootstrap-recovery-unverified");
		expect(
			(
				await journal.recoverBootstrap(async () => {}, {
					operationId: "base",
					value: "initial-budget",
				})
			).map((entry) => entry.operationId),
		).toEqual(["base"]);
		await journal.append("later", "already-established", 1);
		await expect(
			journal.recoverBootstrap(async () => {}, {
				operationId: "base",
				value: "initial-budget",
			}),
		).rejects.toThrow("bootstrap-recovery-unverified");
	});

	it("never initializes from a missing provider or accepts a different independent anchor", async () => {
		const f = fixture();
		f.replicas[2].available = false;
		await expect(f.open().bootstrap(async () => {})).rejects.toThrow(
			"freshness-unverified",
		);
		expect(f.replicas.every((replica) => replica.rows.length === 0)).toBe(true);
		expect(() =>
			createImmutableJournal({
				fleetId: "cd-journal",
				members,
				anchorDigest: "0".repeat(64),
				replicas: f.replicas,
				maxEntryBytes: 100,
				maxEntries: 5,
				authorize: async () => {},
			}),
		).toThrow("anchor-mismatch");
	});

	it("does not silently read a shorter history when no current quorum exists", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		f.replicas[2].available = false;
		await journal.append("op-1", "durable", 0);
		f.replicas[0].available = false;
		f.replicas[2].available = true;
		const before = f.replicas[2].rows.length;
		await expect(journal.read()).rejects.toThrow("quorum-unavailable");
		expect(f.replicas[2].rows).toHaveLength(before);
		expect((await journal.recover()).map((entry) => entry.value)).toEqual([
			"durable",
		]);
		expect(f.authorizations).toContain("recover");
		expect(await journal.append("op-1", "durable", 0)).toMatchObject({
			position: 1,
		});
		expect((await journal.read()).map((entry) => entry.value)).toEqual([
			"durable",
		]);
	});

	it("refuses lost majority, damaged payloads, and revoked budget without leaking values", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		const result = await journal.append("op-secret", "private-event", 0);
		for (const replica of f.replicas)
			replica.documents.set(result.digest, "corrupt");
		await expect(journal.read()).rejects.toThrow("document-unavailable");
		f.replicas[0].available = false;
		f.replicas[1].available = false;
		await expect(journal.read()).rejects.toThrow("quorum-unavailable");
		f.deny();
		await expect(journal.append("other", "private-event", 1)).rejects.toThrow(
			"authorization-unavailable",
		);
	});

	it("serializes concurrent contenders and keeps every accepted command exactly once", async () => {
		const f = fixture();
		const journal = f.open();
		await journal.bootstrap(async () => {});
		const results = await Promise.allSettled(
			Array.from({ length: 8 }, (_, i) =>
				f.open().append(`op-${i}`, `value-${i}`, 0),
			),
		);
		for (let i = 0; i < results.length; i++) {
			if (results[i]?.status === "rejected")
				await f
					.open()
					.append(`op-${i}`, `value-${i}`, (await f.open().read()).length);
		}
		const entries = await journal.read();
		expect(entries).toHaveLength(8);
		expect(new Set(entries.map((entry) => entry.operationId)).size).toBe(8);
		expect(entries.map((entry) => entry.position)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8,
		]);
	});
});
