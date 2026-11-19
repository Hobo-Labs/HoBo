import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFixtureProject } from "../src/codegen/fixture.js";
import { runCodegen } from "../src/codegen/run-codegen.js";
import { createHoboCli } from "../src/index.js";

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
		const generated = await readFile(
			join(projectRoot, "src/_generated/trainables.ts"),
			"utf8",
		);
		expect(generated).toContain("// @generated");

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
		const fixture = await readFile(join(projectRoot, "src/rank.ts"), "utf8");
		expect(fixture).toContain(
			"// Rank feed items; stable sort as the initial implementation.",
		);
		const mod = await importTrainables(projectRoot);

		expect(isTrainable(mod.rankFeedTraining)).toBe(true);
		const fact = listTrainables().find((f) => f.methodRef === "rankFeed");
		expect(fact?.contractRef).toBe("inferred://rankFeed");
		expect(fact?.baseline).toBe("body");
		expect(fact?.intent).toContain("Rank feed items");

		const ranked = resolveTrainable<{ items: string[] }, { ranked: string[] }>(
			"rankFeed",
		);
		await expect(ranked({ items: ["b", "a"] })).resolves.toEqual({
			ranked: ["a", "b"],
		});

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
		await expect(ranked({ items: ["b", "a"] })).resolves.toEqual({
			ranked: ["b", "a"],
		});
		applyTrainingArtifact("rankFeed", null);
		await expect(ranked({ items: ["b", "a"] })).resolves.toEqual({
			ranked: ["a", "b"],
		});
	});

	it.each([
		{
			kind: "line comment",
			comment: "// Rank feed items; stable sort as the initial implementation.",
			assignment: "",
			intent: "Rank feed items; stable sort as the initial implementation.",
		},
		{
			kind: "block comment",
			comment: '/**\n * Rank "new" items first.\n * Keep ties stable.\n */',
			assignment: "",
			intent: 'Rank "new" items first. Keep ties stable.',
		},
		{
			kind: "structured intent",
			comment: "",
			assignment: 'rankFeed.trainingIntent = "Sort by relevance.";',
			intent: "Sort by relevance.",
		},
	])("keeps $kind and method identity after bundling", async ({
		comment,
		assignment,
		intent,
	}) => {
		await writeFile(
			join(projectRoot, "src/rank.ts"),
			[
				"export async function rankFeed(input: { items: string[] }): Promise<{ ranked: string[] }> {",
				'  "use training";',
				comment,
				"  return { ranked: [...input.items].sort() };",
				"}",
				assignment,
			].join("\n"),
		);
		await runCodegen({ projectRoot, check: false });
		const result = await build({
			entryPoints: [join(projectRoot, "src/_generated/trainables.ts")],
			bundle: true,
			packages: "external",
			format: "esm",
			platform: "node",
			minify: true,
			write: false,
		});
		const bundle = result.outputFiles[0];
		if (!bundle) throw new Error("Missing trainables bundle");
		if (comment) expect(bundle.text).not.toContain(comment);
		const file = join(projectRoot, "trainables-bundled.mjs");
		await writeFile(file, bundle.text);
		const mod = await import(pathToFileURL(file).href);
		expect(isTrainable(mod.rankFeedTraining)).toBe(true);
		const fact = listTrainables().find((item) => item.methodRef === "rankFeed");
		expect(fact?.intent).toBe(intent);
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
	return (await import(moduleUrl)) as Awaited<
		ReturnType<typeof importTrainables>
	>;
}
