import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	hashDeploymentPlan,
	type PlanParseInput,
	parseDeploymentPlan,
	ResourcePlanError,
} from "../src/index.js";

/**
 * Executable PACT verification for the one service boundary this shape crosses.
 *
 * A `DeploymentPlan` travels inside `deployment.Planned` alongside a
 * `planHash`, and every consumer that receives it — the deployment saga, the
 * deployment-view projection, a deployment driver — must be able to recompute
 * that hash from the plan body. That agreement is the boundary contract, and
 * the pact is verified by executing it rather than by reading it: each
 * interaction's plan is parsed and hashed here, and the result is compared to
 * the digest the pact declares.
 */

interface PactInteraction {
	description: string;
	request: { body: { plan: PlanParseInput } };
	response: { body: { planHash?: string; error?: string; path?: string } };
}

interface PactFile {
	consumer: { name: string };
	provider: { name: string };
	interactions: PactInteraction[];
}

const pact: PactFile = JSON.parse(
	readFileSync(
		fileURLToPath(
			new URL(
				"../contracts/pacts/deployment-plan-digest.pact.json",
				import.meta.url,
			),
		),
		"utf8",
	),
);

describe(`PACT ${pact.consumer.name} -> ${pact.provider.name}`, () => {
	it("declares the interactions this suite verifies", () => {
		expect(pact.interactions).toHaveLength(5);
	});

	// Keep the legacy plan and its digest alongside the current golden fixture.
	const digestCases = pact.interactions.filter(
		(i) => i.response.body.planHash !== undefined,
	);
	const refusalCases = pact.interactions.filter(
		(i) => i.response.body.error !== undefined,
	);

	it("covers both outcomes the boundary has", () => {
		expect(digestCases).toHaveLength(4);
		expect(refusalCases).toHaveLength(1);
	});

	it("keeps the current golden-plan contract aligned with the cloud fixture", () => {
		const currentPlan: PlanParseInput = JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL(
						"../../cloud/test/fixtures/golden-plan.json",
						import.meta.url,
					),
				),
				"utf8",
			),
		);
		const golden = pact.interactions.find(
			(interaction) =>
				interaction.description ===
				"the current golden plan includes the selected product in its digest",
		);
		expect(golden?.request.body.plan).toEqual(currentPlan);
	});

	it.each(
		digestCases.map((i) => [i.description, i] as const),
	)("%s", (_description, interaction) => {
		const parsed = parseDeploymentPlan(interaction.request.body.plan);
		expect(hashDeploymentPlan(parsed)).toBe(interaction.response.body.planHash);
	});

	it.each(
		refusalCases.map((i) => [i.description, i] as const),
	)("%s", (_description, interaction) => {
		let thrown: ResourcePlanError | undefined;
		try {
			parseDeploymentPlan(interaction.request.body.plan);
		} catch (error) {
			if (error instanceof ResourcePlanError) thrown = error;
			else throw error;
		}
		expect(thrown).toBeInstanceOf(ResourcePlanError);
		if (thrown === undefined) {
			throw new Error("expected ResourcePlanError");
		}
		expect(thrown.code).toBe(interaction.response.body.error);
		expect(thrown.path).toBe(interaction.response.body.path);
	});
});
