/**
 * The suite must not write into the developer's real HoBo home.
 *
 * Much of this workspace resolves its state directory as
 * `process.env.HOBO_HOME ?? join(HOME, ".hobo")`, so a test that calls such an
 * API without an explicit `hoboHome` writes where a real session would. That
 * happened: a clean run of one package's suite left 33 files under
 * `~/.hobo/durable` — chats, evidence, and an auth session written by a test
 * whose only assertion was that `auth --help` prints a help page.
 *
 * `test/setup/isolate-hobo-home.ts` fixes it by pointing every test file's
 * `HOBO_HOME` at a throwaway directory. This file is the guard on that fix: the
 * point of the setup is that the next test somebody writes cannot reintroduce
 * the fault, and a guarantee nothing checks is a guarantee that quietly stops
 * holding.
 *
 * It asserts the *mechanism* rather than the absence of files in the real home,
 * because the real home may legitimately contain a developer's own data — this
 * suite is not entitled to look at it, let alone assert about its contents.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

describe("HOBO_HOME isolation", () => {
	it("is set for every test file", () => {
		// Unset is the dangerous state: it is what makes the default resolve to
		// the real home.
		expect(process.env.HOBO_HOME).toBeTruthy();
	});

	it("does not point at the developer's real home", () => {
		// The specific failure this guards: `~/.hobo`.
		expect(resolve(String(process.env.HOBO_HOME))).not.toBe(
			resolve(join(homedir(), ".hobo")),
		);
	});

	it("does not point anywhere inside the developer's home directory", () => {
		// A sibling like `~/.hobo-test` would still put test state in a place a
		// developer backs up and syncs.
		expect(
			resolve(String(process.env.HOBO_HOME)).startsWith(resolve(homedir())),
		).toBe(false);
	});

	it("points at a directory that exists, so a write does not fail", () => {
		// An isolated home that is not there just moves the failure rather than
		// removing it.
		expect(existsSync(String(process.env.HOBO_HOME))).toBe(true);
	});

	it("is not the repository itself", () => {
		// State written into the working tree shows up as uncommitted changes and
		// gets committed by accident.
		expect(resolve(String(process.env.HOBO_HOME))).not.toBe(
			resolve(process.cwd()),
		);
	});
});

const GLOBAL_SETUP = fileURLToPath(
	new URL("./setup/hobo-test-homes.ts", import.meta.url),
);
const SETUP = fileURLToPath(
	new URL("./setup/isolate-hobo-home.ts", import.meta.url),
);
const scratch = mkdtempSync(join(tmpdir(), "hobo-home-teardown-"));
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

/** What a run of probe files saw, and left. */
interface ProbeRun {
	readonly status: number | null;
	/** One line per record a probe made: "<label> <HOBO_HOME> <whether it existed>". */
	readonly seen: string[];
	/** The run's TMPDIR, where its root of homes is made. */
	readonly temp: string;
	/** What is left in that TMPDIR once the run is over. */
	readonly left: string[];
}

/** Each probe file starts with this: `record(label)` notes the HOBO_HOME it sees now. */
const PROBE_HEAD = `import { appendFileSync, existsSync } from "node:fs";
const record = (label) => {
	const home = process.env.HOBO_HOME ?? "";
	appendFileSync(process.env.SEEN_FILE ?? "", label + " " + home + " " + existsSync(home) + "\\n");
};
`;

let projects = 0;

/**
 * Runs probe files (name to body) one after the other in one worker, as the
 * root config runs files (isolate: false), with only the global setup and the
 * setup file under test, a TMPDIR of their own, and `env`. Files run in name
 * order: vitest's default sequencer puts larger files first, so a probe that
 * needs another to have run first could not rely on its name.
 */
function runProbes(
	files: Readonly<Record<string, string>>,
	env: NodeJS.ProcessEnv = {},
): ProbeRun {
	projects += 1;
	const project = join(scratch, `project-${projects}`);
	const temp = join(project, "tmp");
	const seenFile = join(project, "seen.txt");
	mkdirSync(temp, { recursive: true });
	writeFileSync(seenFile, "");
	for (const [name, body] of Object.entries(files)) {
		writeFileSync(join(project, `${name}.probe.test.mjs`), PROBE_HEAD + body);
	}
	writeFileSync(
		join(project, "vitest.config.mjs"),
		`export default { test: { globals: true, isolate: false, pool: "threads", fileParallelism: false, maxWorkers: 1, include: ["*.probe.test.mjs"], sequence: { sequencer: class { async shard(files) { return files; } async sort(files) { return [...files].sort((x, y) => (x.moduleId < y.moduleId ? -1 : 1)); } } }, globalSetup: [${JSON.stringify(GLOBAL_SETUP)}], setupFiles: [${JSON.stringify(SETUP)}] } };\n`,
	);
	const vitest = join(
		dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
		"vitest.mjs",
	);
	// Another vitest run of its own: none of this one's VITEST_* settings, HOBO_HOME or root.
	const inherited = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("VITEST") &&
				key !== "HOBO_HOME" &&
				key !== "HOBO_TEST_HOMES",
		),
	);
	const run = spawnSync(
		process.execPath,
		[vitest, "run", "--root", project, "--config", "vitest.config.mjs"],
		{
			cwd: project,
			env: { ...inherited, TMPDIR: temp, SEEN_FILE: seenFile, ...env },
			encoding: "utf8",
			timeout: 120_000,
		},
	);
	return {
		status: run.status,
		seen: readFileSync(seenFile, "utf8").split("\n").filter(Boolean),
		temp,
		left: readdirSync(temp).filter((name) => name.startsWith("hobo-test-home")),
	};
}

const RECORDS = `it("records its home", () => record("file"));\n`;

/** "<label> <a home inside the run's root> true" for a run whose TMPDIR is `temp`. */
function inRoot(label: string, temp: string): RegExp {
	const dir = temp.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	return new RegExp(
		`^${label} ${dir}/hobo-test-homes-[^/ ]+/home-[^/ ]+ true$`,
		"u",
	);
}

describe("the throwaway HOBO_HOME", () => {
	it("is one per file inside the run's root, and all are removed when the run ends", () => {
		const { status, seen, temp, left } = runProbes({ a: RECORDS, b: RECORDS });
		expect(status).toBe(0);
		expect(seen).toHaveLength(2);
		for (const line of seen) expect(line).toMatch(inRoot("file", temp));
		expect(new Set(seen).size).toBe(2);
		expect(left).toEqual([]);
	}, 120_000);

	it("leaves nothing behind for a file whose every test is skipped", () => {
		// Vitest runs no afterAll for such a file, so only the run's teardown can remove its home.
		const { status, left } = runProbes({
			a: RECORDS,
			skipped: `describe.skip("never selected", () => { it("is skipped", () => {}); });\n`,
		});
		expect(status).toBe(0);
		expect(left).toEqual([]);
	}, 120_000);

	it("stays set after a file's last test, so a late write lands inside the run's root", () => {
		// The timer fires once the file's test is done; HOBO_HOME unset then would send it to ~/.hobo.
		// The next file waits for that write, so the worker cannot end before it.
		const { status, seen, temp, left } = runProbes({
			a: `it("leaves a timer", () => { globalThis.lateWrite = new Promise((written) => setTimeout(() => { record("late"); written(); }, 0)); });\n`,
			b: `it("waits for the late write", () => { if (!globalThis.lateWrite) throw new Error("a did not run first"); return globalThis.lateWrite; });\n`,
		});
		expect(status).toBe(0);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(inRoot("late", temp));
		expect(left).toEqual([]);
	}, 120_000);

	it("is never one the runner set: that one is kept, and no root is made", () => {
		const own = join(scratch, "own-home");
		mkdirSync(own);
		const { status, seen, left } = runProbes(
			{ a: RECORDS, b: RECORDS },
			{ HOBO_HOME: own },
		);
		expect(status).toBe(0);
		expect(seen).toEqual([`file ${own} true`, `file ${own} true`]);
		expect(existsSync(own)).toBe(true);
		expect(left).toEqual([]);
	}, 120_000);
});
