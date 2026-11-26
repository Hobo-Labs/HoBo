/**
 * Tests for workflow-file loading.
 *
 * Small, and it was 0% covered. Everything the CI guard concludes about a
 * repository's workflows is derived from what this returns, so a filter that
 * quietly skipped a file — or an order that varied between runs — would make
 * the guard's verdict wrong or non-reproducible without failing anything.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadWorkflowFiles } from "../src/workflows.js";

async function workflowDir(files: Record<string, string>) {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-workflows-"));
	for (const [name, content] of Object.entries(files))
		await writeFile(path.join(dir, name), content);
	return dir;
}

describe("loadWorkflowFiles", () => {
	it("returns name, absolute path and content for each workflow", async () => {
		const dir = await workflowDir({ "ci.yml": "name: CI\n" });
		const [file] = await loadWorkflowFiles(dir);
		expect(file?.name).toBe("ci.yml");
		expect(file?.path).toBe(path.join(dir, "ci.yml"));
		expect(file?.content).toBe("name: CI\n");
	});

	it("accepts both .yml and .yaml, in either case", async () => {
		const dir = await workflowDir({
			"a.yml": "a",
			"b.yaml": "b",
			"c.YML": "c",
			"d.YAML": "d",
		});
		expect((await loadWorkflowFiles(dir)).map((f) => f.name)).toEqual([
			"a.yml",
			"b.yaml",
			"c.YML",
			"d.YAML",
		]);
	});

	it("ignores files that are not YAML", async () => {
		const dir = await workflowDir({
			"ci.yml": "yes",
			"README.md": "no",
			"config.json": "no",
			yml: "no",
			"notes.yml.bak": "no",
		});
		expect((await loadWorkflowFiles(dir)).map((f) => f.name)).toEqual([
			"ci.yml",
		]);
	});

	it("ignores directories, even ones named like a workflow", async () => {
		const dir = await workflowDir({ "real.yml": "yes" });
		await mkdir(path.join(dir, "nested.yml"));
		expect((await loadWorkflowFiles(dir)).map((f) => f.name)).toEqual([
			"real.yml",
		]);
	});

	it("returns a stable, sorted order regardless of creation order", async () => {
		const dir = await workflowDir({ "z.yml": "z", "a.yml": "a", "m.yml": "m" });
		expect((await loadWorkflowFiles(dir)).map((f) => f.name)).toEqual([
			"a.yml",
			"m.yml",
			"z.yml",
		]);
	});

	it("returns an empty list for a directory with no workflows", async () => {
		expect(await loadWorkflowFiles(await workflowDir({}))).toEqual([]);
	});

	it("rejects rather than silently returning nothing for a missing directory", async () => {
		const dir = await workflowDir({});
		await expect(
			loadWorkflowFiles(path.join(dir, "does-not-exist")),
		).rejects.toThrow();
	});
});
