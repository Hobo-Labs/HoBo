/* oxlint-disable anti-slop/no-shape-in-symbol-names, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion */
import { describe, expect, it } from "vitest";

import {
	attachCampToYard,
	CAMP_PROVIDER_SELECTION_FORBIDDEN,
	camp,
	campToContract,
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

	it("rejects unknown configuration properties", () => {
		expect(() => camp("prod", { requre: ["node"] } as never)).toThrow(
			/camp config has unknown property: requre/u,
		);
	});

	it("takes the last segment of a slash-qualified name as the env", () => {
		expect(camp("acme/prod").env).toBe("prod");
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(camp("prod"))).toBe(true);
	});
});

describe("provider-neutral labels", () => {
	it("refuses a provider-shaped label", () => {
		expect(
			codeOf(() => camp("prod", { labels: { provider: "aws" } } as never)),
		).toBe(CAMP_PROVIDER_SELECTION_FORBIDDEN);
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
		).toBe(CAMP_PROVIDER_SELECTION_FORBIDDEN);
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

	it("preserves provider words in the id and env", () => {
		const built = camp("prod-aws");
		expect(built.id).toBe("prod-aws");
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
	])("preserves the suffix -%s", (provider) => {
		expect(camp(`prod-${provider}`).id).toBe(`prod-${provider}`);
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

describe("campToContract", () => {
	it("keeps the local id for an unattached Camp", () => {
		expect(campToContract(camp("prod")).id).toBe("prod");
	});

	it("strips the yard prefix from an attached Camp", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "y1",
			providerId: "aws",
		});
		expect(campToContract(attached).id).toBe("prod");
	});

	it("carries env, envType and the canonical lists", () => {
		const contract = campToContract(camp("prod", { require: ["a"] }));
		expect(contract).toMatchObject({
			env: "prod",
			envType: "production",
			require: ["a"],
		});
	});

	it("does not leak the derived provider into the contract", () => {
		const attached = attachCampToYard(camp("prod"), {
			yardId: "y1",
			providerId: "aws",
		});
		expect(campToContract(attached)).not.toHaveProperty("derivedProviderId");
	});

	it("freezes the contract", () => {
		expect(Object.isFrozen(campToContract(camp("prod")))).toBe(true);
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
