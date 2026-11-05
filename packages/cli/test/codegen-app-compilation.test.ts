import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { writeFixtureProject } from "../src/codegen/fixture.js";
import { selectProjectCodegenEngine } from "../src/codegen/project-engine.js";
import { runCodegen } from "../src/codegen/run-codegen.js";
import { scannedSources } from "../src/codegen/source-files.js";
import {
	type CodegenArtifact,
	defaultCodegenLayout,
} from "../src/codegen/types.js";
import { createHoboCli } from "../src/index.js";

describe("generated app declarations compile", () => {
	it.each([
		{ complex: false, empty: false },
		{ complex: true, empty: false },
		{ complex: false, empty: true },
	])("writes, compiles and drift-checks complex=$complex", async ({
		complex,
		empty,
	}) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-codegen-compile-"));
		try {
			await writeFixtureProject(root);
			await writeFile(join(root, "package.json"), '{"type":"module"}');
			const repo = fileURLToPath(new URL("../../../", import.meta.url));
			await mkdir(join(root, "node_modules/@hobo"), { recursive: true });
			for (const name of ["core", "runtime"])
				await symlink(
					join(repo, "packages", name),
					join(root, "node_modules/@hobo", name),
					"dir",
				);
			await symlink(
				join(repo, "node_modules/@types"),
				join(root, "node_modules/@types"),
				"dir",
			);
			if (complex) {
				await writeFile(
					join(root, ".hobo/sources/zod/resources.json"),
					JSON.stringify({
						$defs: {
							Address: {
								type: "object",
								fields: {
									city: { type: "string" },
									tags: { type: "array", items: { type: "string" } },
								},
							},
						},
						resources: {
							"order-line": {
								fields: {
									"display-name": { type: "string" },
									address: { $ref: "#/$defs/Address" },
									forbidden: { type: "never", optional: true },
									'quote"key': { type: "boolean" },
								},
							},
							ticket: { fields: { id: { type: "string" } } },
						},
					}),
				);
				await writeFile(
					join(root, "hobo.bindle.json"),
					JSON.stringify({
						bindles: [
							{
								name: 'sales"app',
								provider: 'custom"provider',
								resources: ["order-line"],
								workflows: ['order"sync'],
								with: { "deployment-region": ["eu", "us"] },
							},
							{
								name: "support",
								provider: "camp",
								resources: ["ticket"],
								workflows: ["ticket.triage"],
							},
						],
					}),
				);
			}
			if (empty)
				await writeFile(
					join(root, "hobo.bindle.json"),
					JSON.stringify({ bindles: [] }),
				);
			const written = await runCodegen({ projectRoot: root, check: false });
			const declarations = written.written
				.filter((path) => path.endsWith(".ts"))
				.map((path) => join(root, path));
			const program = ts.createProgram(declarations, {
				noEmit: true,
				strict: true,
				types: ["node"],
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ES2022,
			});
			expect(
				ts
					.getPreEmitDiagnostics(program)
					.map((diagnostic) =>
						ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
					),
			).toEqual([]);
			await expect(
				runCodegen({ projectRoot: root, check: true }),
			).resolves.toMatchObject({ mode: "check" });
			const bindingPath = join(root, "src/_generated/bindings.d.ts");
			const first = await readFile(bindingPath, "utf8");
			await runCodegen({ projectRoot: root, check: false });
			expect(await readFile(bindingPath, "utf8")).toBe(first);
			await writeFile(bindingPath, "stale");
			await expect(
				runCodegen({ projectRoot: root, check: true }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_DRIFT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("does not exclude authored directories sharing a generated-root prefix", async () => {
		const root = await mkdtemp(join(tmpdir(), "hobo-codegen-scan-"));
		try {
			await mkdir(join(root, "src/_generated-helper"), { recursive: true });
			await mkdir(join(root, "src/_generated"), { recursive: true });
			const authored = join(root, "src/_generated-helper/handler.ts");
			await writeFile(authored, "export const helper = 1;");
			await writeFile(
				join(root, "src/_generated/ignored.ts"),
				"export const generated = 1;",
			);
			expect(await scannedSources(root, defaultCodegenLayout())).toEqual([
				authored,
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each([
		{ names: ["123"] },
		{ names: ["resource-name"] },
		{ names: ["order-line", "order_line"] },
	])("refuses invalid or colliding resource type names: $names", async ({
		names,
	}) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-codegen-names-"));
		try {
			await writeFixtureProject(root);
			await writeFile(
				join(root, ".hobo/sources/zod/resources.json"),
				JSON.stringify({
					resources: Object.fromEntries(
						names.map((name) => [name, { fields: { id: { type: "string" } } }]),
					),
				}),
			);
			await expect(
				runCodegen({ projectRoot: root, check: false }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_SOURCE_PARSE" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each([
		{ definition: { $ref: "#/$defs/missing" } },
		{
			definition: {
				type: "object",
				fields: { child: { $ref: "missing", optional: true } },
			},
		},
	])("rejects dangling definition graphs before writing output: $definition", async ({
		definition,
	}) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-codegen-refs-"));
		try {
			await writeFixtureProject(root);
			await writeFile(
				join(root, ".hobo/sources/zod/resources.json"),
				JSON.stringify({
					$defs: { Unused: definition },
					resources: { order: { fields: { id: "string" } } },
				}),
			);
			await expect(
				runCodegen({ projectRoot: root, check: false }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_SOURCE_PARSE" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it.each([
		"todo",
		"api",
		"agent",
		"fullstack",
	])("regenerates starter %s without deleting its runnable seed", async (template) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-starter-codegen-"));
		try {
			const result = await createHoboCli().run(
				["new", "app", "-t", template, "--json"],
				{ cwd: root },
			);
			expect(result.exitCode).toBe(0);
			const projectRoot = join(root, "app");
			const seed = join(projectRoot, "src/_generated/index.ts");
			const before = await readFile(seed, "utf8");
			const app = join(projectRoot, "app.ts");
			const neighbor = join(
				projectRoot,
				"src/_generated/other-generator/model.ts",
			);
			await mkdir(join(projectRoot, "src/_generated/other-generator"), {
				recursive: true,
			});
			const neighborSource =
				'export const otherGeneratorValue = "preserved";\n';
			await writeFile(neighbor, neighborSource);
			const authored = `${await readFile(app, "utf8")}\nexport { otherGeneratorValue } from "./src/_generated/other-generator/model.js";\n`;
			await writeFile(app, authored);
			let artifacts: readonly CodegenArtifact[] | undefined;
			const regenerate = async (check: boolean) => {
				const selected = await selectProjectCodegenEngine(projectRoot);
				return runCodegen(
					{ projectRoot, check },
					{
						engine: {
							...selected,
							async generate(root) {
								artifacts ??= await selected.generate(root);
								return artifacts.filter(
									(artifact) =>
										selected.layout.ownedFiles?.includes(artifact.path) ===
											true ||
										selected.layout.generatedRoots.some((generatedRoot) =>
											artifact.path.startsWith(`${generatedRoot}/`),
										),
								);
							},
						},
					},
				);
			};
			await regenerate(false);
			await expect(regenerate(true)).resolves.toMatchObject({ mode: "check" });
			expect(await readFile(seed, "utf8")).toBe(before);
			await writeFile(seed, "stale seed");
			await expect(regenerate(true)).rejects.toMatchObject({
				code: "HOBO_CODEGEN_DRIFT",
			});
			await regenerate(false);
			expect(await readFile(seed, "utf8")).toBe(before);
			expect(await readFile(app, "utf8")).toBe(authored);
			expect(await readFile(neighbor, "utf8")).toBe(neighborSource);
			const metadata = join(projectRoot, "hobo.bindle.json");
			await writeFile(
				metadata,
				(await readFile(metadata, "utf8")).replace("app.ts", "custom.ts"),
			);
			await expect(regenerate(false)).resolves.toMatchObject({ mode: "write" });
			expect(await readFile(seed, "utf8")).toBe(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
