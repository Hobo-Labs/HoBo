/**
 * The Camp builder and the architectural rules it enforces.
 *
 * A Camp is a segment inside a Yard. The rules it refuses are the interesting
 * part, because each one is a boundary somebody will eventually try to cross by
 * accident:
 *
 * - **A Camp must not own a Bindle.** Ownership belongs to a deployment request
 *   against a Yard/Camp. Letting a Camp hold one would put deployment topology
 *   inside a segment definition, where nothing that decides placement can see it.
 * - **A Camp must not select a cloud provider.** Provider selection belongs on
 *   the Yard. A Camp that picked its own would let one Yard span two clouds
 *   without anything in the Yard's own declaration saying so.
 * - **`tier` is stated, never inferred.** `envType` *is* inferred from the name
 *   for backwards compatibility, and the source comment explains why that trick
 *   is not repeated: a Camp called `data-migration` would silently become a
 *   data-tier segment. The tests below hold both halves of that asymmetry.
 *
 * Each refusal carries a `code` and a `remediation`. Those are what a caller
 * branches on and what a user reads, so they are asserted rather than assumed —
 * an error whose code changed would silently stop being handled.
 *
 * Everything the builder returns is deep-frozen. That is load-bearing rather
 * than defensive: Camps are shared across a topology graph, and one caller
 * mutating a `require` array would change what every other reader sees.
 */
/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: test helpers intentionally inspect controlled Camp builder fixtures. */
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

/** The `code` a thrown refusal carries. */
function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}

function remediationOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return (error as { remediation?: string }).remediation;
	}
	return undefined;
}

describe("naming a camp", () => {
	it("builds one from a name alone", () => {
		const built = camp("staging");
		expect(built.kind).toBe("camp");
		expect(built.id).toBe("staging");
	});

	it("refuses an empty name", () => {
		// An unnamed Camp cannot be addressed by a deployment request, so it would
		// exist in the topology and be unreachable.
		expect(() => camp("")).toThrow(/camp name must be a non-empty string/u);
	});

	it("refuses a non-object config", () => {
		expect(() => camp("staging", "nope" as never)).toThrow(
			/config must be an object/u,
		);
	});

	it("refuses an array config, which is an object but not a config", () => {
		expect(() => camp("staging", [] as never)).toThrow(
			/config must be an object/u,
		);
	});

	it("takes the last path segment as the environment", () => {
		// Camps arrive namespaced from a Yard. Keeping the whole path as the env
		// would make the same Camp under two Yards look like two environments.
		expect(camp("acme/prod").env).toBe("prod");
	});

	it("strips a legacy provider suffix from the id", () => {
		// `checkout-aws` was the old display convention for a Camp's provider.
		// Keeping it would encode a provider into the Camp id, which is exactly
		// the coupling the provider rule exists to prevent.
		expect(camp("checkout-aws").id).toBe("checkout");
	});

	it("keeps a name that is only a provider word", () => {
		// Stripping here would leave an empty id. The fallback is what stops a
		// Camp legitimately named "local" from becoming nameless.
		expect(camp("local").id).toBe("local");
	});

	it("does not strip a provider word from the middle of a name", () => {
		expect(camp("aws-migration").id).toBe("aws-migration");
	});
});

describe("inferring an environment type", () => {
	for (const [name, envType] of [
		["prod", "production"],
		["production", "production"],
		["staging", "staging"],
		["preview", "ephemeral"],
		["pr", "ephemeral"],
		["ephemeral", "ephemeral"],
		["dev", "development"],
		["development", "development"],
		["local", "development"],
	] as const) {
		it(`reads ${name} as ${envType}`, () => {
			expect(camp(name).envType).toBe(envType);
		});
	}

	it("is case-insensitive", () => {
		expect(camp("PROD").envType).toBe("production");
	});

	it("falls back to the name for an environment it does not recognise", () => {
		// Guessing "production" for an unknown name would apply production posture
		// to a Camp nobody said was production.
		expect(camp("canary").envType).toBe("canary");
	});

	it("prefers an explicit envType over the inference", () => {
		// The inference is a convenience. A caller who states the type must not
		// have it overridden by what their Camp happens to be called.
		expect(camp("canary", { envType: "production" }).envType).toBe(
			"production",
		);
	});

	it("ignores an empty explicit envType", () => {
		expect(camp("prod", { envType: "" }).envType).toBe("production");
	});
});

describe("the tier is stated, never inferred", () => {
	it("accepts each named tier", () => {
		for (const tier of ["edge", "app", "data", "untrusted", "ops"]) {
			expect(camp("seg", { tier }).tier).toBe(tier);
		}
	});

	it("omits tier entirely when none is given", () => {
		// An `undefined` tier key would serialise into the topology and read as a
		// Camp that declared no tier, which is different from one that has none.
		expect("tier" in camp("seg")).toBe(false);
	});

	it("refuses a tier that is not a named one", () => {
		// The named set is what policy rules match on. An unrecognised tier would
		// silently match nothing and the Camp would be governed by no rule at all.
		expect(() => camp("seg", { tier: "middleware" })).toThrow(
			/is not a named tier/u,
		);
	});

	it("codes the unknown tier so a caller can branch on it", () => {
		expect(codeOf(() => camp("seg", { tier: "middleware" }))).toBe(
			"CAMP_TIER_UNKNOWN",
		);
	});

	it("lists the valid tiers in the remediation", () => {
		expect(remediationOf(() => camp("seg", { tier: "middleware" }))).toContain(
			"edge, app, data, untrusted, ops",
		);
	});

	it("does not infer a tier from a name that contains one", () => {
		// This is the asymmetry the source comment calls out: envType is inferred
		// from the name, tier deliberately is not. A Camp called "data-migration"
		// becoming a data-tier segment would put migration traffic under data
		// policy without anybody saying so.
		expect("tier" in camp("data-migration")).toBe(false);
		expect(camp("data-migration").envType).toBe("data-migration");
	});
});

describe("refusing to own a bindle", () => {
	it("refuses a camp carrying a bindle", () => {
		// Ownership belongs to a deployment request. A Camp holding one puts
		// deployment topology inside a segment definition, where nothing that
		// decides placement can see it.
		expect(() => camp("seg", { bindle: {} as never })).toThrow(
			/must not own a Bindle/u,
		);
	});

	it("codes the refusal distinctly from the provider one", () => {
		// Two different architectural rules, two different fixes. A shared code
		// would send the caller to the wrong remediation.
		expect(codeOf(() => camp("seg", { bindle: {} as never }))).toBe(
			CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
		);
	});

	it("names the correct shape in the remediation", () => {
		expect(remediationOf(() => camp("seg", { bindle: {} as never }))).toContain(
			"deploy(bindle, { yard, camp })",
		);
	});
});

describe("refusing to select a provider", () => {
	for (const key of ["defaultProvider", "tiers", "bindings"]) {
		it(`refuses a camp carrying ${key}`, () => {
			// All three are provider-selection surfaces from the old model. Missing
			// any one of them would leave a way to smuggle a provider into a Camp.
			expect(() => camp("seg", { [key]: {} } as never)).toThrow(
				/must not select a cloud provider/u,
			);
		});
	}

	it("codes every provider refusal the same way", () => {
		expect(codeOf(() => camp("seg", { tiers: {} } as never))).toBe(
			CAMP_MIGRATION_CODE,
		);
	});

	it("refuses a provider-specific label", () => {
		// Labels are free-form, which makes them the obvious place to hide a
		// provider once the explicit fields are closed off.
		expect(() => camp("seg", { labels: { provider: "aws" } })).toThrow(
			/provider-specific label forbidden/u,
		);
	});

	for (const key of ["provider", "providerId", "resolverId", "PROVIDER"]) {
		it(`refuses the label ${key} regardless of case`, () => {
			expect(() => camp("seg", { labels: { [key]: "aws" } })).toThrow(
				/label forbidden/u,
			);
		});
	}

	it("refuses a non-string label value", () => {
		// Labels are matched as strings. A number would compare false against
		// every rule and the Camp would quietly match nothing.
		expect(() => camp("seg", { labels: { size: 3 } as never })).toThrow(
			/must be a string/u,
		);
	});
});

describe("canonicalising the lists", () => {
	it("sorts and dedupes require", () => {
		// Two Camps declaring the same requirements in different orders must
		// produce the same Camp, or content hashes over the topology differ for
		// no reason.
		expect(camp("seg", { require: ["b", "a", "b"] }).require).toEqual([
			"a",
			"b",
		]);
	});

	it("sorts and dedupes prefer the same way", () => {
		expect(camp("seg", { prefer: ["z", "a", "z"] }).prefer).toEqual(["a", "z"]);
	});

	it("drops empty strings rather than carrying a nameless requirement", () => {
		expect(camp("seg", { require: ["", "a"] }).require).toEqual(["a"]);
	});

	it("drops non-strings", () => {
		expect(camp("seg", { require: [1, "a"] as never }).require).toEqual(["a"]);
	});

	it("ignores a require that is not an array at all", () => {
		expect(camp("seg", { require: "a" as never }).require).toEqual([]);
	});

	it("sorts label keys", () => {
		expect(
			Object.keys(camp("seg", { labels: { z: "1", a: "2" } }).labels),
		).toEqual(["a", "z"]);
	});
});

describe("freezing", () => {
	it("freezes the camp itself", () => {
		// Camps are shared across a topology graph. One caller mutating a shared
		// Camp changes what every other reader sees, and the change is invisible
		// at the point it is later observed.
		const built = camp("seg");
		expect(Object.isFrozen(built)).toBe(true);
	});

	it("freezes the nested lists too", () => {
		// A shallow freeze would leave `require` mutable, which is the array most
		// likely to be pushed into by a caller building up requirements.
		const built = camp("seg", { require: ["a"] });
		expect(Object.isFrozen(built.require)).toBe(true);
		expect(Object.isFrozen(built.labels)).toBe(true);
	});
});

describe("attaching a camp to a yard", () => {
	it("namespaces the id under the yard", () => {
		// The same Camp definition can be attached to two Yards. Without the
		// namespace both would answer to one id and the second would shadow the
		// first wherever Camps are looked up.
		const attached = attachCampToYard(camp("checkout"), {
			yardId: "acme",
			providerId: "aws",
		});
		expect(attached.id).toBe("acme/checkout");
		expect(attached.name).toBe("acme/checkout");
	});

	it("derives the provider from the yard", () => {
		const attached = attachCampToYard(camp("checkout"), {
			yardId: "acme",
			providerId: "aws",
		});
		expect(attached.derivedProviderId).toBe("aws");
		expect(attached.enclosingYardId).toBe("acme");
	});

	it("refuses something that is not a camp", () => {
		expect(() =>
			attachCampToYard({ kind: "yard" } as never, {
				yardId: "acme",
				providerId: "aws",
			}),
		).toThrow(/expects a Camp object/u);
	});

	it("refuses an empty yard id", () => {
		expect(() =>
			attachCampToYard(camp("c"), { yardId: "", providerId: "aws" }),
		).toThrow(/yard id must be a non-empty string/u);
	});

	it("refuses an empty provider id", () => {
		expect(() =>
			attachCampToYard(camp("c"), { yardId: "acme", providerId: "" }),
		).toThrow(/provider id must be a non-empty string/u);
	});

	it("refuses to re-attach under a different provider", () => {
		// A Camp already derived from one provider cannot be moved under another
		// by re-attaching: its resolvers and mappings were resolved against the
		// first, so the result would be internally inconsistent.
		const attached = attachCampToYard(camp("c"), {
			yardId: "acme",
			providerId: "aws",
		});
		expect(() =>
			attachCampToYard(attached, { yardId: "acme", providerId: "gcp" }),
		).toThrow(/disagrees with Yard provider/u);
	});

	it("allows re-attaching under the same provider", () => {
		// Idempotent re-attachment happens when a topology is rebuilt. Refusing it
		// would make a rebuild fail on unchanged input.
		const attached = attachCampToYard(camp("c"), {
			yardId: "acme",
			providerId: "aws",
		});
		expect(() =>
			attachCampToYard(attached, { yardId: "acme", providerId: "aws" }),
		).not.toThrow();
	});

	it("keeps the camp's own mappings when the yard supplies none", () => {
		// Passing none means "no opinion", not "clear them". Overwriting would
		// silently discard mappings the Camp author wrote.
		const built = camp("c", {
			resourceMappings: [{ selector: { resourceName: "db" } }],
		} as never);
		const attached = attachCampToYard(built, {
			yardId: "acme",
			providerId: "aws",
		});
		expect(attached.resourceMappings).toHaveLength(1);
	});

	it("replaces the mappings when the yard supplies them", () => {
		const built = camp("c", {
			resourceMappings: [{ selector: { resourceName: "db" } }],
		} as never);
		const attached = attachCampToYard(built, {
			yardId: "acme",
			providerId: "aws",
			resourceMappings: [],
		});
		expect(attached.resourceMappings).toEqual([]);
	});

	it("freezes the attached camp", () => {
		const attached = attachCampToYard(camp("c"), {
			yardId: "acme",
			providerId: "aws",
		});
		expect(Object.isFrozen(attached)).toBe(true);
	});
});

describe("resolver pins", () => {
	it("adds a pin", () => {
		const pinned = withResolvers(camp("c"), { db: "postgres" });
		expect(pinned.resolverConfig.pins).toEqual([
			{ slot: "db", resolverId: "postgres" },
		]);
	});

	it("refuses something that is not a camp", () => {
		expect(() => withResolvers({} as never, {})).toThrow(
			/expects a Camp object/u,
		);
	});

	it("refuses two pins for one slot", () => {
		// A slot with two resolvers has no defined winner, and picking one
		// silently would resolve a resource against a provider the author did not
		// choose.
		const pinned = withResolvers(camp("c"), { db: "postgres" });
		expect(() => withResolvers(pinned, { db: "mysql" })).toThrow(
			/duplicate resolver pin slot: db/u,
		);
	});

	it("allows pinning a second, different slot", () => {
		const pinned = withResolvers(camp("c"), { db: "postgres" });
		expect(
			withResolvers(pinned, { cache: "redis" }).resolverConfig.pins,
		).toHaveLength(2);
	});

	it("refuses a pin with no resolver id", () => {
		expect(() =>
			camp("c", { resolverConfig: { pins: [{ slot: "db" }] } } as never),
		).toThrow(/requires slot and resolverId/u);
	});

	it("refuses a pin with no slot", () => {
		expect(() =>
			camp("c", {
				resolverConfig: { pins: [{ resolverId: "postgres" }] },
			} as never),
		).toThrow(/requires slot and resolverId/u);
	});

	it("refuses duplicate slots declared at construction", () => {
		expect(() =>
			camp("c", {
				resolverConfig: {
					pins: [
						{ slot: "db", resolverId: "a" },
						{ slot: "db", resolverId: "b" },
					],
				},
			} as never),
		).toThrow(/duplicate resolver pin slot/u);
	});
});

describe("the public shape", () => {
	it("strips the yard namespace back off the id", () => {
		// The shape is what a Camp author sees. Showing them `acme/checkout` when
		// they wrote `checkout` would make the two look like different things.
		const attached = attachCampToYard(camp("checkout"), {
			yardId: "acme",
			providerId: "aws",
		});
		expect(campToShape(attached).id).toBe("checkout");
	});

	it("leaves an unattached id alone", () => {
		expect(campToShape(camp("checkout")).id).toBe("checkout");
	});

	it("does not expose the derived provider", () => {
		// The shape is the provider-agnostic view. Leaking the derived provider
		// through it would let authoring code start depending on it.
		const attached = attachCampToYard(camp("checkout"), {
			yardId: "acme",
			providerId: "aws",
		});
		const shape = campToShape(attached) as Record<string, unknown>;
		expect(shape.derivedProviderId).toBeUndefined();
		expect(shape.resolverConfig).toBeUndefined();
	});

	it("is frozen", () => {
		expect(Object.isFrozen(campToShape(camp("c")))).toBe(true);
	});
});

describe("legacy provider mappings", () => {
	it("accepts mappings whose provider matches the yard", () => {
		const result = parseLegacyCampMappings(
			{ bindings: { db: { providerId: "aws", selector: "rds" } } },
			"aws",
		);
		expect(result.resourceMappings).toHaveLength(1);
		expect(result.resourceMappings[0]?.resolverId).toBe("rds");
	});

	it("refuses a mapping naming a different provider", () => {
		// This is the compatibility shim's one rule: legacy mappings are tolerated
		// only where they agree with the Yard. A disagreement means the old config
		// genuinely spanned two clouds, which the new model cannot express.
		expect(() =>
			parseLegacyCampMappings(
				{ bindings: { db: { providerId: "gcp" } } },
				"aws",
			),
		).toThrow(/!= yard provider/u);
	});

	it("checks the default provider too", () => {
		expect(() =>
			parseLegacyCampMappings(
				{ defaultProvider: { providerId: "gcp" } },
				"aws",
			),
		).toThrow(/!= yard provider/u);
	});

	it("checks tier mappings too", () => {
		expect(() =>
			parseLegacyCampMappings(
				{ tiers: { data: { providerId: "gcp" } } },
				"aws",
			),
		).toThrow(/!= yard provider/u);
	});

	it("maps a binding onto a resource-name selector", () => {
		const result = parseLegacyCampMappings(
			{ bindings: { db: { providerId: "aws" } } },
			"aws",
		);
		expect(result.resourceMappings[0]?.selector).toEqual({
			resourceName: "db",
		});
	});

	it("maps a tier onto a resource-kind selector", () => {
		// Bindings named a specific resource; tiers named a class of them. Losing
		// that distinction would apply one resource's mapping to every resource of
		// its kind.
		const result = parseLegacyCampMappings(
			{ tiers: { cache: { providerId: "aws" } } },
			"aws",
		);
		expect(result.resourceMappings[0]?.selector).toEqual({
			resourceKind: "cache",
		});
	});

	it("maps a default provider onto an empty selector", () => {
		const result = parseLegacyCampMappings(
			{ defaultProvider: { providerId: "aws", selector: "ec2" } },
			"aws",
		);
		expect(result.resourceMappings.at(-1)?.selector).toEqual({});
	});

	it("omits a default provider that pins no resolver", () => {
		// Without a selector there is nothing to carry forward — an empty catch-all
		// rule would match every resource and resolve none of them.
		const result = parseLegacyCampMappings(
			{ defaultProvider: { providerId: "aws" } },
			"aws",
		);
		expect(result.resourceMappings).toEqual([]);
	});

	it("returns nothing for empty input", () => {
		expect(parseLegacyCampMappings({}, "aws").resourceMappings).toEqual([]);
	});

	it("says the mappings were stripped", () => {
		// The deprecation string is what surfaces to a user still on the old
		// config. Silence would let them keep writing it indefinitely.
		expect(parseLegacyCampMappings({}, "aws").deprecation).toContain(
			"stripped from canonical camp",
		);
	});

	it("freezes what it returns", () => {
		expect(
			Object.isFrozen(parseLegacyCampMappings({}, "aws").resourceMappings),
		).toBe(true);
	});
});
