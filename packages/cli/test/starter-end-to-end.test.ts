import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyBuiltStarter } from "./support/built-starter.js";
import { slow } from "./support/slow.js";

describe("starter to executable application", () => {
	it.each([
		{ template: "todo", path: "/todos" },
		{ template: "api", path: "/api/hello" },
		{ template: "agent", path: "/agent/run" },
		{ template: "fullstack", path: "/app" },
	] as const)(
		"scaffolds, generates, builds and executes $template in plain Node",
		async ({ template, path }) => {
			const root = await mkdtemp(join(tmpdir(), "hobo-starter-e2e-"));
			try {
				const project = await copyBuiltStarter(template, root);
				await rm(join(project, "src"), { recursive: true, force: true });
				const script =
					'import {pathToFileURL} from "node:url"; const client=await import(pathToFileURL(process.argv[1]).href); const app=client.getAppModule("app.ts"); const response=await app.api.run({path:process.argv[2]}); const unknown=await app.api.run({path:"/proof"}); const home=await app.api.run({path:"/"}); process.stdout.write(JSON.stringify({response,unknown,home}));';
				const output = execFileSync(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						script,
						join(project, ".hobo/build/node-app/app.mjs"),
						path,
					],
					{ encoding: "utf8", env: {} },
				);
				const result = JSON.parse(output);
				expect(result.response).toMatchObject({
					status: 200,
					body: { template, path },
				});
				if (template === "fullstack") {
					expect(result.unknown.status).toBe(404);
					expect(result.home.status).toBe(200);
					expect(result.home.body).toContain("Your first note");
				}
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		slow(30_000),
	);
});
