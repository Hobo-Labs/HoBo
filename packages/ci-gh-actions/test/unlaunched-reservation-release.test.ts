import { describe, expect, it } from "vitest";
import {
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
};

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

	it("releases when age exceeds the launch bound", () => {
		const nowMs = Date.parse("2026-11-11T12:00:30.000Z");
		const reason = unlaunchedReleaseReason(baseLease, nowMs, {
			boundMs: 25_000,
			pendingDemand: 0,
			unlaunchedCount: 1,
			launchSlots: 4,
			liveContainerCount: 0,
			backlogImmediate: true,
		});
		expect(reason).toBe("launch-bound-exceeded");
	});

	it("releases oldest unlaunched leases when pending demand exceeds launch capacity", () => {
		const nowMs = Date.parse("2026-11-11T12:00:05.000Z");
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
				pendingDemand: 4,
				unlaunchedCount: 2,
				launchSlots: 1,
				liveContainerCount: 1,
				backlogImmediate: true,
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
