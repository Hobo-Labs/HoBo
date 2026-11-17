import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../post-pr-evidence.mts", import.meta.url));
const secret = "EXTERNAL-CONTENT-MUST-NEVER-BE-POSTED\n";

function artifact(dir: string, primaryPath: string, content: string): string {
	const file = path.join(dir, primaryPath);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, content);
	const sha256 = createHash("sha256").update(content).digest("hex");
	writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath }));
	writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ driver: "cli", primary: { file: primaryPath, kind: "transcript", sha256 }, claims: [] }));
	return sha256;
}

function acceptReview(dir: string, sha256: string): void {
	writeFileSync(path.join(dir, "review.json"), JSON.stringify({ status: "accepted", reviewer: "reviewer", relevance: "relevant", completeness: "complete", coverageMode: "full-journey", coveredClaims: [], artifactSha256: sha256, notes: "The full captured journey was independently reviewed." }));
}

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
	artifact(path.join(evidence, "aaa-valid"), "primary.txt", "first valid scenario\n");
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
			artifact(scenario, "primary.txt", "second scenario\n");
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
			artifact(project, "primary.txt", "project evidence\n");
			const result = invoke();
			assert.equal(result.status, 0, String(result.stderr));
			const comments = readFileSync(log, "utf8");
			assert.match(comments, /Canonical evidence lives on the branch under `site\/\.optimizexp\/features\/example\/evidence\//);
			assert.match(comments, /project evidence/);
			assert.doesNotMatch(comments, /first valid scenario/);
		});
	});

	it("permits consistent pending evidence but refuses alternate primaries and stale accepted reviews", () => {
		fixture(({ root, invoke, log }) => {
			const feature = path.join(root, ".optimizexp/features/example");
			const dir = path.join(feature, "evidence/aaa-valid");
			const sha = createHash("sha256").update("first valid scenario\n").digest("hex");
			writeFileSync(path.join(feature, "feature.json"), JSON.stringify({ id: "example" }));
			writeFileSync(path.join(feature, "example.feature"), "Feature: Example\n  Scenario: aaa valid\n    Then evidence is visible\n");
			writeFileSync(path.join(dir, "review.json"), JSON.stringify({ status: "pending" }));
			const pending = invoke();
			assert.equal(pending.status, 0, String(pending.stderr));
			assert.match(readFileSync(log, "utf8"), /\| pending \|/);
			rmSync(log);
			acceptReview(dir, sha);
			const accepted = invoke();
			assert.equal(accepted.status, 0, String(accepted.stderr));
			assert.match(readFileSync(log, "utf8"), /\| accepted \|/);
			rmSync(log);
			writeFileSync(path.join(dir, "alternate.txt"), "UNREVIEWED ALTERNATE CONTENT\n");
			writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "alternate.txt" }));
			assertNoComment(invoke(), log);
			const capture = fileURLToPath(new URL("../capture-evidence.mts", import.meta.url));
			const strict = spawnSync(process.execPath, ["--experimental-strip-types", capture, "--mode=validate", "--project=root", "--feature=example", "--strict"], { cwd: root, encoding: "utf8" });
			assert.equal(strict.status, 1, strict.stderr);
			assert.match(String(strict.stdout), /manifest_primary_mismatch/);
			writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ kind: "transcript", primaryPath: "primary.txt" }));
			writeFileSync(path.join(dir, "primary.txt"), "changed since review\n");
			assertNoComment(invoke(), log);
			const stale = spawnSync(process.execPath, ["--experimental-strip-types", capture, "--mode=validate", "--project=root", "--feature=example", "--strict"], { cwd: root, encoding: "utf8" });
			assert.equal(stale.status, 1, stale.stderr);
			assert.match(String(stale.stdout), /primary_artifact_hash_mismatch/);
			artifact(dir, "primary.txt", "changed since review\n");
			assertNoComment(invoke(), log);
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
			artifact(scenario, "nested/primary.txt", "second valid scenario\n");
			const result = invoke();
			assert.equal(result.status, 0, String(result.stderr));
			const comments = readFileSync(log, "utf8");
			assert.match(comments, /first valid scenario/);
			assert.match(comments, /second valid scenario/);
			assert.equal(comments.includes(secret), false);
		});
	});

	it("keeps transcript fences and path punctuation literal in comments", () => {
		fixture(({ scenario, invoke, log }) => {
			artifact(scenario, "nested/primary`|odd.txt", "start\n```\n@team\n````\nend\n");
			const result = invoke();
			assert.equal(result.status, 0, String(result.stderr));
			const comments = readFileSync(log, "utf8");
			assert.ok(comments.includes("`````text\nstart\n```\n@team\n````\nend\n\n`````"));
			assert.ok(comments.includes("primary`\\|odd.txt``"));
		});
	});

	it("rejects a manifest kind that can inject Markdown before posting", () => {
		fixture(({ scenario, invoke, log }) => {
			const hash = artifact(scenario, "primary.txt", "evidence\n");
			const kind = "transcript\n@team";
			writeFileSync(path.join(scenario, "manifest.json"), JSON.stringify({ kind, primaryPath: "primary.txt" }));
			writeFileSync(path.join(scenario, "meta.json"), JSON.stringify({ driver: "cli", primary: { file: "primary.txt", kind, sha256: hash }, claims: [] }));
			assertNoComment(invoke(), log);
		});
	});

	it("encodes punctuation in image link destinations", () => {
		fixture(({ scenario, invoke, log }) => {
			const primaryPath = "nested/picture )`|.png";
			const sha256 = artifact(scenario, primaryPath, "image bytes");
			writeFileSync(path.join(scenario, "manifest.json"), JSON.stringify({ kind: "image", primaryPath }));
			writeFileSync(path.join(scenario, "meta.json"), JSON.stringify({ driver: "web", primary: { file: primaryPath, kind: "image", sha256 }, claims: [] }));
			const result = invoke();
			assert.equal(result.status, 0, String(result.stderr));
			assert.match(readFileSync(log, "utf8"), /nested\/picture%20%29%60%7C\.png\)/);
		});
	});
});
