import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../post-pr-evidence.mts", import.meta.url));
const secret = "EXTERNAL-CONTENT-MUST-NEVER-BE-POSTED\n";

function fixture(run: (input: { root: string; outside: string; scenario: string; invoke: (extra?: string[]) => ReturnType<typeof spawnSync>; log: string }) => void): void {
	const base = mkdtempSync(path.join(tmpdir(), "hobo-post-evidence-"));
	const root = path.join(base, "repo");
	const outside = path.join(base, "outside");
	const bin = path.join(base, "bin");
	const log = path.join(base, "fake-gh-comments");
	const evidence = path.join(root, ".optimizexp/features/example/evidence");
	const scenario = path.join(evidence, "zzz-test");
	mkdirSync(path.join(root, ".git"), { recursive: true });
	mkdirSync(path.join(evidence, "aaa-valid"), { recursive: true });
	mkdirSync(scenario);
	mkdirSync(outside);
	mkdirSync(bin);
	writeFileSync(path.join(evidence, "aaa-valid/manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "primary.txt" }));
	writeFileSync(path.join(evidence, "aaa-valid/primary.txt"), "first valid scenario\n");
	writeFileSync(path.join(outside, "secret.txt"), secret);
	writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nif [ "$1" = pr ] && [ "$2" = comment ]; then printf "%s\\n" "$5" >> "$HOBO_FAKE_GH_LOG"; fi\nexit 0\n', { mode: 0o755 });
	const invoke = (extra: string[] = []) => spawnSync(process.execPath, ["--experimental-strip-types", cli, "--feature", "example", "--pr", "1", ...extra], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOBO_FAKE_GH_LOG: log },
	});
	try {
		run({ root, outside, scenario, invoke, log });
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

function assertNoComment(result: ReturnType<typeof spawnSync>, log: string): void {
	assert.equal(result.status, 2, String(result.stderr));
	assert.equal(existsSync(log), false, "no index or scenario comment may be posted");
	assert.equal(String(result.stdout).includes(secret), false);
	assert.equal(String(result.stderr).includes(secret), false);
}

describe("PR evidence manifest read boundary", () => {
	it("rejects absolute, traversal, malformed, and missing primary paths before posting any scenario", () => {
		fixture(({ scenario, outside, invoke, log }) => {
			const escaped = path.relative(scenario, path.join(outside, "secret.txt")).split(path.sep).join("/");
			for (const primaryPath of [escaped, path.join(outside, "secret.txt"), "C:\\outside\\secret.txt", "../aaa-valid/primary.txt", "nested/../primary.txt", "nested//primary.txt", ".", "", "missing.txt", null]) {
				writeFileSync(path.join(scenario, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath }));
				const result = invoke();
				assertNoComment(result, log);
				assert.match(String(result.stderr), /Invalid evidence/);
			}
		});
	});

	it("rejects symlinked and hard-linked path components in both posting and dry-run modes", () => {
		fixture(({ scenario, outside, invoke, log }) => {
			const manifest = path.join(scenario, "manifest.json");
			const primary = path.join(scenario, "primary.txt");
			const aliases = path.join(scenario, "linked");
			writeFileSync(manifest, JSON.stringify({ kind: "transcript", primaryPath: "primary.txt" }));
			symlinkSync(path.join(outside, "secret.txt"), primary);
			for (const extra of [[], ["--dry-run"]]) assertNoComment(invoke(extra), log);
			rmSync(primary);
			linkSync(path.join(outside, "secret.txt"), primary);
			for (const extra of [[], ["--dry-run"]]) assertNoComment(invoke(extra), log);
			rmSync(primary);
			symlinkSync(outside, aliases, "dir");
			writeFileSync(manifest, JSON.stringify({ kind: "transcript", primaryPath: "linked/secret.txt" }));
			for (const extra of [[], ["--dry-run"]]) assertNoComment(invoke(extra), log);
			rmSync(aliases);
			rmSync(manifest);
			writeFileSync(path.join(outside, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "secret.txt" }));
			symlinkSync(path.join(outside, "manifest.json"), manifest);
			for (const extra of [[], ["--dry-run"]]) assertNoComment(invoke(extra), log);
		});
	});

	it("rejects directory primaries and a symlinked scenario before any comments", () => {
		fixture(({ scenario, outside, invoke, log }) => {
			mkdirSync(path.join(scenario, "directory"));
			writeFileSync(path.join(scenario, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "directory" }));
			assertNoComment(invoke(), log);
			rmSync(scenario, { recursive: true });
			symlinkSync(outside, scenario, "dir");
			assertNoComment(invoke(), log);
			assertNoComment(invoke(["--dry-run"]), log);
		});
	});

	it("posts valid contained transcript files, including nested relative paths", () => {
		fixture(({ scenario, invoke, log }) => {
			mkdirSync(path.join(scenario, "nested"));
			writeFileSync(path.join(scenario, "nested/primary.txt"), "second valid scenario\n");
			writeFileSync(path.join(scenario, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "nested/primary.txt" }));
			const result = invoke();
			assert.equal(result.status, 0, String(result.stderr));
			const comments = readFileSync(log, "utf8");
			assert.match(comments, /first valid scenario/);
			assert.match(comments, /second valid scenario/);
			assert.equal(comments.includes(secret), false);
		});
	});
});
