/**
 * Conformance suite for the capability manifest's parse boundaries.
 *
 * Every assertion here names the *specific* refusal it means. A bare
 * `expect(fn).toThrow()` — or a matcher loose enough that a neighbouring
 * refusal from the same function also satisfies it — is worthless: this repo
 * has published a false security finding on the strength of exactly that, and
 * the pattern is called out in the swarm contract's §0.3.
 *
 * So each case asserts a message fragment unique to the branch under test, and
 * several of them additionally assert that the *near-miss* input is admitted,
 * which is what proves the refusal is the one that fired.
 */
import { describe, expect, it } from "vitest";

import {
	CapabilityProfileError,
	parseCapabilityProfile,
} from "../src/descriptor.js";
import { ProfileIdError, parseProfileId } from "../src/ids.js";
import {
	CapabilityRequirementError,
	parseCapabilityRequirement,
} from "../src/requirement.js";
import { STANDARD_CAPABILITY_PROFILES } from "../src/standard-profiles.js";
import {
	CapabilityWireError,
	fromCapabilityProfileCatalogWire,
	fromCapabilityProfileDescriptorWire,
	fromCapabilityRequirementWire,
	toCapabilityProfileDescriptorWire,
	toCapabilityRequirementWire,
} from "../src/wire.js";

const POSTGRES = { profileId: "data.postgres/v1" } as const;

describe("parseCapabilityRequirement refuses the thing each case names", () => {
	it("refuses a requirement that asks for nothing", () => {
		expect(() => parseCapabilityRequirement({ requiredProfiles: [] })).toThrow(
			"a capability requirement must name at least one required profile",
		);
	});

	it("refuses a provider-shaped key, naming the key", () => {
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				providerId: "neon",
			} as never),
		).toThrow(
			"capability requirements must stay provider-neutral; remove providerId",
		);
	});

	it("admits a key that merely mentions a provider without being one", () => {
		// The guard keys on a `*Id$` suffix. `providerClassNote` is not one, and
		// if this started throwing the guard would have grown from a suffix rule
		// into a substring rule without anyone saying so.
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				providerClassNote: "irrelevant",
			} as never),
		).not.toThrow();
	});

	it("refuses a profile that is both required and prohibited, naming it", () => {
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				prohibitedProfiles: [POSTGRES],
			}),
		).toThrow("data.postgres/v1 is both required and prohibited");
	});

	it("refuses a version range it cannot compare, naming the range", () => {
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [
					{ profileId: "data.postgres/v1", versionRange: "latest" },
				],
			}),
		).toThrow('invalid version range "latest" for data.postgres/v1');
	});

	it("refuses a negative preference weight, naming the profile", () => {
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				preferredProfiles: [{ profileId: "data.sqlite/v1", weight: -1 }],
			}),
		).toThrow(
			"preference weight for data.sqlite/v1 must be a non-negative integer",
		);
	});

	it("refuses an unknown runtime model, naming it", () => {
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				runtime: { allowed: ["kubernetes"] },
			}),
		).toThrow('unknown runtime model "kubernetes"');
	});

	it("refuses an unknown *required* runtime with its own distinct message", () => {
		// Deliberately a different message from the one above. If both said
		// "unknown runtime model" a single matcher would satisfy either branch,
		// and neither would be under test.
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				runtime: { required: "kubernetes" },
			}),
		).toThrow('unknown required runtime "kubernetes"');
	});

	it("refuses a requirement no realization can satisfy", () => {
		expect(() =>
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				realization: {
					allowNative: false,
					allowPack: false,
					allowBridge: false,
				},
			}),
		).toThrow(
			"at least one realization kind (native/pack/bridge) must be allowed",
		);
	});

	it("admits the same requirement when one realization survives", () => {
		expect(
			parseCapabilityRequirement({
				requiredProfiles: [POSTGRES],
				realization: {
					allowNative: false,
					allowPack: false,
					allowBridge: true,
				},
			}).realization,
		).toEqual({ native: false, pack: false, bridge: true });
	});

	it("throws CapabilityRequirementError with its documented code", () => {
		try {
			parseCapabilityRequirement({ requiredProfiles: [] });
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(CapabilityRequirementError);
			expect((error as CapabilityRequirementError).code).toBe(
				"INVALID_CAPABILITY_REQUIREMENT",
			);
		}
	});
});

describe("parseProfileId refuses each malformed shape by name", () => {
	it("refuses a missing version segment", () => {
		expect(() => parseProfileId("data.postgres")).toThrow(
			"must end with /v<major>",
		);
	});

	it("refuses v0", () => {
		expect(() => parseProfileId("data.postgres/v0")).toThrow(
			'version segment "v0" must be v<major> with major >= 1',
		);
	});

	it("refuses an uppercase id rather than lowercasing it", () => {
		expect(() => parseProfileId("Data.Postgres/v1")).toThrow(
			"must be lowercase (canonical form)",
		);
	});

	it("refuses a bare primitive with no name segment", () => {
		expect(() => parseProfileId("data/v1")).toThrow(
			"must be <primitive-family>.<name> before the version",
		);
	});

	it("refuses an unknown primitive family, naming it", () => {
		expect(() => parseProfileId("ledger.postgres/v1")).toThrow(
			'unknown primitive family "ledger"',
		);
	});

	it("carries the offending input on the error", () => {
		try {
			parseProfileId("data.postgres/v0");
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ProfileIdError);
			expect((error as ProfileIdError).input).toBe("data.postgres/v0");
			expect((error as ProfileIdError).code).toBe(
				"INVALID_CAPABILITY_PROFILE_ID",
			);
		}
	});
});

const BASE_DESCRIPTOR = STANDARD_CAPABILITY_PROFILES.find(
	(profile) => profile.id === "data.postgres/v1",
) as (typeof STANDARD_CAPABILITY_PROFILES)[number];

describe("parseCapabilityProfile refuses each malformed descriptor by name", () => {
	it("has a descriptor to work from", () => {
		expect(BASE_DESCRIPTOR?.id).toBe("data.postgres/v1");
	});

	it("refuses an unsupported schemaVersion, naming it", () => {
		expect(() =>
			parseCapabilityProfile({
				...BASE_DESCRIPTOR,
				schemaVersion: "hobo.capability-profile/v2" as never,
			}),
		).toThrow(
			"unsupported capability profile schemaVersion hobo.capability-profile/v2",
		);
	});

	it("refuses a primitive that disagrees with the id, naming both", () => {
		expect(() =>
			parseCapabilityProfile({ ...BASE_DESCRIPTOR, primitive: "kv" }),
		).toThrow(
			"data.postgres/v1 declares primitive kv but its id resolves to data",
		);
	});

	it("refuses a descriptor that cites no evidence", () => {
		expect(() =>
			parseCapabilityProfile({ ...BASE_DESCRIPTOR, sourceRefs: [] }),
		).toThrow("data.postgres/v1 must cite at least one evidence source");
	});

	it("refuses a fabricated (non-ISO) checkedAt, naming the source", () => {
		expect(() =>
			parseCapabilityProfile({
				...BASE_DESCRIPTOR,
				sourceRefs: [
					{ url: "https://example.invalid/x", checkedAt: "recently" },
				],
			}),
		).toThrow(
			"data.postgres/v1 source https://example.invalid/x needs an ISO date checkedAt",
		);
	});

	it("refuses a duplicate feature key, naming the key", () => {
		expect(() =>
			parseCapabilityProfile({
				...BASE_DESCRIPTOR,
				features: [
					{ key: "pooling", description: "a", valueKind: "boolean" },
					{ key: "pooling", description: "b", valueKind: "boolean" },
				],
			}),
		).toThrow("data.postgres/v1 declares duplicate feature pooling");
	});

	it("refuses a duplicate guarantee key with its own distinct message", () => {
		expect(() =>
			parseCapabilityProfile({
				...BASE_DESCRIPTOR,
				guarantees: [
					{ key: "tls", description: "a", valueKind: "boolean" },
					{ key: "tls", description: "b", valueKind: "boolean" },
				],
			}),
		).toThrow("data.postgres/v1 declares duplicate guarantee tls");
	});

	it("refuses a self-refinement", () => {
		expect(() =>
			parseCapabilityProfile({
				...BASE_DESCRIPTOR,
				refines: ["data.postgres/v1"],
			}),
		).toThrow("data.postgres/v1 refines itself");
	});

	it("refuses a duplicated refinement target, naming the field", () => {
		expect(() =>
			parseCapabilityProfile({
				...BASE_DESCRIPTOR,
				refines: ["data.relational/v1", "data.relational/v1"],
			}),
		).toThrow(
			"data.postgres/v1.refines lists data.relational/v1 more than once",
		);
	});

	it("carries the documented error code on a refinement cycle", () => {
		try {
			parseCapabilityProfile({
				...BASE_DESCRIPTOR,
				refines: ["data.postgres/v1"],
			});
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(CapabilityProfileError);
			expect((error as CapabilityProfileError).code).toBe(
				"PROFILE_REFINEMENT_CYCLE",
			);
		}
	});
});

describe("the wire codec refuses what it cannot carry, rather than guessing", () => {
	const requirement = parseCapabilityRequirement({
		requiredProfiles: [POSTGRES],
	});
	const wire = toCapabilityRequirementWire(requirement);

	it("refuses a non-finite feature value at encode time, naming the field", () => {
		expect(() =>
			toCapabilityRequirementWire(
				parseCapabilityRequirement({
					requiredProfiles: [POSTGRES],
					features: [
						{
							key: "maxStorageBytes",
							operator: "at-least",
							value: Number.POSITIVE_INFINITY,
							necessity: "required",
						},
					],
				}),
			),
		).toThrow(
			"features[0].value is Infinity; a non-finite requirement value has no wire encoding and no meaning as a threshold",
		);
	});

	it("refuses an int_value outside exact JavaScript integer range", () => {
		expect(() =>
			fromCapabilityRequirementWire({
				...wire,
				features: [
					{
						key: "maxStorageBytes",
						operator: "at-least",
						value: { int_value: "9007199254740993" },
						necessity: "required",
					},
				],
			}),
		).toThrow(
			"features[0].value.int_value 9007199254740993 is outside the range a JavaScript number represents exactly",
		);
	});

	it("accepts the largest int_value that is exact", () => {
		const decoded = fromCapabilityRequirementWire({
			...wire,
			features: [
				{
					key: "maxStorageBytes",
					operator: "at-least",
					value: { int_value: "9007199254740991" },
					necessity: "required",
				},
			],
		});
		expect(decoded.features[0]?.value).toBe(9_007_199_254_740_991);
	});

	it("refuses a RequirementValue holding two arms at once", () => {
		expect(() =>
			fromCapabilityRequirementWire({
				...wire,
				features: [
					{
						key: "k",
						operator: "equals",
						value: { bool_value: true, string_value: "yes" },
						necessity: "required",
					},
				],
			}),
		).toThrow(
			"features[0].value must hold exactly one of bool_value/int_value/double_value/string_value/string_set_value, received 2",
		);
	});

	it("refuses an operator outside the feature vocabulary, listing the vocabulary", () => {
		expect(() =>
			fromCapabilityRequirementWire({
				...wire,
				features: [
					{
						key: "k",
						operator: "at-most-ish",
						value: { bool_value: true },
						necessity: "required",
					},
				],
			}),
		).toThrow(
			'features[0].operator must be one of "equals", "at-least", "at-most", "one-of", "includes-all", received "at-most-ish"',
		);
	});

	it("refuses `at-most` on a guarantee, which features allow and guarantees do not", () => {
		// The two operator vocabularies are separate on purpose. This is the
		// case that proves it: the identical operator is admitted on a feature
		// and refused on a guarantee.
		expect(() =>
			fromCapabilityRequirementWire({
				...wire,
				guarantees: [
					{ key: "tls", operator: "at-most", value: { bool_value: true } },
				],
			}),
		).toThrow(
			'guarantees[0].operator must be one of "equals", "at-least", "one-of", received "at-most"',
		);
		expect(() =>
			fromCapabilityRequirementWire({
				...wire,
				features: [
					{
						key: "tls",
						operator: "at-most",
						value: { bool_value: true },
						necessity: "required",
					},
				],
			}),
		).not.toThrow();
	});

	it("refuses a wire form with no required profile", () => {
		expect(() =>
			fromCapabilityRequirementWire({ ...wire, required_profiles: [] }),
		).toThrow("required_profiles must name at least one profile");
	});

	it("refuses a missing portability field rather than defaulting it", () => {
		// The decoder must not re-derive parse-boundary defaults; if it did, a
		// lossy encoder would round-trip green. See the note in src/wire.ts.
		expect(() =>
			fromCapabilityRequirementWire({
				...wire,
				portability: { require_standard_binding: true },
			}),
		).toThrow(
			"portability.require_export_profile must be a boolean, received undefined",
		);
	});

	it("throws CapabilityWireError with its documented code", () => {
		try {
			fromCapabilityRequirementWire({ ...wire, required_profiles: [] });
			expect.unreachable("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(CapabilityWireError);
			expect((error as CapabilityWireError).code).toBe(
				"INVALID_CAPABILITY_WIRE",
			);
		}
	});

	it("refuses a descriptor whose schema_version is not the pinned one", () => {
		expect(() =>
			fromCapabilityProfileDescriptorWire({
				...toCapabilityProfileDescriptorWire(BASE_DESCRIPTOR),
				schema_version: "hobo.capability-profile/v2",
			}),
		).toThrow(
			'schema_version must be "hobo.capability-profile/v1", received "hobo.capability-profile/v2"',
		);
	});

	it("refuses a catalog envelope whose schema_version is not the pinned one", () => {
		expect(() =>
			fromCapabilityProfileCatalogWire({
				schema_version: "hobo.capability-profile-catalog/v2",
				profiles: [],
			}),
		).toThrow(
			'schema_version must be "hobo.capability-profile-catalog/v1", received "hobo.capability-profile-catalog/v2"',
		);
	});

	it("refuses a semver-range value_kind on a guarantee, which features allow", () => {
		const feature = toCapabilityProfileDescriptorWire(BASE_DESCRIPTOR);
		expect(() =>
			fromCapabilityProfileDescriptorWire({
				...feature,
				guarantees: [
					{ key: "tls", description: "d", value_kind: "semver-range" },
				],
			}),
		).toThrow(
			'guarantees[0].value_kind must be one of "boolean", "enum", "integer", received "semver-range"',
		);
		expect(() =>
			fromCapabilityProfileDescriptorWire({
				...feature,
				features: [
					{ key: "tls", description: "d", value_kind: "semver-range" },
				],
			}),
		).not.toThrow();
	});
});
