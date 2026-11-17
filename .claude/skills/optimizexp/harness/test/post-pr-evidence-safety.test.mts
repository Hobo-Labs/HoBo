import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../post-pr-evidence.mts", import.meta.url));
const secret = "EXTERNAL-CONTENT-MUST-NEVER-BE-POSTED\n";

function fixture(run: (input: { root: string; outside: string; scenario: string; invoke: (extra?: string[], env?: NodeJS.ProcessEnv, omitPr?: boolean) => ReturnType<typeof spawnSync>; log: string; calls: string }) => void): void {
	const base = mkdtempSync(path.join(tmpdir(), "hobo-post-evidence-"));
	const root = path.join(base, "repo");
	const outside = path.join(base, "outside");
	const bin = path.join(base, "bin");
	const log = path.join(base, "fake-gh-comments");
	const calls = path.join(base, "fake-gh-calls");
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
	writeFileSync(path.join(bin, "gh"), '#!/bin/sh\nprintf "%s %s\\n" "$1" "$2" >> "$HOBO_FAKE_GH_CALLS"\nif [ "$1" = pr ] && [ "$2" = view ]; then printf "%s\\n" "${HOBO_FAKE_GH_DETECTED_PR:-}"; exit 0; fi\nif [ "$1" = pr ] && [ "$2" = comment ]; then\n  printf "%s\\n" "$5" >> "$HOBO_FAKE_GH_LOG"\n  case "$5" in "### Scenario "*"${HOBO_FAKE_GH_FAIL_SCENARIO:-__none__}"*) echo "simulated failure" >&2; exit 1;; esac\nfi\nexit 0\n', { mode: 0o755 });
	const invoke = (extra: string[] = [], env: NodeJS.ProcessEnv = {}, omitPr = false) => spawnSync(process.execPath, ["--experimental-strip-types", cli, "--feature", "example", ...(omitPr ? [] : ["--pr", "1"]), ...extra], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ...env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOBO_FAKE_GH_LOG: log, HOBO_FAKE_GH_CALLS: calls },
	});
	try {
		run({ root, outside, scenario, invoke, log, calls });
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
	it("refuses invalid supplied and detected PR numbers before posting", () => {
		fixture(({ invoke, log, calls }) => {
			for (const value of ["--help", "0", "-1", "one", "1/2", "1.5"]) {
				const result = invoke([`--pr=${value}`]);
				assert.equal(result.status, 2, String(result.stderr));
				assert.match(String(result.stderr), /positive decimal/);
				assert.equal(existsSync(calls), false);
				assert.equal(existsSync(log), false);
			}
			const detected = invoke([], { HOBO_FAKE_GH_DETECTED_PR: "--help" }, true);
			assert.equal(detected.status, 2, String(detected.stderr));
			assert.match(String(detected.stderr), /valid PR number/);
			assert.equal(readFileSync(calls, "utf8").trim(), "pr view");
			assert.equal(existsSync(log), false);
		});
	});

	it("reports every attempted comment and fails overall when one scenario fails", () => {
		fixture(({ scenario, invoke, log }) => {
			writeFileSync(path.join(scenario, "primary.txt"), "second scenario\n");
			writeFileSync(path.join(scenario, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "primary.txt" }));
			const result = invoke([], { HOBO_FAKE_GH_FAIL_SCENARIO: "aaa-valid" });
			assert.equal(result.status, 1, String(result.stderr));
			const report = JSON.parse(String(result.stdout)) as { ok: boolean; results: { kind?: string; slug?: string; ok: boolean; error?: string }[] };
			assert.equal(report.ok, false);
			assert.deepEqual(report.results.map(({ kind, slug, ok }) => ({ kind, slug, ok })), [
				{ kind: "index", slug: undefined, ok: true },
				{ kind: undefined, slug: "aaa-valid", ok: false },
				{ kind: undefined, slug: "zzz-test", ok: true },
			]);
			assert.match(report.results[1]!.error ?? "", /simulated failure/);
			assert.match(readFileSync(log, "utf8"), /second scenario/);
		});
	});

	it("reports the resolved project-local evidence path in the index", () => {
		fixture(({ root, invoke, log }) => {
			const project = path.join(root, "site/.optimizexp/features/example/evidence/one");
			mkdirSync(project, { recursive: true });
			writeFileSync(path.join(project, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "primary.txt" }));
			writeFileSync(path.join(project, "primary.txt"), "project evidence\n");
			const result = invoke();
			assert.equal(result.status, 0, String(result.stderr));
			const comments = readFileSync(log, "utf8");
			assert.match(comments, /Canonical evidence lives on the branch under `site\/\.optimizexp\/features\/example\/evidence\//);
			assert.match(comments, /project evidence/);
			assert.doesNotMatch(comments, /first valid scenario/);
		});
	});
	it("rejects absolute, traversal, malformed, and missing primary paths before posting any scenario", () => {
		fixture(({ scenario, outside, invoke, log }) => {
			const escaped = path.relative(scenario, path.join(outside, "secret.txt")).split(path.sep).join("/");
			for (const primaryPath of [escaped, path.join(outside, "secret.txt"), "C:\\outside\\secret.txt", "../aaa-valid/primary.txt", "nested/../primary.txt", "nested//primary.txt", "nested/\u0001secret.txt", "nested/\u007fsecret.txt", ".", "", "missing.txt", null]) {
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
