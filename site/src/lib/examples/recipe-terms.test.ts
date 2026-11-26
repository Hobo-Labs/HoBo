import { describe, expect, it } from "vitest";

import { deriveRecipeTerms } from "./recipe-terms-source.js";
import artifact from "./recipe-terms.json" with { type: "json" };
import {
	formatDeadline,
	RECIPE_TERMS,
	recipesForPrimitives,
	summarizeTerms,
} from "./recipe-terms.js";

// The console is allowed to render claim terms; it is not allowed to invent
// them. That holds only while the checked-in artifact still matches what
// `@hobo/recipes` says, so the drift check is the load-bearing test here.

describe("the recipe-terms artifact", () => {
	it("matches what the shipped recipes currently declare", () => {
		expect(artifact).toEqual(deriveRecipeTerms());
	});

	it("covers every shipped recipe", () => {
		expect(RECIPE_TERMS.length).toBe(deriveRecipeTerms().recipes.length);
		expect(RECIPE_TERMS.length).toBeGreaterThan(0);
	});

	it("gives a claim a deadline and a consent, or asks for neither", () => {
		for (const term of RECIPE_TERMS) {
			if (term.claimActionCount === 0) {
				// A purely local preview creates nothing to hand over, so there
				// is nothing to consent to and no clock to run out.
				expect(term.earliestClaimDeadlineMs).toBeNull();
				continue;
			}
			expect(term.earliestClaimDeadlineMs).not.toBeNull();
			expect(term.requiredConsents.length).toBeGreaterThan(0);
		}
	});

	it("carries no credential material into the bundle", () => {
		const serialized = JSON.stringify(artifact);
		expect(serialized).not.toMatch(/Bearer\s+\S+/u);
		expect(serialized).not.toMatch(/(?:api|secret|token)[-_]?key["']?\s*[:=]/iu);
	});
});

describe("matching a recipe to an app", () => {
	it("offers only recipes that cover every primitive the app declares", () => {
		for (const term of recipesForPrimitives(["kv", "webhook"])) {
			expect(term.primitives).toContain("kv");
			expect(term.primitives).toContain("webhook");
		}
	});

	it("offers nothing for an app that declares nothing", () => {
		expect(recipesForPrimitives([])).toEqual([]);
	});

	it("offers nothing rather than a partial deployment", () => {
		expect(recipesForPrimitives(["kv", "not-a-primitive"])).toEqual([]);
	});
});

describe("reading the terms", () => {
	it("renders deadlines a visitor can read", () => {
		expect(formatDeadline(60 * 60 * 1000)).toBe("1h");
		expect(formatDeadline(24 * 60 * 60 * 1000)).toBe("24h");
		expect(formatDeadline(15 * 60 * 1000)).toBe("15m");
		expect(formatDeadline(null)).toBe("no deadline");
	});

	it("names the providers, the ceremonies and who pays", () => {
		const [term] = RECIPE_TERMS;
		const summary = summarizeTerms(term!);
		for (const providerId of term!.providerIds) {
			expect(summary).toContain(providerId);
		}
		expect(summary).toMatch(/claim action/u);
	});
});
