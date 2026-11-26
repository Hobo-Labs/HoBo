import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertGeneratedFresh } from "../src/build/codegen-gate.js";
import { createHoboCli } from "../src/index.js";
import { slow } from "./support/slow.js";

describe("plain TypeScript application through the product command path", () => {
	it(
		"discovers tsconfig, writes/checks executable imprints, and shares build/stub selection",
		async () => {
			const root = await mkdtemp(join(tmpdir(), "hobo-ts-cli-"));
			try {
				await writeFile(join(root, "package.json"), '{"type":"module"}');
				await writeFile(
					join(root, "tsconfig.json"),
					JSON.stringify({
						compilerOptions: {
							target: "ES2022",
							module: "NodeNext",
							moduleResolution: "NodeNext",
							strict: true,
							types: [],
						},
						include: ["source/**/*.ts"],
					}),
				);
				await mkdir(join(root, "source"));
				await writeFile(
					join(root, "source/service.ts"),
					"export function calculate(order: { items: Array<{price:number;quantity:number}> }): number { return order.items.reduce((sum,item)=>sum+item.price*item.quantity,0); }",
				);
				const cli = createHoboCli();
				const generated = await cli.run(["codegen", "--json"], { cwd: root });
				expect(generated.exitCode, generated.stdout).toBe(0);
				expect(
					await readFile(
						join(root, "src/_generated/app-imprint/app.ts"),
						"utf8",
					),
				).toContain("createAppClient");
				expect(
					(await cli.run(["codegen", "--check", "--json"], { cwd: root }))
						.exitCode,
				).toBe(0);
				expect(
					(await cli.run(["stub", "--check", "--json"], { cwd: root }))
						.exitCode,
				).toBe(0);
				await expect(assertGeneratedFresh(root)).resolves.toBeUndefined();
				await writeFile(
					join(root, "source/service.ts"),
					"export function calculate(): number { return 42; }",
				);
				expect(
					(await cli.run(["codegen", "--check", "--json"], { cwd: root }))
						.exitCode,
				).toBe(1);
				await expect(assertGeneratedFresh(root)).rejects.toMatchObject({
					code: "HOBO_BUILD_CODEGEN_DRIFT",
				});
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
		slow(30_000),
	);
});
