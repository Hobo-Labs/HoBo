import { describe, expect, it } from "vitest";
import {
	boxLeaseIdsOf,
	evaluateFleetVerdict,
	FLEET_VERDICT_POOL_FRESH_MS,
	type FleetVerdictEvaluatorInput,
	fleetRunnerNamePrefix,
} from "../src/isolated-worker/fleet-verdict-evaluator.js";
import {
	type HostResourcePressureSample,
	hostMemoryAdmitFits,
} from "../src/isolated-worker/host-resource-pressure.js";

/**
 * The pure rule of ADR-0180 (amendment, item 1): a fleet label is blocked only
 * while the box is idle and admission would still refuse a job, and nothing
 * else in the fleet can take it.
 */
const NOW = Date.parse("2026-11-12T11:14:00.000Z");
const OWN_LEASE = "0b6f2a2e-7c1d-4b8e-9a51-2f6c1d9e8a10";
const PEER_LEASE = "5d3c1b2a-9e8f-4a7b-8c6d-1e2f3a4b5c6d";

/** An idle box that admission refuses for memory, a fresh poll, nothing else. */
function input(
	overrides: Partial<FleetVerdictEvaluatorInput> = {},
): FleetVerdictEvaluatorInput {
	return {
		nowMs: NOW,
		labels: ["hobo", "hobo-trunk"],
		idle: true,
		host: {
			availableMb: 1_000,
			pressure: { atMs: NOW },
			health: { state: "ok", reasons: [] },
		},
		admission: {
			standardClassMb: 6_144,
			reserveMb: 2_048,
			volatilityMb: 1_024,
		},
		pools: [],
		minFreeRunners: 1,
		poll: { completedAtMs: NOW - 5_000, inProgress: [] },
		mesh: undefined,
		ownLeaseIds: new Set(),
		pickups: [],
		...overrides,
	};
}

const blocked = (overrides: Partial<FleetVerdictEvaluatorInput> = {}) => [
	...evaluateFleetVerdict(input(overrides)).blocked.keys(),
];

describe("the fleet verdict evaluator", () => {
	it("blocks every served label while an idle box is refused and nothing else can take a job", () => {
		const evaluation = evaluateFleetVerdict(input());
		expect(evaluation.refused).toBe(true);
		expect([...evaluation.blocked]).toEqual([
			["hobo", "no-capacity"],
			["hobo-trunk", "no-capacity"],
		]);
		expect(evaluation.labels.get("hobo")?.reasons).toEqual(["memory"]);
	});

	it("a box that is not idle is never blocked", () => {
		const evaluation = evaluateFleetVerdict(input({ idle: false }));
		expect(evaluation.blocked.size).toBe(0);
		expect(evaluation.labels.get("hobo")?.reasons).toEqual(["not-idle"]);
	});

	it("does not block a box admission would admit", () => {
		expect(blocked({ host: { ...input().host, availableMb: 64_000 } })).toEqual(
			[],
		);
	});

	it("blocks on pressure stall and on swap, as admission does", () => {
		const host = { ...input().host, availableMb: 64_000 };
		expect(
			blocked({
				host: {
					...host,
					pressure: { atMs: NOW, memoryPsi: { someAvg10: 40, fullAvg10: 30 } },
				},
			}),
		).toEqual(["hobo", "hobo-trunk"]);
		expect(
			blocked({
				host: {
					...host,
					pressure: { atMs: NOW, swapUsedMb: 900, swapTotalMb: 1_000 },
				},
			}),
		).toEqual(["hobo", "hobo-trunk"]);
	});

	it("blocks on a critical disk or inode verdict, never on a critical load verdict", () => {
		const host = { ...input().host, availableMb: 64_000 };
		for (const reason of ["storage-bytes", "storage-inodes"] as const) {
			const evaluation = evaluateFleetVerdict(
				input({
					host: { ...host, health: { state: "critical", reasons: [reason] } },
				}),
			);
			expect(evaluation.blocked.size, reason).toBe(2);
			expect(evaluation.labels.get("hobo")?.reasons).toEqual([reason]);
		}
		// The load average stays high for minutes after CI's own jobs end (R4).
		expect(
			blocked({
				host: { ...host, health: { state: "critical", reasons: ["load"] } },
			}),
		).toEqual([]);
		expect(
			blocked({
				host: {
					...host,
					health: { state: "pressured", reasons: ["storage-bytes"] },
				},
			}),
		).toEqual([]);
	});

	it("keeps a label open while a live mesh peer serving it has a free slot", () => {
		expect(blocked({ mesh: [{ labels: ["hobo"], freeSlots: 1 }] })).toEqual([
			"hobo-trunk",
		]);
		expect(blocked({ mesh: [{ labels: ["hobo"], freeSlots: 0 }] })).toEqual([
			"hobo",
			"hobo-trunk",
		]);
	});

	it("keeps a label open while a declared pool has the minimum free runners", () => {
		const pools = [
			{ labels: ["hobo"], runnerNamePrefix: "hobo-runner-", maxRunners: 2 },
		];
		const busy = (names: readonly string[]) =>
			names.map((runnerName) => ({
				label: "hobo",
				runnerName,
				startedAtMs: NOW - 120_000,
			}));
		// Two free: open.
		expect(blocked({ pools })).toEqual(["hobo-trunk"]);
		// One busy, minimum 2: below it, blocked.
		expect(
			blocked({
				pools,
				minFreeRunners: 2,
				poll: { completedAtMs: NOW, inProgress: busy(["hobo-runner-a"]) },
				pickups: busy(["hobo-runner-a"]),
			}),
		).toEqual(["hobo", "hobo-trunk"]);
		// Both busy (and one more than declared): never below zero, blocked.
		expect(
			blocked({
				pools,
				poll: {
					completedAtMs: NOW,
					inProgress: busy(["hobo-runner-a", "hobo-runner-b", "hobo-runner-c"]),
				},
			}),
		).toEqual(["hobo", "hobo-trunk"]);
		// A job on another label does not use this pool's runners.
		expect(
			blocked({
				pools,
				minFreeRunners: 2,
				poll: {
					completedAtMs: NOW,
					inProgress: [
						{
							label: "hobo-trunk",
							runnerName: "hobo-runner-a",
							startedAtMs: NOW,
						},
					],
				},
			}),
		).toEqual(["hobo-trunk"]);
	});

	it("a pool count older than 60 s is unknown", () => {
		const pools = [
			{ labels: ["hobo"], runnerNamePrefix: "hobo-runner-", maxRunners: 1 },
		];
		const full = [
			{ label: "hobo", runnerName: "hobo-runner-a", startedAtMs: NOW - 60_000 },
		];
		expect(
			blocked({
				pools,
				poll: { completedAtMs: NOW - 1_000, inProgress: full },
			}),
		).toEqual(["hobo", "hobo-trunk"]);
		const stale = evaluateFleetVerdict(
			input({
				pools,
				poll: {
					completedAtMs: NOW - FLEET_VERDICT_POOL_FRESH_MS - 1,
					inProgress: full,
				},
			}),
		);
		expect([...stale.blocked.keys()]).toEqual([]);
		expect(stale.labels.get("hobo")?.reasons).toContain("poll-stale");
		// No poll at all is no fresher.
		expect(blocked({ poll: undefined })).toEqual([]);
	});

	it("an unaccounted runner keeps the label open", () => {
		const evaluation = evaluateFleetVerdict(
			input({
				pickups: [
					{
						label: "hobo",
						runnerName: "hobo-runner-set-x7k2p-runner-9q4z",
						startedAtMs: NOW - 14 * 60_000,
					},
				],
			}),
		);
		expect([...evaluation.blocked.keys()]).toEqual(["hobo-trunk"]);
		expect(evaluation.labels.get("hobo")?.reasons).toContain(
			"unaccounted-runner",
		);
		expect(evaluation.unaccounted).toEqual([
			"hobo-runner-set-x7k2p-runner-9q4z",
		]);
		// Older than 15 minutes no longer counts.
		expect(
			blocked({
				pickups: [
					{
						label: "hobo",
						runnerName: "hobo-runner-set-x7k2p-runner-9q4z",
						startedAtMs: NOW - 15 * 60_000 - 1,
					},
				],
			}),
		).toEqual(["hobo", "hobo-trunk"]);
	});

	it("counts this box's own runners, a declared pool's and a mesh peer's as accounted", () => {
		const pools = [
			{ labels: ["hobo"], runnerNamePrefix: "hobo-runner-", maxRunners: 1 },
		];
		const pickups = [
			{
				label: "hobo",
				runnerName: `hobo-${OWN_LEASE}`,
				startedAtMs: NOW - 60_000,
			},
			{ label: "hobo", runnerName: "hobo-runner-a", startedAtMs: NOW - 60_000 },
			{
				label: "hobo",
				runnerName: `hobo-${PEER_LEASE}`,
				startedAtMs: NOW - 60_000,
			},
		];
		const evaluation = evaluateFleetVerdict(
			input({
				pools,
				ownLeaseIds: new Set([OWN_LEASE]),
				mesh: [{ labels: ["hobo"], freeSlots: 0 }],
				poll: {
					completedAtMs: NOW,
					inProgress: [
						{
							label: "hobo",
							runnerName: "hobo-runner-a",
							startedAtMs: NOW - 60_000,
						},
					],
				},
				pickups,
			}),
		);
		expect(evaluation.unaccounted).toEqual([]);
		expect([...evaluation.blocked.keys()]).toEqual(["hobo", "hobo-trunk"]);
	});

	it("a peer box without a mesh is unaccounted", () => {
		const evaluation = evaluateFleetVerdict(
			input({
				ownLeaseIds: new Set([OWN_LEASE]),
				pickups: [
					{
						label: "hobo-trunk",
						runnerName: `hobo-${PEER_LEASE}`,
						startedAtMs: NOW - 60_000,
					},
				],
			}),
		);
		expect([...evaluation.blocked.keys()]).toEqual(["hobo"]);
		expect(evaluation.unaccounted).toEqual([`hobo-${PEER_LEASE}`]);
	});

	it("names the lease ids of box runners, for the caller to look up as its own", () => {
		expect(
			boxLeaseIdsOf([
				{ label: "hobo", runnerName: `hobo-${OWN_LEASE}`, startedAtMs: NOW },
				{
					label: "hobo-trunk",
					runnerName: `hobo-${OWN_LEASE}`,
					startedAtMs: NOW,
				},
				{ label: "hobo", runnerName: "hobo-runner-a", startedAtMs: NOW },
			]),
		).toEqual([OWN_LEASE]);
	});

	it("names a runner by the prefix its siblings share", () => {
		expect(fleetRunnerNamePrefix("hobo-runner-set-x7k2p-runner-9q4z")).toBe(
			"hobo-runner-set-x7k2p-runner-",
		);
		expect(fleetRunnerNamePrefix("builder")).toBe("builder");
	});

	it("never reports no-node", () => {
		for (const reason of evaluateFleetVerdict(input()).blocked.values())
			expect(reason).toBe("no-capacity");
	});
});

describe("the evaluator's answer for a lone idle box", () => {
	// A small deterministic generator, so a failure names its seed.
	function* samples(seed: number, count: number) {
		let state = seed;
		const next = () => {
			state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
			return state / 2 ** 31;
		};
		for (let index = 0; index < count; index++) {
			const healthReasons = (
				["load", "memory", "storage-bytes", "storage-inodes"] as const
			).filter(() => next() < 0.3);
			const level =
				next() < 0.34 ? "ok" : next() < 0.5 ? "pressured" : "critical";
			let pressure: HostResourcePressureSample = { atMs: NOW };
			if (next() < 0.5)
				pressure = {
					...pressure,
					memoryPsi: { someAvg10: next() * 60, fullAvg10: next() * 30 },
				};
			if (next() < 0.5)
				pressure = {
					...pressure,
					cpuPsi: { someAvg10: next() * 80, fullAvg10: next() * 60 },
				};
			if (next() < 0.5)
				pressure = {
					...pressure,
					swapTotalMb: Math.floor(next() * 4_000),
					swapUsedMb: Math.floor(next() * 4_000),
				};
			pressure = { ...pressure, loadPerCpu: next() * 6 };
			yield {
				availableMb: next() < 0.1 ? undefined : Math.floor(next() * 20_000),
				pressure,
				health: { state: level, reasons: healthReasons } as const,
			};
		}
	}

	it("equals 'either check in 6.1 fails' for an idle box with no pools, no mesh and no foreign pickups", () => {
		const admission = {
			standardClassMb: 6_144,
			reserveMb: 2_048,
			volatilityMb: 1_024,
		};
		let checked = 0;
		for (const host of samples(20261112, 2_000)) {
			const memoryRefuses = !hostMemoryAdmitFits(
				host.availableMb,
				admission.standardClassMb,
				admission.reserveMb,
				admission.volatilityMb,
				host.pressure,
				undefined,
				0,
			);
			const diskRefuses =
				host.health.state === "critical" &&
				host.health.reasons.some((reason) => reason.startsWith("storage-"));
			const evaluation = evaluateFleetVerdict(
				input({ host, admission, pools: [], mesh: undefined, pickups: [] }),
			);
			expect(evaluation.refused, JSON.stringify(host)).toBe(
				memoryRefuses || diskRefuses,
			);
			expect(evaluation.blocked.size === 2).toBe(memoryRefuses || diskRefuses);
			checked++;
		}
		expect(checked).toBe(2_000);
	});
});

// ADR-0181, decision 5 and M6: a busy, healthy box is never refused (R4); critical
// storage refuses whether or not the box is busy; pools are counted from
// GitHub's runner list, and a list that cannot be read is unknown.
describe("the evaluator behind the routing slip", () => {
	const disk = {
		availableMb: 64_000,
		pressure: { atMs: NOW },
		health: { state: "critical" as const, reasons: ["storage-bytes" as const] },
	};

	it("a busy box short of memory is busy, not refused", () => {
		const evaluation = evaluateFleetVerdict(input({ idle: false }));
		expect(evaluation.blocked.size).toBe(0);
		expect(evaluation.labels.get("hobo")?.reasons).toEqual(["not-idle"]);
	});

	it("a busy box with a critical disk is refused", () => {
		const evaluation = evaluateFleetVerdict(input({ idle: false, host: disk }));
		expect([...evaluation.blocked.keys()]).toEqual(["hobo", "hobo-trunk"]);
		expect(evaluation.labels.get("hobo")?.reasons).toEqual(["storage-bytes"]);
	});

	it("a busy box short of memory with a critical disk names only the disk", () => {
		const evaluation = evaluateFleetVerdict(
			input({ idle: false, host: { ...disk, availableMb: 1_000 } }),
		);
		expect(evaluation.labels.get("hobo")?.reasons).toEqual(["storage-bytes"]);
	});

	const pool = {
		labels: ["hobo"],
		runnerNamePrefix: "arc-",
		maxRunners: 4,
	};
	const runner = (name: string, busy: boolean, online = true) => ({
		name,
		labels: ["self-hosted", "hobo"],
		online,
		busy,
	});
	const view = (runners: ReturnType<typeof runner>[]) => ({
		view: { readAtMs: NOW - 1_000, runners },
	});

	it("counts a pool free only by an online, idle runner of its own", () => {
		expect(
			blocked({ pools: [pool], runners: view([runner("arc-1", false)]) }),
		).toEqual(["hobo-trunk"]);
		expect(
			blocked({
				pools: [pool],
				runners: view([
					runner("arc-1", true),
					runner("arc-2", false, false),
					runner("other-1", false),
				]),
			}),
		).toEqual(["hobo", "hobo-trunk"]);
	});

	it("a runner list that could not be read, or is stale, refuses nothing (R3)", () => {
		expect(blocked({ pools: [pool], runners: { view: undefined } })).toEqual(
			[],
		);
		expect(
			blocked({
				pools: [pool],
				runners: {
					view: {
						readAtMs: NOW - FLEET_VERDICT_POOL_FRESH_MS - 1,
						runners: [],
					},
				},
			}),
		).toEqual([]);
	});

	it("with no pools declared, an empty list read now is known", () => {
		expect(
			blocked({
				poll: undefined,
				runners: { view: { readAtMs: NOW, runners: [] } },
			}),
		).toEqual(["hobo", "hobo-trunk"]);
	});
});
