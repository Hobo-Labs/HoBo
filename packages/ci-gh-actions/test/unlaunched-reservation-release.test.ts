import { describe, expect, it } from "vitest";
import {
	fleetCanAbsorbUnlaunchedRelease,
	isUnlaunchedReservation,
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

	it("refuses release when fleet witnesses report no non-local capacity", () => {
		expect(fleetCanAbsorbUnlaunchedRelease(0)).toBe(false);
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
});
