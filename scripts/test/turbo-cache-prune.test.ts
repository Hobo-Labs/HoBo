import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	entryHash,
	parseRunTasks,
	planPrune,
} from "../ci/turbo-cache-prune.mts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3);

const ENTRY = (hash: string) => [
	`${hash}.tar.zst`,
	`${hash}-meta.json`,
	`${hash}-manifest.json`,
];

const files = (hash: string, ageDays: number) =>
	ENTRY(hash).map((name) => ({ name, mtimeMs: NOW - ageDays * DAY_MS }));

const hit = (hash: string) => ({ hash, missed: false });
const miss = (hash: string) => ({ hash, missed: true });

describe("turbo-cache-prune", () => {
	const dirs: string[] = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	function workspace(
		cache: readonly string[],
		runs: ReadonlyMap<string, string>,
	): string {
		const root = mkdtempSync(join(tmpdir(), "turbo-cache-prune-"));
		dirs.push(root);
		mkdirSync(join(root, ".turbo", "runs"), { recursive: true });
		mkdirSync(join(root, ".turbo", "cache"), { recursive: true });
		for (const file of cache) {
			writeFileSync(join(root, ".turbo", "cache", file), "x");
		}
		for (const [name, body] of runs) {
			writeFileSync(join(root, ".turbo", "runs", name), body);
		}
		return root;
	}

	function prune(root: string): string {
		const output = join(root, "github-output");
		writeFileSync(output, "");
		execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"scripts/ci/turbo-cache-prune.mts",
				root,
			],
			{ stdio: "pipe", env: { ...process.env, GITHUB_OUTPUT: output } },
		);
		return readFileSync(output, "utf8");
	}

	it("maps every file of an entry to its hash", () => {
		assert.deepEqual(ENTRY("01f4a4c506f562bf").map(entryHash), [
			"01f4a4c506f562bf",
			"01f4a4c506f562bf",
			"01f4a4c506f562bf",
		]);
	});

	it("parses tasks and their cache status, and rejects anything else", () => {
		assert.deepEqual(
			parseRunTasks(
				JSON.stringify({
					tasks: [
						{ taskId: "p#build", hash: "aa", cache: { status: "HIT" } },
						{ taskId: "q#build", hash: "bb", cache: { status: "MISS" } },
						{ taskId: "r#build", hash: "cc" },
					],
				}),
			),
			[hit("aa"), miss("bb"), hit("cc")],
		);
		assert.equal(
			parseRunTasks(JSON.stringify({ tasks: [{ hash: "" }] })),
			undefined,
		);
		assert.equal(parseRunTasks("{}"), undefined);
		assert.equal(parseRunTasks("not json"), undefined);
	});

	it("keeps recently used entries a run did not touch and drops stale ones", () => {
		const plan = planPrune(
			[...files("aa", 0), ...files("bb", 3), ...files("cc", 8)],
			[hit("aa")],
			NOW,
			7,
		);
		assert.deepEqual([...plan.keep].sort(), ENTRY("aa").sort());
		assert.deepEqual([...plan.drop].sort(), ENTRY("cc").sort());
	});

	it("keeps an entry a run used however old its files are", () => {
		const plan = planPrune(files("aa", 30), [hit("aa")], NOW, 7);
		assert.deepEqual([...plan.keep].sort(), ENTRY("aa").sort());
		assert.deepEqual(plan.drop, []);
	});

	it("saves only when a missed task left an entry", () => {
		assert.equal(planPrune(files("aa", 0), [hit("aa")], NOW, 7).save, false);
		assert.equal(planPrune(files("aa", 0), [miss("aa")], NOW, 7).save, true);
		// A miss that wrote nothing (a failed task) adds nothing to save.
		assert.equal(planPrune(files("aa", 0), [miss("bb")], NOW, 7).save, false);
	});

	it("deletes nothing and saves nothing without run summaries", () => {
		assert.deepEqual(planPrune(files("aa", 30), [], NOW, 7), {
			keep: [],
			drop: [],
			save: false,
		});
	});

	it("leaves the cache as restored and saves when a summary is unreadable", () => {
		const root = workspace(
			[...ENTRY("aa"), ...ENTRY("bb")],
			new Map([
				["a.json", JSON.stringify({ tasks: [{ hash: "aa" }] })],
				["b.json", "{"],
			]),
		);
		const old = new Date(NOW - 30 * DAY_MS);
		for (const file of ENTRY("bb")) {
			utimesSync(join(root, ".turbo", "cache", file), old, old);
		}
		assert.equal(prune(root), "save=true\n");
		assert.equal(readdirSync(join(root, ".turbo", "cache")).length, 6);
	});

	it("prunes a cache directory from the summaries beside it", () => {
		const root = workspace(
			[...ENTRY("aa"), ...ENTRY("bb"), ...ENTRY("cc")],
			new Map([
				[
					"run.json",
					JSON.stringify({
						tasks: [
							{ taskId: "p#build", hash: "aa", cache: { status: "MISS" } },
						],
					}),
				],
			]),
		);
		const old = new Date(Date.now() - 30 * DAY_MS);
		for (const file of [...ENTRY("aa"), ...ENTRY("cc")]) {
			utimesSync(join(root, ".turbo", "cache", file), old, old);
		}
		assert.equal(prune(root), "save=true\n");
		const cache = join(root, ".turbo", "cache");
		assert.deepEqual(
			readdirSync(cache).sort(),
			[...ENTRY("aa"), ...ENTRY("bb")].sort(),
		);
		// The entry the run used is stamped, so it survives the next run's cutoff.
		for (const file of ENTRY("aa")) {
			assert.ok(Date.now() - statSync(join(cache, file)).mtimeMs < DAY_MS);
		}
	});

	it("skips the save when every task hit the cache", () => {
		const root = workspace(
			ENTRY("aa"),
			new Map([
				[
					"run.json",
					JSON.stringify({
						tasks: [{ hash: "aa", cache: { status: "HIT" } }],
					}),
				],
			]),
		);
		assert.equal(prune(root), "save=false\n");
		assert.equal(readdirSync(join(root, ".turbo", "cache")).length, 3);
	});

	it("imports node builtins only, so it runs before install", () => {
		const source = readFileSync("scripts/ci/turbo-cache-prune.mts", "utf8");
		const specifiers = [...source.matchAll(/from "([^"]+)"/gu)].map(
			(match) => match[1],
		);
		assert.ok(specifiers.length > 0);
		for (const specifier of specifiers) {
			assert.match(specifier ?? "", /^node:/u);
		}
	});
});
