/**
 * The cue lookup of the CUE suite (ADR-0172, test/helpers/cue-binary.ts):
 * which binary record-cue.test.ts vets with, and which it refuses. Fake cue
 * binaries (POSIX shell scripts) stand in, so this needs no cue.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";
import { CUE_VERSION, cueBinary } from "./helpers/cue-binary.js";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const POSIX = process.platform !== "win32";

const scratch = mkdtempSync(join(tmpdir(), "hobo-cue-binary-"));
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/** A cue at `dir`/cue whose `cue version` starts with `firstLine`; like a real one, it names the language version last. */
function fakeCue(dir: string, firstLine: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "cue");
	writeFileSync(
		path,
		`#!/bin/sh\nprintf '%s\\n\\ngo version go1.24.5\\ncue.lang.version ${CUE_VERSION}\\n' '${firstLine}'\n`,
	);
	chmodSync(path, 0o755);
	return path;
}

/** A repo root with no .tools cache. */
const bareRoot = join(scratch, "bare");

describe.runIf(POSIX)("cueBinary", () => {
	it("takes a cue whose first line is `cue version v0.14.0`", () => {
		const cue = fakeCue(join(scratch, "v"), `cue version ${CUE_VERSION}`);
		expect(cueBinary({ HOBO_CUE_BIN: cue }, bareRoot)).toBe(cue);
	});

	it("takes `cue version 0.14.0`, without the v, as schema-tools does", () => {
		const cue = fakeCue(join(scratch, "no-v"), "cue version 0.14.0");
		expect(cueBinary({ HOBO_CUE_BIN: cue }, bareRoot)).toBe(cue);
	});

	it("refuses another patch version, naming both", () => {
		const cue = fakeCue(join(scratch, "patch"), "cue version v0.14.3");
		expect(() => cueBinary({ HOBO_CUE_BIN: cue }, bareRoot)).toThrow(
			/is cue v0\.14\.3, not cue v0\.14\.0/u,
		);
	});

	it("reads only the first line: `cue version v0.14.0` on a later one is refused", () => {
		const cue = fakeCue(
			join(scratch, "second-line"),
			"cue (devel)\ncue version v0.14.0",
		);
		expect(() => cueBinary({ HOBO_CUE_BIN: cue }, bareRoot)).toThrow(
			/is "cue \(devel\)", not cue v0\.14\.0/u,
		);
	});

	it("treats an empty HOBO_CUE_BIN as unset, and falls back to the cache", () => {
		const root = join(scratch, "repo");
		const cached = fakeCue(
			join(root, ".tools", "cue", CUE_VERSION),
			`cue version ${CUE_VERSION}`,
		);
		expect(cueBinary({ HOBO_CUE_BIN: "" }, root)).toBe(cached);
	});

	it("refuses an HOBO_CUE_BIN that does not exist", () => {
		expect(() =>
			cueBinary({ HOBO_CUE_BIN: join(scratch, "no-such-cue") }, bareRoot),
		).toThrow(/which does not exist/u);
	});
});

describe.runIf(POSIX)("record-cue.test.ts with a cue it refuses", () => {
	it("fails before it makes its scratch dir, so it leaves nothing in the temp dir", () => {
		const temp = join(scratch, "tmp");
		mkdirSync(temp);
		const vitest = join(
			dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
			"vitest.mjs",
		);
		// Another vitest run, of its own: none of this run's VITEST_* settings.
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
		);
		const run = spawnSync(
			process.execPath,
			[vitest, "run", "test/record-cue.test.ts", "--no-isolate"],
			{
				cwd: PACKAGE_DIR,
				env: {
					...env,
					HOBO_CUE_BIN: join(scratch, "no-such-cue"),
					TMPDIR: temp,
				},
				encoding: "utf8",
				timeout: 60_000,
			},
		);
		expect(`${run.stdout}${run.stderr}`).toContain("which does not exist");
		expect(run.status).not.toBe(0);
		expect(
			readdirSync(temp).filter((name) => name.startsWith("hobo-record-cue-")),
		).toEqual([]);
	}, 60_000);
});
