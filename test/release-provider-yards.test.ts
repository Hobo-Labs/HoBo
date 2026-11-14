import { describe, expect, it } from "vitest";
import { camps, pipelines } from "../release/hobo-release.delivery.js";

describe("release provider boundaries", () => {
	it("keeps each provider in its own Yard while preserving logical Camp IDs", () => {
		const byYard = new Map<string, Set<string>>();
		for (const camp of camps) {
			expect(camp.campId.startsWith(`${camp.yardId}/`)).toBe(true);
			const providers = byYard.get(camp.yardId) ?? new Set<string>();
			providers.add(camp.provider);
			byYard.set(camp.yardId, providers);
		}
		expect([...byYard.keys()].sort()).toEqual([
			"hobo-release-npm",
			"hobo-release-oci",
			"hobo-release-pages",
		]);
		expect(
			[...byYard.values()].every((providers) => providers.size === 1),
		).toBe(true);
		expect(
			[...byYard].map(([yard, providers]) => [yard, [...providers][0]]).sort(),
		).toEqual([
			["hobo-release-npm", "@hobo/provider-npm"],
			["hobo-release-oci", "@hobo/provider-oci-registry"],
			["hobo-release-pages", "@hobo/provider-github"],
		]);
		expect(camps.map((camp) => camp.logicalId).sort()).toEqual([
			"hobo-release/npm-candidate",
			"hobo-release/npm-stable",
			"hobo-release/oci-candidate",
			"hobo-release/oci-stable",
			"hobo-release/pages-candidate",
			"hobo-release/pages-stable",
		]);
		const declared = new Set(camps.map((camp) => camp.logicalId));
		for (const pipeline of pipelines)
			for (const node of pipeline.nodes)
				for (const campId of node.campIds)
					expect(declared.has(campId)).toBe(true);
	});
});
