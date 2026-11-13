import { describe, expect, it } from "vitest";
import {
	createFleetPickupMemory,
	createFleetVerdictHolds,
	FLEET_VERDICT_ENTER_MS,
	FLEET_VERDICT_EXIT_MS,
} from "../src/isolated-worker/fleet-verdict-state.js";

/** What the box relay keeps between samples (plan 0025, 6.2): the holds and the pickup memory. */
const T0 = Date.parse("2026-11-12T11:14:00.000Z");
const SAMPLE = 10_000;

function holds() {
	return createFleetVerdictHolds({
		labels: ["hobo", "hobo-trunk"],
		enterMs: FLEET_VERDICT_ENTER_MS,
		exitMs: FLEET_VERDICT_EXIT_MS,
	});
}

/** Feeds one sample per 10 s from `from`, `blocked` deciding each; returns when it changed. */
function feed(
	state: ReturnType<typeof holds>,
	from: number,
	samples: readonly boolean[],
) {
	const changes: number[] = [];
	samples.forEach((blocked, index) => {
		const at = from + index * SAMPLE;
		if (state.observe(at, new Set(blocked ? ["hobo"] : [])))
			changes.push(at - from);
	});
	return changes;
}

describe("the fleet verdict holds", () => {
	it("enters after 60 s of blocked samples and leaves after 30 s of clear ones", () => {
		const state = holds();
		expect(feed(state, T0, Array(7).fill(true))).toEqual([60_000]);
		expect([...state.blocked()]).toEqual(["hobo"]);
		expect(feed(state, T0 + 70_000, Array(4).fill(false))).toEqual([30_000]);
		expect([...state.blocked()]).toEqual([]);
	});

	it("does not enter on a dip", () => {
		const state = holds();
		// Fifty seconds blocked, one clear sample, fifty more: never a full minute.
		const samples = [
			...Array(6).fill(true),
			false,
			...Array(6).fill(true),
			false,
		];
		expect(feed(state, T0, samples)).toEqual([]);
		expect(state.blocked().size).toBe(0);
	});

	it("does not leave on a spike", () => {
		const state = holds();
		feed(state, T0, Array(7).fill(true));
		// Twenty seconds clear, then blocked again: still blocked.
		expect(
			feed(state, T0 + 70_000, [
				false,
				false,
				false,
				true,
				false,
				false,
				false,
			]),
		).toEqual([]);
		expect([...state.blocked()]).toEqual(["hobo"]);
	});

	it("ignores labels it does not serve", () => {
		const state = createFleetVerdictHolds({
			labels: ["hobo"],
			enterMs: 0,
			exitMs: 0,
		});
		state.observe(T0, new Set(["hobo-trunk", "hobo"]));
		expect([...state.blocked()]).toEqual(["hobo"]);
	});
});

describe("the pickup memory", () => {
	it("keeps jobs runners took for 15 minutes from their start, across polls", () => {
		const memory = createFleetPickupMemory();
		memory.remember({
			completedAt: new Date(T0).toISOString(),
			inProgress: [
				{
					label: "hobo",
					runnerName: "hobo-runner-a",
					startedAt: new Date(T0 - 60_000).toISOString(),
				},
				// No start time: the poll that saw it stands in.
				{ label: "hobo-trunk", runnerName: "hobo-runner-b" },
			],
		});
		// The next poll no longer sees them: they finished.
		memory.remember({
			completedAt: new Date(T0 + 10_000).toISOString(),
			inProgress: [],
		});
		expect(memory.list(T0 + 10_000)).toEqual([
			{ label: "hobo", runnerName: "hobo-runner-a", startedAtMs: T0 - 60_000 },
			{ label: "hobo-trunk", runnerName: "hobo-runner-b", startedAtMs: T0 },
		]);
		expect(memory.list(T0 + 14 * 60_000 + 1)).toEqual([
			{ label: "hobo-trunk", runnerName: "hobo-runner-b", startedAtMs: T0 },
		]);
		expect(memory.list(T0 + 15 * 60_000 + 1)).toEqual([]);
	});
});
