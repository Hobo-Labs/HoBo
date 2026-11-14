/**
 * The agent's refusal, end to end (L43; amendment 4, D60; ADR-0181 R4): an
 * agent publishes why it admits no new work, and the fleet verdict built from
 * those observations tells `BUSY` (full only with its own work) from
 * `NO_CAPACITY` (refusing for pressure, storage or draining).
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	agentIn,
	createWorld,
	FLEET,
	heldRunner,
	queueSource,
	slots,
	TENANT,
	type World,
} from "../../examples/world.js";
import {
	CapacitySchema,
	DeviceClass,
	EnrollmentRequestSchema,
	Health,
	type MemberRecord,
	type Observation,
	ObservationSchema,
	Refusal,
	Role,
	VerdictState,
} from "../../src/_generated/fleet_pb.js";
import { countOwnWork } from "../../src/agent/capacity.js";
import { fleetVerdict, fleetView } from "../../src/observation/index.js";
import type { CapacitySource, KeyStore } from "../../src/ports.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const now = () => Date.now();

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
	vi.useRealTimers();
});

async function enrolled(
	world: World,
	name: string,
	roles: readonly Role[],
	options: Parameters<typeof agentIn>[1],
) {
	const built = agentIn(world, options);
	const outcome = await built.agent.enroll(
		create(EnrollmentRequestSchema, {
			tenant: TENANT,
			fleet: FLEET,
			name,
			displayName: name,
			platform: { os: "linux", arch: "x64" },
			region: "eu-west",
			deviceClass: DeviceClass.DEDICATED,
			requestedRoles: [...roles],
			proof: {
				case: "bootstrapToken",
				value: await world.token(name, roles, FLEET),
			},
		}),
	);
	if (!outcome.ok) throw new Error(`enroll: ${outcome.error.message}`);
	await built.agent.start();
	return built;
}

async function until(done: () => boolean, limitMs = 180_000): Promise<void> {
	for (let waited = 0; !done(); waited += 1_000) {
		if (waited >= limitMs) throw new Error("timed out waiting");
		console.log("waited", waited, performance.now());
		if (waited >= 10_000) {
			for (let step = 0; step < 400; step++) {
				await vi.advanceTimersByTimeAsync(5);
				if (step % 1 === 0)
					console.log("step", step, vi.getTimerCount(), performance.now());
			}
		}
		await vi.advanceTimersByTimeAsync(1_000);
	}
}

/** A host that measures as given; `hostSignals` rides beside the port's fields as `@hobo/fleet-agent` sends it. */
function host(
	capacity: Readonly<{
		freeSlots: number;
		totalSlots: number;
		freeMemoryMb?: number;
		freeDiskMb?: number;
	}>,
	health: Health,
	hostSignals: Readonly<{
		freeInodes?: number;
		psiMemorySome?: number;
		psiMemoryFull?: number;
	}> = {},
): CapacitySource {
	return {
		async read() {
			const reading = {
				capacity: create(CapacitySchema, capacity),
				health,
				labels: [],
				hostSignals,
			};
			return reading;
		},
	};
}

async function latestOf(world: World, keys: KeyStore): Promise<Observation> {
	const self = (await keys.open()).memberId;
	const own = (await world.bus.observations.read(1_000)).observations
		.filter((keyed) => keyed.memberId === self)
		.at(-1);
	if (own === undefined) throw new Error("no observation");
	return fromBinary(ObservationSchema, own.envelope.payload);
}

/** The verdict a view of exactly these members gives, from their latest observations. */
async function verdictOf(world: World, keys: readonly KeyStore[]) {
	const fleet = await world.bus.registry.fleet(FLEET);
	if (fleet === undefined) throw new Error("no fleet");
	const members: MemberRecord[] = [];
	const observations: Observation[] = [];
	for (const key of keys) {
		const record = await world.bus.registry.member((await key.open()).memberId);
		if (record === undefined) throw new Error("no member");
		members.push(record);
		observations.push(await latestOf(world, key));
	}
	return fleetVerdict(
		fleetView(fleet, members, observations, new Map(), now()),
		"",
		now(),
	);
}

/** An executor with one slot, busy with an order of its own that it holds. */
async function busyWithItsOwnWork(world: World) {
	const work = queueSource(now);
	const run = heldRunner();
	const dispatcher = await enrolled(world, "dispatch", [Role.DISPATCHER], {
		now,
		sources: [work.source],
		capacity: slots(0),
	});
	const executor = await enrolled(world, "busy", [Role.EXECUTOR], {
		now,
		runners: [run.runner],
		capacity: slots(1),
	});
	run.hold();
	work.add("job-1");
	await until(() => run.ran.length === 1);
	await vi.advanceTimersByTimeAsync(10_000);
	return { dispatcher, executor, run };
}

describe("the agent's refusal", () => {
	it("is NONE while a slot is free", async () => {
		const world = await createWorld(now);
		const box = await enrolled(world, "idle", [Role.EXECUTOR], {
			now,
			capacity: slots(2),
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await latestOf(world, box.keys)).toMatchObject({
			health: Health.REACHABLE,
			refusal: Refusal.NONE,
			capacity: { freeSlots: 2 },
		});
		expect((await verdictOf(world, [box.keys])).state).toBe(VerdictState.OPEN);
		await box.agent.stop();
	});

	it("is OWN_WORK when every slot runs its own order, and the fleet is BUSY", async () => {
		const world = await createWorld(now);
		const { dispatcher, executor, run } = await busyWithItsOwnWork(world);
		expect(await latestOf(world, executor.keys)).toMatchObject({
			health: Health.REACHABLE,
			refusal: Refusal.OWN_WORK,
			capacity: { freeSlots: 0, totalSlots: 1 },
		});
		expect(await verdictOf(world, [executor.keys])).toMatchObject({
			state: VerdictState.BUSY,
			members: 1,
			freeSlots: 0,
		});
		run.release();
		await vi.advanceTimersByTimeAsync(20_000);
		expect((await latestOf(world, executor.keys)).refusal).toBe(Refusal.NONE);
		await dispatcher.agent.stop();
		await executor.agent.stop();
	});

	it("is PRESSURE under memory pressure with no free slot, and the fleet has NO_CAPACITY", async () => {
		const world = await createWorld(now);
		const box = await enrolled(world, "pressed", [Role.EXECUTOR], {
			now,
			capacity: host(
				{ freeSlots: 0, totalSlots: 1, freeMemoryMb: 0, freeDiskMb: 50_000 },
				Health.PRESSURED,
			),
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await latestOf(world, box.keys)).toMatchObject({
			health: Health.PRESSURED,
			refusal: Refusal.PRESSURE,
		});
		expect(await verdictOf(world, [box.keys])).toMatchObject({
			state: VerdictState.NO_CAPACITY,
			members: 1,
			freeSlots: 0,
		});
		await box.agent.stop();
	});

	it("is BUSY for a fleet of one member full with its own work and one under pressure", async () => {
		const world = await createWorld(now);
		const pressed = await enrolled(world, "pressed", [Role.EXECUTOR], {
			now,
			capacity: host(
				{ freeSlots: 0, totalSlots: 1, freeMemoryMb: 0 },
				Health.PRESSURED,
			),
		});
		const { dispatcher, executor, run } = await busyWithItsOwnWork(world);
		expect((await latestOf(world, pressed.keys)).refusal).toBe(
			Refusal.PRESSURE,
		);
		expect((await latestOf(world, executor.keys)).refusal).toBe(
			Refusal.OWN_WORK,
		);
		expect(await verdictOf(world, [executor.keys, pressed.keys])).toMatchObject(
			{ state: VerdictState.BUSY, members: 2, freeSlots: 0 },
		);
		run.release();
		await pressed.agent.stop();
		await dispatcher.agent.stop();
		await executor.agent.stop();
	});

	it("is PRESSURE when memory PSI is over its limit, and the executor claims nothing meanwhile", async () => {
		const world = await createWorld(now);
		const work = queueSource(now);
		const run = heldRunner();
		const dispatcher = await enrolled(world, "dispatch", [Role.DISPATCHER], {
			now,
			sources: [work.source],
			capacity: slots(0),
		});
		const box = await enrolled(world, "psi", [Role.EXECUTOR], {
			now,
			runners: [run.runner],
			capacity: host(
				{ freeSlots: 2, totalSlots: 2, freeMemoryMb: 6_000 },
				Health.REACHABLE,
				{ psiMemorySome: 40, psiMemoryFull: 9 },
			),
		});
		work.add("job-1");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(run.ran).toEqual([]);
		expect(await latestOf(world, box.keys)).toMatchObject({
			health: Health.PRESSURED,
			refusal: Refusal.PRESSURE,
		});
		expect((await verdictOf(world, [box.keys])).state).toBe(
			VerdictState.NO_CAPACITY,
		);
		await dispatcher.agent.stop();
		await box.agent.stop();
	});

	it("is STORAGE when the work volume is short of inodes", async () => {
		const world = await createWorld(now);
		const box = await enrolled(world, "full-disk", [Role.EXECUTOR], {
			now,
			capacity: host(
				{ freeSlots: 1, totalSlots: 1, freeDiskMb: 50_000 },
				Health.REACHABLE,
				{ freeInodes: 100 },
			),
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await latestOf(world, box.keys)).toMatchObject({
			health: Health.PRESSURED,
			refusal: Refusal.STORAGE,
		});
		expect((await verdictOf(world, [box.keys])).state).toBe(
			VerdictState.NO_CAPACITY,
		);
		await box.agent.stop();
	});

	it("is DRAINING once it drains", async () => {
		const world = await createWorld(now);
		const box = await enrolled(world, "leaving", [Role.EXECUTOR], {
			now,
			capacity: slots(2),
		});
		await vi.advanceTimersByTimeAsync(10_000);
		await box.agent.drain();
		expect(await latestOf(world, box.keys)).toMatchObject({
			health: Health.DRAINING,
			refusal: Refusal.DRAINING,
		});
		expect((await verdictOf(world, [box.keys])).state).toBe(
			VerdictState.NO_CAPACITY,
		);
		await box.agent.stop();
	});
});

describe("countOwnWork", () => {
	it("counts each open egress proxy as one running order, once however often it is closed", async () => {
		const closed: string[] = [];
		const counted = countOwnWork({
			async open(allow) {
				return {
					url: `http://egress.invalid/${allow.join(",")}`,
					async close() {
						closed.push(allow.join(","));
					},
				};
			},
		});
		const first = await counted.egress.open(["a"]);
		const second = await counted.egress.open(["b"]);
		expect(first.url).toBe("http://egress.invalid/a");
		expect(counted.running()).toBe(2);
		await first.close();
		await first.close();
		expect(counted.running()).toBe(1);
		await second.close();
		expect(counted.running()).toBe(0);
		expect(closed).toEqual(["a", "a", "b"]);
	});
});
