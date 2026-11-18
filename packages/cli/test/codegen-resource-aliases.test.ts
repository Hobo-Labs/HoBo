import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bindle, resourceIdentityLedger } from "@hobo/bindles";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { writeFixtureProject } from "../src/codegen/fixture.js";
import { runCodegen } from "../src/codegen/run-codegen.js";

describe("generated resource aliases", () => {
	it("writes typed alias mappings and detects generated drift", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "hobo-alias-codegen-"));
		try {
			await writeFixtureProject(root);
			await mkdir(path.join(root, "src"), { recursive: true });
			const bindles = pathToFileURL(
				path.resolve("packages/bindles/dist/index.js"),
			).href;
			await writeFile(
				path.join(root, "src", "bindle.mjs"),
				`import { bindle } from ${JSON.stringify(bindles)};\nexport default bindle("shop", (builder) => { const cache = builder.kv(); return { cache, api: builder.api().dependsOn(cache) }; });\n`,
			);
			const definition = bindle("shop", (builder) => {
				const cache = builder.kv();
				return { cache, api: builder.api().dependsOn(cache) };
			});
			await writeFile(
				path.join(root, "hobo.resource-identities.json"),
				JSON.stringify(resourceIdentityLedger(definition)),
			);
			const result = await runCodegen({ projectRoot: root, check: false });
			const aliasPath = "src/_generated/resource-aliases.d.ts";
			expect(result.written).toContain(aliasPath);
			const generated = await readFile(path.join(root, aliasPath), "utf8");
			expect(generated).toContain(
				'readonly "cache": ResourceBinding<"res_kv_0001", "kv">',
			);
			const consumer = path.join(root, "consumer.ts");
			await writeFile(
				consumer,
				'import type { ResourceAliases } from "./src/_generated/resource-aliases.js";\ndeclare const aliases: ResourceAliases;\nconst id: "res_kv_0001" = aliases.cache.generatedId;\nvoid id;\n',
			);
			const program = ts.createProgram([consumer], {
				module: ts.ModuleKind.NodeNext,
				moduleResolution: ts.ModuleResolutionKind.NodeNext,
				target: ts.ScriptTarget.ES2022,
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				types: [],
			});
			expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
			await expect(
				runCodegen({ projectRoot: root, check: true }),
			).resolves.toMatchObject({ mode: "check" });
			await writeFile(path.join(root, aliasPath), "stale\n");
			await expect(
				runCodegen({ projectRoot: root, check: true }),
			).rejects.toMatchObject({ code: "HOBO_CODEGEN_DRIFT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
