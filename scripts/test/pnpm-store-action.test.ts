import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const action = readFileSync(
	new URL("../../.github/actions/pnpm-store/action.yml", import.meta.url),
	"utf8",
);

function resolveStore(env: Record<string, string>): string[] {
	const lines = action.split("\n");
	const start = lines.findIndex((line) => /^\s+run: \|$/u.test(line));
	assert.ok(start >= 0);
	const script: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() && !line.startsWith("        ")) break;
		script.push(line.slice(8));
	}
	const root = mkdtempSync(join(tmpdir(), "hobo-pnpm-store-action-"));
	try {
		const output = join(root, "output");
		const githubEnv = join(root, "env");
		const pnpm = join(root, "pnpm");
		writeFileSync(output, "");
		writeFileSync(githubEnv, "");
		writeFileSync(
			pnpm,
			"#!/bin/sh\nprintf '%s\\n' /home/runner/.local/share/pnpm/store/v10\n",
		);
		chmodSync(pnpm, 0o755);
		execFileSync("bash", ["-c", script.join("\n")], {
			env: {
				PATH: `${root}:/usr/bin:/bin`,
				GITHUB_OUTPUT: output,
				GITHUB_ENV: githubEnv,
				RUNNER_ENVIRONMENT: "self-hosted",
				COLD_SELF_HOSTED_CACHE: "false",
				CACHE_MODE: "restore",
				...env,
			},
		});
		return readFileSync(output, "utf8").trim().split("\n");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("pnpm store cache selection", () => {
	it("keeps the cold self-hosted fallback opt-in and restore-only", () => {
		assert.deepEqual(resolveStore({}), ["use-cache=false"]);
		assert.deepEqual(resolveStore({ COLD_SELF_HOSTED_CACHE: "true" }), [
			"use-cache=true",
			"path=/home/runner/.local/share/pnpm/store/v10",
		]);
		assert.deepEqual(
			resolveStore({ COLD_SELF_HOSTED_CACHE: "true", CACHE_MODE: "save" }),
			["use-cache=false"],
		);
	});

	it("keeps mounted stores ahead of the optional cache", () => {
		for (const env of [
			{ HOBO_CI_PNPM_STORE_MOUNTED: "1" },
			{ HOBO_CI_PNPM_STORE_DIR: "/pnpm-store" },
		]) {
			assert.deepEqual(
				resolveStore({ COLD_SELF_HOSTED_CACHE: "true", ...env }),
				["use-cache=false"],
			);
		}
	});

	it("continues to use the cache on hosted runners", () => {
		assert.deepEqual(resolveStore({ RUNNER_ENVIRONMENT: "github-hosted" }), [
			"use-cache=true",
			"path=/home/runner/.local/share/pnpm/store/v10",
		]);
	});
});
