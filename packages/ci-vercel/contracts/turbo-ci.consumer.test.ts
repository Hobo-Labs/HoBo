import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { planTurboCi } from "../src/turbo-ci.js";

it("verifies the local planner's CLI pact against the installed Turbo binary", async () => {
	const pact = z
		.object({
			interactions: z.array(
				z.object({
					request: z.object({ argv: z.array(z.string()) }),
					response: z.object({
						data: z.object({
							packages: z.object({
								items: z.array(
									z.object({
										name: z.string(),
										tags: z.array(z.string()),
										tasks: z.object({
											items: z.array(
												z.object({
													fullName: z.string(),
													tags: z.array(z.string()),
												}),
											),
										}),
									}),
								),
							}),
						}),
					}),
				}),
			),
		})
		.parse(
			JSON.parse(
				await readFile(
					new URL("./turbo-ci.pact.json", import.meta.url),
					"utf8",
				),
			),
		);
	const cwd = await mkdtemp(join(tmpdir(), "hobo-turbo-pact-"));
	const turboPath = createRequire(import.meta.url).resolve("turbo/bin/turbo");
	try {
		await mkdir(join(cwd, "packages/web"), { recursive: true });
		await writeFile(
			join(cwd, "package.json"),
			JSON.stringify({
				name: "fixture",
				private: true,
				packageManager: "pnpm@10.33.4",
			}),
		);
		await writeFile(
			join(cwd, "pnpm-workspace.yaml"),
			"packages:\n  - packages/*\n",
		);
		await writeFile(
			join(cwd, "turbo.json"),
			'{ "tasks": { "test": { "tags": ["ci"] } } }',
		);
		await writeFile(
			join(cwd, "packages/web/package.json"),
			JSON.stringify({
				name: "web",
				scripts: { test: 'node -e "process.exit(0)"' },
			}),
		);
		await writeFile(
			join(cwd, "packages/web/turbo.json"),
			'{ "extends": ["//"], "tags": ["package-label"] }',
		);
		for (const interaction of pact.interactions) {
			const actual = JSON.parse(
				execFileSync(
					process.execPath,
					[turboPath, ...interaction.request.argv],
					{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
				),
			);
			expect(actual).toMatchObject(interaction.response);
		}
		expect((await planTurboCi({ cwd, turboPath })).taskIds).toEqual([
			"web#test",
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
