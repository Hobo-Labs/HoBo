import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const script = join(import.meta.dirname, "..", "ci", "deps-layer.mts");
const key = "v0123456789ab-0123456789abcdef";

function write(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function link(path: string, target: string): void {
	mkdirSync(dirname(path), { recursive: true });
	symlinkSync(target, path, "dir");
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
) {
	return spawnSync(command, args, {
		cwd,
		env,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	});
}

describe("deps layer linking", () => {
	it("rejects a label-only match and resolves linked root and workspace modules", () => {
		const temporary = mkdtempSync(join(tmpdir(), "hobo-deps-layer-"));
		try {
			const checkout = join(temporary, "checkout");
			const payload = join(temporary, "payload");
			mkdirSync(join(checkout, "packages", "ci-gh-actions"), {
				recursive: true,
			});
			write(join(checkout, "package.json"), '{"private":true}\n');
			write(
				join(checkout, "packages", "ci-gh-actions", "package.json"),
				'{"name":"@hobo/ci-gh-actions","private":true}\n',
			);
			write(
				join(checkout, "packages", "ci", "package.json"),
				'{"name":"@hobo/ci","private":true}\n',
			);
			write(join(payload, ".hobo-ci-deps-key"), `${key}\n`);
			write(
				join(payload, "node_modules", ".modules.yaml"),
				`${JSON.stringify({ storeDir: "/pnpm-store/v10", virtualStoreDir: ".pnpm" }, null, 2)}\n`,
			);
			write(
				join(payload, "node_modules", ".pnpm", "tsx", "package.json"),
				'{"name":"tsx","version":"4.22.4","main":"index.js","bin":{"tsx":"index.js"}}\n',
			);
			write(
				join(payload, "node_modules", ".pnpm", "tsx", "index.js"),
				'#!/usr/bin/env node\nconsole.log("tsx-test");\n',
			);
			chmodSync(
				join(payload, "node_modules", ".pnpm", "tsx", "index.js"),
				0o755,
			);
			link(join(payload, "node_modules", "tsx"), ".pnpm/tsx");
			link(join(payload, "node_modules", ".bin", "tsx"), "../tsx/index.js");
			link(
				join(
					payload,
					"packages",
					"ci-gh-actions",
					"node_modules",
					"@hobo",
					"ci",
				),
				"../../../ci",
			);
			link(
				join(payload, "packages", "ci-gh-actions", "node_modules", "tsx"),
				"../../../node_modules/tsx",
			);
			const env = {
				...process.env,
				HOBO_CI_DEPS_LAYER: key,
				HOBO_CI_DEPS_EXPECTED_KEY: key,
				HOBO_CI_DEPS_PAYLOAD: payload,
			};
			const missing = run(
				process.execPath,
				["--experimental-strip-types", script, "check"],
				checkout,
				env,
			);
			assert.equal(missing.status, 0, missing.stderr);
			assert.match(missing.stdout, /miss \(modules-not-linked/);
			assert.match(missing.stdout, /match=false/);

			const linked = run(
				process.execPath,
				["--experimental-strip-types", script, "link"],
				checkout,
				env,
			);
			assert.equal(linked.status, 0, linked.stderr);
			assert.equal(
				lstatSync(join(checkout, "node_modules")).isSymbolicLink(),
				true,
			);
			assert.equal(
				readlinkSync(
					join(
						checkout,
						"packages",
						"ci-gh-actions",
						"node_modules",
						"@hobo",
						"ci",
					),
				),
				join(checkout, "packages", "ci"),
			);
			const checked = run(
				process.execPath,
				["--experimental-strip-types", script, "check", "--require"],
				checkout,
				env,
			);
			assert.equal(checked.status, 0, checked.stderr);
			assert.match(checked.stdout, /match=true/);
			const otherJob = run(
				process.execPath,
				["--experimental-strip-types", script, "check"],
				checkout,
				{ ...env, HOBO_CI_DEPS_LAYER: "v0123456789ab-fedcba9876543210" },
			);
			assert.match(otherJob.stdout, /miss \(job-key-mismatch\)/);
			for (const cwd of [
				checkout,
				join(checkout, "packages", "ci-gh-actions"),
			]) {
				const resolved = run(
					process.execPath,
					["-e", 'process.stdout.write(require.resolve("tsx"))'],
					cwd,
					env,
				);
				assert.equal(resolved.status, 0, resolved.stderr);
			}
			const executable = run(
				"pnpm",
				["exec", "tsx", "--version"],
				checkout,
				env,
			);
			assert.equal(executable.status, 0, executable.stderr);
			assert.match(executable.stdout, /tsx-test/);
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
});
