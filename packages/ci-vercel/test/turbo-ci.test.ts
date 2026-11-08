import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { z } from "zod";
import { planTurboCi, runTurboCi } from "../src/turbo-ci.js";
import { isolateTurboEnv } from "./isolated-turbo-env.js";

isolateTurboEnv();
const turboPath = createRequire(import.meta.url).resolve("turbo/bin/turbo");
const roots: string[] = [];
// Child Turbo must not inherit GITHUB_ACTIONS and write error annotations into the real job log.
beforeEach(() => vi.stubEnv("GITHUB_ACTIONS", undefined));
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function json(root: string, path: string, value: z.core.JSONType) {
	const target = join(root, path);
	await mkdir(resolve(target, ".."), { recursive: true });
	await writeFile(target, JSON.stringify(value));
}
function record(name: string) {
	return `node -e "require('node:fs').appendFileSync('ran.txt', '${name}\\n')"`;
}
async function fixture() {
	const cwd = await mkdtemp(join(tmpdir(), "hobo-turbo-ci-"));
	roots.push(cwd);
	await json(cwd, "package.json", {
		name: "fixture",
		private: true,
		packageManager: "pnpm@10.33.4",
	});
	await writeFile(
		join(cwd, "pnpm-workspace.yaml"),
		"packages:\n  - packages/*\n",
	);
	await writeFile(
		join(cwd, "pnpm-lock.yaml"),
		"lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/app:\n    dependencies:\n      lib:\n        specifier: workspace:*\n        version: link:../lib\n  packages/lib: {}\n  packages/legacy: {}\n",
	);
	await writeFile(
		join(cwd, ".gitignore"),
		".turbo/\nnode_modules/\nran.txt\nbuilt.txt\n",
	);
	await json(cwd, "turbo.json", {
		tasks: {
			build: { outputs: ["built.txt"] },
			test: { tags: ["ci", "ci:cpus:8"], dependsOn: ["^build"], outputs: [] },
		},
	});
	for (const name of ["app", "lib", "legacy"]) {
		await json(cwd, `packages/${name}/package.json`, {
			name,
			scripts: {
				test: record("test"),
				build:
					"node -e \"require('node:fs').writeFileSync('built.txt','built')\"",
				check: record("check"),
			},
			dependencies: name === "app" ? { lib: "workspace:*" } : {},
		});
		await writeFile(join(cwd, `packages/${name}/source.txt`), name);
	}
	await json(cwd, "packages/app/turbo.json", {
		extends: ["//"],
		tasks: {
			test: { tags: ["$TURBO_EXTENDS$", "ci:cpus:4"] },
			check: { tags: ["ci"] },
		},
	});
	await json(cwd, "packages/lib/turbo.json", {
		extends: ["//"],
		tasks: {
			test: { tags: ["ci", "!ci"] },
			build: { tags: ["!ci"] },
		},
	});
	// Package labels must not select tasks; Vercel uses task-level ci tags.
	await json(cwd, "packages/legacy/turbo.json", {
		extends: ["//"],
		tags: ["ci"],
		tasks: { test: { tags: ["!ci"] } },
	});
	return { cwd, turboPath };
}
function git(cwd: string, ...args: string[]) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

it("uses resolved tags, package overrides and opt-outs without running during planning", async () => {
	const options = await fixture();
	const plan = await planTurboCi(options);
	expect(plan.taskIds).toEqual(["app#check", "app#test"]);
	expect(plan.runArgs).toContain("--cache=local:rw");
	expect(plan.runArgs).toContain("--concurrency=100%");
	expect(existsSync(join(options.cwd, "packages/app/ran.txt"))).toBe(false);
});

it("runs checks locally, includes !ci dependencies and reuses Turbo outputs", async () => {
	const options = await fixture();
	expect(await runTurboCi(options)).toBe(0);
	expect(
		(await readFile(join(options.cwd, "packages/app/ran.txt"), "utf8"))
			.split("\n")
			.filter(Boolean)
			.sort(),
	).toEqual(["check", "test"]);
	expect(
		await readFile(join(options.cwd, "packages/lib/built.txt"), "utf8"),
	).toBe("built");
	expect(existsSync(join(options.cwd, "packages/legacy/ran.txt"))).toBe(false);
	await rm(join(options.cwd, "packages/lib/built.txt"));
	expect(await runTurboCi(options)).toBe(0);
	expect(
		await readFile(join(options.cwd, "packages/lib/built.txt"), "utf8"),
	).toBe("built");
	expect(
		(await readFile(join(options.cwd, "packages/app/ran.txt"), "utf8"))
			.split("\n")
			.filter(Boolean),
	).toHaveLength(2);
}, 20_000);

it("selects affected CI roots before emitting qualified selectors", async () => {
	const options = await fixture();
	git(options.cwd, "init");
	git(
		options.cwd,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@hobo.test",
		"add",
		".",
	);
	git(
		options.cwd,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@hobo.test",
		"commit",
		"-m",
		"base",
	);
	const base = git(options.cwd, "rev-parse", "HEAD");
	await writeFile(
		join(options.cwd, "packages/legacy/source.txt"),
		"unrelated edit",
	);
	git(options.cwd, "add", ".");
	git(
		options.cwd,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@hobo.test",
		"commit",
		"-m",
		"legacy only",
	);
	expect(
		(await planTurboCi({ ...options, affected: true, base })).taskIds,
	).toEqual([]);
	await writeFile(
		join(options.cwd, "packages/lib/source.txt"),
		"dependency edit",
	);
	git(options.cwd, "add", ".");
	git(
		options.cwd,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@hobo.test",
		"commit",
		"-m",
		"lib edit",
	);
	const plan = await planTurboCi({ ...options, affected: true, base });
	expect(plan.taskIds).toEqual(["app#check", "app#test"]);
	expect(plan.runArgs).not.toContain("--affected");
	await expect(
		planTurboCi({ ...options, affected: true, base: "missing-history" }),
	).rejects.toThrow("Turbo planning failed");
});

it("returns a successful empty plan when no task is opted in", async () => {
	const options = await fixture();
	await json(options.cwd, "turbo.json", { tasks: { build: {} } });
	for (const name of ["app", "lib", "legacy"])
		await rm(join(options.cwd, `packages/${name}/turbo.json`));
	expect((await planTurboCi(options)).runArgs).toEqual([]);
	expect(await runTurboCi(options)).toBe(0);
});

it.each([
	false,
	true,
])("refuses Vercel OIDC from task or package defaults (package=%s)", async (packageDefault) => {
	const options = await fixture();
	await json(options.cwd, "packages/app/turbo.json", {
		extends: ["//"],
		tags: packageDefault ? ["ci:oidc:deployments"] : [],
		tasks: {
			test: { tags: packageDefault ? ["ci"] : ["ci", "ci:oidc:deployments"] },
		},
	});
	await expect(planTurboCi(options)).rejects.toThrow(
		"cannot supply Vercel-managed OIDC",
	);
});

it("lets explicit ci:oidc:none override package OIDC", async () => {
	const options = await fixture();
	await json(options.cwd, "packages/app/turbo.json", {
		extends: ["//"],
		tags: ["ci:oidc:deployments"],
		tasks: { test: { tags: ["ci", "ci:oidc:none"] } },
	});
	expect((await planTurboCi(options)).taskIds).toEqual(["app#test"]);
});

it("refuses persistent CI work", async () => {
	const options = await fixture();
	await json(options.cwd, "packages/app/turbo.json", {
		extends: ["//"],
		tasks: { test: { tags: ["ci"], persistent: true, cache: false } },
	});
	await expect(planTurboCi(options)).rejects.toThrow("persistent task");
});

it("propagates failed checks and accepts cancellation before starting", async () => {
	const options = await fixture();
	await json(options.cwd, "packages/app/package.json", {
		name: "app",
		scripts: { test: 'node -e "process.exit(7)"' },
	});
	expect(await runTurboCi(options)).not.toBe(0);
	const controller = new AbortController();
	controller.abort(new Error("cancelled by fixture"));
	await expect(
		runTurboCi({ ...options, signal: controller.signal }),
	).rejects.toThrow("cancelled by fixture");
});

it("only enables remote cache when explicitly requested", async () => {
	const options = await fixture();
	expect(
		(await planTurboCi({ ...options, remoteCache: true })).runArgs,
	).toContain("--cache=local:rw,remote:rw");
	await expect(planTurboCi({ ...options, base: "main" })).rejects.toThrow(
		"base/head require affected",
	);
});

it("stops a running task's process group on cancellation", async () => {
	const options = await fixture();
	await json(options.cwd, "packages/app/package.json", {
		name: "app",
		scripts: {
			test: "node -e \"require('node:fs').writeFileSync('pid.txt',String(process.pid));setInterval(()=>{},100)\"",
		},
	});
	const controller = new AbortController();
	const stopped = expect(
		runTurboCi({ ...options, signal: controller.signal }),
	).rejects.toThrow("stop fixture");
	const pidFile = join(options.cwd, "packages/app/pid.txt");
	try {
		const deadline = Date.now() + 10_000;
		while (!existsSync(pidFile) && Date.now() < deadline)
			await new Promise((done) => setTimeout(done, 25));
		const pid = Number(await readFile(pidFile, "utf8"));
		controller.abort(new Error("stop fixture"));
		await stopped;
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		controller.abort(new Error("stop fixture"));
		await stopped;
	}
}, 15_000);

it("refuses virtual deployment prerequisites before launching commands", async () => {
	const options = await fixture();
	await json(options.cwd, "packages/app/turbo.json", {
		extends: ["//"],
		tasks: { test: { tags: ["ci"], dependsOn: ["app#deployment"] } },
	});
	await expect(planTurboCi(options)).rejects.toThrow();
	expect(existsSync(join(options.cwd, "packages/app/ran.txt"))).toBe(false);
});
