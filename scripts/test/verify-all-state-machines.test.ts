import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const script = fileURLToPath(
	new URL("../verify-all-state-machines.sh", import.meta.url),
);

function list(...args: string[]) {
	return spawnSync("bash", [script, "--list", ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

describe("state-machine verification selection", () => {
	it("partitions every registered skill exactly once", () => {
		const all = list();
		assert.equal(all.status, 0, all.stderr);
		const skills = all.stdout.trim().split("\n");
		assert.ok(skills.length > 0);
		const shards = Array.from({ length: 4 }, (_, index) => {
			const result = list(`--shard=${index}/4`);
			assert.equal(result.status, 0, result.stderr);
			return result.stdout.trim() ? result.stdout.trim().split("\n") : [];
		});
		const assigned = shards.flat();
		assert.equal(new Set(assigned).size, skills.length);
		assert.deepEqual([...assigned].sort(), [...skills].sort());
		assert.ok(
			Math.max(...shards.map((shard) => shard.length)) -
				Math.min(...shards.map((shard) => shard.length)) <=
				1,
		);
	});

	it("partitions explicit selections and permits an empty shard", () => {
		const all = list("verify-budget-policy-routing", "verify-cd-fanout");
		assert.equal(all.status, 0, all.stderr);
		const assigned = Array.from({ length: 4 }, (_, index) =>
			list(
				`--shard=${index}/4`,
				"verify-budget-policy-routing",
				"verify-cd-fanout",
			),
		);
		for (const result of assigned)
			assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(
			assigned
				.flatMap((result) =>
					result.stdout.trim() ? result.stdout.trim().split("\n") : [],
				)
				.sort(),
			all.stdout.trim().split("\n").sort(),
		);
		assert.equal(assigned.filter((result) => result.stdout === "").length, 2);
	});

	it("rejects malformed shards and unknown skills", () => {
		for (const shard of [
			"0/0",
			"4/4",
			"-1/4",
			"1/",
			"1/100",
			"01/4",
			"1/4/2",
		]) {
			assert.notEqual(list(`--shard=${shard}`).status, 0, shard);
		}
		assert.notEqual(list("verify-does-not-exist").status, 0);
	});
});

describe("state-machine verification jobs", () => {
	const repo = mkdtempSync(join(tmpdir(), "hobo-verify-all-"));
	after(() => rmSync(repo, { recursive: true, force: true }));
	const events = join(repo, "events.log");
	mkdirSync(join(repo, "scripts"), { recursive: true });
	copyFileSync(script, join(repo, "scripts/verify-all-state-machines.sh"));
	writeFileSync(
		join(repo, "scripts/verify-state-machine.sh"),
		[
			'name="${1##*/}"',
			`printf 'start %s\\n' "$name" >>'${events}'`,
			'sleep "${FAKE_SKILL_SECONDS:-0.4}"',
			`printf 'end %s\\n' "$name" >>'${events}'`,
			'echo "checked $name"',
			'[[ "$name" != verify-bad ]] || { echo boom; exit 1; }',
			"",
		].join("\n"),
	);
	writeFileSync(join(repo, "tla2tools.jar"), "");
	for (const name of [
		"verify-e",
		"verify-bad",
		"verify-a",
		"verify-c",
		"verify-d",
	])
		mkdirSync(join(repo, ".agents/skills", name), { recursive: true });
	const isolated = Object.fromEntries(
		Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
	);
	spawnSync("git", ["init", "-q"], { cwd: repo, env: isolated });

	function run(...args: string[]) {
		return runWith({}, ...args);
	}

	function runWith(env: Record<string, string>, ...args: string[]) {
		writeFileSync(events, "");
		const result = spawnSync(
			"bash",
			["scripts/verify-all-state-machines.sh", ...args],
			{
				cwd: repo,
				encoding: "utf8",
				env: {
					...isolated,
					"BASH_FUNC_sha256sum%%": "() {  cat >/dev/null\n}",
					TLA2TOOLS: join(repo, "tla2tools.jar"),
					...env,
				},
			},
		);
		let active = 0;
		let peak = 0;
		for (const line of readFileSync(events, "utf8").trim().split("\n")) {
			active += line.startsWith("start ") ? 1 : -1;
			peak = Math.max(peak, active);
		}
		return { ...result, peak };
	}

	it("runs every skill at most N at a time and reports in sorted order", () => {
		const result = run(
			"--jobs=3",
			"verify-e",
			"verify-a",
			"verify-d",
			"verify-c",
			"verify-a",
		);
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.peak > 1 && result.peak <= 3, String(result.peak));
		assert.deepEqual(
			result.stdout
				.trim()
				.split("\n")
				.slice(0, -1)
				.map((line) => line.replace(/ \(\d+s\)$/u, "")),
			["PASS verify-a", "PASS verify-c", "PASS verify-d", "PASS verify-e"],
		);
		assert.match(
			result.stdout,
			/Checked 4 skills with 3 jobs in \d+s; 0 failed\.\n$/u,
		);
	});

	it("keeps one skill at a time by default", () => {
		const result = run("verify-a", "verify-c", "verify-d");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.peak, 1);
		assert.match(result.stdout, /with 1 jobs/u);
	});

	it("fails after every skill ran and prints the failing skill's log", () => {
		const result = run("--jobs=4");
		assert.equal(result.status, 1);
		assert.equal(readFileSync(events, "utf8").match(/^end /gmu)?.length, 5);
		assert.match(
			result.stderr,
			/^FAIL verify-bad \(\d+s\)\nchecked verify-bad\nboom\n/u,
		);
		assert.doesNotMatch(result.stderr, /checked verify-a/u);
		assert.match(
			result.stdout,
			/Checked 5 skills with 4 jobs in \d+s; 1 failed\./u,
		);
	});

	it("applies jobs within a shard", () => {
		const result = run("--shard=0/2", "--jobs=2");
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			result.stdout,
			/^PASS verify-a .*\nPASS verify-c .*\nPASS verify-e /u,
		);
	});

	it("fails a skill that exceeds FORMAL_SKILL_TIMEOUT_SEC", () => {
		const result = runWith(
			{ FORMAL_SKILL_TIMEOUT_SEC: "1", FAKE_SKILL_SECONDS: "5" },
			"verify-a",
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^FAIL verify-a \([12]s\)\n/u);
		assert.doesNotMatch(readFileSync(events, "utf8"), /^end /mu);
		assert.match(
			result.stdout,
			/Checked 1 skills with 1 jobs in \d+s; 1 failed\./u,
		);
	});

	it("rejects malformed job counts", () => {
		for (const jobs of [
			["--jobs=0"],
			["--jobs=x"],
			["--jobs=100"],
			["--jobs=01"],
			["--jobs=2", "--jobs=3"],
		])
			assert.equal(run("--list", ...jobs).status, 2, jobs.join(" "));
	});
});
