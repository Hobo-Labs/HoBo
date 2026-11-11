import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	type PairVerdict,
	PairVerdictSchema,
} from "../src/_generated/agent_pb.js";
import { observeQueue, overlappingPairs, planQueue } from "../src/planner.js";
import { type PolicyOverrides, testPolicies } from "./fixtures/config.js";

const sha = (digit: number) => String(digit).repeat(40);
const policy = (queue: PolicyOverrides["queue"] = {}) =>
	testPolicies({ queue }).queue;
type Entry = {
	number: number;
	minutesAgo?: number;
	paths?: string[];
	labels?: string[];
	dependsOn?: number[];
	started?: boolean;
};
const queue = (entries: Entry[]) =>
	observeQueue({
		repository: "hobo-labs/hobo",
		baseRef: "main",
		baseSha: sha(9),
		observedAt: "2026-11-10T12:00:00.000Z",
		entries: entries.map((entry, position) => ({
			number: entry.number,
			headSha: sha(entry.number % 9),
			headRef: `pr-${entry.number}`,
			baseRef: "main",
			position,
			enqueuedAt: new Date(
				Date.parse("2026-11-10T12:00:00.000Z") -
					(entry.minutesAgo ?? 10 - position) * 60_000,
			).toISOString(),
			labels: entry.labels ?? [],
			dependsOn: entry.dependsOn ?? [],
			changedPaths: entry.paths ?? [`src/${entry.number}.ts`],
			started: entry.started ?? false,
		})),
	});
const conflict = (first: number, second: number, paths = ["src/shared.ts"]) =>
	create(PairVerdictSchema, { first, second, verdict: "conflict", paths });
const plan = (
	entries: Entry[],
	verdicts: PairVerdict[] = [],
	overrides: PolicyOverrides["queue"] = {},
	baseConflicts = new Map<number, string[]>(),
) =>
	planQueue({
		snapshot: queue(entries),
		verdicts,
		baseConflicts,
		policy: policy(overrides),
	});

describe("queue planner", () => {
	it("keeps independent work in arrival order and batches it", () => {
		const result = plan([{ number: 1 }, { number: 2 }, { number: 3 }]);
		expect(result.order).toEqual([1, 2, 3]);
		expect(result.batches.map((batch) => batch.numbers)).toEqual([[1, 2, 3]]);
		expect(result.moved).toEqual([]);
		expect(result.resolutions).toEqual([]);
	});

	it("moves the entry that conflicts with the most waiting work to the back", () => {
		// 1 conflicts with 2 and 3; 2 and 3 are independent of each other.
		const result = plan(
			[{ number: 1 }, { number: 2 }, { number: 3 }],
			[conflict(1, 2), conflict(1, 3)],
		);
		expect(result.order).toEqual([2, 3, 1]);
		expect(result.batches.map((batch) => batch.numbers)).toEqual([[2, 3], [1]]);
		expect(result.moved).toEqual([2, 3, 1]);
		expect(result.resolutions).toMatchObject([
			{ number: 1, against: [2, 3], paths: ["src/shared.ts"] },
		]);
	});

	it("never moves an entry whose checks have started", () => {
		const result = plan(
			[{ number: 1, started: true }, { number: 2 }, { number: 3 }],
			[conflict(1, 2), conflict(1, 3), conflict(2, 3)],
		);
		expect(result.order[0]).toBe(1);
		expect(result.moved).not.toContain(1);
	});

	it("puts a priority label first and a stacked entry after its parent", () => {
		const result = plan(
			[
				{ number: 1 },
				{ number: 2, dependsOn: [3] },
				{ number: 3 },
				{ number: 4, labels: ["hotfix"] },
			],
			[],
			{ priorityLabels: ["hotfix"] },
		);
		expect(result.order).toEqual([4, 1, 3, 2]);
	});

	it("does not let an entry that has waited too long be passed by younger work", () => {
		// 1 would go last on conflicts alone, but it has waited past the limit.
		const result = plan(
			[{ number: 1, minutesAgo: 500 }, { number: 2 }, { number: 3 }],
			[conflict(1, 2), conflict(1, 3)],
			{ maxWaitMinutes: 240, priorityLabels: ["hotfix"] },
		);
		expect(result.order).toEqual([1, 2, 3]);
	});

	it("treats a pair it knows nothing about as a conflict, not as a safe batch", () => {
		// Both touch the same path and no trial merge was recorded.
		const result = plan([
			{ number: 1, paths: ["src/a.ts"] },
			{ number: 2, paths: ["src/a.ts"] },
		]);
		expect(result.batches.map((batch) => batch.numbers)).toEqual([[1], [2]]);
		// Unknown is not a known conflict, so there is nothing to resolve yet.
		expect(result.resolutions).toEqual([]);
	});

	it("keeps an entry that conflicts with the base branch out of every batch", () => {
		const result = plan(
			[{ number: 1 }, { number: 2 }, { number: 3 }],
			[],
			{},
			new Map([[2, ["src/2.ts"]]]),
		);
		expect(result.batches.map((batch) => batch.numbers)).toEqual([
			[1],
			[2],
			[3],
		]);
		expect(result.resolutions).toMatchObject([
			{ number: 2, against: [], paths: ["src/2.ts"] },
		]);
	});

	it("limits batch size and queue depth", () => {
		const entries = [1, 2, 3, 4, 5].map((number) => ({ number }));
		expect(
			plan(entries, [], { maxBatchSize: 2 }).batches.map((b) => b.numbers),
		).toEqual([[1, 2], [3, 4], [5]]);
		expect(plan(entries, [], { maxDepth: 3 }).order).toEqual([1, 2, 3]);
	});

	it("is deterministic: the same inputs give the same digest", () => {
		const entries = [{ number: 1 }, { number: 2 }];
		const first = plan(entries, [conflict(1, 2)]);
		expect(plan(entries, [conflict(1, 2)]).digest).toBe(first.digest);
		expect(plan(entries).digest).not.toBe(first.digest);
		expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("survives a dependency cycle by falling back to arrival order", () => {
		const result = plan([
			{ number: 1, dependsOn: [2] },
			{ number: 2, dependsOn: [1] },
		]);
		expect(result.order).toEqual([1, 2]);
	});

	it("only trial-merges pairs that share a path or have unknown paths", () => {
		const snapshot = queue([
			{ number: 1, paths: ["a"] },
			{ number: 2, paths: ["b"] },
			{ number: 3, paths: ["a", "c"] },
			{ number: 4, paths: [] },
		]);
		expect(
			overlappingPairs(snapshot.entries).map(([a, b]) => [a.number, b.number]),
		).toEqual([
			[1, 3],
			[1, 4],
			[2, 4],
			[3, 4],
		]);
	});

	it("rejects a malformed snapshot and drops dependencies that already left", () => {
		expect(() =>
			observeQueue({
				repository: "hobo-labs/hobo",
				baseRef: "main",
				baseSha: "not-a-sha",
				observedAt: "2026-11-10T12:00:00.000Z",
			}),
		).toThrow(/invalid queue snapshot/);
		expect(
			queue([{ number: 1, dependsOn: [99] }]).entries[0]?.dependsOn,
		).toEqual([]);
	});
});
