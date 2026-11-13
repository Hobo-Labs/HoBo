/**
 * Membership epochs (design §6.10 item 2, O15): the deciding set, the pin and
 * one-name changes, and the safety property over randomised interleavings.
 *
 * The property runs concurrent proposers, a completer and one membership actor
 * (pin, then admit or remove one name) against in-memory replicas under a
 * seeded scheduler, starting from a log with no member sets, with replicas
 * going down and coming back. After every step it checks, from outside, that
 * no two different entries are decided for one epoch, where an entry is
 * decided when a majority of its deciding set holds it.
 */
import { describe, expect, it } from "vitest";
import { Health } from "../../src/_generated/fleet_pb.js";
import {
	assignmentKey,
	bootstrapAssignment,
	completeAssignment,
	decidingSet,
	fleetMajority,
	parseAssignmentEntry,
	parseAssignmentRegister,
	proposeAssignment,
	proposeMembership,
	readCurrentAssignment,
	rejoinAssignmentReplicas,
	resolveAssignment,
} from "../../src/assignment/index.js";
import { type MemberName, parseMemberName } from "../../src/ids.js";
import type {
	AssignmentEntry,
	AssignmentRegister,
	AssignmentReply,
} from "../../src/ports.js";
import { MemoryReplica, Scheduler } from "./fleet-model.js";

const n = (value: string): MemberName => parseMemberName(value);
const names = (...values: string[]): MemberName[] => values.map(n);

function entry(
	epoch: number,
	overrides: Partial<AssignmentEntry> = {},
): AssignmentEntry {
	return parseAssignmentEntry({
		epoch,
		active: n("b0"),
		sealed: false,
		target: undefined,
		reason: "test",
		lossWindowMs: undefined,
		decidedAtMs: epoch,
		decidedBy: "test",
		members: undefined,
		...overrides,
	});
}

function fleet(...ids: string[]) {
	const replicas = ids.map((id) => new MemoryReplica(id));
	return { replicas, register: parseAssignmentRegister(replicas) };
}

async function current(register: AssignmentRegister): Promise<AssignmentEntry> {
	const resolution = await readCurrentAssignment(register);
	if (resolution.status !== "current")
		throw new Error(`expected current, got ${resolution.status}`);
	return resolution.assignment;
}

describe("decidingSet", () => {
	it("is undefined without members, the set itself for an ordinary entry", () => {
		expect(decidingSet(entry(1))).toBeUndefined();
		const pinned = entry(2, {
			reason: "pin-members",
			members: names("b0", "b1", "b2"),
		});
		expect(decidingSet(pinned)).toEqual(names("b0", "b1", "b2"));
	});

	it("leaves out an admitted name and puts back a removed one", () => {
		expect(
			decidingSet(
				entry(3, {
					reason: "admit:b3",
					members: names("b0", "b1", "b2", "b3"),
				}),
			),
		).toEqual(names("b0", "b1", "b2"));
		expect(
			decidingSet(
				entry(3, { reason: "remove:b1", members: names("b0", "b2") }),
			),
		).toEqual(names("b0", "b1", "b2"));
	});

	it("is checked when an entry is parsed", () => {
		expect(() => entry(2, { members: [] })).toThrow(/never empty/u);
		expect(() => entry(2, { members: names("b1", "b0") })).toThrow(/sorted/u);
		expect(() => entry(2, { members: names("b0", "b0") })).toThrow(/sorted/u);
		expect(() =>
			entry(2, { reason: "admit:b3", members: names("b0", "b1") }),
		).toThrow(/admitted/u);
		expect(() =>
			entry(2, { reason: "remove:b1", members: names("b0", "b1") }),
		).toThrow(/removed/u);
	});

	it("keeps today's key for an entry without members and separates sets", () => {
		const plain = entry(4);
		expect(JSON.parse(assignmentKey(plain))).toHaveLength(8);
		expect(assignmentKey(entry(4, { members: names("b0", "b1") }))).not.toBe(
			assignmentKey(entry(4, { members: names("b0", "b2") })),
		);
	});
});

describe("resolving over the deciding set", () => {
	const rows = (
		replica: string,
		...held: AssignmentEntry[]
	): AssignmentReply => ({
		replica: n(replica),
		rows: held,
	});
	const down = (replica: string): AssignmentReply => ({
		replica: n(replica),
		failure: Health.UNREACHABLE,
	});

	it("counts a decider with no replica as silent", () => {
		// b2 was removed from configuration before its removal was decided.
		const pinned = entry(1, {
			reason: "pin-members",
			members: names("b0", "b1", "b2"),
		});
		const resolution = resolveAssignment(names("b0", "b1"), [
			rows("b0", pinned),
			rows("b1", pinned),
		]);
		expect(resolution).toMatchObject({ status: "current", silent: ["b2"] });
		expect(
			resolveAssignment(names("b0", "b1"), [rows("b0", pinned), down("b1")]),
		).toMatchObject({ status: "no-majority", answered: 1, required: 2 });
	});

	it("does not count a configured member outside the deciding set", () => {
		const pinned = entry(1, {
			reason: "pin-members",
			members: names("b0", "b1", "b2"),
		});
		// b3 is configured but not admitted: its copy does not decide.
		const resolution = resolveAssignment(names("b0", "b1", "b2", "b3"), [
			rows("b0", pinned),
			rows("b1"),
			rows("b2"),
			rows("b3", pinned),
		]);
		expect(resolution.status).toBe("undecided");
	});
});

describe("proposeMembership", () => {
	it("pins the configured set after a decided entry that has none", async () => {
		const { register } = fleet("b0", "b1", "b2");
		await bootstrapAssignment(register, n("b0"));
		const pinned = await proposeMembership(register, {
			pin: names("b2", "b0", "b1"),
			expectedEpoch: 1,
			decidedBy: "service:relay",
			nowMs: 5,
		});
		expect(pinned).toMatchObject({
			status: "decided",
			assignment: {
				epoch: 2,
				active: "b0",
				reason: "pin-members",
				members: ["b0", "b1", "b2"],
			},
		});
		// Ordinary entries copy the set.
		const next = await proposeAssignment(register, {
			expectedEpoch: 2,
			value: {
				active: n("b1"),
				sealed: false,
				target: undefined,
				reason: "switch",
				lossWindowMs: undefined,
			},
			decidedBy: "service:relay",
			nowMs: 6,
		});
		expect(next).toMatchObject({
			status: "decided",
			assignment: { members: ["b0", "b1", "b2"] },
		});
	});

	it("admits a name, decided by the old set, and the newcomer rejoins", async () => {
		const old = fleet("b0", "b1", "b2");
		await bootstrapAssignment(old.register, n("b0"));
		await proposeMembership(old.register, {
			pin: names("b0", "b1", "b2"),
			expectedEpoch: 1,
			decidedBy: "service:relay",
			nowMs: 5,
		});
		const newcomer = new MemoryReplica("b3");
		const register = parseAssignmentRegister([...old.replicas, newcomer]);
		const admitted = await proposeMembership(register, {
			add: n("b3"),
			expectedEpoch: 2,
			decidedBy: "service:relay",
			nowMs: 6,
		});
		expect(admitted).toMatchObject({
			status: "decided",
			holders: ["b0", "b1", "b2", "b3"],
			assignment: { reason: "admit:b3", members: ["b0", "b1", "b2", "b3"] },
		});
		// The proposer first copied the log onto the newcomer, which then took it.
		expect(newcomer.rows.map((row) => row.epoch)).toEqual([1, 2, 3]);
		// A replica without `seed` is left alone; its next proposal repairs it.
		expect(await rejoinAssignmentReplicas(register)).toEqual([]);
	});

	it("removes a name and refuses what it must never do", async () => {
		const { register } = fleet("b0", "b1", "b2");
		await bootstrapAssignment(register, n("b0"));
		const base = { decidedBy: "service:relay", nowMs: 5 };
		expect(
			await proposeMembership(register, {
				add: n("b1"),
				expectedEpoch: 1,
				...base,
			}),
		).toMatchObject({ status: "stale" });
		expect(
			await proposeMembership(register, {
				remove: n("b1"),
				expectedEpoch: 1,
				...base,
			}),
		).toMatchObject({ status: "stale" });
		await proposeMembership(register, {
			pin: names("b0", "b1", "b2"),
			expectedEpoch: 1,
			...base,
		});
		const refusals = [
			{ pin: names("b0", "b1", "b2"), expectedEpoch: 2 },
			{ add: n("b1"), expectedEpoch: 2 },
			{ remove: n("b0"), expectedEpoch: 2 },
			{ remove: n("b9"), expectedEpoch: 2 },
			{ remove: n("b1"), expectedEpoch: 1 },
		];
		for (const change of refusals)
			expect(
				(await proposeMembership(register, { ...change, ...base })).status,
			).toBe("stale");
		await expect(
			proposeMembership(register, {
				add: n("b3"),
				remove: n("b1"),
				expectedEpoch: 2,
				...base,
			}),
		).rejects.toThrow(/exactly one/u);
		const removed = await proposeMembership(register, {
			remove: n("b2"),
			expectedEpoch: 2,
			...base,
		});
		expect(removed).toMatchObject({
			status: "decided",
			assignment: { reason: "remove:b2", members: ["b0", "b1"] },
		});
		expect(decidingSet(await current(register))).toEqual(
			names("b0", "b1", "b2"),
		);
		await proposeMembership(register, {
			remove: n("b1"),
			expectedEpoch: 3,
			...base,
		});
		expect(
			(
				await proposeMembership(register, {
					remove: n("b0"),
					expectedEpoch: 4,
					...base,
				})
			).status,
		).toBe("stale");
	});

	it("will not remove a sealed fleet's target, and reads nothing without a majority", async () => {
		const { replicas, register } = fleet("b0", "b1", "b2");
		await bootstrapAssignment(register, n("b0"));
		await proposeMembership(register, {
			pin: names("b0", "b1", "b2"),
			expectedEpoch: 1,
			decidedBy: "service:relay",
			nowMs: 5,
		});
		await proposeAssignment(register, {
			expectedEpoch: 2,
			value: {
				active: n("b0"),
				sealed: true,
				target: n("b1"),
				reason: "switch",
				lossWindowMs: undefined,
			},
			decidedBy: "service:relay",
			nowMs: 6,
		});
		expect(
			(
				await proposeMembership(register, {
					remove: n("b1"),
					expectedEpoch: 3,
					decidedBy: "service:relay",
					nowMs: 7,
				})
			).status,
		).toBe("stale");
		for (const replica of replicas.slice(1)) replica.up = false;
		expect(
			(
				await proposeMembership(register, {
					remove: n("b2"),
					expectedEpoch: 3,
					decidedBy: "service:relay",
					nowMs: 7,
				})
			).status,
		).toBe("unavailable");
	});
});

/** Decided entries from outside: a majority of each entry's deciding set holds it. */
function decidedFromOutside(
	replicas: readonly MemoryReplica[],
	configured: readonly MemberName[],
	seed: number,
): Map<number, AssignmentEntry> {
	const holders = new Map<string, { entry: AssignmentEntry; ids: string[] }>();
	for (const replica of replicas)
		for (const row of replica.rows) {
			const key = assignmentKey(row);
			const seen = holders.get(key) ?? { entry: row, ids: [] };
			seen.ids.push(replica.id);
			holders.set(key, seen);
		}
	const decided = new Map<number, AssignmentEntry>();
	for (const [key, { entry: held, ids }] of holders) {
		const deciders = decidingSet(held) ?? configured;
		const count = ids.filter((id) =>
			deciders.some((name) => name === id),
		).length;
		if (count < fleetMajority(deciders.length)) continue;
		const before = decided.get(held.epoch);
		if (before !== undefined && assignmentKey(before) !== key)
			throw new Error(
				`seed ${seed}: two entries decided for epoch ${held.epoch}`,
			);
		decided.set(held.epoch, held);
	}
	return decided;
}

async function explore(seed: number) {
	const scheduler = new Scheduler(seed);
	const size = 3 + scheduler.pick(3);
	const admit = scheduler.random() < 0.5;
	const configured = Array.from({ length: size }, (_, index) => n(`b${index}`));
	let live = false;
	const pause = () => (live ? scheduler.pause() : Promise.resolve());
	const base = configured.map((id) => new MemoryReplica(id, pause));
	const newcomer = new MemoryReplica("bx", pause);
	const replicas = admit ? [...base, newcomer] : base;
	const removed = configured[1 + scheduler.pick(size - 1)] ?? n("b1");
	const before = parseAssignmentRegister(base);
	// After the pin is decided, the fleet is reconfigured: the newcomer joins, or
	// the removed member may be dropped from configuration before its removal.
	const after = admit
		? parseAssignmentRegister(replicas)
		: scheduler.random() < 0.5
			? parseAssignmentRegister(
					base.filter((replica) => replica.id !== removed),
				)
			: before;
	// A log with no member sets: a few epochs decided by every member.
	await bootstrapAssignment(before, n("b0"));
	const warmUp = scheduler.pick(3);
	for (let epoch = 1; epoch <= warmUp; epoch += 1)
		await proposeAssignment(before, {
			expectedEpoch: epoch,
			value: {
				active: configured[scheduler.pick(size)],
				sealed: false,
				target: undefined,
				reason: "warm-up",
				lossWindowMs: undefined,
			},
			decidedBy: "warm-up",
			nowMs: epoch,
		});

	let pinDecided = false;
	let changeDecided = false;
	let outages = 0;
	const everDecided = new Map<number, string>();
	const check = () => {
		const decided = decidedFromOutside(replicas, configured, seed);
		for (const [epoch, held] of decided) {
			const key = assignmentKey(held);
			const before = everDecided.get(epoch);
			if (before !== undefined && before !== key)
				throw new Error(`seed ${seed}: epoch ${epoch} changed its decision`);
			everDecided.set(epoch, key);
			if (held.reason === "pin-members") pinDecided = true;
			if (/^(admit|remove):/u.test(held.reason)) changeDecided = true;
		}
	};
	const step = () => {
		check();
		if (scheduler.random() < 0.01) {
			const victim = replicas[scheduler.pick(replicas.length)];
			if (victim !== undefined) {
				victim.up = !victim.up;
				outages += 1;
			}
		}
	};
	/** A reader may only ever answer with an entry that was decided. */
	const read = async (register: AssignmentRegister) => {
		const view = await readCurrentAssignment(register);
		check();
		if (
			view.status === "current" &&
			everDecided.get(view.assignment.epoch) !== assignmentKey(view.assignment)
		)
			throw new Error(`seed ${seed}: a reader returned an undecided entry`);
		return view;
	};
	const registerNow = () =>
		pinDecided && scheduler.random() < 0.8 ? after : before;

	const proposer = async (index: number) => {
		for (let round = 0; round < 5; round += 1) {
			const register = registerNow();
			if (scheduler.random() < 0.2) {
				await completeAssignment(register);
				continue;
			}
			const view = await read(register);
			if (view.status !== "current") continue;
			const seen = view.assignment.epoch;
			await proposeAssignment(register, {
				expectedEpoch: scheduler.random() < 0.2 ? Math.max(0, seen - 1) : seen,
				value: {
					active: configured[scheduler.pick(size)],
					sealed: false,
					target: undefined,
					reason: "propose",
					lossWindowMs: undefined,
				},
				decidedBy: `p${index}-${round}`,
				nowMs: round,
			});
		}
	};
	const membership = async () => {
		for (let round = 0; round < 16 && !changeDecided; round += 1) {
			const register = pinDecided ? after : before;
			const view = await read(register);
			if (view.status === "undecided") await completeAssignment(register);
			if (view.status !== "current") continue;
			const { epoch, members } = view.assignment;
			const decidedBy = `m-${round}`;
			if (members === undefined)
				await proposeMembership(register, {
					pin: configured,
					expectedEpoch: epoch,
					decidedBy,
					nowMs: round,
				});
			else if (admit)
				await proposeMembership(register, {
					add: n("bx"),
					expectedEpoch: epoch,
					decidedBy,
					nowMs: round,
				});
			else
				await proposeMembership(register, {
					remove: removed,
					expectedEpoch: epoch,
					decidedBy,
					nowMs: round,
				});
		}
	};

	live = true;
	await scheduler.drive(
		[
			membership(),
			...Array.from({ length: 2 + scheduler.pick(2) }, (_, index) =>
				proposer(index),
			),
		],
		step,
	);
	live = false;
	for (const replica of replicas) replica.up = true;
	await completeAssignment(pinDecided ? after : before);
	check();
	return { pinDecided, changeDecided, outages, steps: scheduler.steps };
}

describe("randomised interleavings with a pin and one membership change", () => {
	it("never decides two different entries for one epoch over 5,000 runs", async () => {
		let pins = 0;
		let changes = 0;
		let outages = 0;
		let steps = 0;
		for (let seed = 1; seed <= 5_000; seed += 1) {
			const run = await explore(seed);
			pins += run.pinDecided ? 1 : 0;
			changes += run.changeDecided ? 1 : 0;
			outages += run.outages;
			steps += run.steps;
		}
		// The runs must have exercised what they claim to check.
		expect(pins).toBeGreaterThan(3_500);
		expect(changes).toBeGreaterThan(2_000);
		expect(outages).toBeGreaterThan(10_000);
		expect(steps).toBeGreaterThan(1_000_000);
	}, 600_000);
});
