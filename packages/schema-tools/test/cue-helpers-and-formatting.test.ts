/**
 * The filesystem helpers in `cue.ts` and the CLI's two output shapes.
 *
 * The CLI is consumed two ways: a human reads `formatHuman` in a terminal, and
 * CI parses `--json`. Both have to keep saying the same thing about the same
 * report, because a run that a human reads as clean and CI reads as failing —
 * or vice versa — is worse than either being wrong on its own. The error path
 * is where they most easily diverge: a thrown preflight has to arrive as a JSON
 * envelope when `--json` was asked for, not as a bare stderr line CI cannot
 * parse.
 */
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
		// The whole point of the helper. A left-behind directory is not a test
		// failure anywhere, it is just slow accumulation on a developer's disk.
		let created = "";
		await withTempDirectory("hobo-schema-tools-test-", async (dir) => {
			created = dir;
			await writeFile(join(dir, "probe.txt"), "ok", "utf8");
		});
		await expect(stat(created)).rejects.toThrow();
	});

	it("removes the directory even when the callback throws, and rethrows", async () => {
		// `finally`, not a trailing cleanup call. A codegen run that fails
		// mid-way is exactly when a stale scratch tree is most confusing, since
		// the next run would compare against it.
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
		// `rm(..., { recursive: true })`. A non-recursive remove would fail on
		// any run that actually wrote something, which is every real run.
		let created = "";
		await withTempDirectory("hobo-schema-tools-test-", async (dir) => {
			created = dir;
			await writeFile(join(dir, "a.txt"), "a", "utf8");
			await writeFile(join(dir, "b.txt"), "b", "utf8");
		});
		await expect(stat(created)).rejects.toThrow();
	});

	it("gives each call its own directory", async () => {
		// `mkdtemp`, so two concurrent codegen runs cannot scribble over each
		// other's scratch tree and produce a drift report about the other's files.
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
		// Pinning a wart rather than an intent. Despite the name, the helper
		// calls `mkdtemp(join(homedir(), prefix))` — so a scratch tree lands at
		// `~/hobo-…` rather than under `os.tmpdir()`. It is cleaned up in a
		// `finally`, so it does not normally accumulate, but a hard kill mid-run
		// leaves a stray directory in the user's home rather than somewhere the
		// OS reaps on reboot.
		//
		// Recorded rather than changed: the choice may be deliberate (a home
		// directory and a repo are more likely to share a filesystem, which makes
		// a later rename across the boundary cheap and non-crossing). Flagged for
		// whoever owns the codegen scratch strategy.
		let created = "";
		await withTempDirectory("hobo-schema-tools-test-", async (dir) => {
			created = dir;
		});
		expect(dirname(created)).toBe(homedir());
		expect(dirname(created)).not.toBe(tmpdir());
		expect(basename(created)).toMatch(/^hobo-schema-tools-test-/u);
	});

	it("leaves nothing behind in the home directory after a run", async () => {
		// The compensating guarantee for the wart above: whatever the location,
		// a completed run must not accumulate.
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
		// Together, in one call, because the drift check compares both: reading
		// them separately opens a window where the file changes between the two
		// reads and the pair describes two different versions.
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
		// An empty generated file is a legitimate state, and the drift check has
		// to be able to compare it.
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
		// Not a silent empty result: "the file is not there" and "the file is
		// empty" mean opposite things to a drift comparison.
		await expect(
			readFileStat(join(tmpdir(), "definitely-not-here")),
		).rejects.toThrow();
	});
});

describe("runCli --json error envelope", () => {
	it(
		"reports a preflight failure as a parseable JSON envelope",
		async () => {
			// The divergence this guards. The argv parser throws *before* the
			// invocation exists, so `--json --frobnicate` can only go to stderr —
			// that case is already pinned elsewhere. But a preflight failure
			// happens after parsing, so `--json` is known by then and CI must get
			// an envelope it can read rather than a bare stderr line it will
			// report as "no output".
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
				// The envelope keeps the same shape as a successful report, so a
				// consumer parses one schema rather than branching on whether the
				// run got far enough to produce a real report.
				expect(parsed.drift).toEqual([]);
				expect(parsed.durationMs).toBe(0);
				// And the failure is attributed to `preflight`, so a reader can tell
				// a setup problem from a genuine CUE violation.
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
			// So the output composes in a pipeline and does not show as a
			// no-newline-at-end-of-file when redirected to a build artifact.
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
			// The two shapes must agree about *what* failed; only the framing
			// differs. A human-mode run that said nothing while the JSON run
			// reported an error would send a developer looking in the wrong place.
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
