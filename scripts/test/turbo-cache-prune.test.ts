import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
	entryHash,
	filesToPrune,
	parseRunHashes,
} from "../ci/turbo-cache-prune.mts";

const ENTRY = (hash: string) => [
	`${hash}.tar.zst`,
	`${hash}-meta.json`,
	`${hash}-manifest.json`,
];

describe("turbo-cache-prune", () => {
	const dirs: string[] = [];
	after(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	it("maps every file of an entry to its hash", () => {
		assert.deepEqual(ENTRY("01f4a4c506f562bf").map(entryHash), [
			"01f4a4c506f562bf",
			"01f4a4c506f562bf",
			"01f4a4c506f562bf",
		]);
	});

	it("parses task hashes from a run summary and rejects anything else", () => {
		assert.deepEqual(
			parseRunHashes(
				JSON.stringify({ tasks: [{ taskId: "p#build", hash: "aa" }] }),
			)?.tasks.map((task) => task.hash),
			["aa"],
		);
		assert.equal(
			parseRunHashes(JSON.stringify({ tasks: [{ hash: "" }] })),
			undefined,
		);
		assert.equal(parseRunHashes("{}"), undefined);
		assert.equal(parseRunHashes("not json"), undefined);
	});

	it("drops whole entries whose hash no run touched", () => {
		const files = [...ENTRY("aa"), ...ENTRY("bb"), ...ENTRY("cc")];
		assert.deepEqual(
			filesToPrune(files, new Set(["aa", "cc"])).sort(),
			ENTRY("bb").sort(),
		);
	});

	it("deletes nothing when no run summary named a hash", () => {
		assert.deepEqual(filesToPrune(ENTRY("aa"), new Set()), []);
	});

	it("leaves the cache as restored when a summary is unreadable", () => {
		const root = mkdtempSync(join(tmpdir(), "turbo-cache-prune-"));
		dirs.push(root);
		mkdirSync(join(root, ".turbo", "runs"), { recursive: true });
		mkdirSync(join(root, ".turbo", "cache"), { recursive: true });
		for (const file of [...ENTRY("aa"), ...ENTRY("bb")]) {
			writeFileSync(join(root, ".turbo", "cache", file), "x");
		}
		writeFileSync(
			join(root, ".turbo", "runs", "a.json"),
			JSON.stringify({ tasks: [{ hash: "aa" }] }),
		);
		writeFileSync(join(root, ".turbo", "runs", "b.json"), "{");
		execFileSync(
			process.execPath,
			["--experimental-strip-types", "scripts/ci/turbo-cache-prune.mts", root],
			{ stdio: "pipe" },
		);
		assert.equal(readdirSync(join(root, ".turbo", "cache")).length, 6);
	});

	it("prunes a cache directory from the summaries beside it", () => {
		const root = mkdtempSync(join(tmpdir(), "turbo-cache-prune-"));
		dirs.push(root);
		mkdirSync(join(root, ".turbo", "runs"), { recursive: true });
		mkdirSync(join(root, ".turbo", "cache"), { recursive: true });
		for (const file of [...ENTRY("aa"), ...ENTRY("bb")]) {
			writeFileSync(join(root, ".turbo", "cache", file), "x");
		}
		writeFileSync(
			join(root, ".turbo", "runs", "run.json"),
			JSON.stringify({ tasks: [{ taskId: "p#build", hash: "aa" }] }),
		);
		execFileSync(
			process.execPath,
			["--experimental-strip-types", "scripts/ci/turbo-cache-prune.mts", root],
			{ stdio: "pipe" },
		);
		assert.deepEqual(
			readdirSync(join(root, ".turbo", "cache")).sort(),
			ENTRY("aa").sort(),
		);
	});
});
