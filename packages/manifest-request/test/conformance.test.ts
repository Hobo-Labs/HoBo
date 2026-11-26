/**
 * What the parse boundary refuses, and why each refusal earns its place.
 *
 * Every case asserts the specific refusal — the `path` and a message fragment
 * unique to that branch — rather than "it threw". A test that only asserts
 * "threw" passes when the function throws for an entirely different reason,
 * which is how a refusal that never existed gets reported as enforced.
 */
import { describe, expect, it } from "vitest";

import {
	canonicalSelectionCandidateJson,
	fromSelectionCandidateRecord,
	parseSelectionCandidate,
	SELECTION_CANDIDATE_SCHEMA_VERSION,
	type SelectionCandidate,
	SelectionCandidateError,
	toSelectionCandidateRecord,
} from "../src/index.js";
import { BASE_CANDIDATE } from "./fixtures.js";

/** Returns the refusal, or fails loudly if the call returned or threw else. */
function refusal(act: () => unknown): SelectionCandidateError {
	try {
		act();
	} catch (error) {
		if (error instanceof SelectionCandidateError) return error;
		throw new Error(
			`expected a SelectionCandidateError, got ${String(error)}`,
			{ cause: error },
		);
	}
	throw new Error("expected a SelectionCandidateError, but the call returned");
}

const withCandidate = (patch: Record<string, unknown>): unknown => ({
	...BASE_CANDIDATE,
	...patch,
});

const withoutKey = (key: string): Record<string, unknown> => {
	const draft: Record<string, unknown> = { ...BASE_CANDIDATE };
	delete draft[key];
	return draft;
};

describe("shape refusals", () => {
	it("names the unknown field rather than dropping it", () => {
		const error = refusal(() =>
			parseSelectionCandidate(withCandidate({ monthlyCostMinorUnits: 500 })),
		);
		expect(error.path).toBe("selectionCandidate");
		expect(error.message).toContain('unknown field(s) "monthlyCostMinorUnits"');
		expect(error.code).toBe("INVALID_SELECTION_CANDIDATE");
	});

	it("refuses a missing required field by name", () => {
		const error = refusal(() =>
			parseSelectionCandidate(withoutKey("secretCustodyAvailable")),
		);
		expect(error.path).toBe("secretCustodyAvailable");
		expect(error.message).toContain("must be a boolean, got undefined");
	});

	it("refuses a non-object candidate", () => {
		expect(refusal(() => parseSelectionCandidate(null)).message).toContain(
			"selectionCandidate: must be an object, got null",
		);
		expect(refusal(() => parseSelectionCandidate([])).message).toContain(
			"selectionCandidate: must be an object, got an array",
		);
	});
});

describe("optionality is not nullability", () => {
	it("refuses a null evidence expiry", () => {
		const error = refusal(() =>
			parseSelectionCandidate(withCandidate({ evidenceExpiresAtMs: null })),
		);
		expect(error.path).toBe("evidenceExpiresAtMs");
		expect(error.message).toContain("must be absent rather than null");
	});

	it("refuses a present-but-undefined evidence expiry", () => {
		const error = refusal(() =>
			parseSelectionCandidate(
				withCandidate({ evidenceExpiresAtMs: undefined }),
			),
		);
		expect(error.path).toBe("evidenceExpiresAtMs");
		expect(error.message).toContain(
			"must be absent rather than present-and-undefined",
		);
	});

	it("accepts the same candidate with the key omitted", () => {
		const parsed = parseSelectionCandidate(withoutKey("evidenceExpiresAtMs"));
		expect("evidenceExpiresAtMs" in parsed).toBe(false);
	});

	it("refuses a non-integer expiry", () => {
		expect(
			refusal(() =>
				parseSelectionCandidate(withCandidate({ evidenceExpiresAtMs: 1.5 })),
			).message,
		).toContain("must be epoch milliseconds as a safe integer, got number");
	});
});

describe("closed vocabularies", () => {
	it("refuses an unknown provider class and lists the admissible ones", () => {
		const error = refusal(() =>
			parseSelectionCandidate(withCandidate({ providerClass: "gold" })),
		);
		expect(error.path).toBe("providerClass");
		expect(error.message).toContain(
			'must be one of "established", "verified-emerging", "experimental", got "gold"',
		);
	});

	it("keeps the credential vocabulary distinct from the continuity grades", () => {
		const error = refusal(() =>
			parseSelectionCandidate(
				withCandidate({
					continuity: {
						endpoint: "preserved",
						data: "preserved",
						// A grade from the other axis: valid there, meaningless here.
						credentials: "migrated",
					},
				}),
			),
		);
		expect(error.path).toBe("continuity.credentials");
		expect(error.message).toContain('got "migrated"');
	});

	it("refuses an unknown runtime model", () => {
		expect(
			refusal(() =>
				parseSelectionCandidate(withCandidate({ runtimeModels: ["lambda"] })),
			).path,
		).toBe("runtimeModels[0]");
	});
});

describe("profile claims", () => {
	const claim = (patch: Record<string, unknown>) => ({
		profileId: "data.postgres/v1",
		versionRange: ">=1",
		realization: "native",
		conformanceRef: "conformance.data.postgres/v1",
		conformance: "pass",
		...patch,
	});

	it("refuses two claims for the same profile", () => {
		const error = refusal(() =>
			parseSelectionCandidate(
				withCandidate({
					implementsProfiles: [
						claim({}),
						claim({ realization: "pack", conformance: "fail" }),
					],
				}),
			),
		);
		expect(error.path).toBe("implementsProfiles");
		expect(error.message).toContain('must not repeat "data.postgres/v1"');
	});

	it("refuses a non-canonical profile id", () => {
		expect(
			refusal(() =>
				parseSelectionCandidate(
					withCandidate({
						implementsProfiles: [claim({ profileId: "Data.Postgres/v1" })],
					}),
				),
			).path,
		).toBe("implementsProfiles[0].profileId");
	});

	it("refuses a version range that is not a range", () => {
		expect(
			refusal(() =>
				parseSelectionCandidate(
					withCandidate({
						implementsProfiles: [claim({ versionRange: "latest" })],
					}),
				),
			).message,
		).toContain('got "latest"');
	});

	it("refuses an unknown conformance outcome instead of reading it as a pass", () => {
		expect(
			refusal(() =>
				parseSelectionCandidate(
					withCandidate({
						implementsProfiles: [claim({ conformance: "waived" })],
					}),
				),
			).path,
		).toBe("implementsProfiles[0].conformance");
	});

	it("admits a connectivity-only product that implements nothing", () => {
		// CLOUDFLARE_TEMPORARY_HYPERDRIVE is a real catalog row with an empty
		// claim list: it produces binding.postgresql/v1 and satisfies no data.*
		// requirement. Refusing an empty list here would refuse that row.
		const parsed = parseSelectionCandidate(
			withCandidate({
				implementsProfiles: [],
				producesBindingProfiles: ["binding.postgresql/v1"],
			}),
		);
		expect(parsed.implementsProfiles).toStrictEqual([]);
	});
});

describe("structured capabilities", () => {
	it("refuses a nested object value", () => {
		const error = refusal(() =>
			parseSelectionCandidate(
				withCandidate({ structuredCapabilities: { limits: { maxRows: 10 } } }),
			),
		);
		expect(error.path).toBe("structuredCapabilities.limits");
		expect(error.message).toContain(
			"must be a boolean, finite number, string, or string array, got object",
		);
	});

	it("refuses a non-finite number", () => {
		expect(
			refusal(() =>
				parseSelectionCandidate(
					withCandidate({ structuredCapabilities: { ratio: Number.NaN } }),
				),
			).message,
		).toContain("must be a finite number, got NaN");
	});

	it("refuses an index-shaped key, which JavaScript would hoist out of sorted order", () => {
		const error = refusal(() =>
			parseSelectionCandidate(
				withCandidate({ structuredCapabilities: { "0": true, tls: true } }),
			),
		);
		expect(error.path).toBe("structuredCapabilities.0");
		expect(error.message).toContain("key must match");
	});

	it("normalizes -0, which JSON cannot carry back", () => {
		const parsed = parseSelectionCandidate(
			withCandidate({ structuredCapabilities: { worstCaseLossMs: -0 } }),
		);
		expect(Object.is(parsed.structuredCapabilities.worstCaseLossMs, 0)).toBe(
			true,
		);
	});

	it("keeps a negative number, which the real catalog uses", () => {
		// pack-valkey-oci publishes worstCaseLossMs: -1 for "unbounded".
		const parsed = parseSelectionCandidate(
			withCandidate({ structuredCapabilities: { worstCaseLossMs: -1 } }),
		);
		expect(parsed.structuredCapabilities.worstCaseLossMs).toBe(-1);
	});

	it("keeps a list value in its authored order", () => {
		const parsed = parseSelectionCandidate(
			withCandidate({
				structuredCapabilities: { extensions: ["vector", "pg_trgm"] },
			}),
		);
		expect(parsed.structuredCapabilities.extensions).toStrictEqual([
			"vector",
			"pg_trgm",
		]);
	});
});

describe("counts", () => {
	it("refuses a negative claim action count", () => {
		const error = refusal(() =>
			parseSelectionCandidate(withCandidate({ claimActionCount: -1 })),
		);
		expect(error.path).toBe("claimActionCount");
		expect(error.message).toContain("must not be negative, got -1");
	});

	it("refuses a fractional sponsor exposure", () => {
		expect(
			refusal(() =>
				parseSelectionCandidate(
					withCandidate({ sponsorExposureMinorUnits: 12.5 }),
				),
			).message,
		).toContain("must be a safe integer, got number");
	});
});

describe("the wire record", () => {
	const record = () =>
		JSON.parse(
			canonicalSelectionCandidateJson(
				BASE_CANDIDATE as unknown as SelectionCandidate,
			),
		) as Record<string, unknown>;

	it("stamps the schema version", () => {
		expect(record().schema_version).toBe(SELECTION_CANDIDATE_SCHEMA_VERSION);
		expect(SELECTION_CANDIDATE_SCHEMA_VERSION).toBe(
			"hobo.selection-candidate/v1",
		);
	});

	it("refuses a record from another schema version", () => {
		const error = refusal(() =>
			fromSelectionCandidateRecord({
				...record(),
				schema_version: "hobo.selection-candidate/v2",
			}),
		);
		expect(error.path).toBe("selectionCandidateRecord.schema_version");
		expect(error.message).toContain('got "hobo.selection-candidate/v2"');
	});

	it("refuses a record carrying a field this version does not model", () => {
		const error = refusal(() =>
			fromSelectionCandidateRecord({ ...record(), region_pinned: true }),
		);
		expect(error.path).toBe("selectionCandidateRecord");
		expect(error.message).toContain('unknown field(s) "region_pinned"');
	});

	it("emits every field the shape declares, in schema order", () => {
		expect(Object.keys(record())).toStrictEqual([
			"schema_version",
			"definition_id",
			"provider_id",
			"implements_profiles",
			"runtime_models",
			"structured_capabilities",
			"produces_binding_profiles",
			"migration_profiles",
			"provider_class",
			"evidence_expires_at_ms",
			"evidence_signature_valid",
			"creator_authority_after_claim",
			"claim_atomicity",
			"claim_action_count",
			"continuity",
			"supports_export",
			"supports_rotation",
			"supports_revocation",
			"sponsor_exposure_minor_units",
			"has_registered_driver",
			"secret_custody_available",
		]);
	});

	it("canonicalizes on encode, whatever order the caller authored", () => {
		const authored = toSelectionCandidateRecord({
			...BASE_CANDIDATE,
			runtimeModels: ["paas", "oci"],
		} as unknown as SelectionCandidate);
		expect(authored.runtime_models).toStrictEqual(["oci", "paas"]);
	});

	it("refuses a repeated entry in a set-valued field", () => {
		const error = refusal(() =>
			parseSelectionCandidate(
				withCandidate({ runtimeModels: ["paas", "paas"] }),
			),
		);
		expect(error.path).toBe("runtimeModels");
		expect(error.message).toContain('must not repeat "paas"');
	});
});
