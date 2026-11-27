import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	changesPreserved,
	findSupersessions,
	listOpenPulls,
	type OpenPull,
	parsePullsPage,
	shouldDryRun,
	snapshotsCurrent,
	supersessionComment,
} from "../ci/pr-supersession.mts";

const parentOf = new Map([
	["b", "a"],
	["c", "b"],
	["d", "a"],
	["x", "m"],
]);
function contains(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return true;
	const parent = parentOf.get(descendant);
	return parent !== undefined && contains(ancestor, parent);
}
const inMain = (sha: string) => contains(sha, "x");
const pull = (number: number, headSha: string): OpenPull => ({
	number,
	headSha,
	baseSha: "base",
});
const preserved = () => true;

describe("dry-run default", () => {
	it("requires an explicit false value to enable closing", () => {
		assert.equal(shouldDryRun(undefined), true);
		assert.equal(shouldDryRun("true"), true);
		assert.equal(shouldDryRun(""), true);
		assert.equal(shouldDryRun("false"), false);
	});
});

describe("findSupersessions", () => {
	it("keeps distinct layers open even if the top preserves them", () => {
		assert.deepEqual(
			findSupersessions(
				[pull(1, "a"), pull(2, "b"), pull(3, "c")],
				contains,
				inMain,
				preserved,
			),
			[],
		);
	});
	it("keeps two tips that only share a base open", () => {
		assert.deepEqual(
			findSupersessions(
				[pull(3, "c"), pull(4, "d")],
				contains,
				inMain,
				preserved,
			),
			[],
		);
	});
	it("keeps a shared lower layer open for bottom-up merging", () => {
		assert.deepEqual(
			findSupersessions(
				[pull(1, "a"), pull(3, "c"), pull(4, "d")],
				contains,
				inMain,
				preserved,
			),
			[],
		);
	});
	it("keeps the older of two pull requests at one head", () => {
		assert.deepEqual(
			findSupersessions(
				[pull(7, "c"), pull(5, "c")],
				contains,
				inMain,
				preserved,
			),
			[{ ...pull(7, "c"), carriedBy: 5 }],
		);
	});
	it("does not close when main or the top branch dropped the work", () => {
		assert.deepEqual(
			findSupersessions([pull(9, "m")], contains, inMain, () => false),
			[],
		);
		assert.deepEqual(
			findSupersessions(
				[pull(1, "a"), pull(2, "b"), pull(3, "c")],
				contains,
				inMain,
				(source, target) => source.headSha !== "a" || target !== "c",
			),
			[],
		);
	});
	it("closes a pull request main still carries", () => {
		assert.deepEqual(
			findSupersessions(
				[pull(9, "m"), pull(3, "c")],
				contains,
				inMain,
				preserved,
			),
			[{ ...pull(9, "m"), carriedBy: "main" }],
		);
	});
});

describe("changesPreserved", () => {
	it("requires all changed paths, modes and deletions to match the carrier tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-supersession-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
		try {
			git("init", "-q", "-b", "main");
			git("config", "user.name", "Test");
			git("config", "user.email", "test@example.invalid");
			writeFileSync(join(dir, "change"), "old\n");
			writeFileSync(join(dir, "remove"), "old\n");
			writeFileSync(join(dir, "mode"), "x\n");
			git("add", ".");
			git("commit", "-qm", "base");
			const base = git("rev-parse", "HEAD");
			writeFileSync(join(dir, "change"), "new\n");
			rmSync(join(dir, "remove"));
			writeFileSync(join(dir, "line\nbreak"), "added\n");
			chmodSync(join(dir, "mode"), 0o755);
			git("add", "-A");
			git("commit", "-qm", "source");
			const head = git("rev-parse", "HEAD");
			writeFileSync(join(dir, "extra"), "unrelated\n");
			git("add", "-A");
			git("commit", "-qm", "carrier");
			const carrier = git("rev-parse", "HEAD");
			const source = { number: 1, headSha: head, baseSha: base };
			assert.equal(changesPreserved(source, carrier, dir), true);
			writeFileSync(join(dir, "change"), "old\n");
			git("add", "-A");
			git("commit", "-qm", "drop change");
			assert.equal(
				changesPreserved(source, git("rev-parse", "HEAD"), dir),
				false,
			);
			git("reset", "--hard", carrier);
			writeFileSync(join(dir, "remove"), "old\n");
			git("add", "-A");
			git("commit", "-qm", "restore deletion");
			assert.equal(
				changesPreserved(source, git("rev-parse", "HEAD"), dir),
				false,
			);
			git("reset", "--hard", carrier);
			chmodSync(join(dir, "mode"), 0o644);
			git("add", "-A");
			git("commit", "-qm", "drop mode");
			assert.equal(
				changesPreserved(source, git("rev-parse", "HEAD"), dir),
				false,
			);
			assert.equal(
				changesPreserved({ ...source, baseSha: carrier }, carrier, dir),
				false,
			);
			assert.equal(changesPreserved(source, "missing-commit", dir), false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("supersessionComment", () => {
	it("names the carrier and keeps the branch", () => {
		const text = supersessionComment({ ...pull(1, "a"), carriedBy: 3 });
		assert.match(text, /#3's branch/);
		assert.match(text, /changed paths match/);
		assert.match(text, /The branch is kept\./);
	});
});

const apiPull = (number: number, sha: string, base = "base") => ({
	number,
	state: "open",
	base: { sha: base, ref: "main" },
	head: { sha, repo: { full_name: "o/r" } },
});

describe("parsePullsPage", () => {
	it("keeps only well-formed same-repository entries with a base", () => {
		assert.deepEqual(
			parsePullsPage(
				[
					apiPull(4, "d"),
					{ number: 5, head: { sha: "e", repo: { full_name: "o/r" } } },
					null,
				],
				"o/r",
			),
			[pull(4, "d")],
		);
	});
});

describe("listOpenPulls", () => {
	it("pages until empty and skips forks", async () => {
		const pages = [
			[
				apiPull(1, "a"),
				{
					...apiPull(2, "b"),
					head: { sha: "b", repo: { full_name: "fork/r" } },
				},
			],
			[],
		];
		const seen: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			seen.push(String(input));
			return new Response(JSON.stringify(pages.shift() ?? []), { status: 200 });
		};
		assert.deepEqual(await listOpenPulls(fetcher, "t", "o/r", "main"), [
			pull(1, "a"),
		]);
		assert.equal(seen.length, 2);
		assert.match(seen[0] ?? "", /state=open&base=main&per_page=100&page=1$/);
	});
});

describe("snapshotsCurrent", () => {
	it("refuses a changed source, carrier or main before closing", async () => {
		const source = pull(1, "a");
		const carrier = pull(2, "b");
		let sourceData = apiPull(1, "a");
		let carrierData = apiPull(2, "b");
		let main = "main-sha";
		const fetcher: typeof fetch = async (input) =>
			new Response(
				JSON.stringify(
					String(input).endsWith("/pulls/1")
						? sourceData
						: String(input).endsWith("/pulls/2")
							? carrierData
							: { commit: { sha: main } },
				),
				{ status: 200 },
			);
		assert.equal(
			await snapshotsCurrent(
				fetcher,
				"t",
				"o/r",
				"main",
				main,
				source,
				carrier,
			),
			true,
		);
		carrierData = apiPull(2, "new");
		assert.equal(
			await snapshotsCurrent(
				fetcher,
				"t",
				"o/r",
				"main",
				main,
				source,
				carrier,
			),
			false,
		);
		carrierData = apiPull(2, "b");
		sourceData = apiPull(1, "new");
		assert.equal(
			await snapshotsCurrent(
				fetcher,
				"t",
				"o/r",
				"main",
				main,
				source,
				carrier,
			),
			false,
		);
		sourceData = apiPull(1, "a");
		main = "advanced";
		assert.equal(
			await snapshotsCurrent(
				fetcher,
				"t",
				"o/r",
				"main",
				"main-sha",
				source,
				"main",
			),
			false,
		);
	});
});
