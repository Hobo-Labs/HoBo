import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { readFileStat, withTempDirectory } from "../src/cue.js";
import {
	FIXTURE_WORKSPACE,
	makeTempRepo,
	removeTempRepo,
} from "./support/temp-workspace.js";

const INTEGRATION_TIMEOUT_MS = 60_000;

describe("withTempDirectory", () => {
	it("hands the callback a directory that exists and returns its value", async () => {
		let seen = "";
		const value = await withTempDirectory(
			"hobo-schema-tools-test-",
			async (dir) => {
				seen = dir;
				await writeFile(join(dir, "probe.txt"), "ok", "utf8");
				return 42;
			},
		);
		expect(value).toBe(42);
		expect(seen).not.toBe("");
	});

	it("removes the directory after the callback returns", async () => {
		let created = "";
		await withTempDirectory("hobo-schema-tools-test-", async (dir) => {
			created = dir;
			await writeFile(join(dir, "probe.txt"), "ok", "utf8");
		});
		await expect(stat(created)).rejects.toThrow();
	});

	it("removes the directory even when the callback throws, and rethrows", async () => {
		let created = "";
		await expect(
			withTempDirectory("hobo-schema-tools-test-", async (dir) => {
				created = dir;
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await expect(stat(created)).rejects.toThrow();
	});

	it("removes a directory that still has contents", async () => {
		let created = "";
		await withTempDirectory("hobo-schema-tools-test-", async (dir) => {
			created = dir;
			await writeFile(join(dir, "a.txt"), "a", "utf8");
			await writeFile(join(dir, "b.txt"), "b", "utf8");
		});
		await expect(stat(created)).rejects.toThrow();
	});

	it("gives each call its own directory", async () => {
		const dirs: string[] = [];
		await Promise.all([
			withTempDirectory("hobo-schema-tools-test-", async (dir) => {
				dirs.push(dir);
			}),
			withTempDirectory("hobo-schema-tools-test-", async (dir) => {
				dirs.push(dir);
			}),
		]);
		expect(new Set(dirs).size).toBe(2);
	});

	it("creates the directory under the home directory, not the OS temp dir", async () => {
		let created = "";
		await withTempDirectory("hobo-schema-tools-test-", async (dir) => {
			created = dir;
		});
		expect(dirname(created)).toBe(homedir());
		expect(dirname(created)).not.toBe(tmpdir());
		expect(basename(created)).toMatch(/^hobo-schema-tools-test-/u);
	});

	it("leaves nothing behind in the home directory after a run", async () => {
		const before = (await readdir(homedir())).filter((name) =>
			name.startsWith("hobo-schema-tools-leak-probe-"),
		);
		await withTempDirectory("hobo-schema-tools-leak-probe-", async () => {});
		const after = (await readdir(homedir())).filter((name) =>
			name.startsWith("hobo-schema-tools-leak-probe-"),
		);
		expect(after).toEqual(before);
	});
});

describe("readFileStat", () => {
	it("returns the content and the modification time together", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hobo-schema-tools-stat-"));
		try {
			const file = join(dir, "a.txt");
			await writeFile(file, "hello", "utf8");
			const result = await readFileStat(file);
			expect(result.content).toBe("hello");
			expect(typeof result.mtimeMs).toBe("number");
			expect(result.mtimeMs).toBeGreaterThan(0);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reads as utf8 rather than returning a buffer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hobo-schema-tools-stat-"));
		try {
			const file = join(dir, "a.txt");
			await writeFile(file, "héllo — ok", "utf8");
			expect((await readFileStat(file)).content).toBe("héllo — ok");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("returns an empty string for an empty file rather than failing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "hobo-schema-tools-stat-"));
		try {
			const file = join(dir, "empty.txt");
			await writeFile(file, "", "utf8");
			expect((await readFileStat(file)).content).toBe("");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects for a missing file", async () => {
		await expect(
			readFileStat(join(tmpdir(), "definitely-not-here")),
		).rejects.toThrow();
	});
});

describe("runCli --json error envelope", () => {
	it(
		"reports a preflight failure as a parseable JSON envelope",
		async () => {
			const root = await makeTempRepo({
				withBufTemplate: false,
				workspace: FIXTURE_WORKSPACE,
			});
			try {
				const result = await runCli(["--json", "--check"], root);
				expect(result.exitCode).toBe(1);
				expect(result.stderr).toBe("");
				const parsed = JSON.parse(result.stdout) as {
					status: string;
					drift: unknown[];
					cueViolations: Array<{
						package: string;
						constraint: string;
						message: string;
					}>;
					durationMs: number;
				};
				expect(parsed.status).toBe("ERROR");
				expect(parsed.drift).toEqual([]);
				expect(parsed.durationMs).toBe(0);
				expect(parsed.cueViolations[0]?.constraint).toBe("preflight");
				expect(parsed.cueViolations[0]?.package).toBe("schema-tools");
				expect(parsed.cueViolations[0]?.message).toContain("buf template");
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"ends the JSON envelope with a newline",
		async () => {
			const root = await makeTempRepo({
				withBufTemplate: false,
				workspace: FIXTURE_WORKSPACE,
			});
			try {
				const result = await runCli(["--json", "--check"], root);
				expect(result.stdout.endsWith("\n")).toBe(true);
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);

	it(
		"writes the same failure to stderr when --json was not asked for",
		async () => {
			const root = await makeTempRepo({
				withBufTemplate: false,
				workspace: FIXTURE_WORKSPACE,
			});
			try {
				const result = await runCli(["--check"], root);
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("buf template");
				expect(result.stderr.endsWith("\n")).toBe(true);
			} finally {
				await removeTempRepo(root);
			}
		},
		INTEGRATION_TIMEOUT_MS,
	);
});
