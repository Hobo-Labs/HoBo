import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectCodegenEngine } from "../src/codegen/engine.js";
import { writeFixtureProject } from "../src/codegen/fixture.js";
import { runCodegen } from "../src/codegen/run-codegen.js";
import { defaultCodegenLayout } from "../src/codegen/types.js";
import { createHoboCli } from "../src/index.js";

describe("hobo codegen", () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "hobo-codegen-cli-"));
		await writeFixtureProject(projectRoot);
	});

	afterEach(async () => {
		await rm(projectRoot, { recursive: true, force: true });
	});

	it("writes the checked-in generated tree from project sources", async () => {
		const result = await createHoboCli().run(["codegen", "--json"], {
			cwd: projectRoot,
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");

		const envelope = JSON.parse(result.stdout);
		expect(envelope.ok).toBe(true);
		expect(envelope.verb).toBe("codegen");
		expect(envelope.data.mode).toBe("write");
		expect(envelope.data.written).toContain("src/_generated/api-tree.ts");
		await expect(
			access(join(projectRoot, "src/_generated/api-tree.ts")),
		).resolves.toBeUndefined();
	});

	it("--check passes on a freshly generated tree", async () => {
		await createHoboCli().run(["codegen"], { cwd: projectRoot });

		const result = await createHoboCli().run(["codegen", "--check", "--json"], {
			cwd: projectRoot,
		});

		expect(result.exitCode).toBe(0);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.ok).toBe(true);
		expect(envelope.data.mode).toBe("check");
		expect(envelope.data.checked).toContain("src/_generated/api-tree.ts");
	});

	it("--check reports drift and exits non-zero on a stale tree", async () => {
		await createHoboCli().run(["codegen"], { cwd: projectRoot });
		await writeFile(
			join(projectRoot, "src/_generated/hooks.ts"),
			"stale generated file\n",
		);

		const result = await createHoboCli().run(["codegen", "--check", "--json"], {
			cwd: projectRoot,
		});

		expect(result.exitCode).toBe(1);
		const envelope = JSON.parse(result.stdout);
		expect(envelope.ok).toBe(false);
		expect(envelope.code).toBe("HOBO_CODEGEN_DRIFT");
		expect(envelope.message).toMatch(/drift/);
		expect(Array.isArray(envelope.data.detail.drift)).toBe(true);
	});

	it("every output path and generated import specifier is layout-overridable", async () => {
		const base = defaultCodegenLayout();
		const engine = createProjectCodegenEngine({
			layout: {
				...base,
				generatedRoots: [".hobo/generated", "generated"],
				files: {
					manifest: ".hobo/generated/manifest.json",
					apiTree: "generated/api.ts",
					bindings: "generated/models.d.ts",
					hooks: "generated/hooks.ts",
					steps: "generated/steps.d.ts",
					workflows: "generated/workflows.d.ts",
					withOptions: "generated/options.d.ts",
					trainables: "generated/trainables.ts",
				},
				imports: {
					runtimeModule: "@acme/runtime",
					bindingsSpecifier: "./models.js",
				},
			},
		});

		const report = await runCodegen({ projectRoot, check: false }, { engine });

		expect(report.written).toContain("generated/models.d.ts");
		const apiTree = await readFile(
			join(projectRoot, "generated/api.ts"),
			"utf8",
		);
		expect(apiTree).toContain('from "./models.js"');
		const trainables = await readFile(
			join(projectRoot, "generated/trainables.ts"),
			"utf8",
		);
		expect(trainables).toContain('from "@acme/runtime"');
		expect(trainables).toContain('from "./models.js"');
	});

	it("regeneration is idempotent across a clean rewrite", async () => {
		await createHoboCli().run(["codegen"], { cwd: projectRoot });
		const first = await readFile(
			join(projectRoot, "src/_generated/api-tree.ts"),
			"utf8",
		);
		await createHoboCli().run(["codegen"], { cwd: projectRoot });
		const second = await readFile(
			join(projectRoot, "src/_generated/api-tree.ts"),
			"utf8",
		);
		expect(second).toBe(first);
	});
});
