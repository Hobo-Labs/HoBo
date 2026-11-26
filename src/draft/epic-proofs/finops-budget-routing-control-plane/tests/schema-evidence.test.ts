import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { evaluateRoutingScenario } from "../services/finops-routing-control-plane.js";

test("architecture evidence is an exact mirror of the canonical generated input schema", async () => {
	for (const extension of ["proto", "cue"]) {
		const name = `finops_budget_routing_control_plane.${extension}`;
		const [canonical, evidence] = await Promise.all([
			readFile(new URL(`../data-models/${name}`, import.meta.url), "utf8"),
			readFile(new URL(`../architecture/${name}`, import.meta.url), "utf8"),
		]);
		assert.equal(evidence, canonical);
	}
});

test("record fixtures exercise the generated parser rather than schema-presence claims", async () => {
	const valid = JSON.parse(
		await readFile(
			new URL(
				"../data-models/fixtures/valid/routing-scenario.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	assert.equal(evaluateRoutingScenario(valid).status, "allow");
	for (const name of ["negative-budget", "missing-exposure"]) {
		const invalid = JSON.parse(
			await readFile(
				new URL(
					`../data-models/fixtures/invalid/${name}.json`,
					import.meta.url,
				),
				"utf8",
			),
		);
		assert.equal(evaluateRoutingScenario(invalid).status, "rejected");
	}
});
