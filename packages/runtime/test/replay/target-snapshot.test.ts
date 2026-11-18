import fc from "fast-check";
import { expect, it } from "vitest";
import { isJsonNumber, isJsonObject } from "../../src/json.js";
import { digest } from "../../src/replay/divergence.js";
import {
	assertReplayEqualsLive,
	hashReadSet,
} from "../../src/replay/equivalence.js";
import type { ReplayReport } from "../../src/replay/types.js";

const event = {
	id: "one",
	streamId: "stream",
	seq: 1,
	type: "value",
	data: null,
};

it("reports a non-enumerable own target used by the fold", () => {
	const target = Object.defineProperty({}, "stream", { value: 1 });
	const report = assertReplayEqualsLive({
		events: [event],
		targetSeq: target,
		initialState: 0,
		fold: (count) => count + 1,
	});
	expect(report.stateDigest).toBe(digest(1));
	expect(report.seqVector).toEqual([{ streamId: "stream", seq: 1 }]);
});

it("retains non-enumerable target entries with special stream names", () => {
	const target = Object.defineProperty({}, "__proto__", { value: 1 });
	const special = { ...event, streamId: "__proto__" };
	const report = assertReplayEqualsLive({
		events: [special],
		targetSeq: target,
		initialState: 0,
		fold: (count) => count + 1,
	});
	expect(report.stateDigest).toBe(digest(1));
	expect(report.seqVector).toEqual([{ streamId: "__proto__", seq: 1 }]);
});

it("keeps the selected target when a fold edits the caller's vector", () => {
	const target = { stream: 1 };
	const report = assertReplayEqualsLive({
		events: [event],
		targetSeq: target,
		initialState: 0,
		fold: (count) => {
			target.stream = 0;
			return count + 1;
		},
	});
	expect(report.stateDigest).toBe(digest(1));
	expect(report.seqVector).toEqual([{ streamId: "stream", seq: 1 }]);
});

it("reads each own target value once for filtering and reporting", () => {
	let reads = 0;
	const target = Object.defineProperty({}, "stream", {
		enumerable: true,
		get() {
			reads++;
			return reads === 1 ? 1 : 0;
		},
	});
	const report = assertReplayEqualsLive({
		events: [event],
		targetSeq: target,
		initialState: 0,
		fold: (count) => count + 1,
	});
	expect(report.stateDigest).toBe(digest(1));
	expect(report.seqVector).toEqual([{ streamId: "stream", seq: 1 }]);
	expect(reads).toBe(1);
});

it("reports generated target snapshots despite caller edits", () => {
	fc.assert(
		fc.property(
			fc.integer({ min: 1, max: 1000 }),
			fc.integer({ min: 1, max: 1000 }),
			(initial, changed) => {
				const target = { stream: initial };
				const report = assertReplayEqualsLive({
					events: [event],
					targetSeq: target,
					initialState: 0,
					fold: (count) => {
						target.stream = changed;
						return count + 1;
					},
				});
				expect(report.stateDigest).toBe(digest(1));
				expect(report.seqVector).toEqual([
					{ streamId: "stream", seq: initial },
				]);
			},
		),
		{ seed: 614611, numRuns: 100 },
	);
});

it("keeps both folds and the read-set report on the original events", () => {
	const original = {
		id: "one",
		streamId: "stream",
		seq: 1,
		type: "value",
		data: { value: 1 },
	};
	const events = [original];
	const expectedReadSet = hashReadSet(events);
	let calls = 0;
	let report: ReplayReport | undefined;
	expect(() => {
		report = assertReplayEqualsLive({
			events,
			initialState: 0,
			fold: (_count, current) => {
				if (!isJsonObject(current.data) || !isJsonNumber(current.data.value))
					throw new Error("invalid test event");
				const value = current.data.value;
				if (calls++ === 0) {
					original.data.value = 2;
					events.push({
						id: "two",
						streamId: "later",
						seq: 1,
						type: "value",
						data: { value: 3 },
					});
				}
				return value;
			},
		});
	}).not.toThrow();
	expect(report?.stateDigest).toBe(digest(1));
	expect(report?.readSetHash).toBe(expectedReadSet);
});
