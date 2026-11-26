import { describe, expect, it } from "vitest";

import {
	compareByTerms,
	primitivesForExample,
	recipesForExample,
	termsRows,
} from "./app-recipe-terms.js";
import type { RecipeTerm } from "./recipe-terms.js";

// What the Ship board promises a visitor before they press Deploy. The tests
// that matter here are the refusals: an app nothing can host must not be shown
// somebody else's terms, and the ranking must favour the visitor rather than
// the deployment that is most convenient to run.

function exampleWith(
	resources: Readonly<Record<string, "kv" | "queue">>,
	routeCount: number,
) {
	const example = {
		id: "app",
		title: "App",
		runtime: {
			schemaVersion: "hobo.try-runtime/v1",
			resources: Object.fromEntries(
				Object.entries(resources).map(([name, kind]) => [
					name,
					{ kind, initial: null },
				]),
			),
			routes: Array.from({ length: routeCount }, () => ({
				method: "GET",
				path: "/",
				action: "health",
			})),
		},
	};
	// SAFETY: test fixture is a partial catalog entry consumed by terms ranking helpers.
	return example as never;
}

function termWith(overrides: Partial<RecipeTerm>): RecipeTerm {
	return {
		recipeId: "recipe.test/v1",
		displayName: "Test",
		description: "",
		providerIds: ["test"],
		primitives: ["api"],
		claimActionCount: 1,
		earliestClaimDeadlineMs: 60 * 60 * 1000,
		claimKind: "provider-native",
		persistence: "ephemeral",
		realtime: "none",
		credentialCustody: "secret-ref",
		bootstrapFunding: "public-anonymous",
		bootstrapClasses: ["anonymous-claimable"],
		cleanupPolicies: ["delete"],
		sponsoredCostCapMinorUnits: 0,
		sourceDisclosure: "public-source",
		requiredConsents: ["claim.ownership-transfer"],
		offerTtlMs: 900_000,
		placements: [],
		...overrides,
	};
}

describe("what an app needs", () => {
	it("reads the primitives off the app's own resources and routes", () => {
		expect(primitivesForExample(exampleWith({ log: "kv" }, 3))).toEqual([
			"api",
			"kv",
		]);
	});

	it("does not claim an api for an app that serves no route", () => {
		expect(primitivesForExample(exampleWith({ log: "kv" }, 0))).toEqual(["kv"]);
	});
});

describe("matching an app to terms", () => {
	it("only offers recipes that place everything the app declares", () => {
		const matches = recipesForExample(exampleWith({ log: "kv" }, 2));
		expect(matches.length).toBeGreaterThan(0);
		for (const term of matches) {
			expect(term.primitives).toContain("kv");
			expect(term.primitives).toContain("api");
		}
	});

	it("offers nothing for an app that declares nothing", () => {
		expect(recipesForExample(exampleWith({}, 0))).toEqual([]);
	});
});

describe("ranking terms for the visitor", () => {
	it("prefers fewer ownership ceremonies", () => {
		const fewer = termWith({ recipeId: "a/v1", claimActionCount: 1 });
		const more = termWith({ recipeId: "b/v1", claimActionCount: 3 });
		expect([more, fewer].sort(compareByTerms)[0]).toBe(fewer);
	});

	it("prefers more time to complete them", () => {
		const longer = termWith({
			recipeId: "a/v1",
			earliestClaimDeadlineMs: 24 * 60 * 60 * 1000,
		});
		const shorter = termWith({
			recipeId: "b/v1",
			earliestClaimDeadlineMs: 60 * 60 * 1000,
		});
		expect([shorter, longer].sort(compareByTerms)[0]).toBe(longer);
	});

	it("prefers a deployment that owes nobody anything", () => {
		const free = termWith({ recipeId: "a/v1" });
		const sponsored = termWith({
			recipeId: "b/v1",
			bootstrapFunding: "sponsored",
			sponsoredCostCapMinorUnits: 500,
		});
		expect([sponsored, free].sort(compareByTerms)[0]).toBe(free);
	});
});

describe("the disclosure rows", () => {
	it("say plainly when nothing changes hands", () => {
		const rows = new Map(
			termsRows(
				termWith({
					claimActionCount: 0,
					earliestClaimDeadlineMs: null,
					requiredConsents: [],
				}),
			),
		);
		expect(rows.get("claim actions")).toMatch(/nothing leaves this machine/u);
		expect(rows.get("you consent to")).toMatch(/no ownership changes hands/u);
		expect(rows.get("claim deadline")).toBe("no deadline");
	});

	it("name the cap when HoBo is paying", () => {
		const rows = new Map(
			termsRows(
				termWith({
					bootstrapFunding: "sponsored",
					sponsoredCostCapMinorUnits: 500,
				}),
			),
		);
		expect(rows.get("paid by")).toBe("HoBo, capped at 500 minor units");
	});
});
