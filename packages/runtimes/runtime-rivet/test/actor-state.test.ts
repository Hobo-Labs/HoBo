import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FoldEvent } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";
import { createRivetActorHost } from "../src/actor-host.js";
import { createActorLocalJournal } from "../src/journal.js";
import { isJsonNumber } from "../src/json.js";

const directories: string[] = [];
function journalPath() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-rivet-state-"));
	directories.push(directory);
	return join(directory, "actor.sqlite");
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

const counter = {
	initialState: 0,
	fold(state: number, event: FoldEvent) {
		if (event.type !== "counter.Added" || !isJsonNumber(event.amount))
			throw new TypeError("invalid counter event");
		return state + event.amount;
	},
};

describe("Rivet durable actor state", () => {
	it("shares events between state handles and rebuilds them after reopening", () => {
		const path = journalPath();
		const now = 1_000;
		const first = createActorLocalJournal(path);
		const host = createRivetActorHost({ journal: first, nowMs: () => now });
		const firstHandle = host.state("counter", counter);
		const secondHandle = host.state("counter", counter);
		const lease = host.acquire("counter", { holderId: "worker-a" });
		const added = { type: "counter.Added", amount: 2 };
		expect(firstHandle.append(lease, added).seq).toBe(1);
		added.amount = 100;
		expect(
			secondHandle.append(lease, { type: "counter.Added", amount: 3 }).seq,
		).toBe(2);
		expect(firstHandle.read()).toMatchObject({ seq: 2, state: 5 });
		lease.release();
		first.close();

		const reopened = createActorLocalJournal(path);
		try {
			const next = createRivetActorHost({
				journal: reopened,
				nowMs: () => now,
			});
			const state = next.state("counter", counter);
			expect(state.read()).toMatchObject({ seq: 2, state: 5 });
			const laterLease = next.acquire("counter", { holderId: "worker-b" });
			expect(laterLease.fenceToken).toBeGreaterThan(lease.fenceToken);
			expect(
				state.append(laterLease, { type: "counter.Added", amount: 4 }).seq,
			).toBe(3);
			expect(state.read()).toMatchObject({ seq: 3, state: 9 });
			laterLease.release();
		} finally {
			reopened.close();
		}
	});

	it("keeps an unreleased lease across reopen until its deadline", () => {
		const path = journalPath();
		let now = 1_000;
		const first = createActorLocalJournal(path);
		const host = createRivetActorHost({
			journal: first,
			nowMs: () => now,
			leaseTtlMs: 100,
		});
		const lease = host.acquire("counter", { holderId: "worker-a" });
		host
			.state("counter", counter)
			.append(lease, { type: "counter.Added", amount: 2 });
		first.close();
		const reopened = createActorLocalJournal(path);
		try {
			const next = createRivetActorHost({
				journal: reopened,
				nowMs: () => now,
				leaseTtlMs: 100,
			});
			now += 99;
			expect(() => next.acquire("counter", { holderId: "worker-b" })).toThrow(
				/placement conflict/,
			);
			now += 1;
			const replacement = next.acquire("counter", { holderId: "worker-b" });
			expect(replacement.fenceToken).toBeGreaterThan(lease.fenceToken);
			const state = next.state("counter", counter);
			state.append(replacement, { type: "counter.Added", amount: 3 });
			expect(state.read()).toMatchObject({ seq: 2, state: 5 });
			replacement.release();
		} finally {
			reopened.close();
		}
	});

	it("keeps the acquired holder when the caller changes its request", () => {
		const journal = createActorLocalJournal(journalPath());
		try {
			const host = createRivetActorHost({ journal, nowMs: () => 1_000 });
			const request = { holderId: "worker-a" };
			const lease = host.acquire("counter", request);
			request.holderId = "worker-b";
			lease.release();
			const next = host.acquire("counter", { holderId: "worker-c" });
			expect(next.fenceToken).toBeGreaterThan(lease.fenceToken);
			next.release();
		} finally {
			journal.close();
		}
	});

	it("keeps stale lease metadata from adopting another holder", () => {
		const path = journalPath();
		let now = 1_000;
		const first = createActorLocalJournal(path);
		const second = createActorLocalJournal(path);
		try {
			const a = createRivetActorHost({
				journal: first,
				nowMs: () => now,
				leaseTtlMs: 100,
			});
			const b = createRivetActorHost({
				journal: second,
				nowMs: () => now,
				leaseTtlMs: 100,
			});
			const stale = a.acquire("counter", { holderId: "worker-a" });
			now += 100;
			const current = b.acquire("counter", { holderId: "worker-b" });
			expect(Reflect.set(stale, "holderId", current.holderId)).toBe(false);
			expect(Reflect.set(stale, "fenceToken", current.fenceToken)).toBe(false);
			expect(() =>
				a.state("counter", counter).append(stale, {
					type: "counter.Added",
					amount: 99,
				}),
			).toThrow(/stale rivet lease/);
			b.state("counter", counter).append(current, {
				type: "counter.Added",
				amount: 2,
			});
			expect(b.state("counter", counter).read()).toMatchObject({
				seq: 1,
				state: 2,
			});
			stale.release();
			current.release();
		} finally {
			first.close();
			second.close();
		}
	});

	it("fences expired owners across independent journal connections", () => {
		const path = journalPath();
		let now = 1_000;
		const first = createActorLocalJournal(path);
		const second = createActorLocalJournal(path);
		try {
			const a = createRivetActorHost({
				journal: first,
				nowMs: () => now,
				leaseTtlMs: 100,
			});
			const b = createRivetActorHost({
				journal: second,
				nowMs: () => now,
				leaseTtlMs: 100,
			});
			const oldLease = a.acquire("counter", { holderId: "worker-a" });
			const oldState = a.state("counter", counter);
			oldState.append(oldLease, { type: "counter.Added", amount: 1 });
			expect(() => b.acquire("counter", { holderId: "worker-b" })).toThrow(
				/placement conflict/,
			);
			expect(() => a.acquire("counter", { holderId: "worker-a" })).toThrow(
				/placement conflict/,
			);
			now += 100;
			expect(() =>
				oldState.append(oldLease, { type: "counter.Added", amount: 100 }),
			).toThrow(/stale rivet lease/);
			const newLease = b.acquire("counter", { holderId: "worker-b" });
			expect(newLease.fenceToken).toBeGreaterThan(oldLease.fenceToken);
			expect(() =>
				oldState.append(oldLease, { type: "counter.Added", amount: 100 }),
			).toThrow(/stale rivet lease/);
			oldLease.release();
			const newState = b.state("counter", counter);
			newState.append(newLease, { type: "counter.Added", amount: 2 });
			expect(newState.read()).toMatchObject({ seq: 2, state: 3 });
			expect(() => a.acquire("counter", { holderId: "worker-a" })).toThrow(
				/placement conflict/,
			);
			newLease.release();
			const lastLease = a.acquire("counter", { holderId: "worker-a" });
			expect(lastLease.fenceToken).toBeGreaterThan(newLease.fenceToken);
			lastLease.release();
		} finally {
			first.close();
			second.close();
		}
	});
});
