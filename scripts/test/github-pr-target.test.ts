import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { JsonValue } from "../ci/attestation.mts";
import {
	PrHeadVerificationError,
	verifyPrHead,
} from "../ci/github-pr-target.mts";
import { GIT_LOCATION_VARIABLES, gitEnvironment } from "../ci/local-attest.mts";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const target = {
	id: 111,
	name: "HoBo",
	full_name: "Hobo-Labs/HoBo",
	owner: { login: "Hobo-Labs" },
};
const fork = {
	id: 222,
	name: "HoBo",
	full_name: "Contributor/HoBo",
	owner: { login: "Contributor" },
};
const pull = () => ({
	number: 42,
	state: "open",
	base: { ref: "main", sha: baseSha, repo: target },
	head: { ref: "feature/fix-ci", sha: headSha, repo: fork },
});
const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hobo-fork-proof-"));
	roots.push(root);
	const bin = join(root, "bin");
	const cwd = join(root, "checkout");
	const log = join(root, "calls");
	mkdirSync(bin);
	mkdirSync(cwd);
	writeFileSync(log, "");
	const store = (name: string, value: Readonly<Record<string, JsonValue>>) =>
		writeFileSync(join(root, `${name}.json`), JSON.stringify(value));
	store("pull", pull());
	store("target", target);
	store("fork", fork);
	store("branch", { name: "feature/fix-ci", commit: { sha: headSha } });
	store("basebranch", { name: "main", commit: { sha: baseSha } });
	writeFileSync(
		join(bin, "gh"),
		`#!/bin/sh
if [ -n "$GIT_DIR$GIT_WORK_TREE$GIT_INDEX_FILE$GIT_COMMON_DIR$GIT_OBJECT_DIRECTORY$GIT_ALTERNATE_OBJECT_DIRECTORIES$GIT_NAMESPACE$GIT_PREFIX$GIT_QUARANTINE_PATH" ]; then exit 1; fi
if [ "$GIT_NO_REPLACE_OBJECTS" != 1 ] || [ "$GIT_GRAFT_FILE" != /dev/null ] || [ -n "$GIT_REPLACE_REF_BASE" ]; then exit 1; fi
printf '%s|%s|%s\\n' "$GH_HOST" "$GH_REPO" "$*" >> "$HOBO_PR_LOG"
if [ "$1" = pr ] && [ "$2" = view ]; then
  case " $* " in *" --repo "*) echo 'argument required when using the --repo flag' >&2; exit 1 ;; esac
  if [ "$HOBO_PR_FAIL" = discovery ]; then echo "$HOBO_PR_SECRET" >&2; exit 1; fi
  printf '%s\\n' "$HOBO_PR_DISCOVERED"
  exit 0
fi
if [ "$1" != api ] || [ "$2" != --hostname ] || [ "$3" != "$GH_HOST" ]; then exit 1; fi
case "$4" in
  'repos/{owner}/{repo}/pulls/'*) file=pull ;;
  'repos/{owner}/{repo}/branches/'*) file=basebranch ;;
  'repos/{owner}/{repo}') file=target ;;
  'repos/Hobo-Labs/HoBo/branches/'*) file=branch ;;
  'repos/Hobo-Labs/HoBo') file=target ;;
  'repos/Contributor/HoBo/branches/'*) file=branch ;;
  'repos/Contributor/HoBo') file=fork ;;
  *) exit 1 ;;
esac
if [ "$HOBO_PR_FAIL" = "$file" ]; then echo "$HOBO_PR_SECRET" >&2; exit 1; fi
cat "$HOBO_PR_FIXTURE/$file.json" || exit 1
if [ "$file" = branch ]; then
  for later in pull fork; do
    if [ -f "$HOBO_PR_FIXTURE/after-branch-$later.json" ]; then
      cp "$HOBO_PR_FIXTURE/after-branch-$later.json" "$HOBO_PR_FIXTURE/$later.json"
    fi
  done
fi
if [ "$file" = basebranch ] && [ -f "$HOBO_PR_FIXTURE/after-basebranch-target.json" ]; then
  cp "$HOBO_PR_FIXTURE/after-basebranch-target.json" "$HOBO_PR_FIXTURE/target.json"
fi
`,
		{ mode: 0o755 },
	);
	const env: NodeJS.ProcessEnv = {
		PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		GH_HOST: "github.com",
		GH_REPO: "github.com/Hobo-Labs/HoBo",
		HOBO_PR_FIXTURE: root,
		HOBO_PR_LOG: log,
		HOBO_PR_SECRET: "sensitive-child-output",
		HOBO_PR_DISCOVERED: "42",
	};
	const verify = (
		overrides: Partial<Parameters<typeof verifyPrHead>[0]> = {},
	) =>
		verifyPrHead({
			cwd,
			env,
			baseBranch: "main",
			baseSha,
			headSha,
			prNumber: 42,
			...overrides,
		});
	return {
		cwd,
		env,
		log: () => readFileSync(log, "utf8"),
		reset: () => writeFileSync(log, ""),
		store,
		raw: (name: string, value: string) =>
			writeFileSync(join(root, `${name}.json`), value),
		verify,
	};
}

function refused(action: () => object, message?: RegExp) {
	assert.throws(action, (error) => {
		assert.ok(error instanceof PrHeadVerificationError);
		assert.doesNotMatch(error.message, /sensitive-child-output/u);
		if (message) assert.match(error.message, message);
		return true;
	});
}

describe("pull request head verification", () => {
	it("binds an explicit PR to the target, fork identity, live branch and commits", () => {
		const f = fixture();
		assert.deepEqual(f.verify(), {
			host: "github.com",
			prNumber: 42,
			baseRepository: { name: "Hobo-Labs/HoBo", id: 111 },
			baseBranch: "main",
			baseSha,
			headRepository: { name: "Contributor/HoBo", id: 222 },
			headBranch: "feature/fix-ci",
			headSha,
		});
		const calls = f.log().trim().split("\n");
		assert.equal(calls.length, 8);
		for (const call of calls)
			assert.match(
				call,
				/^github\.com\|github\.com\/Hobo-Labs\/HoBo\|api --hostname github\.com /u,
			);
		assert.match(calls[0] ?? "", /repos\/\{owner\}\/\{repo\}\/pulls\/42$/u);
		assert.match(
			calls[3] ?? "",
			/repos\/Contributor\/HoBo\/branches\/feature%2Ffix-ci$/u,
		);
		assert.match(calls[4] ?? "", /repos\/Contributor\/HoBo$/u);
		assert.match(
			calls[5] ?? "",
			/repos\/\{owner\}\/\{repo\}\/branches\/main$/u,
		);
		assert.match(calls[7] ?? "", /repos\/\{owner\}\/\{repo\}\/pulls\/42$/u);
		assert.doesNotMatch(f.log(), /signoff|POST|sensitive-child-output/u);
	});

	it("verifies a same-repository head with the same live branch and identity checks", () => {
		const f = fixture();
		const sample = pull();
		f.store("pull", { ...sample, head: { ...sample.head, repo: target } });
		const proof = f.verify();
		assert.deepEqual(proof.headRepository, { name: "Hobo-Labs/HoBo", id: 111 });
		assert.equal(proof.headBranch, "feature/fix-ci");
		assert.match(
			f.log(),
			/repos\/Hobo-Labs\/HoBo\/branches\/feature%2Ffix-ci/u,
		);
		assert.equal(f.verify({ prNumber: undefined }).headRepository.id, 111);
		f.store("branch", {
			name: "feature/fix-ci",
			commit: { sha: "c".repeat(40) },
		});
		refused(() => f.verify(), /head branch no longer/u);
	});

	it("pins the target and removes inherited Git location overrides", () => {
		const f = fixture();
		const proof = f.verify({
			env: {
				...f.env,
				GH_REPO: "Hobo-Labs/HoBo",
				GIT_DIR: "/unrelated/repository",
				GIT_WORK_TREE: "/unrelated/checkout",
				GIT_INDEX_FILE: "/unrelated/index",
				GIT_NO_REPLACE_OBJECTS: "0",
				GIT_GRAFT_FILE: "/unrelated/grafts",
				GIT_REPLACE_REF_BASE: "refs/other/",
			},
		});
		assert.equal(proof.prNumber, 42);
		assert.match(f.log(), /github\.com\|github\.com\/Hobo-Labs\/HoBo\|/u);
	});

	it("uses the same pinned host for a GitHub Enterprise fork", () => {
		const f = fixture();
		const host = "github.example.com:8443";
		const proof = f.verify({
			env: { ...f.env, GH_HOST: host, GH_REPO: `${host}/Hobo-Labs/HoBo` },
		});
		assert.equal(proof.host, host);
		for (const call of f.log().trim().split("\n"))
			assert.match(
				call,
				/^github\.example\.com:8443\|github\.example\.com:8443\/Hobo-Labs\/HoBo\|api --hostname github\.example\.com:8443 /u,
			);
	});

	it("discovers only a candidate number and still checks the PR and fork", () => {
		const f = fixture();
		assert.equal(f.verify({ prNumber: undefined }).prNumber, 42);
		const calls = f.log().trim().split("\n");
		assert.match(calls[0] ?? "", /pr view --json number --jq \.number$/u);
		assert.equal(calls.length, 9);
		f.reset();
		f.store("pull", { ...pull(), state: "closed" });
		refused(() => f.verify({ prNumber: undefined }), /open pull request/u);
	});

	it("accepts an explicit PR for a detached checkout without branch discovery", () => {
		const f = fixture();
		const other = join(f.cwd, "other");
		mkdirSync(other);
		const gitAt = (cwd: string, ...args: string[]) =>
			execFileSync("git", args, {
				cwd,
				encoding: "utf8",
				env: gitEnvironment(),
			}).trim();
		gitAt(other, "init", "--quiet", "--initial-branch=main");
		writeFileSync(join(other, "tracked.txt"), "other checkout\n");
		gitAt(other, "add", "tracked.txt");
		gitAt(
			other,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			"other",
		);
		const otherHead = gitAt(other, "rev-parse", "HEAD");
		const otherConfig = readFileSync(join(other, ".git", "config"));
		const otherIndex = readFileSync(join(other, ".git", "index"));
		const saved = new Map(
			GIT_LOCATION_VARIABLES.map((name) => [name, process.env[name]]),
		);
		process.env.GIT_DIR = join(other, ".git");
		process.env.GIT_COMMON_DIR = join(other, ".git");
		process.env.GIT_WORK_TREE = other;
		process.env.GIT_INDEX_FILE = join(other, ".git", "index");
		const git = (...args: string[]) => gitAt(f.cwd, ...args);
		try {
			git("init", "--quiet", "--initial-branch=main");
			git(
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--quiet",
				"--allow-empty",
				"-m",
				"head",
			);
			const detached = git("rev-parse", "HEAD");
			git("checkout", "--quiet", "--detach");
			const entry = pull();
			f.store("pull", { ...entry, head: { ...entry.head, sha: detached } });
			f.store("branch", { name: "feature/fix-ci", commit: { sha: detached } });
			assert.equal(f.verify({ headSha: detached }).headSha, detached);
			assert.doesNotMatch(f.log(), /pr view/u);
			refused(
				() =>
					f.verify({
						headSha: detached,
						prNumber: undefined,
						env: { ...f.env, HOBO_PR_FAIL: "discovery" },
					}),
				/specify --pr/u,
			);
		} finally {
			for (const [name, value] of saved)
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
		}
		assert.equal(gitAt(other, "rev-parse", "HEAD"), otherHead);
		assert.deepEqual(readFileSync(join(other, ".git", "config")), otherConfig);
		assert.deepEqual(readFileSync(join(other, ".git", "index")), otherIndex);
	});

	it("rejects missing, ambiguous or failed discovery without echoing child output", () => {
		for (const discovered of [
			"",
			"0",
			"1\n2",
			"not-a-number",
			"9007199254740992",
		]) {
			const f = fixture();
			refused(
				() =>
					f.verify({
						prNumber: undefined,
						env: { ...f.env, HOBO_PR_DISCOVERED: discovered },
					}),
				/specify --pr/u,
			);
			assert.doesNotMatch(f.log(), /api --hostname/u);
		}
		const f = fixture();
		refused(
			() =>
				f.verify({
					prNumber: undefined,
					env: { ...f.env, HOBO_PR_FAIL: "discovery" },
				}),
			/specify --pr/u,
		);
	});

	it("rejects invalid input and unpinned or mismatched GitHub targets before calling gh", () => {
		const f = fixture();
		for (const prNumber of [
			0,
			-1,
			1.5,
			Number.NaN,
			Number.MAX_SAFE_INTEGER + 1,
		])
			refused(() => f.verify({ prNumber }), /positive integer/u);
		for (const baseBranch of [
			"",
			"../main",
			"topic//bad",
			"-main",
			"feature bad",
			"main.lock",
		])
			refused(() => f.verify({ baseBranch }), /base or head/u);
		refused(() => f.verify({ baseSha: "bad" }), /base or head/u);
		refused(() => f.verify({ headSha: "A".repeat(40) }), /base or head/u);
		for (const env of [
			{ ...f.env, GH_HOST: undefined },
			{ ...f.env, GH_REPO: undefined },
			{ ...f.env, GH_HOST: "github.com/evil" },
			{ ...f.env, GH_HOST: "github..com" },
			{ ...f.env, GH_HOST: "github.com:99999" },
			{ ...f.env, GH_REPO: "elsewhere.example/Hobo-Labs/HoBo" },
		])
			refused(() => f.verify({ env }), /target is not pinned/u);
		assert.equal(f.log(), "");
	});

	it("rejects malformed, closed, retargeted and wrong-head PR responses", () => {
		const f = fixture();
		const sample = pull();
		for (const value of [
			{ ...sample, number: 41 },
			{ ...sample, state: "closed" },
			{ ...sample, base: { ...sample.base, ref: "other" } },
			{
				...sample,
				base: { ...sample.base, repo: { ...target, full_name: "Other/HoBo" } },
			},
			{ ...sample, head: { ...sample.head, sha: "c".repeat(40) } },
			{ ...sample, head: { ...sample.head, repo: null } },
			{ ...sample, head: { ...sample.head, repo: { ...target, id: 222 } } },
			{ ...sample, head: { ...sample.head, repo: { ...fork, id: 111 } } },
			{ ...sample, head: { ...sample.head, ref: "../escape" } },
		]) {
			f.store("pull", value);
			refused(() => f.verify(), /open pull request/u);
		}
		f.raw("pull", "sensitive-child-output {");
		refused(() => f.verify(), /could not read the target pull request/u);
	});

	it("rejects missing, inaccessible, replaced or moved fork and target data", () => {
		for (const unavailable of [
			"pull",
			"target",
			"fork",
			"branch",
			"basebranch",
		]) {
			const f = fixture();
			refused(() => f.verify({ env: { ...f.env, HOBO_PR_FAIL: unavailable } }));
			f.raw(unavailable, "sensitive-child-output {");
			refused(() => f.verify());
		}
		const f = fixture();
		f.store("target", { ...target, id: 999 });
		refused(() => f.verify(), /target repository identity changed/u);
		f.store("target", target);
		f.store("fork", { ...fork, id: 999 });
		refused(() => f.verify(), /head repository identity changed/u);
		f.store("fork", fork);
		f.store("branch", {
			name: "feature/fix-ci",
			commit: { sha: "c".repeat(40) },
		});
		refused(() => f.verify(), /head branch no longer/u);
		f.store("branch", { name: "feature/another", commit: { sha: headSha } });
		refused(() => f.verify(), /head branch no longer/u);
	});

	it("uses the live base branch instead of the PR's cached base SHA", () => {
		const f = fixture();
		const sample = pull();
		f.store("pull", {
			...sample,
			base: { ...sample.base, sha: "c".repeat(40) },
		});
		assert.equal(f.verify().baseSha, baseSha);
		f.store("pull", { ...sample, base: { ...sample.base, sha: null } });
		assert.equal(f.verify().baseSha, baseSha);
		f.store("basebranch", { name: "main", commit: { sha: "c".repeat(40) } });
		refused(() => f.verify(), /live base branch changed/u);
		f.store("basebranch", { name: "wrong", commit: { sha: baseSha } });
		refused(() => f.verify(), /live base branch changed/u);
	});

	it("encodes a slash in the live base branch and rechecks its repository identity", () => {
		const f = fixture();
		const sample = pull();
		f.store("pull", {
			...sample,
			base: { ...sample.base, ref: "release/main" },
		});
		f.store("basebranch", { name: "release/main", commit: { sha: baseSha } });
		assert.equal(
			f.verify({ baseBranch: "release/main" }).baseBranch,
			"release/main",
		);
		assert.match(
			f.log(),
			/repos\/\{owner\}\/\{repo\}\/branches\/release%2Fmain/u,
		);
		f.store("after-basebranch-target", { ...target, id: 333 });
		refused(
			() => f.verify({ baseBranch: "release/main" }),
			/target repository identity changed/u,
		);
	});

	it("returns changed repository identities so a caller can compare rechecks", () => {
		const f = fixture();
		const original = f.verify();
		const replacement = { ...fork, id: 333 };
		const sample = pull();
		f.store("pull", { ...sample, head: { ...sample.head, repo: replacement } });
		f.store("fork", replacement);
		const rechecked = f.verify();
		assert.notDeepEqual(rechecked, original);
		assert.equal(rechecked.headRepository.id, 333);
	});

	it("refuses a PR or branch that moves between two verifications", () => {
		for (const changed of ["closed", "base", "head", "fork"] as const) {
			const f = fixture();
			assert.equal(f.verify().prNumber, 42);
			const sample = pull();
			if (changed === "closed") f.store("pull", { ...sample, state: "closed" });
			if (changed === "base")
				f.store("basebranch", {
					name: "main",
					commit: { sha: "c".repeat(40) },
				});
			if (changed === "head")
				f.store("pull", {
					...sample,
					head: { ...sample.head, sha: "c".repeat(40) },
				});
			if (changed === "fork")
				f.store("branch", {
					name: "feature/fix-ci",
					commit: { sha: "c".repeat(40) },
				});
			refused(() => f.verify());
		}
	});

	it("refuses a PR that closes, retargets or changes while the fork is read", () => {
		const sample = pull();
		for (const changed of [
			{ ...sample, state: "closed" },
			{ ...sample, base: { ...sample.base, ref: "another-base" } },
			{ ...sample, base: { ...sample.base, repo: { ...target, id: 333 } } },
			{ ...sample, head: { ...sample.head, ref: "feature/other" } },
			{ ...sample, head: { ...sample.head, sha: "c".repeat(40) } },
			{ ...sample, head: { ...sample.head, repo: null } },
			{ ...sample, head: { ...sample.head, repo: { ...fork, id: 333 } } },
		]) {
			const f = fixture();
			f.store("after-branch-pull", changed);
			refused(() => f.verify(), /pull request changed during verification/u);
		}
		const unavailable = fixture();
		unavailable.raw("after-branch-pull", "sensitive-child-output {");
		refused(
			() => unavailable.verify(),
			/could not recheck the target pull request/u,
		);
	});

	it("refuses a fork identity that changes while its branch is read", () => {
		const f = fixture();
		f.store("after-branch-fork", { ...fork, id: 333 });
		refused(() => f.verify(), /head repository identity changed/u);
	});
});
