import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	createFleetPickupMemory,
	createFleetVerdictHolds,
	createFleetVerdictSchedule,
	createFleetVerdictSequence,
	FLEET_VERDICT_ENTER_MS,
	FLEET_VERDICT_EXIT_MS,
} from "../src/isolated-worker/fleet-verdict-state.js";

/** The reporter's state (ADR-0180 amendment, item 2): holds, send schedule, sequence. */
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

describe("the send schedule", () => {
	it("sends at once on a change, then every 60 s", () => {
		const schedule = createFleetVerdictSchedule({ resendMs: 60_000 });
		expect(schedule.due(T0, false)).toBe(true);
		schedule.attempted(T0, true);
		expect(schedule.due(T0 + 10_000, false)).toBe(false);
		expect(schedule.due(T0 + 20_000, true)).toBe(true);
		schedule.attempted(T0 + 20_000, true);
		expect(schedule.due(T0 + 70_000, false)).toBe(false);
		expect(schedule.due(T0 + 80_000, false)).toBe(true);
	});

	it("tries again at the next sample while a change is unsent, otherwise at the next 60 s mark", () => {
		const schedule = createFleetVerdictSchedule({ resendMs: 60_000 });
		schedule.attempted(T0, true);
		// A change fails to send: the next sample tries again.
		expect(schedule.due(T0 + 10_000, true)).toBe(true);
		schedule.attempted(T0 + 10_000, false);
		expect(schedule.due(T0 + 20_000, false)).toBe(true);
		schedule.attempted(T0 + 20_000, true);
		// A routine send fails: not until 60 s after it.
		expect(schedule.due(T0 + 80_000, false)).toBe(true);
		schedule.attempted(T0 + 80_000, false);
		expect(schedule.due(T0 + 90_000, false)).toBe(false);
		expect(schedule.due(T0 + 140_000, false)).toBe(true);
	});
});

describe("the report sequence", () => {
	function file() {
		const directory = mkdtempSync(join(tmpdir(), "hobo-fleet-verdict-"));
		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		return join(directory, "fleet-verdict-state.json");
	}

	it("is the clock, or one more than the last, whichever is higher, and is written before it is used", () => {
		const path = file();
		const sequence = createFleetVerdictSequence(path);
		expect(sequence.next(T0)).toBe(BigInt(T0));
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			lastSequence: String(T0),
		});
		expect(sequence.next(T0)).toBe(BigInt(T0) + 1n);
		expect(statSync(path).mode & 0o077).toBe(0);
	});

	it("never reuses a sequence, even if the clock steps back", () => {
		const path = file();
		const first = createFleetVerdictSequence(path);
		const issued = [first.next(T0), first.next(T0 + 5_000)];
		// The box restarts with its clock an hour behind.
		const restarted = createFleetVerdictSequence(path);
		const after = restarted.next(T0 - 3_600_000);
		expect(after).toBe(BigInt(T0 + 5_000) + 1n);
		expect(new Set([...issued, after]).size).toBe(3);
	});

	it("refuses to start from a state file it cannot read as one", () => {
		const path = file();
		createFleetVerdictSequence(path).next(T0);
		rmSync(path);
		// Missing is a first start; malformed is not.
		expect(createFleetVerdictSequence(path).next(T0)).toBe(BigInt(T0));
		const malformed = file();
		writeFileSync(malformed, '{"lastSequence":-1}');
		expect(() => createFleetVerdictSequence(malformed)).toThrow(
			/fleet-verdict-state/u,
		);
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
