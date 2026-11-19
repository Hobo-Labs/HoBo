import { describe, expect, it } from "vitest";
import {
	BETTER_AUTH_ACCEPTED_CLAIM_KEYS,
	BETTER_AUTH_CLAIMS_CONFORMANCE_CASES,
	BETTER_AUTH_CLAIMS_ERROR_CODES,
	BETTER_AUTH_CLAIMS_MAPPING_VERSION,
	type MappedPrincipal,
	mapClaimsToPrincipal,
	runClaimsMappingConformance,
	unexercisedAcceptedClaimKeys,
} from "../src/index.js";
import type { JsonObject } from "../src/json.js";

describe("claims-mapping conformance suite", () => {
	it("passes against this adapter's own mapping", () => {
		const result = runClaimsMappingConformance();
		expect(result.failed).toEqual([]);
		expect(result.passed).toBe(result.total);
		expect(result.total).toBe(BETTER_AUTH_CLAIMS_CONFORMANCE_CASES.length);
		expect(result.mappingVersion).toBe(BETTER_AUTH_CLAIMS_MAPPING_VERSION);
	});

	it("is total over the accepted claim vocabulary", () => {
		expect(unexercisedAcceptedClaimKeys()).toEqual([]);
	});

	it("covers every claims refusal code, so the suite proves what it refuses", () => {
		const covered = new Set(
			BETTER_AUTH_CLAIMS_CONFORMANCE_CASES.filter(
				(testCase) => testCase.expected.outcome === "refused",
			).map((testCase) =>
				testCase.expected.outcome === "refused" ? testCase.expected.code : "",
			),
		);
		expect([...covered].sort()).toEqual(
			[...BETTER_AUTH_CLAIMS_ERROR_CODES].sort(),
		);
	});

	it("has teeth: a mapping that coerces an unknown claim fails the suite", () => {
		const coercing = <T>(claims: T): MappedPrincipal => {
			try {
				return mapClaimsToPrincipal(claims);
			} catch {
				// The failure mode ADR-0073 warns about: silently accepting whatever
				// the new issuer sends instead of refusing an unmapped claim shape.
				// SAFETY: assertion to `(claims ?? {}) as JsonObject` is required at this boundary.
				const raw = (claims ?? {}) as JsonObject;
				return Object.freeze({
					subject: String(raw.sub ?? "unknown"),
					issuer: String(raw.iss ?? "unknown"),
					roles: Object.freeze([]),
					claimsMappingVersion: BETTER_AUTH_CLAIMS_MAPPING_VERSION,
				});
			}
		};

		const result = runClaimsMappingConformance({ map: coercing });
		expect(result.failed.length).toBeGreaterThan(0);
		expect(result.failed.map((entry) => entry.name)).toContain(
			"an unrecognized group claim is refused, not silently ignored",
		);
	});

	it("has teeth: a mapping that drops roles fails the suite", () => {
		const rolesDropped = <T>(claims: T): MappedPrincipal => {
			const principal = mapClaimsToPrincipal(claims);
			return Object.freeze({ ...principal, roles: Object.freeze([]) });
		};

		const result = runClaimsMappingConformance({ map: rolesDropped });
		expect(result.failed.map((entry) => entry.name)).toContain(
			"roles array is deduped and sorted, not preserved in issue order",
		);
	});

	it("exposes frozen case data so a host cannot mutate the baseline", () => {
		expect(Object.isFrozen(BETTER_AUTH_CLAIMS_CONFORMANCE_CASES)).toBe(true);
		for (const testCase of BETTER_AUTH_CLAIMS_CONFORMANCE_CASES) {
			expect(Object.isFrozen(testCase)).toBe(true);
		}
	});

	it("keeps the accepted vocabulary sorted and duplicate-free", () => {
		expect([...BETTER_AUTH_ACCEPTED_CLAIM_KEYS]).toEqual(
			[...new Set(BETTER_AUTH_ACCEPTED_CLAIM_KEYS)].sort(),
		);
	});
});
