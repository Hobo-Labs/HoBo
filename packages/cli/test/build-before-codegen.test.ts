import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHoboCli } from "../src/index.js";
import { copyBuiltStarter } from "./support/built-starter.js";
import { slow } from "./support/slow.js";

// A build's cheap refusals judge hobo.bindle.json and the generated imprint.
// When codegen has not produced that imprint (or a clone dropped the
// gitignored .hobo/), neither is authoritative, so the freshness gate answers.
describe("hobo build on a project codegen has not generated", {
	timeout: slow(60_000),
}, () => {
	let root: string;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "hobo-build-before-codegen-"));
	});
	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function build(cwd: string, ...args: string[]) {
		const result = await createHoboCli().run(["build", ...args, "--json"], {
			cwd,
		});
		return JSON.parse(result.stdout);
	}

	it("asks for codegen after hobo new", async () => {
		const cwd = await mkdtemp(join(root, "new-"));
		const created = await createHoboCli().run(["new", "app", "--json"], {
			cwd,
		});
		expect(created.exitCode, created.stdout).toBe(0);
		expect(await build(join(cwd, "app"))).toMatchObject({
			ok: false,
			code: "HOBO_BUILD_CODEGEN_DRIFT",
		});
	});

	it.each([
		{ request: "the default runtime", args: [] },
		{ request: "an explicit wasm runtime", args: ["--runtime", "wasm"] },
	])("asks for codegen in a fresh clone of a built starter, for $request", async ({
		args,
	}) => {
		const project = await copyBuiltStarter(
			"api",
			await mkdtemp(join(root, "clone-")),
		);
		// .hobo/ is gitignored by every starter, so a clone has none of it.
		await rm(join(project, ".hobo"), { recursive: true, force: true });
		expect(await build(project, ...args)).toMatchObject({
			ok: false,
			code: "HOBO_BUILD_CODEGEN_DRIFT",
		});
	});

	it("asks for codegen in a plain TypeScript project with no hobo.bindle.json", async () => {
		const project = await mkdtemp(join(root, "plain-"));
		await writeFile(join(project, "package.json"), '{"type":"module"}');
		await writeFile(
			join(project, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					types: [],
				},
			}),
		);
		await writeFile(
			join(project, "app.ts"),
			"export function total(units: number): number { return units * 2; }\n",
		);
		expect(await build(project)).toMatchObject({
			ok: false,
			code: "HOBO_BUILD_CODEGEN_DRIFT",
		});
	});
});
