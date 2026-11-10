/**
 * The assignment register, checked without a database.
 *
 * The scenario tests pin the rules one at a time. The randomized test then runs
 * concurrent proposers, completers and an occasional operator override against
 * replicas that go down and come back, under a seeded scheduler, and checks the
 * invariants after every single step from outside the system.
 */
import { describe, expect, it } from "vitest";
import {
	type AssignmentReply,
	assignmentKey,
	bootstrapAssignment,
	completeAssignment,
	type FleetAssignmentValue,
	fleetMajority,
	overrideAssignment,
	type PostgresFleetAssignment,
	parseAssignmentRegister,
	parseFleetAssignment,
	proposeAssignment,
	readCurrentAssignment,
	resolveAssignment,
} from "../src/index.js";
import {
	decidedEntries,
	highestDecided,
	MemoryReplica,
	Scheduler,
} from "./fleet-model.js";

function entry(
	epoch: number,
	active: string,
	decidedBy = "test",
): PostgresFleetAssignment {
	return parseFleetAssignment({
		epoch,
		active,
		sealed: false,
		target: undefined,
		reason: "test",
		lossWindowMs: undefined,
		decidedAtMs: 1,
		decidedBy,
	});
}

function writer(active: string): FleetAssignmentValue {
	return {
		active,
		sealed: false,
		target: undefined,
		reason: "test",
		lossWindowMs: undefined,
	};
}

function fleet(count: number) {
	const replicas = Array.from(
		{ length: count },
		(_, index) => new MemoryReplica(`b${index}`),
	);
	return { replicas, register: parseAssignmentRegister(replicas) };
}

describe("majority", () => {
	it("is more than half of the configured backends", () => {
		expect([1, 2, 3, 4, 5, 7].map(fleetMajority)).toEqual([1, 2, 2, 3, 3, 4]);
	});

	it("gives an even fleet no more tolerance than the odd fleet below it", () => {
		// Two backends tolerate no failure; four tolerate one, like three.
		expect(2 - fleetMajority(2)).toBe(0);
		expect(4 - fleetMajority(4)).toBe(3 - fleetMajority(3));
	});
});

describe("parseFleetAssignment", () => {
	it("refuses a sealed entry without a different target", () => {
		const sealed = { ...entry(1, "b0"), sealed: true };
		expect(() => parseFleetAssignment(sealed)).toThrow(/different target/u);
		expect(() => parseFleetAssignment({ ...sealed, target: "b0" })).toThrow(
			/different target/u,
		);
		expect(parseFleetAssignment({ ...sealed, target: "b1" }).target).toBe("b1");
	});

	it("refuses a target on an unsealed entry, and malformed fields", () => {
		expect(() =>
			parseFleetAssignment({ ...entry(1, "b0"), target: "b1" }),
		).toThrow(/only a sealed/u);
		expect(() => parseFleetAssignment({ ...entry(1, "b0"), epoch: 0 })).toThrow(
			/positive integer/u,
		);
		expect(() =>
			parseFleetAssignment({ ...entry(1, "b0"), lossWindowMs: -1 }),
		).toThrow(/loss window/u);
		expect(() =>
			parseFleetAssignment({ ...entry(1, "b0"), active: "No Spaces" }),
		).toThrow(/lower-case token/u);
	});
});

describe("resolveAssignment", () => {
	const members = ["b0", "b1", "b2"];
	const rows = (
		replica: string,
		...held: PostgresFleetAssignment[]
	): AssignmentReply => ({
		replica,
		rows: held,
	});
	const down = (replica: string): AssignmentReply => ({
		replica,
		failure: "unreachable",
	});

	it("is current when a majority hold the same newest entry", () => {
		const first = entry(1, "b0");
		const resolution = resolveAssignment(members, [
			rows("b0", first),
			rows("b1", first),
			down("b2"),
		]);
		expect(resolution).toMatchObject({
			status: "current",
			assignment: first,
			holders: ["b0", "b1"],
			silent: ["b2"],
		});
	});

	it("is no-majority when too few answer, whatever they hold", () => {
		const resolution = resolveAssignment(members, [
			rows("b0", entry(1, "b0")),
			down("b1"),
			down("b2"),
		]);
		expect(resolution).toMatchObject({
			status: "no-majority",
			answered: 1,
			required: 2,
		});
	});

	it("is empty only when a majority answer and hold nothing", () => {
		expect(
			resolveAssignment(members, [rows("b0"), rows("b1"), down("b2")]).status,
		).toBe("empty");
	});

	it("does not fall back to the older decided epoch below an undecided one", () => {
		const first = entry(1, "b0");
		const second = entry(2, "b1");
		const resolution = resolveAssignment(members, [
			rows("b0", first),
			rows("b1", first, second),
			rows("b2", first),
		]);
		expect(resolution.status).toBe("undecided");
		expect(resolution).toMatchObject({ epoch: 2 });
	});

	it("is undecided when the newest epoch is split", () => {
		const first = entry(1, "b0");
		const resolution = resolveAssignment(members, [
			rows("b0", first, entry(2, "b0", "left")),
			rows("b1", first, entry(2, "b1", "right")),
			rows("b2", first),
		]);
		expect(resolution.status).toBe("undecided");
	});

	it("ignores replies from backends that are not configured", () => {
		const first = entry(1, "b0");
		expect(
			resolveAssignment(members, [
				rows("b0", first),
				rows("stranger", first),
				down("b1"),
				down("b2"),
			]).status,
		).toBe("no-majority");
	});

	it("needs both backends of a fleet of two", () => {
		const first = entry(1, "b0");
		expect(
			resolveAssignment(["b0", "b1"], [rows("b0", first), down("b1")]).status,
		).toBe("no-majority");
	});
});

describe("proposing", () => {
	it("bootstraps the first epoch identically from any instance", async () => {
		const { replicas, register } = fleet(3);
		const [first, second] = await Promise.all([
			bootstrapAssignment(register, "b0"),
			bootstrapAssignment(register, "b0"),
		]);
		expect(first.status).toBe("decided");
		expect(second.status).toBe("decided");
		expect(replicas.map((replica) => replica.rows.length)).toEqual([1, 1, 1]);
		expect(decidedEntries(replicas).get(1)?.active).toBe("b0");
	});

	it("is a compare-and-set on the current epoch", async () => {
		const { register } = fleet(3);
		await bootstrapAssignment(register, "b0");
		const stale = await proposeAssignment(register, {
			expectedEpoch: 0,
			value: writer("b1"),
			decidedBy: "late",
			nowMs: 5,
		});
		expect(stale.status).toBe("stale");
		const next = await proposeAssignment(register, {
			expectedEpoch: 1,
			value: writer("b1"),
			decidedBy: "ok",
			nowMs: 5,
		});
		expect(next).toMatchObject({
			status: "decided",
			holders: ["b1", "b0", "b2"],
		});
	});

	it("writes to the named writer first and nowhere else if it refuses", async () => {
		const { replicas, register } = fleet(3);
		await bootstrapAssignment(register, "b0");
		const promoted = replicas[1];
		if (promoted === undefined) throw new Error("fleet too small");
		promoted.up = false;
		const outcome = await proposeAssignment(register, {
			expectedEpoch: 1,
			value: writer("b1"),
			decidedBy: "failover",
			nowMs: 5,
		});
		expect(outcome).toMatchObject({ status: "refused", replica: "b1" });
		expect(replicas.map((replica) => replica.rows.length)).toEqual([1, 1, 1]);
	});

	it("refuses a writer that is not a member", async () => {
		const { register } = fleet(3);
		expect(await bootstrapAssignment(register, "elsewhere")).toMatchObject({
			status: "refused",
			outcome: "not-a-member",
		});
	});

	it("repairs a backend that was down before writing the next epoch", async () => {
		const { replicas, register } = fleet(3);
		const lagging = replicas[2];
		if (lagging === undefined) throw new Error("fleet too small");
		lagging.up = false;
		await bootstrapAssignment(register, "b0");
		await proposeAssignment(register, {
			expectedEpoch: 1,
			value: writer("b1"),
			decidedBy: "second",
			nowMs: 5,
		});
		lagging.up = true;
		const third = await proposeAssignment(register, {
			expectedEpoch: 2,
			value: writer("b0"),
			decidedBy: "third",
			nowMs: 6,
		});
		expect(third).toMatchObject({ status: "decided" });
		expect(lagging.rows.map((row) => row.epoch)).toEqual([1, 2, 3]);
	});

	it("does not decide on older information while the newest epoch is undecided", async () => {
		const { replicas, register } = fleet(3);
		await bootstrapAssignment(register, "b0");
		replicas[0]?.apply(entry(2, "b0", "interrupted"));
		const outcome = await proposeAssignment(register, {
			expectedEpoch: 1,
			value: writer("b1"),
			decidedBy: "impatient",
			nowMs: 5,
		});
		expect(outcome.status).toBe("unavailable");
		expect(replicas.map((replica) => replica.rows.length)).toEqual([2, 1, 1]);
	});
});

describe("completing and overriding", () => {
	it("completes the same entry an interrupted proposer left behind", async () => {
		const { replicas, register } = fleet(3);
		await bootstrapAssignment(register, "b0");
		const interrupted = entry(2, "b0", "interrupted");
		replicas[0]?.apply(interrupted);
		expect((await readCurrentAssignment(register)).status).toBe("undecided");
		const resolution = await completeAssignment(register);
		expect(resolution).toMatchObject({
			status: "current",
			assignment: interrupted,
		});
	});

	it("settles a contested epoch when a free backend remains", async () => {
		const { replicas, register } = fleet(3);
		await bootstrapAssignment(register, "b0");
		replicas[0]?.apply(entry(2, "b0", "left"));
		replicas[1]?.apply(entry(2, "b1", "right"));
		const resolution = await completeAssignment(register);
		expect(resolution.status).toBe("current");
		expect(decidedEntries(replicas).size).toBe(2);
	});

	it("leaves a fully split epoch undecided until an operator overrides it", async () => {
		const { replicas, register } = fleet(3);
		await bootstrapAssignment(register, "b0");
		replicas[0]?.apply(entry(2, "b0", "one"));
		replicas[1]?.apply(entry(2, "b1", "two"));
		replicas[2]?.apply(entry(2, "b2", "three"));
		expect((await completeAssignment(register)).status).toBe("undecided");
		const forced = await overrideAssignment(register, {
			value: { ...writer("b1"), reason: "operator-override" },
			decidedBy: "operator",
			nowMs: 9,
		});
		expect(forced).toMatchObject({ status: "decided" });
		const resolution = await readCurrentAssignment(register);
		expect(resolution).toMatchObject({
			status: "current",
			assignment: { epoch: 3, active: "b1" },
		});
		expect(decidedEntries(replicas).has(2)).toBe(false);
	});

	it("overrides nothing without a majority", async () => {
		const { replicas, register } = fleet(3);
		await bootstrapAssignment(register, "b0");
		for (const replica of replicas.slice(1)) replica.up = false;
		const forced = await overrideAssignment(register, {
			value: writer("b0"),
			decidedBy: "operator",
			nowMs: 9,
		});
		expect(forced.status).toBe("unavailable");
	});
});

/**
 * One seeded run. Returns what happened so the suite can also assert that the
 * runs were not trivially idle.
 */
async function explore(seed: number) {
	const scheduler = new Scheduler(seed);
	const size = 2 + scheduler.pick(4);
	let live = true;
	const replicas = Array.from(
		{ length: size },
		(_, index) =>
			new MemoryReplica(`b${index}`, () =>
				live ? scheduler.pause() : Promise.resolve(),
			),
	);
	const register = parseAssignmentRegister(replicas);
	const staleAuthors = new Set<string>();
	const everDecided = new Map<number, string>();
	let highest = 0;
	let outages = 0;
	let staleAttempts = 0;

	const randomWriter = (): FleetAssignmentValue =>
		writer(`b${scheduler.pick(size)}`);

	const check = () => {
		// Throws when two different entries are decided for one epoch.
		const decided = decidedEntries(replicas);
		for (const [epoch, assignment] of decided) {
			const key = assignmentKey(assignment);
			const before = everDecided.get(epoch);
			if (before !== undefined && before !== key)
				throw new Error(`seed ${seed}: epoch ${epoch} changed its decision`);
			everDecided.set(epoch, key);
			if (staleAuthors.has(assignment.decidedBy))
				throw new Error(`seed ${seed}: a stale proposal was decided`);
		}
		const now = highestDecided(replicas);
		if (now < highest)
			throw new Error(`seed ${seed}: the decided epoch went backwards`);
		highest = now;
		for (const replica of replicas) {
			const epochs = replica.rows.map((row) => row.epoch);
			if (epochs.some((epoch, index) => epoch !== index + 1))
				throw new Error(`seed ${seed}: ${replica.id} has a gap in its log`);
			for (const row of replica.rows) {
				const named = replicas.find((other) => other.id === row.active);
				if (
					named !== undefined &&
					!named.rows.some((held) => assignmentKey(held) === assignmentKey(row))
				)
					throw new Error(
						`seed ${seed}: ${row.active} is named writer by an entry it does not hold`,
					);
			}
		}
	};

	const step = () => {
		check();
		if (scheduler.random() < 0.02) {
			const victim = replicas[scheduler.pick(size)];
			if (victim !== undefined) {
				victim.up = !victim.up;
				outages += 1;
			}
		}
	};

	const proposer = async (index: number) => {
		for (let round = 0; round < 12; round += 1) {
			const action = scheduler.random();
			if (action < 0.15) {
				await completeAssignment(register);
				continue;
			}
			if (action < 0.19) {
				await overrideAssignment(register, {
					value: randomWriter(),
					decidedBy: `o${index}-${round}`,
					nowMs: 1,
				});
				continue;
			}
			const before = highestDecided(replicas);
			const view = await readCurrentAssignment(register);
			const after = highestDecided(replicas);
			if (view.status === "current") {
				const { epoch } = view.assignment;
				if (epoch < before || epoch > after)
					throw new Error(`seed ${seed}: a reader returned a stale epoch`);
				if (everDecided.get(epoch) !== assignmentKey(view.assignment))
					throw new Error(`seed ${seed}: a reader returned an undecided entry`);
			}
			if (view.status !== "current" && view.status !== "empty") continue;
			const seen = view.status === "current" ? view.assignment.epoch : 0;
			// Sometimes act on a deliberately old view, as a slow caller would.
			const expectedEpoch =
				scheduler.random() < 0.25 ? Math.max(0, seen - 1) : seen;
			const decidedBy = `p${index}-${round}`;
			if (highestDecided(replicas) > expectedEpoch) {
				staleAuthors.add(decidedBy);
				staleAttempts += 1;
			}
			const outcome = await proposeAssignment(register, {
				expectedEpoch,
				value: randomWriter(),
				decidedBy,
				nowMs: 1,
			});
			if (
				outcome.status === "decided" &&
				everDecided.get(outcome.assignment.epoch) !==
					assignmentKey(outcome.assignment)
			)
				throw new Error(
					`seed ${seed}: an undecided entry was reported decided`,
				);
		}
	};

	await scheduler.drive(
		Array.from({ length: 2 + scheduler.pick(3) }, (_, index) =>
			proposer(index),
		),
		step,
	);

	// Quiescence: everything returns, and one completer runs alone.
	live = false;
	for (const replica of replicas) replica.up = true;
	let settled = await completeAssignment(register);
	check();
	let overridden = false;
	if (settled.status === "undecided") {
		overridden = true;
		await overrideAssignment(register, {
			value: writer("b0"),
			decidedBy: "operator",
			nowMs: 2,
		});
		settled = await readCurrentAssignment(register);
		check();
	}
	return {
		settled: settled.status,
		highest,
		outages,
		staleAttempts,
		overridden,
		steps: scheduler.steps,
	};
}

describe("randomized interleavings", () => {
	it("keeps every invariant over 400 seeds of concurrent proposers and outages", async () => {
		let decisions = 0;
		let outages = 0;
		let staleAttempts = 0;
		let overridden = 0;
		let steps = 0;
		for (let seed = 1; seed <= 400; seed += 1) {
			const run = await explore(seed);
			expect(["current", "empty"]).toContain(run.settled);
			decisions += run.highest;
			outages += run.outages;
			staleAttempts += run.staleAttempts;
			overridden += run.overridden ? 1 : 0;
			steps += run.steps;
		}
		// The runs must have exercised what they claim to check.
		expect(decisions).toBeGreaterThan(1000);
		expect(outages).toBeGreaterThan(1500);
		expect(staleAttempts).toBeGreaterThan(300);
		expect(steps).toBeGreaterThan(100_000);
		// A split that needs an operator is possible and must stay rare.
		expect(overridden).toBeLessThan(40);
	}, 120_000);
});
