// `prepareHoboHome`: what an entry point calls before it writes the HoBo home.
//
// Earlier versions kept state in `/tmp/.hobo` (or `$(os.tmpdir())/.hobo`) when
// HOME was unset. That state is never read now, so a user who has some is told
// once where it lives now. Only their own: another uid's directory, a symlink,
// or the very directory that is now the home says nothing. And a home that
// cannot be created (the account `nobody`, whose passwd home does not exist) fails
// with a message naming HOBO_HOME rather than with EACCES from a later write.

import { spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import {
	ensureHoboHome,
	HoboHomeUnavailable,
	LEGACY_NOTICE_MARKER,
	prepareHoboHome,
} from "../src/hobo-home.js";

const SOURCE = fileURLToPath(new URL("../src/hobo-home.ts", import.meta.url));
const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), "hobo-home-prepare-"));
afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

let cases = 0;

/** A user's HOME and a legacy temp home with state in it, for one case. */
function layout() {
	cases += 1;
	const root = join(scratch, `case-${cases}`);
	const user = join(root, "user");
	const legacy = join(root, "tmp", ".hobo");
	mkdirSync(user, { recursive: true });
	mkdirSync(join(legacy, "durable", "code"), { recursive: true });
	writeFileSync(join(legacy, "durable", "code", "chat.json"), "{}");
	return { root, user, legacy };
}

const me = process.getuid?.() ?? 0;

describe("ensureHoboHome", () => {
	it("creates a missing home owner-only and leaves an existing one as it is", () => {
		const { root, user } = layout();
		const fresh = join(root, "fresh", ".hobo");
		expect(ensureHoboHome(fresh)).toBe(fresh);
		expect(statSync(fresh).mode & 0o777).toBe(0o700);
		chmodSync(user, 0o750);
		ensureHoboHome(user);
		expect(statSync(user).mode & 0o777).toBe(0o750);
	});
});

describe("prepareHoboHome", () => {
	it("creates the home, owner-only", () => {
		const { user } = layout();
		const home = prepareHoboHome({
			env: { HOME: user },
			legacyHomes: [],
			warn: () => {},
		});
		expect(home).toBe(join(user, ".hobo"));
		expect(statSync(home).isDirectory()).toBe(true);
		expect(statSync(home).mode & 0o777).toBe(0o700);
	});

	it("tells the user once where their legacy temp-dir state went", () => {
		const { user, legacy } = layout();
		const lines: string[] = [];
		const prepare = () =>
			prepareHoboHome({
				env: { HOME: user },
				legacyHomes: [legacy],
				uid: me,
				warn: (line) => lines.push(line),
			});
		prepare();
		prepare();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(
			`HoBo state now lives in ${join(user, ".hobo")}`,
		);
		expect(lines[0]).toContain(`${legacy} holds state`);
		// It suggests only homes under the user's own: never the temp dir.
		expect(lines[0]).not.toContain(`HOBO_HOME=${legacy}`);
		expect(lines[0]?.startsWith("hobo: ")).toBe(true);
		expect(existsSync(join(user, ".hobo", LEGACY_NOTICE_MARKER))).toBe(true);
		// Nothing is read from, or moved out of, the legacy home.
		expect(existsSync(join(legacy, "durable", "code", "chat.json"))).toBe(true);
		expect(existsSync(join(user, ".hobo", "durable"))).toBe(false);
	});

	it("prints the notice exactly once when eight processes start together", async () => {
		// Eight `hobo` invocations from one shell script, all on a fresh home.
		// Each loads the module, says it is ready, then waits for the go file
		// and prepares the home at once. A child waits by sleeping, not
		// spinning, gives up after a minute or once its parent is gone, and is
		// stopped when the test ends, however it ends: a slow start must not
		// leave eight processes polling.
		const { user, legacy } = layout();
		const go = join(user, "go");
		const script = `
const { existsSync } = await import("node:fs");
const { prepareHoboHome } = await import(${JSON.stringify(SOURCE)});
process.stdout.write("ready\\n");
const tick = new Int32Array(new SharedArrayBuffer(4));
const parent = process.ppid;
const giveUp = Date.now() + 60_000;
while (!existsSync(${JSON.stringify(go)})) {
	if (Date.now() > giveUp || process.ppid !== parent) process.exit(3);
	Atomics.wait(tick, 0, 0, 1);
}
prepareHoboHome({
	env: { HOME: ${JSON.stringify(user)} },
	legacyHomes: [${JSON.stringify(legacy)}],
	uid: ${me},
	warn: (line) => process.stdout.write(\`notice \${line}\\n\`),
});
`;
		// Node strips the module's types itself, which starts eight children
		// far faster than a loader would.
		const children = Array.from({ length: 8 }, () =>
			spawn(
				process.execPath,
				["--experimental-strip-types", "--input-type=module", "-e", script],
				{ cwd: PACKAGE },
			),
		);
		// Runs when the test ends, a timeout included; a `finally` would wait
		// for the readiness the timeout gave up on.
		onTestFinished(() => {
			for (const child of children)
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGKILL");
		});
		{
			const outputs = children.map(
				(child) =>
					new Promise<string>((done) => {
						let out = "";
						child.stdout.on("data", (chunk) => {
							out += String(chunk);
						});
						child.on("close", () => done(out));
					}),
			);
			await Promise.all(
				children.map(
					(child) =>
						new Promise<void>((ready) => {
							const listen = (chunk: Buffer | string) => {
								if (String(chunk).includes("ready")) {
									child.stdout.off("data", listen);
									ready();
								}
							};
							child.stdout.on("data", listen);
						}),
				),
			);
			writeFileSync(go, "");
			const notices = (await Promise.all(outputs))
				.flatMap((out) => out.split("\n"))
				.filter((line) => line.startsWith("notice "));
			expect(notices).toHaveLength(1);
		}
	});

	it("names the program that printed it, and offers XDG_STATE_HOME/hobo", () => {
		const { root, user, legacy } = layout();
		const state = join(root, "state");
		const lines: string[] = [];
		prepareHoboHome({
			env: { HOME: user, XDG_STATE_HOME: state },
			legacyHomes: [legacy],
			uid: me,
			program: "hobo-code",
			warn: (line) => lines.push(line),
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]?.startsWith("hobo-code: ")).toBe(true);
		expect(lines[0]).toContain(`HOBO_HOME=${join(state, "hobo")}`);
		expect(lines[0]).not.toContain(`HOBO_HOME=${legacy}`);
	});

	it("neither throws nor prints when the marker cannot be written", () => {
		// The notice is advisory. A home where nothing can be created (here a
		// link to /proc/self, a directory no one can add a file to) must not
		// turn it into a failure, and without its marker it is not printed,
		// so it could not repeat on every run.
		const { user, legacy } = layout();
		symlinkSync("/proc/self", join(user, ".hobo"));
		const lines: string[] = [];
		expect(
			prepareHoboHome({
				env: { HOME: user },
				legacyHomes: [legacy],
				uid: me,
				warn: (line) => lines.push(line),
			}),
		).toBe(join(user, ".hobo"));
		expect(lines).toEqual([]);
	});

	it("says nothing about another uid's directory", () => {
		const { user, legacy } = layout();
		const lines: string[] = [];
		prepareHoboHome({
			env: { HOME: user },
			legacyHomes: [legacy],
			uid: me + 4242,
			warn: (line) => lines.push(line),
		});
		expect(lines).toEqual([]);
	});

	it("says nothing about a symlink", () => {
		const { root, user, legacy } = layout();
		const link = join(root, "tmp", ".hobo-link");
		symlinkSync(legacy, link);
		const lines: string[] = [];
		prepareHoboHome({
			env: { HOME: user },
			legacyHomes: [link],
			uid: me,
			warn: (line) => lines.push(line),
		});
		expect(lines).toEqual([]);
	});

	it("says nothing when the legacy directory is the resolved home", () => {
		const { root, legacy } = layout();
		const lines: string[] = [];
		prepareHoboHome({
			env: { HOME: join(root, "tmp") },
			legacyHomes: [legacy],
			uid: me,
			warn: (line) => lines.push(line),
		});
		expect(lines).toEqual([]);
	});

	it("says nothing when HOBO_HOME is set: the fallback never applied", () => {
		const { root, legacy } = layout();
		const lines: string[] = [];
		prepareHoboHome({
			env: { HOBO_HOME: join(root, "chosen") },
			legacyHomes: [legacy],
			uid: me,
			warn: (line) => lines.push(line),
		});
		expect(lines).toEqual([]);
	});

	it("fails with HoboHomeUnavailable naming HOBO_HOME when the home cannot be made", () => {
		// A file where a directory must go: as `nobody`, under its missing home,
		// the same call fails with EACCES instead.
		const { root } = layout();
		writeFileSync(join(root, "file"), "");
		let thrown: unknown;
		try {
			prepareHoboHome({ env: { HOME: join(root, "file") }, legacyHomes: [] });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(HoboHomeUnavailable);
		expect(thrown).toMatchObject({
			message: expect.stringMatching(
				/cannot create .*\/file\/\.hobo \(ENOTDIR\); set HOBO_HOME to a directory you can write$/u,
			),
		});
	});
});
