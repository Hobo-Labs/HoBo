/**
 * Camp authoring, and the two things a Camp is forbidden to do.
 *
 * `camp.test.ts` covers the shape; this covers the refusals and the
 * canonicalization, which are where the topology model is actually enforced.
 *
 * **A Camp does not own a Bindle and does not choose a provider.** Both are
 * refused with their own error code and a remediation naming the correct call,
 * because the failure they prevent is architectural: a Camp that pinned a
 * provider would make the Bindle→Camp→Yard layering a suggestion rather than a
 * rule, and the whole portability story rests on it being a rule.
 *
 * **`envType` is inferred; `tier` never is.** That asymmetry is deliberate and
 * documented in the source, and it is worth pinning precisely because it looks
 * like an inconsistency someone would "fix": inferring tier from a name would
 * make a Camp called `data-migration` silently a data-tier segment.
 *
 * Canonicalization — sorted, de-duplicated lists and sorted labels — is what
 * lets two Camps written in different orders hash the same, so it is asserted
 * rather than assumed.
 */
/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: test helpers intentionally inspect controlled Camp compatibility fixtures. */
import { describe, expect, it } from "vitest";

import {
	attachCampToYard,
	CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
	CAMP_MIGRATION_CODE,
	camp,
	campToShape,
	parseLegacyCampMappings,
	withResolvers,
} from "../src/camp.js";

const codeOf = (fn: () => unknown): string | undefined => {
	try {
		fn();
		return undefined;
	} catch (error) {
		return (error as { code?: string }).code;
	}
};

describe("camp()", () => {
	it("builds a minimal Camp", () => {
		expect(camp("prod")).toMatchObject({
			kind: "camp",
			id: "prod",
			env: "prod",
		});
	});

	it.each(["", null, undefined, 7])("rejects the name %s", (name) => {
		expect(() => camp(name as string)).toThrow(TypeError);
	});

	it.each([null, "config", 7, []])("rejects the config %s", (config) => {
		expect(() => camp("prod", config as never)).toThrow(TypeError);
	});

	it("takes the last segment of a slash-qualified name as the env", () => {
		expect(camp("acme/prod").env).toBe("prod");
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(camp("prod"))).toBe(true);
	});
});

describe("a Camp may not own a Bindle", () => {
	it("refuses a bindle in the config", () => {
		expect(codeOf(() => camp("prod", { bindle: {} } as never))).toBe(
			CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
		);
	});

	it("names the correct call in the remediation", () => {
		// An architectural refusal without the alternative is a dead end.
		try {
			camp("prod", { bindle: {} } as never);
		} catch (error) {
			expect((error as { remediation?: string }).remediation).toMatch(
				/deploy\(bindle/u,
			);
		}
	});
});

describe("a Camp may not select a provider", () => {
	it.each([
		"defaultProvider",
		"tiers",
		"bindings",
	])("refuses %s in the config", (key) => {
		// The layering the whole portability story rests on: a Camp that
		// pinned a provider would make Bindle→Camp→Yard a suggestion.
		expect(codeOf(() => camp("prod", { [key]: {} } as never))).toBe(
			CAMP_MIGRATION_CODE,
		);
	});

	it("points at yard() in the remediation", () => {
		try {
			camp("prod", { defaultProvider: {} } as never);
		} catch (error) {
			expect((error as { remediation?: string }).remediation).toMatch(
				/yard\(/u,
			);
		}
	});

	it("refuses a provider-shaped label", () => {
		// The same rule, one level down: a label is not an escape hatch.
		expect(
			codeOf(() => camp("prod", { labels: { provider: "aws" } } as never)),
		).toBe(CAMP_MIGRATION_CODE);
	});

	it.each([
		"provider",
		"providerId",
		"resolverId",
		"PROVIDER",
		"ProviderId",
	])("refuses the label %s in any case", (key) => {
		expect(
			codeOf(() => camp("prod", { labels: { [key]: "aws" } } as never)),
		).toBe(CAMP_MIGRATION_CODE);
	});

	it("allows an unrelated label", () => {
		expect(camp("prod", { labels: { team: "core" } }).labels).toEqual({
			team: "core",
		});
	});

	it("rejects a non-string label value", () => {
		expect(() => camp("prod", { labels: { team: 7 } } as never)).toThrow(
			TypeError,
		);
	});
});

describe("envType is inferred", () => {
	it.each([
		["prod", "production"],
		["production", "production"],
		["PROD", "production"],
		["staging", "staging"],
		["preview", "ephemeral"],
		["pr", "ephemeral"],
		["ephemeral", "ephemeral"],
		["dev", "development"],
		["development", "development"],
		["local", "development"],
	])("infers %s as %s", (name, envType) => {
		expect(camp(name).envType).toBe(envType);
	});

	it("falls back to the name itself for an unrecognised env", () => {
		expect(camp("qa").envType).toBe("qa");
	});

	it("prefers an explicit envType over the inference", () => {
		expect(camp("qa", { envType: "staging" }).envType).toBe("staging");
	});

	it("ignores an empty explicit envType", () => {
		expect(camp("prod", { envType: "" }).envType).toBe("production");
	});
});

describe("tier is never inferred", () => {
	it.each([
		"edge",
		"app",
		"data",
		"untrusted",
		"ops",
	])("accepts the named tier %s", (tier) => {
		expect(camp("prod", { tier } as never).tier).toBe(tier);
	});

	it("refuses an unnamed tier rather than guessing", () => {
		expect(codeOf(() => camp("prod", { tier: "backend" } as never))).toBe(
			"CAMP_TIER_UNKNOWN",
		);
	});

	it("does not infer a tier from the Camp's name", () => {
		// The documented asymmetry with envType, and the reason for it: a Camp
		// called "data-migration" must not silently become a data-tier segment.
		expect(camp("data-migration")).not.toHaveProperty("tier");
	});

	it("omits tier entirely when unset", () => {
		expect(camp("prod")).not.toHaveProperty("tier");
	});

	it("names the permitted tiers in the remediation", () => {
		try {
			camp("prod", { tier: "backend" } as never);
		} catch (error) {
			expect((error as { remediation?: string }).remediation).toMatch(
				/edge, app, data, untrusted, ops/u,
			);
		}
	});
});

describe("canonicalization", () => {
	it("sorts and de-duplicates the require list", () => {
		// Two Camps written in different orders must hash the same.
		expect(camp("prod", { require: ["b", "a", "b"] }).require).toEqual([
			"a",
			"b",
		]);
	});

	it("drops empty and non-string entries", () => {
		expect(
			camp("prod", { require: ["a", "", 7, null] } as never).require,
		).toEqual(["a"]);
	});

	it("applies the same rules to prefer", () => {
		expect(camp("prod", { prefer: ["z", "a", "a"] }).prefer).toEqual([
			"a",
			"z",
		]);
	});

	it("treats a non-array list as empty", () => {
		expect(camp("prod", { require: "a" } as never).require).toEqual([]);
	});

	it("sorts label keys", () => {
		expect(
			Object.keys(camp("prod", { labels: { z: "1", a: "2" } }).labels),
		).toEqual(["a", "z"]);
	});

	it("freezes the canonicalized lists", () => {
		const built = camp("prod", { require: ["a"] });
		expect(Object.isFrozen(built.require)).toBe(true);
	});

	it("strips a legacy provider suffix from the id but keeps the env", () => {
		const built = camp("prod-aws");
		expect(built.id).toBe("prod");
		expect(built.env).toBe("prod-aws");
	});

	it.each([
		"local",
		"aws",
		"azure",
		"gcp",
		"cloudflare",
		"oci",
		"wasm-sandbox",
	])("strips the legacy suffix -%s", (provider) => {
		expect(camp(`prod-${provider}`).id).toBe("prod");
	});

	it("does not strip a suffix that is the whole name", () => {
		expect(camp("aws").id).toBe("aws");
	});

	it("leaves an unrelated suffix alone", () => {
		expect(camp("prod-eu").id).toBe("prod-eu");
	});
});

describe("attachCampToYard", () => {
	it("qualifies the id with the yard", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "y1",
			providerId: "aws",
		});
		expect(attached.id).toBe("y1/prod");
		expect(attached.name).toBe("y1/prod");
	});

	it("derives the provider from the yard", () => {
		// Derived, never chosen — which is the whole point of attachment.
		expect(
			attachCampToYard(camp("prod"), { yardId: "y1", providerId: "aws" })
				.derivedProviderId,
		).toBe("aws");
	});

	it("records the enclosing yard", () => {
		expect(
			attachCampToYard(camp("prod"), { yardId: "y1", providerId: "aws" })
				.enclosingYardId,
		).toBe("y1");
	});

	it("rejects a non-Camp", () => {
		expect(() =>
			attachCampToYard({ kind: "yard" } as never, {
				yardId: "y1",
				providerId: "aws",
			}),
		).toThrow(TypeError);
	});

	it.each(["", null, undefined])("rejects the yard id %s", (yardId) => {
		expect(() =>
			attachCampToYard(camp("prod"), {
				yardId: yardId as string,
				providerId: "aws",
			}),
		).toThrow(TypeError);
	});

	it("rejects an empty provider id", () => {
		expect(() =>
			attachCampToYard(camp("prod"), { yardId: "y1", providerId: "" }),
		).toThrow(TypeError);
	});

	it("moves an attached Camp to a different provider Yard", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "y1",
			providerId: "aws",
		});
		expect(
			attachCampToYard(attached, { yardId: "y2", providerId: "gcp" }),
		).toMatchObject({
			id: "y2/prod",
			logicalId: "y1/y1/prod",
			derivedProviderId: "gcp",
			enclosingYardId: "y2",
		});
	});

	it("permits re-attaching to the same provider", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "y1",
			providerId: "aws",
		});
		expect(() =>
			attachCampToYard(attached, { yardId: "y2", providerId: "aws" }),
		).not.toThrow();
	});

	it("freezes the attached Camp", () => {
		expect(
			Object.isFrozen(
				attachCampToYard(camp("prod"), { yardId: "y1", providerId: "aws" }),
			),
		).toBe(true);
	});
});

describe("parseLegacyCampMappings", () => {
	it("accepts mappings whose provider equals the yard's", () => {
		const result = parseLegacyCampMappings(
			{ bindings: { db: { providerId: "aws", selector: "rds" } } as never },
			"aws",
		);
		expect(result.resourceMappings).toHaveLength(1);
	});

	it("refuses a mapping naming a different provider", () => {
		// Accepting it would let a Camp override its Yard by the back door.
		expect(
			codeOf(() =>
				parseLegacyCampMappings(
					{ bindings: { db: { providerId: "gcp" } } as never },
					"aws",
				),
			),
		).toBe(CAMP_MIGRATION_CODE);
	});

	it("checks defaultProvider as well as bindings", () => {
		expect(
			codeOf(() =>
				parseLegacyCampMappings(
					{ defaultProvider: { providerId: "gcp" } as never },
					"aws",
				),
			),
		).toBe(CAMP_MIGRATION_CODE);
	});

	it("checks tiers as well", () => {
		expect(
			codeOf(() =>
				parseLegacyCampMappings(
					{ tiers: { data: { providerId: "gcp" } } as never },
					"aws",
				),
			),
		).toBe(CAMP_MIGRATION_CODE);
	});

	it("maps a binding to a resource-name selector", () => {
		const result = parseLegacyCampMappings(
			{ bindings: { db: { providerId: "aws", selector: "rds" } } as never },
			"aws",
		);
		expect(result.resourceMappings[0]?.selector).toEqual({
			resourceName: "db",
		});
	});

	it("maps a tier to a resource-kind selector", () => {
		const result = parseLegacyCampMappings(
			{ tiers: { data: { providerId: "aws", selector: "rds" } } as never },
			"aws",
		);
		expect(result.resourceMappings[0]?.selector).toEqual({
			resourceKind: "data",
		});
	});

	it("maps a default provider to an empty selector", () => {
		const result = parseLegacyCampMappings(
			{ defaultProvider: { providerId: "aws", selector: "any" } as never },
			"aws",
		);
		expect(result.resourceMappings.at(-1)?.selector).toEqual({});
	});

	it("omits the default rule when it names no selector", () => {
		const result = parseLegacyCampMappings(
			{ defaultProvider: { providerId: "aws" } as never },
			"aws",
		);
		expect(result.resourceMappings).toHaveLength(0);
	});

	it("returns a deprecation note explaining what was stripped", () => {
		// Silence would let the legacy form look supported.
		expect(parseLegacyCampMappings({}, "aws").deprecation).toMatch(
			/stripped from canonical camp/u,
		);
	});

	it("accepts an empty input", () => {
		expect(parseLegacyCampMappings({}, "aws").resourceMappings).toEqual([]);
	});

	it("freezes the mappings", () => {
		expect(
			Object.isFrozen(parseLegacyCampMappings({}, "aws").resourceMappings),
		).toBe(true);
	});
});

describe("campToShape", () => {
	it("keeps the local id for an unattached Camp", () => {
		expect(campToShape(camp("prod")).id).toBe("prod");
	});

	it("strips the yard prefix from an attached Camp", () => {
		// A shape is Yard-relative, so carrying the Yard id would double it.
		const attached = attachCampToYard(camp("prod"), {
			yardId: "y1",
			providerId: "aws",
		});
		expect(campToShape(attached).id).toBe("prod");
	});

	it("carries env, envType and the canonical lists", () => {
		const shape = campToShape(camp("prod", { require: ["a"] }));
		expect(shape).toMatchObject({
			env: "prod",
			envType: "production",
			require: ["a"],
		});
	});

	it("does not leak the derived provider into the shape", () => {
		// A shape is the provider-neutral projection; including the derivation
		// would put provider detail back where it was refused.
		const attached = attachCampToYard(camp("prod"), {
			yardId: "y1",
			providerId: "aws",
		});
		expect(campToShape(attached)).not.toHaveProperty("derivedProviderId");
	});

	it("freezes the shape", () => {
		expect(Object.isFrozen(campToShape(camp("prod")))).toBe(true);
	});
});

describe("withResolvers", () => {
	it("rejects a non-Camp", () => {
		expect(() => withResolvers({ kind: "yard" } as never, {})).toThrow(
			TypeError,
		);
	});

	it("returns a Camp", () => {
		expect(withResolvers(camp("prod"), {}).kind).toBe("camp");
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(withResolvers(camp("prod"), {}))).toBe(true);
	});
});
