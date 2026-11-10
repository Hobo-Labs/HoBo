import { describe, expect, it } from "vitest";
import { fleetDocsPages, renderFleetDocs } from "../scripts/fleet-docs.js";

describe("HoBo CI docs pages", () => {
	it("show what the fleet code produces today", () => {
		// Regenerate with: node --import tsx packages/ci/scripts/fleet-docs.ts
		for (const page of fleetDocsPages())
			expect(page.current, page.path).toBe(page.next);
	});

	it("demonstrate the decisions the pages describe in prose", () => {
		const balancing = renderFleetDocs()["fleet-balancing.md"];
		const first = (fragment: string) =>
			fragment.split("\n").find((line) => line.startsWith("| 1 |"));
		expect(first(balancing["box-free"])).toContain("HoBo box worker");
		expect(first(balancing["box-full"])).toContain("Blacksmith runner");
		expect(first(balancing["private-trunk"])).toContain(
			"Remote actions-runner-controller scale set",
		);
		expect(first(balancing.queued)).toContain("| `hobo` |");
		expect(balancing.queued).toContain("`fleet.label-bound`");
		expect(balancing["budget-spent"]).toContain("`budget.policy.exhausted`");
		expect(balancing["box-unhealthy"]).toContain("`fleet.unhealthy`");
		const routes = renderFleetDocs()["route-table.md"];
		expect(routes["routes-box-free"]).toContain(
			'{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}',
		);
	});
});
