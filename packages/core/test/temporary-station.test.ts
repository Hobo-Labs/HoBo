import { describe, expect, it } from "vitest";
import {
	assertTemporaryEnvironmentStationResult,
	TEMPORARY_ENVIRONMENT_STATION_SCHEMA,
	TEMPORARY_STATION_TTL_MS,
	temporaryStationExpiresAt,
	temporaryStationToAnonymousSessionView,
	temporaryStationTtlSeconds,
} from "../src/ports/temporary-station.js";

describe("temporary Environment Station contract", () => {
	it("pins schema and default TTL", () => {
		expect(TEMPORARY_ENVIRONMENT_STATION_SCHEMA).toBe(
			"hobo.temporary-environment-station/v1",
		);
		expect(TEMPORARY_STATION_TTL_MS).toBe(3_600_000);
		expect(temporaryStationTtlSeconds()).toBe(3600);
	});

	it("projects onto broker AnonymousSession-aligned shape", () => {
		const expiresAt = temporaryStationExpiresAt(60_000, 1_700_000_000_000);
		const fixture = temporaryStationToAnonymousSessionView({
			stationId: "st-1",
			stationUrl: "https://anon.example/app",
			claimUrl: "https://claim.example/c",
			expiresAt,
			providerId: "lakebed",
			anonymous: true,
			temporary: true,
		});
		expect(fixture).toEqual({
			stationId: "st-1",
			providerId: "lakebed",
			claimUrl: "https://claim.example/c",
			primaryUrl: "https://anon.example/app",
			expiresAt,
			ttlSeconds: expect.any(Number),
			anonymous: true,
			temporary: true,
		});
		expect(fixture.ttlSeconds).toBeGreaterThan(0);
	});

	it("parse-don't-validate rejects incomplete results", () => {
		expect(() =>
			assertTemporaryEnvironmentStationResult({ stationId: "x" }),
		).toThrow(/missing string field/);
		expect(() =>
			assertTemporaryEnvironmentStationResult({
				stationId: "st",
				stationUrl: "https://x.test",
				claimUrl: "https://claim.test",
				expiresAt: new Date().toISOString(),
				providerId: "lakebed",
				anonymous: false,
				temporary: true,
			}),
		).toThrow(/anonymous:true/);
	});
});
