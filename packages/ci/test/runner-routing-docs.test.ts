import { describe, expect, it } from "vitest";
import {
	applyRunnerRoutingDocs,
	renderRunnerRoutingDocs,
	runnerRoutingDocsPages,
} from "../scripts/runner-routing-docs.js";
import { RUNNER_REFUSAL_CODES } from "../src/runner-routing/index.js";

describe("HoBo CI docs pages", () => {
	it("show what the runner routing code produces today", () => {
		// Regenerate with: node --import tsx packages/ci/scripts/runner-routing-docs.ts
		for (const page of runnerRoutingDocsPages())
			expect(page.current, page.path).toBe(page.next);
	});

	it("demonstrate the decisions the pages describe in prose", () => {
		const balancing = renderRunnerRoutingDocs()["ci/fleet-balancing.md"];
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
		const routes = renderRunnerRoutingDocs()["ci/route-table.md"];
		expect(routes["routes-box-free"]).toContain(
			'{"fork":"hobo","pr":"hobo","trunk":"hobo-trunk"}',
		);
	});

	it("lists every refusal code runner routing can raise in the errors reference", () => {
		const reference =
			renderRunnerRoutingDocs()["reference/errors.md"]["ci-fleet-codes"];
		for (const code of Object.keys(RUNNER_REFUSAL_CODES))
			expect(reference).toContain(`\`${code}\``);
	});

	it("does not call a bridge-only provider usable without saying so", () => {
		const providers = renderRunnerRoutingDocs()["ci/providers.md"].providers;
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

	it("rewrites the notice unless the page keeps its own", () => {
		const page = [
			"<!-- generated:x:start -->",
			"<!-- Generated from older code by old.ts. Do not edit by hand. -->",
			"",
			"old",
			"",
			"<!-- generated:x:end -->",
		].join("\n");
		const fresh = applyRunnerRoutingDocs(page, { x: "new" });
		expect(fresh).toContain("runner-routing-docs.ts");
		expect(fresh).toContain("new");
		const kept = applyRunnerRoutingDocs(
			page,
			{ x: "new" },
			{ keepNotice: true },
		);
		expect(kept).toContain("by old.ts");
		expect(kept).not.toContain("old\n");
		expect(() => applyRunnerRoutingDocs("no markers", { x: "new" })).toThrow(
			"page has no generated:x markers",
		);
	});
});
