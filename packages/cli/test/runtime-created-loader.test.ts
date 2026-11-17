import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBindleDefinition } from "../src/cloud/loader.js";
import { BindleImportError } from "../src/shell/errors.js";

const projects: string[] = [];

afterEach(async () => {
	await Promise.all(
		projects.splice(0).map((project) =>
			rm(project, {
				force: true,
				recursive: true,
			}),
		),
	);
});

async function projectWithTypeScriptBindle(): Promise<string> {
	const project = await mkdtemp(join(tmpdir(), "hobo-runtime-loader-"));
	projects.push(project);
	await mkdir(join(project, "src"));
	await writeFile(join(project, "src/bindle.ts"), "not valid JavaScript");
	return project;
}

describe("runtime-created Bindle loading", () => {
	it("uses the supplied importer for a candidate created after startup", async () => {
		const project = await projectWithTypeScriptBindle();
		const imported: string[] = [];
		const definition = await loadBindleDefinition(project, {
			importModule: async (path) => {
				imported.push(path);
				return {
					default: { name: "approved", resources: {}, edges: [] },
				};
			},
		});
		expect(definition?.name).toBe("approved");
		expect(imported).toEqual([join(project, "src/bindle.ts")]);
	});

	it("surfaces importer failure instead of silently falling back", async () => {
		const project = await projectWithTypeScriptBindle();
		await expect(
			loadBindleDefinition(project, {
				importModule: async () => {
					throw new TypeError('Unknown file extension ".ts"');
				},
			}),
		).rejects.toBeInstanceOf(BindleImportError);
	});
});
