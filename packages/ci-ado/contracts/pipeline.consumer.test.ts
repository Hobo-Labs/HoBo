import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	loadAdoProject,
	parseAdoProject,
	renderAzurePipeline,
} from "../src/index.js";
import pact from "./pipeline.pact.json" with { type: "json" };

// Hand-authored consumer expectation. This does not verify a live ADO agent or service.
describe("Azure Pipelines YAML consumer contract", () => {
	it.each(pact.interactions)("$description", async (interaction) => {
		const expected = interaction.response[0]?.contents;
		if (!expected) throw new Error("missing Pact response");
		const { pipeline } = await loadAdoProject(
			resolve(import.meta.dirname, "../../.."),
			"packages/ci-ado/examples/ci.json",
		);
		const project = parseAdoProject(
			JSON.stringify(interaction.request.contents),
		);
		const yaml = parse(
			renderAzurePipeline(
				project,
				pipeline,
				"packages/ci-ado/examples/ci.json",
			),
		);
		for (const job of yaml.jobs) expect(job.pool).toEqual(expected.pool);
		const task = yaml.jobs
			.flatMap((job: { steps: { task?: string }[] }) => job.steps)
			.find((step: { task?: string }) => step.task === expected.task);
		expect(task).toMatchObject({
			task: expected.task,
			inputs: expected.inputs,
		});
	});
});
