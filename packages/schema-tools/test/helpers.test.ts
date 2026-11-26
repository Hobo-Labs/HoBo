import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Directory, writeManifest } from "../src/codegen.js";
import { readFileStat, withTempDirectory } from "../src/cue.js";

let scratch: string;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), "schema-tools-helpers-"));
});

afterAll(async () => {
	await rm(scratch, { recursive: true, force: true });
});

describe("sha256Directory", () => {
	it("is deterministic for the same tree and sensitive to content and names", async () => {
		const treeA = join(scratch, "tree-a");
		await mkdir(join(treeA, "nested"), { recursive: true });
		await writeFile(join(treeA, "one.txt"), "one");
		await writeFile(join(treeA, "nested", "two.txt"), "two");

		const first = await sha256Directory(treeA);
		const second = await sha256Directory(treeA);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{64}$/);

		await writeFile(join(treeA, "one.txt"), "one!");
		const afterContentChange = await sha256Directory(treeA);
		expect(afterContentChange).not.toBe(first);

		const treeB = join(scratch, "tree-b");
		await mkdir(treeB, { recursive: true });
		await writeFile(join(treeB, "renamed.txt"), "one!");
		const differentName = await sha256Directory(treeB);
		expect(differentName).not.toBe(afterContentChange);
	});

	it("hashes relative paths, so identical trees at different roots agree", async () => {
		const left = join(scratch, "same-left");
		const right = join(scratch, "same-right");
		for (const root of [left, right]) {
			await mkdir(root, { recursive: true });
			await writeFile(join(root, "file.txt"), "payload");
		}
		expect(await sha256Directory(left)).toBe(await sha256Directory(right));
	});

	it("treats a missing directory as the empty tree", async () => {
		const missing = join(scratch, "does-not-exist");
		const empty = join(scratch, "empty");
		await mkdir(empty, { recursive: true });
		expect(await sha256Directory(missing)).toBe(await sha256Directory(empty));
	});
});

describe("writeManifest", () => {
	it("creates parent directories and pretty-prints with a trailing newline", async () => {
		const path = join(scratch, "deep", "nested", "manifest.json");
		await writeManifest(path, { name: "widgets", digest: "abc" });
		const content = await readFile(path, "utf8");
		expect(content).toBe(
			`${JSON.stringify({ name: "widgets", digest: "abc" }, null, 2)}\n`,
		);
	});
});

describe("withTempDirectory", () => {
	it("provides a directory, returns the callback value, and cleans up", async () => {
		let seen = "";
		const value = await withTempDirectory("schema-tools-tmp-", async (dir) => {
			seen = dir;
			expect(existsSync(dir)).toBe(true);
			await writeFile(join(dir, "scratch.txt"), "x");
			return 42;
		});
		expect(value).toBe(42);
		expect(existsSync(seen)).toBe(false);
	});

	it("cleans up and rethrows when the callback fails", async () => {
		let seen = "";
		await expect(
			withTempDirectory("schema-tools-tmp-", async (dir) => {
				seen = dir;
				throw new Error("callback failed");
			}),
		).rejects.toThrow("callback failed");
		expect(existsSync(seen)).toBe(false);
	});
});

describe("readFileStat", () => {
	it("returns content together with the file's mtime", async () => {
		const path = join(scratch, "stat.txt");
		await writeFile(path, "stat me");
		const result = await readFileStat(path);
		expect(result.content).toBe("stat me");
		expect(result.mtimeMs).toBeGreaterThan(0);
	});
});
