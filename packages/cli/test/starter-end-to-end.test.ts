import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyBuiltStarter } from "./support/built-starter.js";

describe("starter to executable application", () => {
	it.each([
		"todo",
		"api",
		"agent",
		"fullstack",
	] as const)("scaffolds, generates, builds and executes %s in plain Node", async (template) => {
		const root = await mkdtemp(join(tmpdir(), "hobo-starter-e2e-"));
		try {
			// new -> codegen -> build, each asserted to exit 0 by the fixture.
			const project = await copyBuiltStarter(template, root);
			await rm(join(project, "src"), { recursive: true, force: true });
			const script =
				'import {pathToFileURL} from "node:url"; const client=await import(pathToFileURL(process.argv[1]).href); const app=client.getAppModule("app.ts"); const response=await app.api.run({path:"/proof"}); process.stdout.write(JSON.stringify(response));';
			const output = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					script,
					join(project, ".hobo/build/node-app/app.mjs"),
				],
				{ encoding: "utf8", env: {} },
			);
			expect(JSON.parse(output)).toMatchObject({
				status: 200,
				body: { template, path: "/proof" },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
