import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { releaseOciTurboBuildArgs } from "../ci/stage-release-oci-app.mts";

test("a deeply shallow release checkout never fetches or broadens the deployable build", () => {
	const temp = mkdtempSync(join(tmpdir(), "hobo-release-closure-"));
	const git = (cwd: string, ...args: string[]): string => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const oldPath = process.env.PATH;
	const oldBase = process.env.HOBO_RELEASE_TURBO_BASE;
	try {
		const seed = join(temp, "seed");
		git(temp, "init", "--quiet", "--initial-branch=main", seed);
		git(seed, "config", "user.name", "Release Fixture");
		git(seed, "config", "user.email", "fixture@example.invalid");
		const tree = git(seed, "mktree");
		let parent = git(seed, "commit-tree", tree, "-m", "base");
		git(seed, "tag", "v0.0.0-alpha.2", parent);
		for (let i = 0; i < 480; i++)
			parent = git(
				seed,
				"commit-tree",
				tree,
				"-p",
				parent,
				"-m",
				`commit-${i}`,
			);
		git(seed, "update-ref", "refs/heads/main", parent);
		const origin = join(temp, "origin.git");
		git(temp, "clone", "--quiet", "--bare", seed, origin);
		const work = join(temp, "work");
		git(
			temp,
			"clone",
			"--quiet",
			"--depth=1",
			"--branch",
			"main",
			`file://${origin}`,
			work,
		);
		assert.equal(git(work, "rev-parse", "--is-shallow-repository"), "true");
		const shim = join(temp, "shim");
		mkdirSync(shim);
		const log = join(temp, "git-called");
		writeFileSync(join(shim, "git"), `#!/bin/sh\ntouch "${log}"\nexit 1\n`, {
			mode: 0o755,
		});
		process.env.PATH = `${shim}:${oldPath}`;
		process.env.HOBO_RELEASE_TURBO_BASE = "v0.0.0-alpha.2";
		assert.deepEqual(releaseOciTurboBuildArgs(work, ["@hobo/hobo..."], {}), [
			"exec",
			"turbo",
			"run",
			"build",
			"--filter=@hobo/hobo...",
		]);
		process.env.HOBO_RELEASE_TURBO_BASE = `invalid; touch ${join(temp, "injected")}`;
		assert.deepEqual(releaseOciTurboBuildArgs(work, ["@hobo/hobo..."], {}), [
			"exec",
			"turbo",
			"run",
			"build",
			"--filter=@hobo/hobo...",
		]);
		assert.equal(existsSync(log), false);
		assert.equal(existsSync(join(temp, "injected")), false);
		assert.throws(
			() => releaseOciTurboBuildArgs(work, []),
			/requires at least one image filter/,
		);
	} finally {
		if (oldPath === undefined) delete process.env.PATH;
		else process.env.PATH = oldPath;
		if (oldBase === undefined) delete process.env.HOBO_RELEASE_TURBO_BASE;
		else process.env.HOBO_RELEASE_TURBO_BASE = oldBase;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("the deployable closure restores warm outputs and invalidates only relevant changes", () => {
	const temp = mkdtempSync(join(tmpdir(), "hobo-release-cache-"));
	const turbo = resolve(
		import.meta.dirname,
		"../../node_modules/turbo/bin/turbo",
	);
	const env: NodeJS.ProcessEnv = { TURBO_TELEMETRY_DISABLED: "1" };
	for (const key of [
		"PATH",
		"HOME",
		"TMPDIR",
		"SystemRoot",
		"ComSpec",
		"TEMP",
		"TMP",
	]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	const write = (relativePath: string, text: string): void => {
		const file = join(temp, relativePath);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, text);
	};
	const run = (...args: string[]): string => {
		const result = spawnSync(process.execPath, [turbo, ...args], {
			cwd: temp,
			env,
			encoding: "utf8",
			maxBuffer: 10_000_000,
		});
		assert.equal(
			result.status,
			0,
			`${result.stderr}
${result.stdout}`,
		);
		return result.stdout;
	};
	try {
		write(
			"package.json",
			JSON.stringify({
				name: "proof",
				private: true,
				packageManager: "pnpm@10.33.4",
			}),
		);
		write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
		write(
			"turbo.json",
			JSON.stringify({
				tasks: { build: { dependsOn: ["^build"], outputs: ["dist/**"] } },
			}),
		);
		write(
			"pnpm-lock.yaml",
			`lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/dep: {}\n  packages/other: {}\n  packages/app:\n    dependencies:\n      '@test/dep':\n        specifier: workspace:*\n        version: link:../dep\n`,
		);
		for (const name of ["dep", "app", "other"]) {
			const common = {
				name: `@test/${name}`,
				version: "1.0.0",
				scripts: { build: "node build.cjs" },
			};
			const manifest =
				name === "app"
					? { ...common, dependencies: { "@test/dep": "workspace:*" } }
					: common;
			write(`packages/${name}/package.json`, JSON.stringify(manifest));
			write(
				`packages/${name}/build.cjs`,
				'const fs=require("fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/out",fs.readFileSync("input.txt"));',
			);
			write(`packages/${name}/input.txt`, name);
		}
		const args = releaseOciTurboBuildArgs(temp, ["@test/app..."]).slice(2);
		run(...args, "--cache=local:rw", "--output-logs=none");
		run(...args, "--cache=local:rw", "--output-logs=none");
		const dry = () => {
			const result: {
				tasks: { taskId: string; hash: string; cache: { status: string } }[];
			} = JSON.parse(run(...args, "--cache=local:rw", "--dry=json"));
			return result.tasks.map((task) => ({
				id: task.taskId,
				hash: task.hash,
				cache: task.cache.status,
			}));
		};
		const warm = dry();
		assert.equal(warm.length, 2);
		assert.ok(warm.every((task) => task.cache === "HIT"));
		write("packages/dep/input.txt", "dep-changed");
		const changed = dry();
		assert.ok(changed.every((task) => task.cache === "MISS"));
		assert.ok(
			changed.every(
				(task) =>
					warm.find((before) => before.id === task.id)?.hash !== task.hash,
			),
		);
		write("packages/dep/input.txt", "dep");
		write("packages/other/input.txt", "other-changed");
		assert.deepEqual(dry(), warm);
		assert.equal(
			readFileSync(join(temp, "packages/app/dist/out"), "utf8"),
			"app",
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
