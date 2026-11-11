import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	runHobo,
	scaffoldHoboProject,
	VALID_TEMPLATES,
	validateScaffoldProject,
} from "../src/index.js";

const expectedCreatedFiles = [
	".gitignore",
	"app.test.ts",
	"app.ts",
	"hobo.bindle.json",
	"package.json",
	"src/_generated/hobo.d.ts",
	"src/_generated/index.ts",
	"tsconfig.json",
];

async function withScratch<T>(
	callback: (cwd: string) => Promise<T>,
): Promise<T> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-new-scaffold-"));
	try {
		return await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function assertFile(root: string, relativePath: string) {
	const info = await stat(path.join(root, relativePath));
	expect(info.isFile()).toBe(true);
}

describe("hobo new scaffold", () => {
	it("scaffolds an api project through the CLI shell and stays offline", async () => {
		await withScratch(async (cwd) => {
			const result = await runHobo(["new", "snapshop", "-t", "api", "--json"], {
				cwd,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");

			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				verb: string;
				data: {
					name: string;
					template: string;
					offline: boolean;
					nextSteps: string[];
					createdFiles: string[];
				};
			};
			expect(envelope.ok).toBe(true);
			expect(envelope.verb).toBe("new");
			expect(envelope.data.name).toBe("snapshop");
			expect(envelope.data.template).toBe("api");
			expect(envelope.data.offline).toBe(true);
			expect(envelope.data.nextSteps).toEqual([
				"cd snapshop",
				"npm install",
				"npm run typecheck",
				"npm test",
				"hobo dev",
			]);
			expect(envelope.data.createdFiles).toEqual(expectedCreatedFiles);

			const projectDir = path.join(cwd, "snapshop");
			for (const relativePath of expectedCreatedFiles) {
				await assertFile(projectDir, relativePath);
			}

			// That the api project's own tests and typecheck pass is asserted, with
			// every other template, in "creates all four templates" below.
			const report = await validateScaffoldProject(projectDir);
			expect(report.ok).toBe(true);
		});
	});

	// Spawns tsc + node --test for all four templates; slow on cold CI runners.
	it(
		"creates all four templates as runnable SDK project stubs",
		{ timeout: 120_000 },
		async () => {
			await withScratch(async (cwd) => {
				expect(VALID_TEMPLATES).toEqual(["todo", "api", "agent", "fullstack"]);

				for (const template of VALID_TEMPLATES) {
					const { projectDir, createdFiles } = await scaffoldHoboProject({
						cwd,
						// SAFETY: `name: `sample-${template}` as never,` is required at this I/O or test boundary.
						name: `sample-${template}` as never,
						template,
					});

					expect(createdFiles).toEqual(expectedCreatedFiles);

					const report = await validateScaffoldProject(projectDir);
					expect(report.ok).toBe(true);
					expect(report.template).toBe(template);
					assertGeneratedProjectRuns(projectDir);
					assertGeneratedProjectTypechecks(projectDir);
				}
			});
		},
		30_000,
	);

	it("prints exact next steps for human output", async () => {
		await withScratch(async (cwd) => {
			const result = await runHobo(["new", "snapshop", "--template", "todo"], {
				cwd,
			});

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toMatch(/Created HoBo project snapshop/);
			expect(result.stdout).toMatch(
				/cd snapshop\nnpm install\nnpm run typecheck\nnpm test\nhobo dev/,
			);
		});
	});

	it("fails safely when the destination is populated and --force is absent", async () => {
		await withScratch(async (cwd) => {
			const projectDir = path.join(cwd, "snapshop");
			await mkdir(projectDir);
			await writeFile(
				path.join(projectDir, "README.md"),
				"existing human work\n",
			);

			const result = await runHobo(["new", "snapshop", "-t", "api"], { cwd });

			expect(result.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toMatch(/already exists and is not empty/);
			expect(await readFile(path.join(projectDir, "README.md"), "utf8")).toBe(
				"existing human work\n",
			);
			await expect(
				stat(path.join(projectDir, "package.json")),
			).rejects.toThrow();
		});
	});

	it("emits JSON failure envelope with remediation for non-empty destination", async () => {
		await withScratch(async (cwd) => {
			const projectDir = path.join(cwd, "snapshop");
			await mkdir(projectDir);
			await writeFile(path.join(projectDir, "README.md"), "existing\n");

			const result = await runHobo(["new", "snapshop", "-t", "api", "--json"], {
				cwd,
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toBe("");

			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				ok: boolean;
				code: string;
				remediation: string[];
			};
			expect(envelope.ok).toBe(false);
			expect(envelope.code).toMatch(/^HOBO_/);
			expect(envelope.remediation.length).toBeGreaterThanOrEqual(1);
		});
	});

	it("rejects invalid templates and unsafe project names without silently defaulting", async () => {
		await withScratch(async (cwd) => {
			const invalidTemplate = await runHobo(["new", "snapshop", "-t", "nope"], {
				cwd,
			});
			expect(invalidTemplate.exitCode).toBe(2);
			expect(invalidTemplate.stdout).toBe("");
			expect(invalidTemplate.stderr).toMatch(/Unknown template "nope"/);

			for (const name of [
				"../snapshop",
				"snap/shop",
				"snap\\shop",
				"CON",
				"aux",
				"snap:shop",
				"",
			]) {
				const invalidName = await runHobo(["new", name, "-t", "api"], { cwd });
				expect(invalidName.exitCode).toBe(2);
				expect(invalidName.stdout).toBe("");
				expect(invalidName.stderr).toMatch(/Invalid project name/);
			}
		});
	});

	it("can scaffold inside an existing git repo with --force without clobbering unrelated files", async () => {
		await withScratch(async (cwd) => {
			const projectDir = path.join(cwd, "snapshop");
			await mkdir(path.join(projectDir, ".git"), { recursive: true });
			await writeFile(path.join(projectDir, "README.md"), "do not touch\n");
			await writeFile(path.join(projectDir, ".gitignore"), "coverage/\n");
			await writeFile(
				path.join(projectDir, ".git", "HEAD"),
				"ref: refs/heads/main\n",
			);

			const result = await runHobo(
				["new", "snapshop", "-t", "fullstack", "--force", "--json"],
				{
					cwd,
				},
			);

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(await readFile(path.join(projectDir, "README.md"), "utf8")).toBe(
				"do not touch\n",
			);
			expect(
				await readFile(path.join(projectDir, ".git", "HEAD"), "utf8"),
			).toBe("ref: refs/heads/main\n");
			expect(await readFile(path.join(projectDir, ".gitignore"), "utf8")).toBe(
				"coverage/\n.hobo/\n.hobo-codegen.lock\n.hobo-codegen.lock-*\n.hobo-codegen-*\nnode_modules/\ndist/\n",
			);

			// SAFETY: `const envelope = JSON.parse(result.stdout) as {` is required at this I/O or test boundary.
			const envelope = JSON.parse(result.stdout) as {
				data: { createdFiles: string[] };
			};
			expect(envelope.data.createdFiles).toEqual(expectedCreatedFiles);
			await assertFile(projectDir, "package.json");
		});
	});
});

/**
 * What the subprocess actually said.
 *
 * `expect(result.status).toBe(0)` alone reports "expected 1 to be +0" and
 * throws away the compiler diagnostics or the failing test output that explain
 * it — which turns a scaffold regression into a guessing game. The scaffold is
 * generated, so the failure is never visible in a diff either; the subprocess
 * output is the only evidence there is.
 */
function subprocessReport(
	label: string,
	result: { readonly stdout?: string; readonly stderr?: string },
): string {
	const parts = [result.stdout, result.stderr]
		.map((part) => (part ?? "").trim())
		.filter((part) => part.length > 0);
	return parts.length === 0
		? `${label} failed and produced no output`
		: `${label} failed:\n${parts.join("\n")}`;
}

function assertGeneratedProjectRuns(projectDir: string) {
	const result = spawnSync(
		process.execPath,
		["--experimental-strip-types", "--test", "app.test.ts"],
		{
			cwd: projectDir,
			encoding: "utf8",
			shell: false,
		},
	);

	expect(
		result.status,
		subprocessReport("generated project tests", result),
	).toBe(0);
}

function assertGeneratedProjectTypechecks(projectDir: string) {
	const result = spawnSync(
		process.execPath,
		[typescriptCliPath(), "--noEmit", "--project", "tsconfig.json"],
		{
			cwd: projectDir,
			encoding: "utf8",
			shell: false,
		},
	);

	expect(result.error).toBeUndefined();
	expect(result.status, subprocessReport("generated project tsc", result)).toBe(
		0,
	);
}

/**
 * Where `tsc` actually is, asked of Node rather than guessed from the cwd.
 *
 * This used to be `path.resolve(process.cwd(), "..", "..", "node_modules", …)`,
 * which encodes two assumptions that are both wrong often enough to matter: that
 * the process cwd is this package's directory (it is when `pnpm --filter` runs
 * the suite, and is not when vitest is pointed here with `--root` from the
 * workspace root), and that `typescript` is hoisted to exactly two levels up
 * (pnpm's layout is not a promise). When either slipped, the spawn failed with
 * `MODULE_NOT_FOUND` for a path like `/home/node_modules/typescript/bin/tsc`
 * and the assertion reported it as `expected 1 to be +0` — a scaffold
 * regression indistinguishable from a broken test path.
 *
 * Resolving `typescript/package.json` and walking to its `bin/tsc` uses the
 * same algorithm the runtime uses, so it is correct from any cwd and any
 * hoisting depth. `package.json` is the entry to ask for because it is exported
 * by convention even when a package restricts its `exports` map.
 */
function typescriptCliPath() {
	const require = createRequire(import.meta.url);
	return path.join(
		path.dirname(require.resolve("typescript/package.json")),
		"bin",
		"tsc",
	);
}
