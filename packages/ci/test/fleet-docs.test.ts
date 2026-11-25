import { describe, expect, it } from "vitest";
import { fleetDocsPages, renderFleetDocs } from "../scripts/fleet-docs.js";
import { FLEET_REFUSAL_CODES } from "../src/fleet/index.js";

describe("HoBo CI docs pages", () => {
	it("show what the fleet code produces today", () => {
		// Regenerate with: node --import tsx packages/ci/scripts/fleet-docs.ts
		for (const page of fleetDocsPages())
			expect(page.current, page.path).toBe(page.next);
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
