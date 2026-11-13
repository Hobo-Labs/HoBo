import { describe, expect, it } from "vitest";
import {
	fleetCanAbsorbUnlaunchedRelease,
	isUnlaunchedReservation,
	pickTrunkHeadroomFleetReleases,
	pickUnlaunchedReservationsToRelease,
	unlaunchedReleaseReason,
} from "../src/unlaunched-reservation-release.js";

const baseLease = {
	id: "lease-a",
	state: "reserved" as const,
	sandboxName: undefined,
	sandboxSessionId: undefined,
	runnerId: 0,
	createdAt: "2026-11-11T12:00:00.000Z",
	jobId: 1,
	installationId: 1,
	repository: "Org/Repo",
	runAttempt: 1,
};

const baseContext = {
	boundMs: 60_000,
	backlogMinAgeMs: 25_000,
	pendingDemand: 0,
	unlaunchedCount: 1,
	launchSlots: 4,
	liveContainerCount: 0,
	backlogImmediate: true,
	nonLocalFreeSlots: 1,
} as const;

describe("unlaunched reservation release", () => {
	it("detects reserved leases with no sandbox or runner", () => {
		expect(isUnlaunchedReservation(baseLease)).toBe(true);
		expect(
			isUnlaunchedReservation({ ...baseLease, sandboxName: "hobo-x" }),
		).toBe(false);
		expect(
			isUnlaunchedReservation({ ...baseLease, state: "dispatching" }),
		).toBe(false);
	});

	it("accepts fleet peer headroom beyond this box's own slots", () => {
		expect(
			fleetCanAbsorbUnlaunchedRelease({
				hoboFreeSlots: 1,
				fleetFreeSlots: 3,
			}),
		).toBe(true);
	});

	it("refuses release when fleet witnesses report no non-local capacity", () => {
		expect(fleetCanAbsorbUnlaunchedRelease({ fleetFreeSlots: 0 })).toBe(false);
		expect(fleetCanAbsorbUnlaunchedRelease(undefined)).toBe(false);
		const nowMs = Date.parse("2026-11-11T12:01:00.000Z");
		const reason = unlaunchedReleaseReason(baseLease, nowMs, {
			...baseContext,
			nonLocalFreeSlots: 0,
		});
		expect(reason).toBeUndefined();
	});

	it("releases when age exceeds the launch bound and fleet can absorb", () => {
		const nowMs = Date.parse("2026-11-11T12:01:30.000Z");
		const reason = unlaunchedReleaseReason(baseLease, nowMs, {
			...baseContext,
			boundMs: 25_000,
		});
		expect(reason).toBe("launch-bound-exceeded");
	});

	it("does not backlog-release before backlogMinAgeMs", () => {
		const nowMs = Date.parse("2026-11-11T12:00:05.000Z");
		const reason = unlaunchedReleaseReason(baseLease, nowMs, {
			...baseContext,
			boundMs: 60_000,
			backlogMinAgeMs: 25_000,
			pendingDemand: 4,
			unlaunchedCount: 2,
			launchSlots: 1,
			liveContainerCount: 1,
		});
		expect(reason).toBeUndefined();
	});

	it("does not backlog-release when every pending job already holds a reservation", () => {
		const nowMs = Date.parse("2026-11-11T12:00:30.000Z");
		const releases = pickUnlaunchedReservationsToRelease(
			[
				baseLease,
				{
					...baseLease,
					id: "lease-b",
					jobId: 2,
					createdAt: "2026-11-11T12:00:02.000Z",
				},
				{
					...baseLease,
					id: "lease-c",
					jobId: 3,
					createdAt: "2026-11-11T12:00:01.000Z",
				},
			],
			nowMs,
			{
				boundMs: 60_000,
				backlogMinAgeMs: 25_000,
				pendingDemand: 0,
				unlaunchedCount: 3,
				launchSlots: 3,
				liveContainerCount: 0,
				backlogImmediate: true,
				nonLocalFreeSlots: 3,
			},
		);
		expect(releases).toEqual([]);
	});

	it("releases oldest unlaunched leases when backlog age and fleet capacity allow", () => {
		const nowMs = Date.parse("2026-11-11T12:00:30.000Z");
		const releases = pickUnlaunchedReservationsToRelease(
			[
				baseLease,
				{
					...baseLease,
					id: "lease-b",
					jobId: 2,
					createdAt: "2026-11-11T12:00:02.000Z",
				},
			],
			nowMs,
			{
				boundMs: 60_000,
				backlogMinAgeMs: 25_000,
				pendingDemand: 4,
				unlaunchedCount: 2,
				launchSlots: 1,
				liveContainerCount: 1,
				backlogImmediate: true,
				nonLocalFreeSlots: 2,
			},
		);
		expect(releases.map((entry) => entry.leaseId)).toEqual([
			"lease-a",
			"lease-b",
		]);
		for (const entry of releases)
			expect(entry.reason).toBe("admission-backlog");
	});

	const deferReasons = [
		"host-available",
		"memory-headroom",
		"memory-budget",
		"trunk-pr-cap",
		"host-pressure",
		"storage",
		"headroom",
	] as const;

	for (const reason of deferReasons) {
		it(`releases trunk waits blocked on ${reason} after the fleet defer window`, () => {
			const nowMs = Date.parse("2026-11-11T12:02:00.000Z");
			const waits = new Map([
				[
					"Org/Repo:42:1",
					{
						sinceMs: nowMs - 50_000,
						logged: true,
						reason,
					},
				],
			]);
			const releases = pickTrunkHeadroomFleetReleases(
				waits,
				[{ ...baseLease, id: "lease-x", jobId: 42 }],
				nowMs,
				{
					deferMs: 45_000,
					fleetWitness: { fleetFreeSlots: 2, hoboFreeSlots: 0 },
				},
			);
			expect(releases).toEqual([
				{
					leaseId: "lease-x",
					jobId: 42,
					reason: `trunk-${reason}-fleet-defer`,
					waitKey: "Org/Repo:42:1",
					waitedMs: 50_000,
				},
			]);
		});
	}
});
