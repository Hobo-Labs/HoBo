import { describe, expect, it } from "vitest";

import {
	type AggregateStationCapabilitiesInput,
	aggregateStationCapabilities,
	renderStationCapabilityCoverage,
	STATION_CAPABILITY_COVERAGE_SCHEMA,
	StationCapabilityCoverageError,
	type StationYardCatalogInput,
} from "../src/index.js";

const azure: StationYardCatalogInput = {
	yardName: "yard:azure-east",
	providerId: "azure",
	bindings: [
		// A Yard is a catalog: Azure legitimately lists four ways to do web.
		{ profile: "web.hosted/v1", productId: "azure:app-service" },
		{ profile: "web.hosted/v1", productId: "azure:static-web-apps" },
		{ profile: "web.hosted/v1", productId: "azure:container-apps" },
		{ profile: "data.postgres/v1", productId: "azure:flexible-server" },
	],
};

const cloudflare: StationYardCatalogInput = {
	yardName: "yard:cf",
	providerId: "cloudflare",
	bindings: [
		{ profile: "web.hosted/v1", productId: "cf:workers" },
		{ profile: "bucket.s3-compatible/v1", productId: "cf:r2" },
		{
			profile: "queue.stream/v1",
			connectivityId: "cf:queues-binding",
		},
	],
};

function aggregate(overrides: Partial<AggregateStationCapabilitiesInput> = {}) {
	return aggregateStationCapabilities({
		stationId: "station:acme",
		yards: [azure, cloudflare],
		expected: ["web.hosted/v1", "data.postgres/v1", "bucket.s3-compatible/v1"],
		...overrides,
	});
}

describe("aggregateStationCapabilities() — breadth, not choice", () => {
	it("reports every offering that can satisfy a profile across yards", () => {
		const coverage = aggregate();
		const web = coverage.served.find(
			(entry) => entry.profile === "web.hosted/v1",
		);
		expect(web?.offeringCount).toBe(4);
		expect(web?.yardNames).toEqual(["yard:azure-east", "yard:cf"]);
		expect(web?.providerIds).toEqual(["azure", "cloudflare"]);
		expect(web?.expected).toBe(true);
	});

	it("two yards serving the same profile is coverage, not a conflict", () => {
		const coverage = aggregateStationCapabilities({
			stationId: "station:acme",
			yards: [
				{
					yardName: "yard:a",
					providerId: "azure",
					bindings: [
						{ profile: "web.hosted/v1", productId: "azure:app-service" },
					],
				},
				{
					yardName: "yard:b",
					providerId: "cloudflare",
					bindings: [{ profile: "web.hosted/v1", productId: "cf:workers" }],
				},
			],
			expected: ["web.hosted/v1"],
		});
		expect(coverage.ok).toBe(true);
		expect(coverage.gaps).toEqual([]);
		expect(coverage.served).toHaveLength(1);
		expect(coverage.served[0]?.offeringCount).toBe(2);
	});

	it("never collapses to a single 'the' offering and never marks a winner", () => {
		const web = aggregate().served.find(
			(entry) => entry.profile === "web.hosted/v1",
		);
		const keys = Object.keys(web?.offerings[0] ?? {});
		// No preferred/selected/rank/score/weight field exists to smuggle a choice.
		for (const forbidden of [
			"preferred",
			"selected",
			"rank",
			"score",
			"weight",
		]) {
			expect(keys).not.toContain(forbidden);
		}
		expect(Object.keys(web ?? {})).not.toContain("chosen");
	});

	it("orders offerings lexicographically by yard then productId, not by input order", () => {
		const coverage = aggregateStationCapabilities({
			stationId: "station:acme",
			// "zulu" is authored first; a preference-carrying aggregation would
			// keep it first. ADR-0151 forbids authoring order influencing anything.
			yards: [
				{
					yardName: "yard:a",
					providerId: "azure",
					bindings: [
						{ profile: "web.hosted/v1", productId: "zulu" },
						{ profile: "web.hosted/v1", productId: "alpha" },
					],
				},
			],
			expected: ["web.hosted/v1"],
		});
		expect(
			coverage.served[0]?.offerings.map((offering) => offering.productId),
		).toEqual(["alpha", "zulu"]);
	});

	it("sorts served entries by profile", () => {
		expect(aggregate().served.map((entry) => entry.profile)).toEqual([
			"bucket.s3-compatible/v1",
			"data.postgres/v1",
			"queue.stream/v1",
			"web.hosted/v1",
		]);
	});

	it("reports breadth beyond the expected set instead of hiding it", () => {
		const extra = aggregate().served.find(
			(entry) => entry.profile === "queue.stream/v1",
		);
		expect(extra?.expected).toBe(false);
		expect(extra?.offerings[0]?.connectivityId).toBe("cf:queues-binding");
	});

	it("deep-freezes the report", () => {
		const coverage = aggregate();
		expect(Object.isFrozen(coverage)).toBe(true);
		expect(Object.isFrozen(coverage.served)).toBe(true);
		expect(Object.isFrozen(coverage.served[0])).toBe(true);
		expect(Object.isFrozen(coverage.served[0]?.offerings[0])).toBe(true);
		expect(coverage.schema).toBe(STATION_CAPABILITY_COVERAGE_SCHEMA);
	});
});

describe("aggregateStationCapabilities() — gaps", () => {
	it("an expected profile no yard can allocate is a gap with remediation", () => {
		const coverage = aggregate({
			expected: ["web.hosted/v1", "data.warehouse/v1"],
		});
		expect(coverage.ok).toBe(false);
		expect(coverage.gaps).toEqual([
			{
				profile: "data.warehouse/v1",
				remediation:
					"no Yard on this Station declares an offering for data.warehouse/v1; add a row to a Yard whose provider publishes one (yards on this Station: yard:azure-east, yard:cf)",
			},
		]);
	});

	it("a station with no yards makes every expected profile a gap", () => {
		const coverage = aggregate({ yards: [] });
		expect(coverage.ok).toBe(false);
		expect(coverage.served).toEqual([]);
		expect(coverage.yardNames).toEqual([]);
		expect(coverage.gaps.map((gap) => gap.profile)).toEqual([
			"bucket.s3-compatible/v1",
			"data.postgres/v1",
			"web.hosted/v1",
		]);
		for (const gap of coverage.gaps) {
			expect(gap.remediation).toContain("this Station has no Yard catalogs");
		}
	});

	it("ok is true only when no expected profile is a gap", () => {
		expect(aggregate().ok).toBe(true);
		expect(aggregate({ expected: ["nope.missing/v1"] }).ok).toBe(false);
	});
});

describe("aggregateStationCapabilities() — singlySourced", () => {
	it("flags profiles served by exactly one offering", () => {
		expect(aggregate().singlySourced).toEqual([
			"bucket.s3-compatible/v1",
			"data.postgres/v1",
			"queue.stream/v1",
		]);
	});

	it("a second offering removes the single-source signal", () => {
		const coverage = aggregate({
			yards: [
				azure,
				cloudflare,
				{
					yardName: "yard:aws",
					providerId: "aws",
					bindings: [
						{ profile: "data.postgres/v1", productId: "aws:rds-postgres" },
					],
				},
			],
		});
		expect(coverage.singlySourced).not.toContain("data.postgres/v1");
	});

	it("singly sourced is a signal, never an error", () => {
		const coverage = aggregate();
		expect(coverage.singlySourced.length).toBeGreaterThan(0);
		expect(coverage.ok).toBe(true);
	});
});

describe("aggregateStationCapabilities() — provider concentration", () => {
	it("names the providers the coverage depends on, with sole-source facts", () => {
		const coverage = aggregate();
		expect(
			coverage.providerConcentration.map((entry) => entry.providerId),
		).toEqual(["azure", "cloudflare"]);
		const azureEntry = coverage.providerConcentration[0];
		expect(azureEntry?.offeringCount).toBe(4);
		expect(azureEntry?.profiles).toEqual(["data.postgres/v1", "web.hosted/v1"]);
		expect(azureEntry?.soleSourceProfiles).toEqual(["data.postgres/v1"]);
		expect(coverage.providerConcentration[1]?.soleSourceProfiles).toEqual([
			"bucket.s3-compatible/v1",
			"queue.stream/v1",
		]);
	});

	it("makes an every-capability-is-one-provider station visible at a glance", () => {
		const coverage = aggregate({
			yards: [cloudflare],
			expected: ["web.hosted/v1", "bucket.s3-compatible/v1"],
		});
		expect(coverage.providerConcentration).toHaveLength(1);
		const only = coverage.providerConcentration[0];
		expect(only?.providerId).toBe("cloudflare");
		expect(only?.soleSourceProfiles).toEqual(only?.profiles);
	});

	it("carries no score or threshold — facts only", () => {
		const keys = Object.keys(aggregate().providerConcentration[0] ?? {});
		expect(keys.sort()).toEqual([
			"offeringCount",
			"profiles",
			"providerId",
			"soleSourceProfiles",
			"yardNames",
		]);
	});
});

describe("aggregateStationCapabilities() — determinism", () => {
	it("two calls with equal input are deep-equal", () => {
		expect(aggregate()).toEqual(aggregate());
	});

	it("input ordering does not change output", () => {
		const forward = aggregate({ yards: [azure, cloudflare] });
		const reversed = aggregate({ yards: [cloudflare, azure] });
		expect(reversed).toEqual(forward);
	});

	it("expected ordering and duplicates do not change output", () => {
		const a = aggregate({
			expected: [
				"web.hosted/v1",
				"data.postgres/v1",
				"bucket.s3-compatible/v1",
			],
		});
		const b = aggregate({
			expected: [
				"bucket.s3-compatible/v1",
				"web.hosted/v1",
				"data.postgres/v1",
				"web.hosted/v1",
			],
		});
		expect(b).toEqual(a);
	});

	it("carries no timestamp — coverage does not depend on when it was computed", () => {
		expect(Object.keys(aggregate())).not.toContain("generatedAt");
	});
});

describe("aggregateStationCapabilities() — typed refusals", () => {
	function refusal(input: AggregateStationCapabilitiesInput) {
		try {
			aggregateStationCapabilities(input);
		} catch (error) {
			expect(error).toBeInstanceOf(StationCapabilityCoverageError);
			// SAFETY: assertion required at this I/O or test boundary.
			const typed = error as StationCapabilityCoverageError;
			expect(typed.remediation.length).toBeGreaterThan(0);
			return { code: typed.code, remediation: typed.remediation };
		}
		throw new Error("expected a refusal");
	}

	it("refuses a bad capability-profile grammar on a row", () => {
		expect(
			refusal({
				stationId: "station:acme",
				yards: [
					{
						yardName: "yard:a",
						providerId: "azure",
						bindings: [{ profile: "Web.Hosted", productId: "p" }],
					},
				],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_PROFILE_INVALID");
	});

	it("refuses a bad capability-profile grammar in the expected set", () => {
		expect(
			refusal({
				stationId: "station:acme",
				yards: [],
				expected: ["web.hosted/v0"],
			}).code,
		).toBe("STATION_COVERAGE_PROFILE_INVALID");
	});

	it("refuses a row constraining neither productId nor connectivityId", () => {
		const { code, remediation } = refusal({
			stationId: "station:acme",
			yards: [
				{
					yardName: "yard:a",
					providerId: "azure",
					bindings: [{ profile: "web.hosted/v1" }],
				},
			],
			expected: [],
		});
		expect(code).toBe("STATION_COVERAGE_EMPTY_CONSTRAINT");
		expect(remediation).toContain("claims coverage it does not have");
	});

	it("refuses a present-but-empty constraint rather than normalizing it away", () => {
		expect(
			refusal({
				stationId: "station:acme",
				yards: [
					{
						yardName: "yard:a",
						providerId: "azure",
						bindings: [{ profile: "web.hosted/v1", productId: "" }],
					},
				],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_EMPTY_CONSTRAINT");
	});

	it("fails closed: one malformed row refuses the whole report, never a partial one", () => {
		expect(
			refusal({
				stationId: "station:acme",
				yards: [
					azure,
					{
						yardName: "yard:bad",
						providerId: "azure",
						// SAFETY: assertion required at this I/O or test boundary.
						bindings: [null as never],
					},
				],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_ROW_INVALID");
	});

	it("refuses malformed yard catalogs", () => {
		expect(
			refusal({
				stationId: "station:acme",
				yards: [{ yardName: "", providerId: "azure", bindings: [] }],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_YARD_INVALID");
		expect(
			refusal({
				stationId: "station:acme",
				yards: [{ yardName: "yard:a", providerId: "", bindings: [] }],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_YARD_INVALID");
		expect(
			refusal({
				stationId: "station:acme",
				yards: [
					{
						yardName: "yard:a",
						providerId: "azure",
						// SAFETY: assertion required at this I/O or test boundary.
						bindings: undefined as never,
					},
				],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_YARD_INVALID");
		expect(
			refusal({
				stationId: "station:acme",
				// SAFETY: assertion required at this I/O or test boundary.
				yards: [null as never],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_YARD_INVALID");
	});

	it("refuses a duplicate offering within one yard — double counting overstates coverage", () => {
		expect(
			refusal({
				stationId: "station:acme",
				yards: [
					{
						yardName: "yard:a",
						providerId: "azure",
						bindings: [
							{ profile: "web.hosted/v1", productId: "p" },
							{ profile: "web.hosted/v1", productId: "p" },
						],
					},
				],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_DUPLICATE_ROW");
	});

	it("refuses the same yard twice", () => {
		expect(
			refusal({
				stationId: "station:acme",
				yards: [azure, azure],
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_DUPLICATE_YARD");
	});

	it("refuses a missing stationId and a non-array yards/expected", () => {
		expect(refusal({ stationId: "", yards: [], expected: [] }).code).toBe(
			"STATION_COVERAGE_STATION_INVALID",
		);
		expect(
			refusal({
				stationId: "station:acme",
				// SAFETY: assertion required at this I/O or test boundary.
				yards: undefined as never,
				expected: [],
			}).code,
		).toBe("STATION_COVERAGE_YARD_INVALID");
		expect(
			refusal({
				stationId: "station:acme",
				yards: [],
				// SAFETY: assertion required at this I/O or test boundary.
				expected: undefined as never,
			}).code,
		).toBe("STATION_COVERAGE_EXPECTED_INVALID");
	});
});

describe("renderStationCapabilityCoverage()", () => {
	it("puts gaps first and is deterministic", () => {
		const coverage = aggregate({
			expected: ["web.hosted/v1", "data.warehouse/v1"],
		});
		const digest = renderStationCapabilityCoverage(coverage);
		expect(digest).toBe(renderStationCapabilityCoverage(coverage));
		const lines = digest.split("\n");
		expect(lines[0]).toContain("station station:acme capability coverage");
		expect(lines[0]).toContain("INCOMPLETE");
		expect(lines[1]).toContain("gap  data.warehouse/v1");
		expect(lines.findIndex((line) => line.includes("gap  "))).toBeLessThan(
			lines.findIndex((line) => line.includes("ok   ")),
		);
	});

	it("names offering counts, single sourcing, and providers", () => {
		const digest = renderStationCapabilityCoverage(aggregate());
		expect(digest).toContain("ok   web.hosted/v1 — 4 offering(s)");
		expect(digest).toContain("yard:azure-east/azure/azure:app-service");
		expect(digest).toContain("[singly sourced]");
		expect(digest).toContain("beyond expected set");
		expect(digest).toContain("via  cloudflare — 3 offering(s)");
	});

	it("says so plainly when there is nothing to report", () => {
		const digest = renderStationCapabilityCoverage(
			aggregate({ yards: [], expected: [] }),
		);
		expect(digest).toContain("no Yard catalogs and no expected profiles");
	});
});
