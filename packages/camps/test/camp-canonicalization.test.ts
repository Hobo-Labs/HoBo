/**
 * Camp authoring: canonicalization, the provider-neutrality guards, and Yard
 * attachment.
 *
 * A Camp exists to be placeable on any provider. Every guard here stops the
 * same class of failure: a Camp that names a provider, an account, or a region
 * still builds and still deploys — on exactly one provider — and nobody finds
 * out until a migration. The canonicalization assertions guard the other
 * silent failure: two authors writing the same Camp producing two different
 * identities, and therefore two different placement receipts.
 */

import { CAMP_TIERS } from "@hobo/core";
/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- SAFETY: test helpers intentionally inspect controlled canonicalization fixtures. */
import { describe, expect, it } from "vitest";

import {
	attachCampToYard,
	CAMP_BINDLE_OWNERSHIP_FORBIDDEN,
	CAMP_MIGRATION_CODE,
	camp,
	campToShape,
	parseLegacyCampMappings,
	providerSelection,
	withResolvers,
} from "../src/camp.js";
import { TOPOLOGY_CONTRACT_VERSION } from "../src/types.js";

function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}

/** Assert the refusal carries the migration code callers branch on. */
function expectMigrationRefusal(run: () => unknown, match: RegExp): void {
	try {
		run();
	} catch (error) {
		expect((error as Error).message).toMatch(match);
		// The code is what a codemod and the CLI's remediation hint key on. A
		// bare TypeError would satisfy `toThrow()` and tell an author nothing
		// about how to migrate.
		expect(codeOf(error)).toBe(CAMP_MIGRATION_CODE);
		return;
	}
	expect.unreachable(`expected a refusal matching ${match}`);
}

describe("camp() — identity and naming", () => {
	it("builds a frozen Camp stamped with the topology contract version", () => {
		const result = camp("prod");
		expect(result.kind).toBe("camp");
		// The contract version is how a reader of a stored topology knows which
		// shape it is looking at; omitting it would make an old topology
		// indistinguishable from a current one.
		expect(result.contract).toBe(TOPOLOGY_CONTRACT_VERSION);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.require)).toBe(true);
		expect(Object.isFrozen(result.labels)).toBe(true);
	});

	it("takes the last path segment of a slashed name as the env", () => {
		// A Camp authored as `acme/prod` is the `prod` Camp; keeping the whole
		// string as the env would make `envType` inference fail and produce a
		// Camp whose id contains a separator that Yard attachment then adds again.
		const result = camp("acme/prod");
		expect(result.env).toBe("prod");
		expect(result.id).toBe("prod");
		expect(result.name).toBe("prod");
	});

	it("keeps id and name identical", () => {
		// They are the same string by construction. A consumer that displays one
		// and keys on the other must not be able to see them diverge.
		const result = camp("staging");
		expect(result.id).toBe(result.name);
	});

	it("rejects an empty or non-string name", () => {
		for (const name of ["", undefined, null, 7]) {
			expect(() => camp(name as never), String(name)).toThrowError(TypeError);
		}
	});

	it("rejects a non-object config", () => {
		expect(() => camp("prod", "prod" as never)).toThrowError(
			/camp config must be an object/u,
		);
		// Arrays are objects to `typeof`; treating one as a config would read
		// every option as undefined and silently produce a default Camp.
		expect(() => camp("prod", [] as never)).toThrowError(
			/camp config must be an object/u,
		);
	});

	it("strips a legacy -<provider> display suffix from the id", () => {
		// The suffix was a display convention, not identity. Leaving it in would
		// make `prod-aws` and `prod-azure` two different Camps that are actually
		// the same segment placed twice.
		for (const provider of [
			"local",
			"aws",
			"azure",
			"gcp",
			"cloudflare",
			"oci",
			"wasm-sandbox",
		]) {
			expect(camp(`prod-${provider}`).id, provider).toBe("prod");
		}
		expect(camp("prod-AWS").id).toBe("prod");
	});

	it("keeps a name that is only a provider word", () => {
		// `camp("local")` is a legitimate Camp named for a local environment.
		// Stripping it would leave an empty id, so the whole-match case is
		// deliberately preserved.
		expect(camp("local").id).toBe("local");
		expect(camp("aws").id).toBe("aws");
	});

	it("does not strip a provider word that is not a suffix", () => {
		expect(camp("aws-prod").id).toBe("aws-prod");
		expect(camp("production").id).toBe("production");
	});
});

describe("camp() — envType", () => {
	it("infers a canonical envType from the env name", () => {
		const cases: Array<[string, string]> = [
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
		];
		for (const [env, expected] of cases) {
			// Inference exists for backwards compatibility only. Getting it wrong
			// would mislabel a production Camp as development, and envType is what
			// policy packs gate on.
			expect(camp(env).envType, env).toBe(expected);
		}
	});

	it("falls back to the env name for anything it does not recognize", () => {
		// Not "unknown" and not "development": an unrecognized env keeps its own
		// name so a policy pack can still match on it exactly.
		expect(camp("canary").envType).toBe("canary");
	});

	it("prefers an explicit non-empty envType over inference", () => {
		expect(camp("canary", { envType: "production" }).envType).toBe(
			"production",
		);
		// An empty string is not an override — it falls back to inference rather
		// than producing a Camp with no envType at all.
		expect(camp("prod", { envType: "" }).envType).toBe("production");
		expect(camp("prod", { envType: 7 as never }).envType).toBe("production");
	});
});

describe("camp() — tier", () => {
	it("accepts every named tier and omits the field when absent", () => {
		// `CAMP_TIERS` is a frozen record, not an array — the values are the
		// wire form and appear in Camp ids.
		for (const tier of Object.values(CAMP_TIERS)) {
			expect(camp("prod", { tier }).tier, tier).toBe(tier);
		}
		expect(Object.values(CAMP_TIERS)).toEqual([
			"edge",
			"app",
			"data",
			"untrusted",
			"ops",
		]);
		// Absent, not null: a Camp that segments on some other axis has no tier,
		// and a null would read as a tier value to anything doing a key check.
		expect(Object.hasOwn(camp("prod"), "tier")).toBe(false);
	});

	it("refuses an unknown tier rather than inferring one", () => {
		// The module states this explicitly: envType is inferred from the name
		// for compatibility, but repeating that trick for tier would make a Camp
		// called "data-migration" silently a data-tier segment — and tier drives
		// network segmentation.
		try {
			camp("prod", { tier: "database" as never });
			expect.unreachable("an unknown tier must be refused");
		} catch (error) {
			expect(codeOf(error)).toBe("CAMP_TIER_UNKNOWN");
			expect((error as { remediation?: string }).remediation).toMatch(
				/CAMP_TIERS/u,
			);
		}
	});
});

describe("camp() — provider neutrality", () => {
	it("refuses to own a Bindle", () => {
		try {
			camp("prod", { bindle: {} } as never);
			expect.unreachable("a Camp must not own a Bindle");
		} catch (error) {
			// Ownership belongs on the deployment request. A Camp that owned one
			// would make the Bindle undeployable to a second Camp.
			expect(codeOf(error)).toBe(CAMP_BINDLE_OWNERSHIP_FORBIDDEN);
			expect((error as { remediation?: string }).remediation).toMatch(
				/deploy\(bindle/u,
			);
		}
	});

	it("refuses each legacy provider-selection key", () => {
		for (const key of ["defaultProvider", "tiers", "bindings"]) {
			expectMigrationRefusal(
				() => camp("prod", { [key]: {} } as never),
				/must not select a cloud provider/u,
			);
		}
	});

	it("refuses a provider-specific label", () => {
		for (const key of ["provider", "providerId", "resolverId", "ProviderId"]) {
			expectMigrationRefusal(
				() => camp("prod", { labels: { [key]: "aws" } } as never),
				/provider-specific label forbidden/u,
			);
		}
	});

	it("refuses a non-string label value", () => {
		expect(() => camp("prod", { labels: { team: 7 } } as never)).toThrowError(
			/label team must be a string/u,
		);
	});

	it("refuses every provider account identifier as a property key", () => {
		for (const key of [
			"provider",
			"providerId",
			"subscriptionId",
			"accountId",
			"projectId",
			"resourceGroup",
			"SUBSCRIPTIONID",
		]) {
			// `subscriptionId`/`resourceGroup` are Azure, `projectId` is GCP,
			// `accountId` is AWS and Cloudflare. A Camp carrying any of them is no
			// longer placeable anywhere else — which is the leak this module
			// exists to prevent, and which `@hobo/bindles` already refuses for the
			// same key set.
			expectMigrationRefusal(
				() =>
					camp("prod", {
						resourceMappings: [
							{ selector: { resourceName: "db" }, properties: { [key]: "x" } },
						],
					} as never),
				/provider-specific property key forbidden/u,
			);
		}
	});

	it("drops resolverId from properties instead of refusing it", () => {
		// It is a first-class field on the rule, so an author who spelled it as a
		// property gets the field they meant rather than an error — and the
		// property does not shadow it.
		const result = camp("prod", {
			resourceMappings: [
				{
					selector: { resourceName: "db" },
					resolverId: "sqlite",
					properties: { resolverId: "postgres", size: "small" },
				},
			],
		} as never);
		expect(result.resourceMappings[0]?.resolverId).toBe("sqlite");
		expect(result.resourceMappings[0]?.properties).toEqual({ size: "small" });
	});

	it("refuses a resource mapping that carries a provider field", () => {
		for (const key of ["provider", "providerId"]) {
			expectMigrationRefusal(
				() =>
					camp("prod", {
						resourceMappings: [{ selector: {}, [key]: "aws" }],
					} as never),
				/must not include provider/u,
			);
		}
	});
});

describe("camp() — canonicalization", () => {
	it("sorts, de-duplicates and drops empties from require and prefer", () => {
		const result = camp("prod", {
			require: ["b", "a", "b", "", "c"],
			prefer: ["z", "y", "y"],
		} as never);
		// Canonical order is what makes two authors who listed the same
		// capabilities differently produce the same Camp — and therefore the same
		// placement receipt.
		expect(result.require).toEqual(["a", "b", "c"]);
		expect(result.prefer).toEqual(["y", "z"]);
	});

	it("ignores a non-array require or prefer rather than throwing", () => {
		// Tolerated because these arrive from hand-written topology files; the
		// canonical empty list is a safer read than a crash mid-parse.
		const result = camp("prod", { require: "a", prefer: 7 } as never);
		expect(result.require).toEqual([]);
		expect(result.prefer).toEqual([]);
	});

	it("drops non-string members from a capability list", () => {
		expect(camp("prod", { require: ["a", 7, null] } as never).require).toEqual([
			"a",
		]);
	});

	it("sorts label keys", () => {
		const result = camp("prod", { labels: { zeta: "1", alpha: "2" } });
		expect(Object.keys(result.labels)).toEqual(["alpha", "zeta"]);
	});

	it("produces an identical Camp regardless of authoring order", () => {
		const a = camp("prod", {
			require: ["b", "a"],
			labels: { z: "1", a: "2" },
			prefer: ["q"],
		});
		const b = camp("prod", {
			prefer: ["q"],
			labels: { a: "2", z: "1" },
			require: ["a", "b"],
		});
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});

describe("camp() — runtime requirements", () => {
	it("prefers an explicit runtimeRequirements list", () => {
		expect(
			camp("prod", { runtimeRequirements: ["wasm", "node"] } as never)
				.runtimeRequirements,
		).toEqual(["node", "wasm"]);
	});

	it("accepts a runtime descriptor as a string or an object with an id", () => {
		expect(
			camp("prod", { runtime: "wasm" } as never).runtimeRequirements,
		).toEqual(["wasm"]);
		expect(
			camp("prod", { runtime: { id: "node22" } } as never).runtimeRequirements,
		).toEqual(["node22"]);
	});

	it("falls back to the literal 'runtime' for a descriptor it cannot read", () => {
		// Pinning the fallback rather than assuming it throws. A descriptor with
		// no `id` yields the placeholder `"runtime"`, which will not match any
		// real runtime capability — so the Camp fails placement loudly rather
		// than being placed on an arbitrary runtime.
		expect(
			camp("prod", { runtime: { name: "node" } } as never).runtimeRequirements,
		).toEqual(["runtime"]);
		expect(camp("prod", { runtime: 7 } as never).runtimeRequirements).toEqual([
			"runtime",
		]);
	});

	it("ignores a falsy runtime and yields an empty list", () => {
		expect(camp("prod").runtimeRequirements).toEqual([]);
		expect(camp("prod", { runtime: "" } as never).runtimeRequirements).toEqual(
			[],
		);
	});
});

describe("camp() — resolver config", () => {
	it("defaults to the shared empty config", () => {
		const result = camp("prod");
		expect(result.resolverConfig.pins).toEqual([]);
		expect(result.resolverConfig.require).toEqual([]);
		expect(result.resolverConfig.properties).toEqual({});
	});

	it("parses pins and canonicalizes the rest", () => {
		const result = camp("prod", {
			resolverConfig: {
				pins: [{ slot: "kv", resolverId: "sqlite" }],
				require: ["b", "a"],
				properties: { z: 1, a: 2 },
				labels: { team: "core" },
			},
		} as never);
		expect(result.resolverConfig.pins).toEqual([
			{ slot: "kv", resolverId: "sqlite" },
		]);
		expect(result.resolverConfig.require).toEqual(["a", "b"]);
		expect(Object.keys(result.resolverConfig.properties)).toEqual(["a", "z"]);
	});

	it("refuses a pin missing either half", () => {
		for (const pin of [{ slot: "kv" }, { resolverId: "sqlite" }, {}, null]) {
			// A pin with no resolverId pins nothing; a pin with no slot pins
			// everything. Both are silently wrong at resolution time.
			expect(() =>
				camp("prod", { resolverConfig: { pins: [pin] } } as never),
			).toThrowError(/resolver pin requires slot and resolverId/u);
		}
	});

	it("refuses two pins for the same slot", () => {
		// Last-writer-wins would make resolution depend on authoring order, which
		// is exactly what the rest of this module works to eliminate.
		expect(() =>
			camp("prod", {
				resolverConfig: {
					pins: [
						{ slot: "kv", resolverId: "sqlite" },
						{ slot: "kv", resolverId: "redis" },
					],
				},
			} as never),
		).toThrowError(/duplicate resolver pin slot: kv/u);
	});

	it("refuses a property value that is not JSON-safe", () => {
		expect(() =>
			camp("prod", {
				resolverConfig: { properties: { fn: () => 1 } },
			} as never),
		).toThrowError(/must be JSON-safe/u);
	});

	it("keeps nested JSON property values, canonicalizing objects at depth", () => {
		const result = camp("prod", {
			resolverConfig: {
				properties: {
					nested: { z: 1, a: [true, null, "s"] },
				},
			},
		} as never);
		expect(
			Object.keys(result.resolverConfig.properties.nested as object),
		).toEqual(["a", "z"]);
	});
});

describe("camp() — resource mappings", () => {
	it("canonicalizes each rule and freezes it", () => {
		const result = camp("prod", {
			resourceMappings: [
				{
					selector: { resourceKind: "kv" },
					definitionId: "def-1",
					className: "kv",
					require: ["b", "a"],
					prefer: ["y"],
					properties: { z: 1, a: 2 },
				},
			],
		} as never);
		const rule = result.resourceMappings[0];
		expect(rule?.require).toEqual(["a", "b"]);
		expect(rule?.definitionId).toBe("def-1");
		expect(rule?.className).toBe("kv");
		expect(Object.isFrozen(rule)).toBe(true);
	});

	it("omits optional rule fields that were not supplied", () => {
		const rule = camp("prod", {
			resourceMappings: [{ selector: {} }],
		} as never).resourceMappings[0];
		// Absent rather than undefined-valued, so a serialized topology does not
		// carry keys the author never wrote.
		expect(Object.hasOwn(rule ?? {}, "definitionId")).toBe(false);
		expect(Object.hasOwn(rule ?? {}, "className")).toBe(false);
	});

	it("refuses a rule with no selector object", () => {
		for (const rule of [{}, { selector: "all" }, null, "rule"]) {
			expect(() =>
				camp("prod", { resourceMappings: [rule] } as never),
			).toThrowError(/resource mapping requires selector object/u);
		}
	});

	it("ignores a non-array resourceMappings", () => {
		expect(
			camp("prod", { resourceMappings: {} } as never).resourceMappings,
		).toEqual([]);
	});
});

describe("attachCampToYard", () => {
	it("namespaces identity under the Yard and derives the provider", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "eu",
			providerId: "aws",
		});
		// Canonical identity is `<yardId>/<campId>` so the same Camp attached to
		// two Yards is two distinct placements rather than one ambiguous one.
		expect(attached.id).toBe("eu/prod");
		expect(attached.name).toBe("eu/prod");
		expect(attached.derivedProviderId).toBe("aws");
		expect(attached.enclosingYardId).toBe("eu");
		expect(Object.isFrozen(attached)).toBe(true);
	});

	it("is idempotent for the same provider", () => {
		const once = attachCampToYard(camp("prod"), {
			yardId: "eu",
			providerId: "aws",
		});
		expect(attachCampToYard(once, { yardId: "eu", providerId: "aws" })).toEqual(
			once,
		);
	});

	it("moves the logical Camp to a new provider Yard without changing the source placement", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "eu",
			providerId: "aws",
		});
		const moved = attachCampToYard(attached, {
			yardId: "us",
			providerId: "gcp",
		});
		expect(moved).toMatchObject({
			id: "us/prod",
			logicalId: "eu/eu/prod",
			enclosingYardId: "us",
			derivedProviderId: "gcp",
		});
		expect(attached).toMatchObject({
			id: "eu/prod",
			logicalId: "eu/eu/prod",
			enclosingYardId: "eu",
			derivedProviderId: "aws",
		});
		expect(() =>
			attachCampToYard(attached, { yardId: "eu", providerId: "gcp" }),
		).toThrow(/disagrees with Yard provider/u);
	});

	it("refuses a non-Camp, an empty yardId and an empty providerId", () => {
		expect(() =>
			attachCampToYard({ kind: "yard" } as never, {
				yardId: "eu",
				providerId: "aws",
			}),
		).toThrowError(/expects a Camp object/u);
		expect(() =>
			attachCampToYard(undefined as never, { yardId: "eu", providerId: "aws" }),
		).toThrowError(/expects a Camp object/u);
		expect(() =>
			attachCampToYard(camp("prod"), { yardId: "", providerId: "aws" }),
		).toThrowError(/yard id must be a non-empty string/u);
		expect(() =>
			attachCampToYard(camp("prod"), { yardId: "eu", providerId: "" }),
		).toThrowError(/provider id must be a non-empty string/u);
	});

	it("merges resolver config, with the Yard overlay winning per slot", () => {
		const base = camp("prod", {
			resolverConfig: {
				pins: [{ slot: "kv", resolverId: "sqlite" }],
				require: ["a"],
				properties: { shared: "camp", campOnly: "1" },
				labels: { team: "core" },
			},
		} as never);
		const attached = attachCampToYard(base, {
			yardId: "eu",
			providerId: "aws",
			resolverConfig: {
				pins: [{ slot: "kv", resolverId: "dynamo" }],
				require: ["b"],
				properties: { shared: "yard" },
				labels: { region: "eu" },
			},
		} as never);
		// The Yard is the more specific scope, so its pin for a slot replaces the
		// Camp's rather than duplicating it — a duplicate would trip the
		// duplicate-slot guard and make a legitimate attachment impossible.
		expect(attached.resolverConfig.pins).toEqual([
			{ slot: "kv", resolverId: "dynamo" },
		]);
		// Capability lists union rather than replace: both scopes' requirements
		// have to hold.
		expect(attached.resolverConfig.require).toEqual(["a", "b"]);
		expect(attached.resolverConfig.properties.shared).toBe("yard");
		expect(attached.resolverConfig.properties.campOnly).toBe("1");
		expect(attached.resolverConfig.labels).toEqual({
			region: "eu",
			team: "core",
		});
		expect(
			attachCampToYard(attached, { yardId: "eu", providerId: "aws" }),
		).toEqual(attached);
		const moved = attachCampToYard(attached, {
			yardId: "west",
			providerId: "gcp",
			resolverConfig: {
				pins: [{ slot: "kv", resolverId: "firestore" }],
				properties: { destinationOnly: "yes" },
			},
		});
		expect(moved.resolverConfig.pins).toEqual([
			{ slot: "kv", resolverId: "firestore" },
		]);
		expect(moved.resolverConfig.properties).toEqual({
			shared: "camp",
			campOnly: "1",
			destinationOnly: "yes",
		});
		expect(moved.resolverConfig.require).toEqual(["a"]);
		expect(moved.resolverConfig.labels).toEqual({ team: "core" });
	});

	it("keeps the Camp's mappings when the Yard supplies none", () => {
		const base = camp("prod", {
			resourceMappings: [{ selector: { resourceKind: "kv" } }],
		} as never);
		const attached = attachCampToYard(base, {
			yardId: "eu",
			providerId: "aws",
		});
		// Absent means "no opinion", not "clear them" — otherwise attaching a
		// Camp would silently drop its own resource mappings.
		expect(attached.resourceMappings).toEqual(base.resourceMappings);
	});

	it("replaces the Camp's mappings when the Yard supplies its own", () => {
		const attached = attachCampToYard(
			camp("prod", {
				resourceMappings: [{ selector: { resourceKind: "kv" } }],
			} as never),
			{
				yardId: "eu",
				providerId: "aws",
				resourceMappings: [{ selector: { resourceName: "db" } }],
			} as never,
		);
		expect(attached.resourceMappings).toHaveLength(1);
		expect(attached.resourceMappings[0]?.selector).toEqual({
			resourceName: "db",
		});
	});

	it("applies the neutrality guards to Yard-supplied mappings too", () => {
		expectMigrationRefusal(
			() =>
				attachCampToYard(camp("prod"), {
					yardId: "eu",
					providerId: "aws",
					resourceMappings: [{ selector: {}, providerId: "aws" }],
				} as never),
			/must not include provider/u,
		);
	});
});

describe("withResolvers", () => {
	it("appends pins to an existing config", () => {
		const result = withResolvers(camp("prod"), { kv: "sqlite", blob: "fs" });
		expect(result.resolverConfig.pins).toEqual([
			{ slot: "kv", resolverId: "sqlite" },
			{ slot: "blob", resolverId: "fs" },
		]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("refuses a pin that collides with one already present", () => {
		const base = camp("prod", {
			resolverConfig: { pins: [{ slot: "kv", resolverId: "sqlite" }] },
		} as never);
		// Same reason as the parse-time guard: silently overriding would make
		// resolution depend on which call happened last.
		expect(() => withResolvers(base, { kv: "redis" })).toThrowError(
			/duplicate resolver pin slot: kv/u,
		);
	});

	it("refuses a non-Camp", () => {
		expect(() => withResolvers({} as never, {})).toThrowError(
			/expects a Camp object/u,
		);
	});

	it("leaves the original Camp untouched", () => {
		const base = camp("prod");
		withResolvers(base, { kv: "sqlite" });
		// The input is frozen, so a mutating implementation would throw in strict
		// mode — but this pins the intent rather than relying on the freeze.
		expect(base.resolverConfig.pins).toEqual([]);
	});
});

describe("campToShape", () => {
	it("reduces a Camp to its portable shape", () => {
		const shape = campToShape(
			camp("prod", { require: ["a"], labels: { team: "core" } }),
		);
		expect(shape).toEqual({
			id: "prod",
			env: "prod",
			envType: "production",
			require: ["a"],
			prefer: [],
			labels: { team: "core" },
			runtimeRequirements: [],
		});
		// No provider, no Yard, no resolver config: the shape is what travels to
		// a different topology, so anything placement-specific must not be in it.
		expect(Object.hasOwn(shape, "derivedProviderId")).toBe(false);
		expect(Object.hasOwn(shape, "resolverConfig")).toBe(false);
		expect(Object.isFrozen(shape)).toBe(true);
	});

	it("uses the local id for an attached Camp", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "eu",
			providerId: "aws",
		});
		// `eu/prod` is an identity within one topology. Carrying it into a shape
		// would make the shape unusable in a topology with a different Yard.
		expect(campToShape(attached).id).toBe("prod");
		expect(campToShape(attached).logicalId).toBe("eu/eu/prod");
	});
});

describe("parseLegacyCampMappings", () => {
	const sel = (selector?: string, options: Record<string, unknown> = {}) =>
		providerSelection("aws", selector ?? "default", options);

	it("converts bindings, tiers and a default into rules", () => {
		const result = parseLegacyCampMappings(
			{
				bindings: { db: sel("rds") },
				tiers: { kv: sel("elasticache") },
				defaultProvider: sel("fallback"),
			},
			"aws",
		);
		const selectors = result.resourceMappings.map((rule) => rule.selector);
		// Bindings key on resource *name*, tiers on resource *kind*, and the
		// default on nothing at all — three different match scopes that would
		// silently collapse if any were mapped onto the wrong selector field.
		expect(selectors).toEqual([
			{ resourceName: "db" },
			{ resourceKind: "kv" },
			{},
		]);
		expect(result.resourceMappings.map((rule) => rule.resolverId)).toEqual([
			"rds",
			"elasticache",
			"fallback",
		]);
	});

	it("strips the provider id, keeping only the selector as a resolver", () => {
		const result = parseLegacyCampMappings(
			{ bindings: { db: sel("rds") } },
			"aws",
		);
		// The whole point of the compatibility path: accept the legacy shape and
		// emit a canonical Camp that names no provider.
		expect(JSON.stringify(result.resourceMappings)).not.toContain("aws");
		expect(result.deprecation).toMatch(/stripped from canonical camp/u);
	});

	it("refuses a mapping whose provider disagrees with the Yard", () => {
		for (const input of [
			{ defaultProvider: providerSelection("gcp") },
			{ tiers: { kv: providerSelection("gcp") } },
			{ bindings: { db: providerSelection("gcp") } },
		]) {
			// Accepting it would let a legacy topology place one resource on a
			// provider the Yard does not use — which is the state this migration
			// exists to make unrepresentable.
			expectMigrationRefusal(
				() => parseLegacyCampMappings(input, "aws"),
				/!= yard provider aws/u,
			);
		}
	});

	it("returns nothing for an empty input", () => {
		expect(parseLegacyCampMappings({}, "aws").resourceMappings).toEqual([]);
	});

	it("omits a default rule when the default selection has no selector", () => {
		// `providerSelection` defaults the selector to "default", so this is the
		// shape a hand-written legacy object takes. Pinning that a falsy selector
		// produces no catch-all rule rather than one with an empty resolverId.
		const result = parseLegacyCampMappings(
			{ defaultProvider: { providerId: "aws", selector: "" } as never },
			"aws",
		);
		expect(result.resourceMappings).toEqual([]);
	});

	it("carries selection options through as JSON properties", () => {
		const result = parseLegacyCampMappings(
			{ bindings: { db: sel("rds", { size: "small", nested: { a: 1 } }) } },
			"aws",
		);
		expect(result.resourceMappings[0]?.properties).toEqual({
			nested: { a: 1 },
			size: "small",
		});
	});

	it("freezes the emitted rule list", () => {
		expect(
			Object.isFrozen(
				parseLegacyCampMappings({ bindings: { db: sel() } }, "aws")
					.resourceMappings,
			),
		).toBe(true);
	});
});

describe("providerSelection", () => {
	it("builds a deeply frozen, key-sorted selection", () => {
		const selection = providerSelection("aws", "rds", {
			z: 1,
			a: { d: 1, c: 2 },
		});
		expect(selection.kind).toBe("provider-selection");
		expect(Object.keys(selection.options)).toEqual(["a", "z"]);
		expect(Object.keys(selection.options.a as Record<string, unknown>)).toEqual(
			["c", "d"],
		);
		// Deep freeze so a selection handed to two Yards cannot be mutated by one
		// of them after the fact.
		expect(Object.isFrozen(selection)).toBe(true);
		expect(Object.isFrozen(selection.options)).toBe(true);
		expect(Object.isFrozen(selection.options.a)).toBe(true);
	});

	it("defaults the selector and options", () => {
		const selection = providerSelection("aws");
		expect(selection.selector).toBe("default");
		expect(selection.options).toEqual({});
	});

	it("refuses an empty providerId or selector, and a non-object options", () => {
		expect(() => providerSelection("")).toThrowError(
			/providerId must be a non-empty string/u,
		);
		expect(() => providerSelection("aws", "")).toThrowError(
			/selector must be a non-empty string/u,
		);
		// Arrays are objects to `typeof`; accepting one would produce a selection
		// whose options serialize as a list and match nothing.
		expect(() => providerSelection("aws", "rds", [] as never)).toThrowError(
			/options must be an object/u,
		);
	});

	it("preserves array option values in order", () => {
		// Only object keys are sorted. Arrays carry meaning in their order, so
		// sorting them would change what the option says.
		expect(
			providerSelection("aws", "rds", { zones: ["c", "a", "b"] }).options.zones,
		).toEqual(["c", "a", "b"]);
	});
});
