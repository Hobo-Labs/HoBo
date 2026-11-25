import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const runtime = dirname(dirname(fileURLToPath(import.meta.url)));
const packages = dirname(runtime);
const requireFromRuntime = createRequire(join(runtime, "package.json"));

it("typechecks packed runtime and WIT packages in a hoisted consumer", async () => {
	const dir = await mkdtemp(join(tmpdir(), "hobo-messaging-consumer-"));
	try {
		await execFileAsync(
			process.execPath,
			[requireFromRuntime.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"],
			{ cwd: runtime },
		);
		const scope = join(dir, "node_modules/@hobo");
		await mkdir(scope, { recursive: true });
		for (const name of ["core", "wit", "runtime"]) {
			const packagePath = join(packages, name);
			const { stdout } = await execFileAsync(
				"npm",
				[
					"pack",
					"--ignore-scripts",
					"--json",
					"--cache",
					join(dir, "npm-cache"),
					"--pack-destination",
					dir,
				],
				{ cwd: packagePath, timeout: 60_000 },
			);
			const parsed = JSON.parse(stdout) as { filename: string }[];
			const archive = parsed[0]?.filename;
			if (archive === undefined) throw new Error("missing package archive");
			const target = join(scope, name);
			await mkdir(target);
			await execFileAsync("tar", [
				"-xzf",
				join(dir, archive),
				"--strip-components=1",
				"-C",
				target,
			]);
		}
		await symlink(
			join(packages, "core/node_modules/@bufbuild"),
			join(dir, "node_modules/@bufbuild"),
			"dir",
		);
		await symlink(
			join(runtime, "node_modules/@types"),
			join(dir, "node_modules/@types"),
			"dir",
		);
		await writeFile(
			join(dir, "package.json"),
			JSON.stringify({ type: "module" }),
		);
		await writeFile(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					noEmit: true,
					skipLibCheck: false,
					types: ["node"],
				},
				files: ["consumer.ts"],
			}),
		);
		await writeFile(
			join(dir, "consumer.ts"),
			`import { createDurableMessagingWitHost, type DurableMessagingWitHost } from "@hobo/runtime/durable-messaging-host";
import type { TopicOutcome } from "@hobo/wit/durable-messaging";
type IsAny<T> = 0 extends (1 & T) ? true : false;
const noAny: IsAny<Awaited<ReturnType<DurableMessagingWitHost["ensureTopic"]>>> = false;
const typed: TopicOutcome = { tag: "committed", val: { topic: "orders" } };
void [createDurableMessagingWitHost, noAny, typed];
`,
		);
		const result = await execFileAsync(
			process.execPath,
			[
				requireFromRuntime.resolve("typescript/bin/tsc"),
				"-p",
				join(dir, "tsconfig.json"),
			],
			{ cwd: dir, timeout: 60_000 },
		);
		expect(result.stderr).toBe("");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}, 120_000);
