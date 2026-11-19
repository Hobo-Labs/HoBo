import { CAMP_TIERS } from "@hobo/core";
/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type */
import { describe, expect, it } from "vitest";

import {
	attachCampToYard,
	CAMP_PROVIDER_SELECTION_FORBIDDEN,
	camp,
	campToContract,
	withResolvers,
} from "../src/camp.js";
import { TOPOLOGY_CONTRACT_VERSION } from "../src/types.js";

function codeOf(error: unknown): string | undefined {
	return (error as { code?: string }).code;
}

function expectProviderRefusal(run: () => unknown, match: RegExp): void {
	try {
		run();
	} catch (error) {
		expect((error as Error).message).toMatch(match);
		expect(codeOf(error)).toBe(CAMP_PROVIDER_SELECTION_FORBIDDEN);
		return;
	}
	expect.unreachable(`expected a refusal matching ${match}`);
}

describe("camp() — identity and naming", () => {
	it("builds a frozen Camp stamped with the topology contract version", () => {
		const result = camp("prod");
		expect(result.kind).toBe("camp");
		expect(result.contract).toBe(TOPOLOGY_CONTRACT_VERSION);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.require)).toBe(true);
		expect(Object.isFrozen(result.labels)).toBe(true);
	});

	it("takes the last path segment of a slashed name as the env", () => {
		const result = camp("acme/prod");
		expect(result.env).toBe("prod");
		expect(result.id).toBe("prod");
		expect(result.name).toBe("prod");
	});

	it("keeps id and name identical", () => {
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
		expect(() => camp("prod", [] as never)).toThrowError(
			/camp config must be an object/u,
		);
	});

	it("preserves provider words in the id", () => {
		for (const provider of [
			"local",
			"aws",
			"azure",
			"gcp",
			"cloudflare",
			"oci",
			"wasm-sandbox",
		]) {
			expect(camp(`prod-${provider}`).id, provider).toBe(`prod-${provider}`);
		}
		expect(camp("prod-AWS").id).toBe("prod-AWS");
	});

	it("keeps a name that is only a provider word", () => {
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
			expect(camp(env).envType, env).toBe(expected);
		}
	});

	it("falls back to the env name for anything it does not recognize", () => {
		expect(camp("canary").envType).toBe("canary");
	});

	it("prefers an explicit non-empty envType over inference", () => {
		expect(camp("canary", { envType: "production" }).envType).toBe(
			"production",
		);
		expect(camp("prod", { envType: "" }).envType).toBe("production");
		expect(camp("prod", { envType: 7 as never }).envType).toBe("production");
	});
});

describe("camp() — tier", () => {
	it("accepts every named tier and omits the field when absent", () => {
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
		expect(Object.hasOwn(camp("prod"), "tier")).toBe(false);
	});

	it("refuses an unknown tier rather than inferring one", () => {
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
	it("refuses a provider-specific label", () => {
		for (const key of ["provider", "providerId", "resolverId", "ProviderId"]) {
			expectProviderRefusal(
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
			expectProviderRefusal(
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

	it("retains resolverId within explicitly authored properties", () => {
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
		expect(result.resourceMappings[0]?.properties).toEqual({
			resolverId: "postgres",
			size: "small",
		});
	});

	it("refuses a resource mapping that carries a provider field", () => {
		for (const key of ["provider", "providerId"]) {
			expectProviderRefusal(
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
		expect(result.require).toEqual(["a", "b", "c"]);
		expect(result.prefer).toEqual(["y", "z"]);
	});

	it("ignores a non-array require or prefer rather than throwing", () => {
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
	it("canonicalizes the runtimeRequirements list", () => {
		expect(
			camp("prod", { runtimeRequirements: ["wasm", "node"] } as never)
				.runtimeRequirements,
		).toEqual(["node", "wasm"]);
	});

	it("defaults to an empty requirement list", () => {
		expect(camp("prod").runtimeRequirements).toEqual([]);
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
			expect(() =>
				camp("prod", { resolverConfig: { pins: [pin] } } as never),
			).toThrowError(/resolver pin requires slot and resolverId/u);
		}
	});

	it("refuses two pins for the same slot", () => {
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
	it("rejects a placement without its provider-neutral declaration", () => {
		const original = attachCampToYard(camp("prod"), {
			yardId: "eu",
			providerId: "aws",
		});
		const { placementDeclaration: _declaration, ...incomplete } = original;
		for (const yardId of ["eu", "west"]) {
			expect(() =>
				attachCampToYard(incomplete, { yardId, providerId: "aws" }),
			).toThrow(/provider-neutral declaration/);
		}
	});

	it("namespaces identity under the Yard and derives the provider", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "eu",
			providerId: "aws",
		});
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
		expect(attached.resolverConfig.pins).toEqual([
			{ slot: "kv", resolverId: "dynamo" },
		]);
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
		expectProviderRefusal(
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
		expect(base.resolverConfig.pins).toEqual([]);
	});
});

describe("campToContract", () => {
	it("reduces a Camp to its portable contract", () => {
		const contract = campToContract(
			camp("prod", { require: ["a"], labels: { team: "core" } }),
		);
		expect(contract).toEqual({
			id: "prod",
			env: "prod",
			envType: "production",
			require: ["a"],
			prefer: [],
			labels: { team: "core" },
			runtimeRequirements: [],
		});
		expect(Object.hasOwn(contract, "derivedProviderId")).toBe(false);
		expect(Object.hasOwn(contract, "resolverConfig")).toBe(false);
		expect(Object.isFrozen(contract)).toBe(true);
	});

	it("uses the local id for an attached Camp", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "eu",
			providerId: "aws",
		});
		expect(campToContract(attached).id).toBe("prod");
		expect(campToContract(attached).logicalId).toBe("eu/eu/prod");
	});
});
