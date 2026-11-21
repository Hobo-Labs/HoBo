import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

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

describe("state-machine verification shards", () => {
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
