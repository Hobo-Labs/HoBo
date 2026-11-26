import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serializeTrainingArtifactProgram } from "@hobo/core";
import {
	applyTrainingArtifact,
	isTrainable,
	listTrainables,
	resetTrainables,
	resolveTrainable,
	type Trainable,
} from "@hobo/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFixtureProject } from "../src/codegen/fixture.js";
import { runCodegen } from "../src/codegen/run-codegen.js";
import { createHoboCli } from "../src/index.js";

// End-to-end trainable codegen (ADR-0125): codegen emits a contract-backed
// training.define() stub per bindle step; the generated module serves its
// contract example until a training artifact is applied, then serves the
// tuned demo, and reverts cleanly. The temp project lives inside the package
// so vitest's transform pipeline can import the generated TypeScript.

type Incident = {
	readonly id: string;
	readonly severity: "sev1" | "sev2" | "sev3";
	readonly open: boolean;
};

const INCIDENT_EXAMPLE: Incident = {
	id: "example",
	severity: "sev1",
	open: false,
};

describe("trainable codegen", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(
			join(fileURLToPath(new URL(".", import.meta.url)), ".tmp-trainable-"),
		);
		await writeFixtureProject(projectRoot);
		await runCodegen({ projectRoot, check: false });
	});

	afterEach(async () => {
		resetTrainables();
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("emits a training.define stub per bindle step and hobo stub reports them", async () => {
		await expect(
			access(join(projectRoot, "src/_generated/trainables.ts")),
		).resolves.toBeUndefined();

		const result = await createHoboCli().run(["stub", "--json"], {
			cwd: projectRoot,
		});
		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.ok).toBe(true);
		expect(envelope.verb).toBe("stub");
		expect(envelope.data.trainables).toEqual([
			{
				methodRef: "incident.classify",
				exportName: "incidentClassify",
				resource: "incident",
				typeName: "Incident",
				contractRef: "bindle://support/steps/incident.classify",
				origin: "bindle-step",
			},
			{
				methodRef: "ticket.validate",
				exportName: "ticketValidate",
				resource: "ticket",
				typeName: "Ticket",
				contractRef: "bindle://support/steps/ticket.validate",
				origin: "bindle-step",
			},
			{
				methodRef: "rankFeed",
				exportName: "rankFeedTraining",
				contractRef: "inferred://rankFeed",
				origin: "directive",
			},
		]);

		const check = await createHoboCli().run(["stub", "--check", "--json"], {
			cwd: projectRoot,
		});
		expect(JSON.parse(check.stdout).ok).toBe(true);
		expect(JSON.parse(check.stdout).data.mode).toBe("check");
	});

	it("generated stubs register as trainables and serve their contract example", async () => {
		const mod = await importTrainables(projectRoot);

		expect(isTrainable(mod.incidentClassify)).toBe(true);
		expect(isTrainable(mod.ticketValidate)).toBe(true);
		expect(mod.trainableStubs.map((stub) => stub.methodRef)).toEqual([
			"incident.classify",
			"ticket.validate",
			"rankFeed",
		]);

		const facts = listTrainables();
		const fact = facts.find((f) => f.methodRef === "incident.classify");
		expect(fact?.baseline).toBe("stub");
		expect(fact?.contractRef).toBe("bindle://support/steps/incident.classify");

		const served = await mod.incidentClassify(INCIDENT_EXAMPLE);
		expect(served).toEqual(INCIDENT_EXAMPLE);
	});

	it("generates inferred bindings for bare use-training markers (syntax 3)", async () => {
		const mod = await importTrainables(projectRoot);

		// The marker carried NO bindings — codegen generated them.
		expect(isTrainable(mod.rankFeedTraining)).toBe(true);
		const fact = listTrainables().find((f) => f.methodRef === "rankFeed");
		expect(fact?.contractRef).toBe("inferred://rankFeed");
		expect(fact?.baseline).toBe("body");
		expect(fact?.intent).toContain("Rank feed items");

		// DI-style resolution sees the generated registration...
		const ranked = resolveTrainable<{ items: string[] }, { ranked: string[] }>(
			"rankFeed",
		);
		await expect(ranked({ items: ["b", "a"] })).resolves.toEqual({
			ranked: ["a", "b"],
		});

		// ...and the optimization loop applies to it like any other form.
		const tunedArtifact = {
			engineId: "hobo.training-engine/built-in-opto@0.1.0",
			engineVersion: "22.0.9",
			methodRef: "rankFeed",
			programJson: serializeTrainingArtifactProgram({
				instructions: "Rank by recency, not lexicographically.",
				demos: [
					{ input: { items: ["b", "a"] }, output: { ranked: ["b", "a"] } },
				],
			}),
		};
		applyTrainingArtifact("rankFeed", tunedArtifact);
		applyTrainingArtifact("rankFeed", null);
		await expect(ranked({ items: ["b", "a"] })).resolves.toEqual({
			ranked: ["a", "b"],
		});
	});

	it("applies a training artifact for tuned output and reverts to the stub", async () => {
		const mod = await importTrainables(projectRoot);

		const input: Incident = { id: "inc-42", severity: "sev2", open: true };
		const tuned: Incident = { id: "inc-42", severity: "sev1", open: false };
		const artifact = {
			engineId: "hobo.training-engine/built-in-opto@0.1.0",
			engineVersion: "22.0.9",
			methodRef: "incident.classify",
			programJson: serializeTrainingArtifactProgram({
				instructions: "Classify and de-escalate resolved incidents.",
				demos: [{ input, output: tuned }],
			}),
		};

		applyTrainingArtifact(mod.incidentClassify, artifact);
		await expect(mod.incidentClassify(input)).resolves.toEqual(tuned);

		applyTrainingArtifact(mod.incidentClassify, null);
		await expect(mod.incidentClassify(input)).resolves.toEqual(
			INCIDENT_EXAMPLE,
		);
	});
});

async function importTrainables(projectRoot: string): Promise<{
	incidentClassify: Trainable<Incident, Incident>;
	ticketValidate: Trainable<unknown, unknown>;
	rankFeedTraining: Trainable<{ items: string[] }, { ranked: string[] }>;
	trainableStubs: readonly { readonly methodRef: string }[];
}> {
	const moduleUrl = pathToFileURL(
		join(projectRoot, "src/_generated/trainables.ts"),
	).href;
	// SAFETY: `return (await import(moduleUrl)) as Awaited<` is required at this I/O or test boundary.
	return (await import(moduleUrl)) as Awaited<
		ReturnType<typeof importTrainables>
	>;
}
