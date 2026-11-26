/**
 * The standard Camp tiers, and the properties that make them worth having.
 *
 * These tests are mostly about the *shape* of the default rather than its
 * contents, because the contents are a judgement sourced from Azure WAF SE:04
 * and AWS WAF SEC05-BP01 while the shape is what breaks silently: a default
 * that quietly grows, a containment graph that gains an upward edge, a tier
 * inferred from a name.
 */
import {
	CAMP_TIER_EGRESS,
	CAMP_TIER_ORDER,
	CAMP_TIERS,
	type CampTier,
	DEFAULT_CAMP_TIERS,
	isCampTier,
} from "@hobo/core";
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: assertions inspect known standard-Camp test fixtures. */
import { describe, expect, it } from "vitest";

import { camp } from "../src/camp.js";
import { standardCamps } from "../src/standard-camps.js";

describe("the default tier set", () => {
	it("is the three-tier shape both frameworks reach for first", () => {
		// SEC05-BP01: "presentation layer, application layer, and data layer".
		// SE:04 networking pattern 1: one subnet for web, one for database.
		expect([...DEFAULT_CAMP_TIERS]).toEqual(["edge", "app", "data"]);
	});

	it("does not default to the opt-in tiers", () => {
		// SE:04 records the countervailing risk explicitly: "Micro-segmentation
		// beyond a reasonable limit loses the benefit of isolation." A workload
		// that runs no untrusted code should not provision a segment for it.
		expect(DEFAULT_CAMP_TIERS).not.toContain(CAMP_TIERS.untrusted);
		expect(DEFAULT_CAMP_TIERS).not.toContain(CAMP_TIERS.ops);
	});

	it("builds one Camp per tier, tagged with its tier and environment", () => {
		const camps = standardCamps("production");
		expect(camps.map((c) => c.id)).toEqual([
			"production-edge",
			"production-app",
			"production-data",
		]);
		expect(camps.map((c) => c.tier)).toEqual(["edge", "app", "data"]);
		for (const built of camps) {
			expect(built.envType).toBe("production");
			expect(built.labels["hobo.tier"]).toBe(built.tier);
		}
	});
});

describe("tier and environment are orthogonal axes", () => {
	it("produces a distinct Camp set per environment", () => {
		const prod = standardCamps("production").map((c) => c.id);
		const staging = standardCamps("staging").map((c) => c.id);
		expect(prod).not.toEqual(staging);
		// Same segmentation, different environment — SE:04 lists "deployment
		// environments that isolate deployment by stages" as its own axis.
		expect(standardCamps("staging").map((c) => c.tier)).toEqual(
			standardCamps("production").map((c) => c.tier),
		);
	});

	it("refuses to guess an environment", () => {
		// Guessing one is how a staging deploy lands in production.
		expect(() => standardCamps("")).toThrowError(/environment type/u);
		expect(() => standardCamps(undefined as never)).toThrowError(
			/environment type/u,
		);
	});
});

describe("tier is stated, never inferred", () => {
	it("does not read a tier out of the Camp's name", () => {
		// envType IS inferred from the name for backwards compatibility. Doing
		// the same for tier would make a Camp called "data-migration" silently a
		// data-tier segment, which is a naming convention carrying security
		// meaning — the load-bearing-convention trap ADR-0144 names.
		expect(camp("data-migration").tier).toBeUndefined();
		expect(camp("edge-cases").tier).toBeUndefined();
	});

	it("keeps an explicitly stated tier", () => {
		expect(camp("gateway", { tier: "edge" }).tier).toBe("edge");
	});

	it("refuses a tier outside the vocabulary", () => {
		let raised: unknown;
		try {
			camp("x", { tier: "dmz" });
		} catch (error) {
			raised = error;
		}
		expect((raised as { code?: string })?.code).toBe("CAMP_TIER_UNKNOWN");
	});
});

describe("the containment graph", () => {
	it("covers every named tier", () => {
		expect(Object.keys(CAMP_TIER_EGRESS).sort()).toEqual(
			[...CAMP_TIER_ORDER].sort(),
		);
	});

	it("has no upward edges — nothing reaches back toward the perimeter", () => {
		// SE:04 calls containment "the exit edge of a segment that prevents
		// lateral movement". A store that can call business logic is the
		// inversion that makes a breach in `data` reach everything.
		const rank = new Map<CampTier, number>(
			CAMP_TIER_ORDER.map((tier, index) => [tier, index]),
		);
		const upward: string[] = [];
		for (const [from, targets] of Object.entries(CAMP_TIER_EGRESS)) {
			// `ops` is deliberately exempt: operational surfaces reach everything
			// by definition, which is exactly why SE:04 wants them segmented off
			// the workload path rather than living inside it.
			if (from === CAMP_TIERS.ops) continue;
			for (const to of targets) {
				if ((rank.get(to) ?? 0) < (rank.get(from as CampTier) ?? 0)) {
					upward.push(`${from} -> ${to}`);
				}
			}
		}
		expect(upward).toEqual([]);
	});

	it("is acyclic", () => {
		const seen = new Set<CampTier>();
		const stack = new Set<CampTier>();
		const cycles: string[] = [];
		const walk = (tier: CampTier, path: CampTier[]): void => {
			if (stack.has(tier)) {
				cycles.push([...path, tier].join(" -> "));
				return;
			}
			if (seen.has(tier)) return;
			seen.add(tier);
			stack.add(tier);
			for (const next of CAMP_TIER_EGRESS[tier]) walk(next, [...path, tier]);
			stack.delete(tier);
		};
		for (const tier of CAMP_TIER_ORDER) walk(tier, []);
		expect(cycles).toEqual([]);
	});

	it("terminates at the tiers that hold the most sensitive things", () => {
		expect(CAMP_TIER_EGRESS.data).toEqual([]);
		expect(CAMP_TIER_EGRESS.untrusted).toEqual([]);
	});

	it("never lets edge reach data directly", () => {
		// The whole point of the middle tier: a breach at the perimeter does not
		// put the caller one hop from persistence.
		expect(CAMP_TIER_EGRESS.edge).not.toContain(CAMP_TIERS.data);
	});
});

describe("refusals", () => {
	it("refuses an empty tier list", () => {
		let raised: unknown;
		try {
			standardCamps("production", { tiers: [] });
		} catch (error) {
			raised = error;
		}
		expect((raised as { code?: string })?.code).toBe("CAMP_TIERS_EMPTY");
	});

	it("refuses a repeated tier", () => {
		let raised: unknown;
		try {
			standardCamps("production", { tiers: ["app", "app"] });
		} catch (error) {
			raised = error;
		}
		expect((raised as { code?: string })?.code).toBe("CAMP_TIER_DUPLICATE");
	});
});

describe("determinism", () => {
	it("emits tiers in vocabulary order, not argument order", () => {
		const forward = standardCamps("production", {
			tiers: ["edge", "app", "data"],
		});
		const backward = standardCamps("production", {
			tiers: ["data", "app", "edge"],
		});
		expect(backward.map((c) => c.id)).toEqual(forward.map((c) => c.id));
	});

	it("is a pure function of its inputs", () => {
		expect(JSON.stringify(standardCamps("production"))).toBe(
			JSON.stringify(standardCamps("production")),
		);
	});
});

describe("what standard Camps deliberately do not carry", () => {
	it("sets no require/prefer constraints", () => {
		// Making the data tier require "encrypted-at-rest" here would smuggle a
		// policy decision into a factory, where it is neither reviewable nor
		// overridable. Segments belong here; what a segment demands is policy.
		for (const built of standardCamps("production")) {
			expect(built.require).toEqual([]);
			expect(built.prefer).toEqual([]);
		}
	});

	it("names no provider", () => {
		for (const built of standardCamps("production")) {
			expect(built.derivedProviderId).toBeUndefined();
		}
	});
});

describe("vocabulary guard", () => {
	it("recognises exactly the named tiers", () => {
		for (const tier of CAMP_TIER_ORDER) expect(isCampTier(tier)).toBe(true);
		for (const notATier of ["dmz", "business", "presentation", "", "APP"]) {
			expect(isCampTier(notATier)).toBe(false);
		}
	});
});
