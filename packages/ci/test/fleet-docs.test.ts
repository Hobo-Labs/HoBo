import { describe, expect, it } from "vitest";
import { fleetDocsPages, renderFleetDocs } from "../scripts/fleet-docs.js";
import { FLEET_REFUSAL_CODES } from "../src/fleet/index.js";

describe("HoBo CI docs pages", () => {
	it("show what the fleet code produces today", () => {
		// Regenerate with: node --import tsx packages/ci/scripts/fleet-docs.ts
		for (const page of fleetDocsPages())
			expect(page.current, page.path).toBe(page.next);
	});

	it("demonstrate the decisions the pages describe in prose", () => {
		const balancing = renderFleetDocs()["ci/fleet-balancing.md"];
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
		const routes = renderFleetDocs()["ci/route-table.md"];
		expect(routes["routes-box-free"]).toContain(
			'{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}',
		);
	});

	it("lists every refusal code the fleet can raise in the errors reference", () => {
		const reference =
			renderFleetDocs()["reference/errors.md"]["ci-fleet-codes"];
		for (const code of Object.keys(FLEET_REFUSAL_CODES))
			expect(reference).toContain(`\`${code}\``);
	});

	it("does not call a bridge-only provider usable without saying so", () => {
		const providers = renderFleetDocs()["ci/providers.md"].providers;
		const row = (name: string) =>
			providers.split("\n").find((line) => line.startsWith(`| ${name} |`));
		expect(row("HoBo box worker")).toMatch(/\| yes \|$/);
		for (const name of [
			"Blacksmith runner",
			"Depot runner",
			"GitHub-hosted runner (public repository)",
		])
			expect(row(name)).toContain("yes, through the bridge");
		expect(row("Modal Sandbox")).toContain("no: modelled only");
	});
});
