/**
 * `createOneActiveFleet` (design §6.10 "A tick, for any one-active fleet").
 *
 * With membership epochs off, every tick reports what today's cache fleet
 * reported for the same inputs (`CacheFleetTick` of
 * `packages/ci-vercel/src/cache-fleet.ts`), and nothing writes a member set.
 * With them on, the loop pins the configured set, then admits and removes one
 * name per tick. A fleet left sealed longer than twice `sealWaitMs` logs
 * `hobo_fleet_assignment_sealed_too_long` (F24).
 */
import { create } from "@bufbuild/protobuf";
import { parseEphemeralKey } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	CoordinationMode,
	FleetPolicySchema,
	FleetRecordSchema,
	Health,
	type MemberRecord,
	MemberRecordSchema,
	MemberState,
	type Observation,
	ObservationSchema,
} from "../../src/_generated/fleet_pb.js";
import {
	createOneActiveFleet,
	decodeAssignmentLog,
	ephemeralAssignmentRegister,
	readCurrentAssignment,
} from "../../src/assignment/index.js";
import type { FleetLogEvent } from "../../src/events.js";
import { type MemberName, parseMemberName } from "../../src/ids.js";
import type {
	AssignmentEntry,
	AssignmentRegister,
	FleetRecord,
	OneActiveAction,
	OneActiveDeps,
	RegistryView,
} from "../../src/ports.js";
import { cacheFleet, LOG_KEY } from "./fixtures.js";
import { MemoryReplica } from "./fleet-model.js";

const n = (value: string): MemberName => parseMemberName(value);
const SEAL_WAIT_MS = 150_000;

function fleetRecord(membershipEpochs: boolean, recoveryPointMs?: number) {
	return create(FleetRecordSchema, {
		fleetId: "cache",
		coordination: CoordinationMode.ONE_ACTIVE,
		policy: create(FleetPolicySchema, {
			failoverAfterMs: 60_000,
			recoveryPointMs,
			membershipEpochs,
		}),
	});
}

function memberRecord(name: string, state = MemberState.ACTIVE): MemberRecord {
	return create(MemberRecordSchema, {
		memberId: `bkd_${name.padStart(32, "0")}`,
		state,
		memberships: [{ fleet: "cache", name }],
	});
}

/** The registry rebuilt from configuration: only `membersOf` is used. */
function registry(records: () => readonly MemberRecord[]): RegistryView {
	const unused = () => Promise.reject(new Error("not used by the loop"));
	return {
		member: unused,
		fleet: unused,
		membersOf: async () => records(),
		fleets: unused,
		members: unused,
		view: unused,
		trust: () => {
			throw new Error("not used by the loop");
		},
		trustEnvelope: () => undefined,
		caughtUp: async () => undefined,
	};
}

type Asked = Parameters<OneActiveDeps["chooseAction"]>[0];

/** A world: members, their health, a clock, and what the loop said and asked. */
function world(
	options: Readonly<{
		register: AssignmentRegister;
		names: readonly string[];
		membershipEpochs?: boolean;
		recoveryPointMs?: number;
		choose?: (input: Asked) => OneActiveAction;
	}>,
) {
	const health = new Map<string, Health>(
		options.names.map((name) => [name, Health.REACHABLE]),
	);
	const records = new Map<string, MemberRecord>(
		options.names.map((name) => [name, memberRecord(name)]),
	);
	const asked: Asked[] = [];
	const scheduled: [number, number][] = [];
	const logged: [
		FleetLogEvent,
		Readonly<Record<string, string | number | boolean>>,
	][] = [];
	const state = {
		nowMs: 1_000_000,
		asked,
		scheduled,
		logged,
		failSchedule: false,
		throwing: new Set<string>(),
		health,
		records,
	};
	const keep: OneActiveAction = { action: "keep", reasons: ["within-budget"] };
	const deps: OneActiveDeps = {
		fleet: fleetRecord(
			options.membershipEpochs ?? false,
			options.recoveryPointMs,
		) satisfies FleetRecord,
		registry: registry(() => [...records.values()]),
		register: options.register,
		async observe(member): Promise<Observation> {
			const name = member.memberships[0]?.name ?? "";
			const seen = health.get(name) ?? Health.UNKNOWN;
			if (state.throwing.has(name)) throw new Error("probe failed");
			return create(ObservationSchema, {
				memberId: member.memberId,
				health: seen,
				failingForMs: seen === Health.REACHABLE ? 0 : 120_000,
			});
		},
		async chooseAction(input) {
			state.asked.push(input);
			return (options.choose ?? (() => keep))(input);
		},
		async scheduleActivation(epoch, afterMs) {
			if (state.failSchedule) throw new Error("queue down");
			state.scheduled.push([epoch, afterMs]);
		},
		decidedBy: "service:relay",
		sealWaitMs: SEAL_WAIT_MS,
		viewTtlMs: 60_000,
		refusedTtlMs: 5_000,
		now: () => state.nowMs,
		log: (event, fields) => {
			state.logged.push([event, fields]);
		},
	};
	return { state, deps, fleet: createOneActiveFleet(deps) };
}

async function newest(register: AssignmentRegister): Promise<AssignmentEntry> {
	const resolution = await readCurrentAssignment(register);
	if (resolution.status !== "current")
		throw new Error(`expected current, got ${resolution.status}`);
	return resolution.assignment;
}

const failoverTo = (target: string): OneActiveAction => ({
	action: "failover",
	target: n(target),
	lossWindowMs: undefined,
	reasons: [`writer-failing ${target}`],
});

describe("a fleet of one", () => {
	it("has no register: active is the member and the tick reads nothing", async () => {
		const replica = new MemoryReplica("c0");
		replica.up = false;
		const { fleet } = world({
			register: ephemeralAssignmentRegisterOf([replica]),
			names: ["c0"],
		});
		expect(await fleet.tick()).toEqual({
			action: "single",
			epoch: 0,
			active: "c0",
			target: undefined,
			reasons: ["one-member"],
		});
		expect(await fleet.active()).toEqual({ ok: true, value: "c0" });
	});
});

function ephemeralAssignmentRegisterOf(
	replicas: readonly MemoryReplica[],
): AssignmentRegister {
	return { replicas };
}

describe("ticks with membership epochs off: today's values", () => {
	it("bootstraps an empty register, then keeps", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
		});
		expect(await fleet.tick()).toEqual({
			action: "bootstrap",
			epoch: 1,
			active: "c0",
			target: undefined,
			reasons: ["empty-register"],
		});
		expect(await fleet.tick()).toEqual({
			action: "keep",
			epoch: 1,
			active: "c0",
			target: undefined,
			reasons: ["within-budget"],
			route: { action: "keep", reasons: ["within-budget"] },
		});
		const [asked] = state.asked;
		expect(asked?.members).toEqual(["c0", "c1", "c2"]);
		expect(asked?.observations.map((entry) => entry.name)).toEqual([
			"c0",
			"c1",
			"c2",
		]);
		expect(asked?.eligibility.map((entry) => entry.eligible)).toEqual([
			true,
			true,
			true,
		]);
		expect(state.logged.map(([event]) => event)).toEqual([
			"hobo_fleet_assignment_tick",
			"hobo_fleet_assignment_tick",
		]);
	});

	it("switches by sealing with the writer kept, waits, then activates", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
			choose: () => ({
				action: "switch",
				target: n("c1"),
				lossWindowMs: undefined,
				reasons: ["Projected 120% of allowance!"],
			}),
		});
		await fleet.tick();
		expect(await fleet.active()).toEqual({ ok: true, value: "c0" });
		expect(await fleet.tick()).toEqual({
			action: "switch",
			epoch: 2,
			active: "c0",
			target: "c1",
			reasons: ["Projected 120% of allowance!"],
			route: {
				action: "switch",
				target: "c1",
				lossWindowMs: undefined,
				reasons: ["Projected 120% of allowance!"],
			},
		});
		expect(await newest(cache.register)).toMatchObject({
			sealed: true,
			active: "c0",
			target: "c1",
			reason: "switch:projected-120-of-allowance",
			members: undefined,
		});
		expect(state.scheduled).toEqual([[2, SEAL_WAIT_MS]]);
		// The view was dropped: a sealed fleet refuses.
		expect(await fleet.active()).toMatchObject({
			ok: false,
			error: { code: "unavailable", detail: { reason: "sealed" } },
		});
		state.nowMs += 60_000;
		expect(await fleet.tick()).toEqual({
			action: "sealed-waiting",
			epoch: 2,
			active: "c0",
			target: "c1",
			reasons: ["seal-wait-not-over"],
		});
		expect(state.scheduled.at(-1)).toEqual([2, SEAL_WAIT_MS - 60_000]);
		state.nowMs += SEAL_WAIT_MS;
		await fleet.activate(2);
		expect(await newest(cache.register)).toMatchObject({
			epoch: 3,
			active: "c1",
			sealed: false,
			reason: "activate",
		});
		// A stale activation message does nothing.
		await fleet.activate(2);
		expect((await newest(cache.register)).epoch).toBe(3);
		state.nowMs += 60_000;
		expect(await fleet.active()).toEqual({ ok: true, value: "c1" });
	});

	it("reports the tick that activates", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
			choose: (input) =>
				input.assignment.epoch === 1
					? {
							action: "switch",
							target: n("c2"),
							lossWindowMs: undefined,
							reasons: ["cheaper"],
						}
					: { action: "keep", reasons: ["within-budget"] },
		});
		await fleet.tick();
		await fleet.tick();
		state.nowMs += SEAL_WAIT_MS;
		expect(await fleet.tick()).toEqual({
			action: "activate",
			epoch: 3,
			active: "c2",
			target: "c2",
			reasons: ["proposal-decided"],
		});
	});

	it("fails over with nobody writing, asking as a failover", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
			recoveryPointMs: 30_000,
			choose: () => failoverTo("c2"),
		});
		await fleet.tick();
		state.health.set("c0", Health.QUOTA_EXHAUSTED);
		expect(await fleet.tick()).toMatchObject({
			action: "failover",
			epoch: 2,
			active: undefined,
			target: "c2",
			reasons: ["writer-failing c2"],
		});
		expect(await newest(cache.register)).toMatchObject({
			reason: "failover:quota-exhausted",
			active: undefined,
		});
		// With a recovery point, a standby that reports no lag was never copied.
		expect(state.asked.at(-1)?.eligibility).toEqual([
			{
				name: "c0",
				eligible: false,
				reasons: ["quota-exhausted", "never-copied"],
			},
			{ name: "c1", eligible: false, reasons: ["never-copied"] },
			{ name: "c2", eligible: false, reasons: ["never-copied"] },
		]);
	});

	it("reseals when the target goes away, asked as a failover from it", async () => {
		const cache = cacheFleet(3);
		let answer: OneActiveAction = failoverTo("c1");
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
			choose: () => answer,
		});
		await fleet.tick();
		state.health.set("c0", Health.UNREACHABLE);
		await fleet.tick();
		state.health.set("c1", Health.AUTH);
		answer = { action: "hold", reasons: ["no-eligible-standby"] };
		expect(await fleet.tick()).toEqual({
			action: "sealed-waiting",
			epoch: 2,
			active: undefined,
			target: "c1",
			reasons: ["target-auth", "no-eligible-standby"],
			route: answer,
		});
		const asked = state.asked.at(-1);
		expect(asked?.assignment).toMatchObject({
			active: "c1",
			sealed: false,
			target: undefined,
		});
		expect(
			asked?.observations.find((entry) => entry.name === "c1")?.observation
				.failingForMs,
		).toBe(4_294_967_295);
		answer = failoverTo("c2");
		expect(await fleet.tick()).toEqual({
			action: "reseal",
			epoch: 3,
			active: undefined,
			target: "c2",
			reasons: ["target-auth"],
			route: answer,
		});
	});

	it("stops without a majority, and refuses meanwhile", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
		});
		await fleet.tick();
		cache.backend("c1").down = true;
		cache.backend("c2").down = true;
		expect(await fleet.tick()).toEqual({
			action: "no-majority",
			epoch: 0,
			active: undefined,
			target: undefined,
			reasons: ["no-majority"],
		});
		expect(await fleet.active()).toMatchObject({
			ok: false,
			error: { code: "no-majority" },
		});
		// A refusal is reused for refusedTtlMs, then read again.
		cache.backend("c1").down = false;
		expect(await fleet.active()).toMatchObject({ ok: false });
		state.nowMs += 5_000;
		expect(await fleet.active()).toEqual({ ok: true, value: "c0" });
	});

	it("bootstraps on the first read, completes an undecided epoch, and reuses an answer", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
		});
		expect(await fleet.active()).toEqual({ ok: true, value: "c0" });
		const [c0] = cache.replicas;
		const top = await newest(cache.register);
		await c0?.accept({ ...top, epoch: 2, reason: "interrupted" });
		// Reused within viewTtlMs: no read.
		cache.backend("c0").down = true;
		expect(await fleet.active()).toEqual({ ok: true, value: "c0" });
		cache.backend("c0").down = false;
		state.nowMs += 60_000;
		expect(await fleet.active()).toEqual({ ok: true, value: "c0" });
		expect((await newest(cache.register)).reason).toBe("interrupted");
	});

	it("re-admits a lost log, refreshes lifetimes, and writes no member set", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
		});
		await fleet.tick();
		await fleet.tick();
		cache.backend("c2").wipe();
		state.failSchedule = true;
		state.health.set("c1", Health.UNREACHABLE);
		state.throwing.add("c2");
		state.records.delete("c1");
		const tick = await fleet.tick();
		expect(tick.action).toBe("keep");
		const asked = state.asked.at(-1);
		expect(
			asked?.observations.map((entry) => entry.observation.health),
		).toEqual([Health.REACHABLE, Health.UNKNOWN, Health.UNKNOWN]);
		expect(await cache.replicas[2]?.read()).toHaveLength(1);
		for (const backend of cache.backends) {
			const stored = await backend.state.get(parseEphemeralKey(LOG_KEY));
			expect(stored?.value).toContain('"format":1');
			for (const entry of decodeAssignmentLog(stored?.value ?? ""))
				expect(entry.members).toBeUndefined();
		}
	});
});

describe("a fleet sealed too long (F24)", () => {
	it("logs hobo_fleet_assignment_sealed_too_long past twice sealWaitMs", async () => {
		const cache = cacheFleet(3);
		let answer: OneActiveAction = failoverTo("c1");
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
			choose: () => answer,
		});
		await fleet.tick();
		state.health.set("c0", Health.UNREACHABLE);
		state.failSchedule = true;
		await fleet.tick();
		expect(
			state.logged.filter(([event]) => event !== "hobo_fleet_assignment_tick"),
		).toEqual([]);
		state.health.set("c1", Health.UNREACHABLE);
		answer = { action: "hold", reasons: ["no-eligible-standby"] };
		state.nowMs += 2 * SEAL_WAIT_MS;
		await fleet.tick();
		expect(
			state.logged.some(
				([event]) => event === "hobo_fleet_assignment_sealed_too_long",
			),
		).toBe(false);
		state.nowMs += 1;
		await fleet.tick();
		expect(
			state.logged.filter(
				([event]) => event === "hobo_fleet_assignment_sealed_too_long",
			),
		).toEqual([
			[
				"hobo_fleet_assignment_sealed_too_long",
				{
					fleet: "cache",
					epoch: 2,
					target: "c1",
					sealedForMs: 2 * SEAL_WAIT_MS + 1,
				},
			],
		]);
	});
});

describe("ticks with membership epochs on", () => {
	it("pins the configured set, admits a new candidate and removes a gone one", async () => {
		const cache = cacheFleet(4);
		const three = ephemeralAssignmentRegister(cache.replicas.slice(0, 3));
		const before = world({
			register: three,
			names: ["c0", "c1", "c2"],
			membershipEpochs: true,
		});
		await before.fleet.tick();
		expect(await before.fleet.tick()).toEqual({
			action: "membership",
			epoch: 2,
			active: "c0",
			target: undefined,
			reasons: ["pin-members", "proposal-decided"],
		});
		expect((await newest(three)).members).toEqual(["c0", "c1", "c2"]);
		expect(await before.fleet.tick()).toMatchObject({ action: "keep" });

		// A new deploy configures c3.
		const after = world({
			register: cache.register,
			names: ["c0", "c1", "c2", "c3"],
			membershipEpochs: true,
		});
		expect(await after.fleet.tick()).toEqual({
			action: "membership",
			epoch: 3,
			active: "c0",
			target: undefined,
			reasons: ["admit:c3", "proposal-decided"],
		});
		expect(await newest(cache.register)).toMatchObject({
			reason: "admit:c3",
			members: ["c0", "c1", "c2", "c3"],
		});
		// c2 is no longer a candidate.
		after.state.records.set("c2", memberRecord("c2", MemberState.SUSPENDED));
		expect(await after.fleet.tick()).toMatchObject({
			action: "membership",
			epoch: 4,
			reasons: ["remove:c2", "proposal-decided"],
		});
		expect(await after.fleet.tick()).toMatchObject({ action: "keep" });
		// The active member is never removed.
		after.state.records.set("c0", memberRecord("c0", MemberState.SUSPENDED));
		expect(await after.fleet.tick()).toMatchObject({ action: "keep" });
	});

	it("changes no member set while sealed", async () => {
		const cache = cacheFleet(3);
		const { fleet, state } = world({
			register: cache.register,
			names: ["c0", "c1", "c2"],
			membershipEpochs: true,
			choose: () => ({
				action: "switch",
				target: n("c1"),
				lossWindowMs: undefined,
				reasons: ["cheaper"],
			}),
		});
		await fleet.tick();
		await fleet.tick();
		expect(await fleet.tick()).toMatchObject({ action: "switch", epoch: 3 });
		state.records.set("c2", memberRecord("c2", MemberState.SUSPENDED));
		expect(await fleet.tick()).toMatchObject({ action: "sealed-waiting" });
	});
});
