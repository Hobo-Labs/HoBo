import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OpenSesameAdapterError } from "../src/errors.js";
import { runProxied } from "../src/launch.js";
import { type BinProbe, trustedOpenSesame } from "../src/opensesame-bin.js";
import { parsed } from "./fixtures/bindings.js";
import { dir, file, memoryTrust, type TreeNode } from "./support/trust-fs.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "fixtures/fake-opensesame.mts");
const CHILD = join(here, "fixtures/child.mts");
const SYSTEM_PATH = process.env.PATH ?? "";
const PASSPHRASE = "store-passphrase-for-tests";

let work = "";
let cwd = "";
beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "hobo-bin-test-"));
	cwd = process.cwd();
});
afterEach(() => {
	process.chdir(cwd);
	rmSync(work, { recursive: true, force: true });
});

const IDENTIFIES: BinProbe = () => ({
	status: 0,
	stdout: "opensesame 0.1.0\n",
});

function codeOf(run: () => string): string {
	try {
		run();
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error.code;
		throw error;
	}
	return "no error";
}

/** A stand-in that records that it ran, with the environment and argument it was given, and prints `says`. */
function stub(
	path: string,
	says: string,
	record = join(work, "ran.jsonl"),
): string {
	mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
	writeFileSync(
		path,
		`#!/bin/sh\nprintf '%s\\n' "$(env | sort | tr '\\n' ' ') ARGS: $*" >> '${record}'\nprintf '%s\\n' '${says}'\n`,
		{ mode: 0o755 },
	);
	chmodSync(path, 0o755);
	return path;
}

describe("the executable is found on absolute PATH entries only", () => {
	it("never runs a stub in the working directory, whatever PATH says about it", () => {
		const planted = stub(join(work, "opensesame"), "opensesame 0.1.0");
		process.chdir(work);
		for (const path of [
			".",
			`.${delimiter}${SYSTEM_PATH}`,
			`${delimiter}${SYSTEM_PATH}`,
			`${SYSTEM_PATH}${delimiter}.`,
			`${SYSTEM_PATH}${delimiter}`,
			"",
			`./${delimiter}bin`,
			`..${delimiter}${SYSTEM_PATH}`,
		]) {
			expect(
				codeOf(() =>
					trustedOpenSesame({
						bin: "opensesame",
						env: { PATH: path },
						probe: IDENTIFIES,
					}),
				),
				JSON.stringify(path),
			).toBe("opensesame_bin_missing");
		}
		expect(existsSync(join(work, "ran.jsonl"))).toBe(false);
		expect(planted).toContain("opensesame");
	});

	it("finds a bare name in an absolute entry and returns its absolute path", () => {
		const found = stub(join(work, "tools", "opensesame"), "opensesame 0.1.0");
		const got = trustedOpenSesame({
			bin: "opensesame",
			env: { PATH: `relative${delimiter}${join(work, "tools")}` },
			probe: IDENTIFIES,
		});
		expect(got).toBe(realpathSync(found));
	});

	it("takes the first entry that holds an executable file, as a shell does, and skips a directory or a file that is not executable", () => {
		mkdirSync(join(work, "a", "opensesame"), { recursive: true });
		mkdirSync(join(work, "b"), { recursive: true });
		writeFileSync(join(work, "b", "opensesame"), "x", { mode: 0o644 });
		const wanted = stub(join(work, "c", "opensesame"), "opensesame 0.1.0");
		stub(join(work, "d", "opensesame"), "opensesame 0.1.0");
		const path = ["a", "b", "c", "d"].map((d) => join(work, d)).join(delimiter);
		expect(
			trustedOpenSesame({
				bin: "opensesame",
				env: { PATH: path },
				probe: IDENTIFIES,
			}),
		).toBe(realpathSync(wanted));
	});

	it("refuses an executable that group or others can write, without running it", () => {
		for (const mode of [0o775, 0o757, 0o777, 0o722]) {
			const dir = join(work, `m${mode.toString(8)}`);
			const path = stub(join(dir, "opensesame"), "opensesame 0.1.0");
			chmodSync(path, mode);
			expect(
				codeOf(() =>
					trustedOpenSesame({
						bin: "opensesame",
						env: { PATH: dir },
						probe: IDENTIFIES,
					}),
				),
				mode.toString(8),
			).toBe("opensesame_bin_untrusted");
		}
		expect(existsSync(join(work, "ran.jsonl"))).toBe(false);
	});

	it("an explicit path is the caller's own choice: used as given, resolved from the working directory, and still identified", () => {
		const explicit = stub(join(work, "mine", "opensesame"), "opensesame 0.1.0");
		chmodSync(explicit, 0o775);
		expect(
			trustedOpenSesame({
				bin: explicit,
				env: { PATH: "" },
				probe: IDENTIFIES,
			}),
		).toBe(realpathSync(explicit));
		process.chdir(work);
		expect(
			trustedOpenSesame({
				bin: "./mine/opensesame",
				env: { PATH: "" },
				probe: IDENTIFIES,
			}),
		).toBe(explicit);
		expect(
			codeOf(() =>
				trustedOpenSesame({
					bin: join(work, "mine", "nothing"),
					env: { PATH: "" },
					probe: IDENTIFIES,
				}),
			),
		).toBe("opensesame_bin_missing");
		expect(
			codeOf(() =>
				trustedOpenSesame({ bin: work, env: { PATH: "" }, probe: IDENTIFIES }),
			),
		).toBe("opensesame_bin_missing");
	});
});

describe("the executable is identified with nothing to steal before it gets the passphrase", () => {
	it("asks --version with PATH alone, reduced to the entries that pass the trust rule: no passphrase, no listed variable, no relative, missing or writable entry", () => {
		const exe = stub(join(work, "tools", "opensesame"), "opensesame 0.1.0");
		const good = join(work, "good");
		const open = join(work, "open");
		mkdirSync(good, { mode: 0o755 });
		mkdirSync(open);
		chmodSync(open, 0o777);
		const seen: { bin: string; env: NodeJS.ProcessEnv }[] = [];
		trustedOpenSesame({
			bin: exe,
			env: {
				PATH: [".", "", "relative", `${good}-x`, open, good].join(delimiter),
				OPENSESAME_STORE_PASSWORD: PASSPHRASE,
				AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			},
			probe: (bin, env) => {
				seen.push({ bin, env });
				return { status: 0, stdout: "opensesame 0.1.0\n" };
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.bin).toBe(realpathSync(exe));
		expect(Object.keys(seen[0]?.env ?? {})).toEqual(["PATH"]);
		expect(seen[0]?.env.PATH).toBe(realpathSync(good));
	});

	it("refuses an executable that does not say it is opensesame, and does not repeat what it said", () => {
		const exe = stub(join(work, "tools", "opensesame"), "x");
		for (const stdout of [
			"",
			"evil 0.1.0\n",
			"opensesame\n",
			"opensesame x.y.z\n",
			"  opensesame 0.1.0\n",
			"not opensesame 0.1.0 Bearer vtok_dummy_marker_0123456789abcdef\n",
		]) {
			let message = "";
			try {
				trustedOpenSesame({
					bin: exe,
					env: { PATH: SYSTEM_PATH },
					probe: () => ({ status: 0, stdout }),
				});
			} catch (error) {
				if (error instanceof OpenSesameAdapterError) {
					expect(error.code, JSON.stringify(stdout)).toBe(
						"opensesame_bin_untrusted",
					);
					message = error.message;
				} else throw error;
			}
			expect(message, JSON.stringify(stdout)).not.toBe("");
			expect(message).not.toContain("vtok_dummy");
		}
	});

	it("refuses one that fails or cannot be run", () => {
		const exe = stub(join(work, "tools", "opensesame"), "x");
		for (const probe of [
			() => ({ status: 1, stdout: "opensesame 0.1.0\n" }),
			() => ({ status: null, stdout: "opensesame 0.1.0\n" }),
		] satisfies BinProbe[]) {
			expect(
				codeOf(() =>
					trustedOpenSesame({ bin: exe, env: { PATH: SYSTEM_PATH }, probe }),
				),
			).toBe("opensesame_bin_untrusted");
		}
		const notAProgram = join(work, "tools", "garbage");
		writeFileSync(notAProgram, "\0\0\0", { mode: 0o755 });
		expect(
			codeOf(() =>
				trustedOpenSesame({ bin: notAProgram, env: { PATH: SYSTEM_PATH } }),
			),
		).toBe("opensesame_bin_untrusted");
	});
});

describe("a bare name resolves to a place only the user or root can write", () => {
	const ME = 1000;
	const STRANGER = 4242;

	it("refuses a file another user owns, naming why, with the file left unrun (ownership injected, so this holds without root)", () => {
		const exe = stub(join(work, "tools", "opensesame"), "opensesame 0.1.0");
		const real = realpathSync(exe);
		// Every directory above the file belongs to root, 0755, as /usr/bin does; the file is a stranger's.
		const above: Record<string, TreeNode> = {};
		for (let at = dirname(real); ; at = dirname(at)) {
			above[at] = dir(0, 0o755);
			if (dirname(at) === at) break;
		}
		const trust = memoryTrust(
			{ ...above, [real]: file(STRANGER, 0o755) },
			{ euid: ME, cwd: "/elsewhere" },
		);
		let ran = false;
		let message = "";
		try {
			trustedOpenSesame({
				bin: "opensesame",
				env: { PATH: dirname(exe) },
				trust,
				probe: () => {
					ran = true;
					return { status: 0, stdout: "opensesame 0.1.0\n" };
				},
			});
		} catch (error) {
			if (error instanceof OpenSesameAdapterError) {
				expect(error.code).toBe("opensesame_bin_untrusted");
				message = error.message;
			} else throw error;
		}
		expect(message).toContain("is owned by another user");
		expect(ran).toBe(false);
		// The same tree with the file the user's own is accepted, so it was the owner that decided.
		const mine = memoryTrust(
			{ ...above, [real]: file(ME, 0o755) },
			{ euid: ME, cwd: "/elsewhere" },
		);
		expect(
			trustedOpenSesame({
				bin: "opensesame",
				env: { PATH: dirname(exe) },
				trust: mine,
				probe: IDENTIFIES,
			}),
		).toBe(real);
	});

	it("refuses a file in a group- or world-writable directory, and a symlink into or out of one, without running it", () => {
		const open = join(work, "open");
		const closed = join(work, "closed");
		mkdirSync(closed, { mode: 0o755 });
		stub(join(open, "opensesame"), "opensesame 0.1.0");
		chmodSync(open, 0o777);
		const target = stub(join(closed, "opensesame"), "opensesame 0.1.0");
		symlinkSync(target, join(open, "link-out"));
		const aimed = join(work, "aimed");
		mkdirSync(aimed, { mode: 0o755 });
		symlinkSync(join(open, "opensesame"), join(aimed, "opensesame"));
		for (const [label, entry, name] of [
			["a file in a world-writable directory", open, "opensesame"],
			["a symlink in a world-writable directory", open, "link-out"],
			["a symlink out to a world-writable directory", aimed, "opensesame"],
		] as const) {
			expect(
				codeOf(() =>
					trustedOpenSesame({
						bin: name,
						env: { PATH: entry },
						probe: IDENTIFIES,
					}),
				),
				label,
			).toBe("opensesame_bin_untrusted");
		}
		expect(existsSync(join(work, "ran.jsonl"))).toBe(false);
	});

	it("follows a chain of symlinks through trusted directories and hands back where it ends", () => {
		const one = join(work, "one");
		const two = join(work, "two");
		const end = stub(join(work, "end", "opensesame"), "opensesame 0.1.0");
		mkdirSync(one, { mode: 0o755 });
		mkdirSync(two, { mode: 0o755 });
		symlinkSync(end, join(two, "opensesame"));
		symlinkSync(join(two, "opensesame"), join(one, "opensesame"));
		const probed: string[] = [];
		const got = trustedOpenSesame({
			bin: "opensesame",
			env: { PATH: one },
			probe: (bin) => {
				probed.push(bin);
				return { status: 0, stdout: "opensesame 0.1.0\n" };
			},
		});
		expect(got).toBe(realpathSync(end));
		expect(probed).toEqual([got]);
	});

	it("refuses an entry inside node_modules/.bin, where a dependency can name a program anything", () => {
		const bin = join(work, "proj", "node_modules", ".bin");
		stub(join(bin, "opensesame"), "opensesame 0.1.0");
		expect(
			codeOf(() =>
				trustedOpenSesame({
					bin: "opensesame",
					env: { PATH: bin },
					probe: IDENTIFIES,
				}),
			),
		).toBe("opensesame_bin_untrusted");
	});

	it("refuses a PATH entry that is a symlink to the working directory's checkout, and one inside it", () => {
		const checkout = join(work, "checkout");
		stub(join(checkout, "opensesame"), "opensesame 0.1.0");
		stub(join(checkout, "sub", "opensesame"), "opensesame 0.1.0");
		const aliased = join(work, "alias");
		symlinkSync(checkout, aliased);
		process.chdir(checkout);
		for (const entry of [aliased, checkout, join(checkout, "sub")]) {
			expect(
				codeOf(() =>
					trustedOpenSesame({
						bin: "opensesame",
						env: { PATH: entry },
						probe: IDENTIFIES,
					}),
				),
				entry,
			).toBe("opensesame_bin_untrusted");
		}
		expect(existsSync(join(work, "ran.jsonl"))).toBe(false);
	});

	it("an explicit path is resolved once, through its links, and that resolved path is what is probed", () => {
		const end = stub(join(work, "end", "opensesame"), "opensesame 0.1.0");
		const alias = join(work, "alias");
		symlinkSync(end, alias);
		const probed: string[] = [];
		const got = trustedOpenSesame({
			bin: alias,
			env: { PATH: "" },
			probe: (bin) => {
				probed.push(bin);
				return { status: 0, stdout: "opensesame 0.1.0\n" };
			},
		});
		expect(got).toBe(realpathSync(end));
		expect(probed).toEqual([got]);
	});
});

describe("runProxied hands the passphrase to the executable it identified, and to no other", () => {
	function input(bin: string, env: NodeJS.ProcessEnv) {
		return {
			bin,
			bindings: parsed(),
			argv: [
				process.execPath,
				"--no-warnings",
				CHILD,
				join(work, "child.json"),
			],
			env: {
				PATH: SYSTEM_PATH,
				NODE_NO_WARNINGS: "1",
				OPENSESAME_STORE_PASSWORD: PASSPHRASE,
				...env,
			},
			passEnv: ["OPENSESAME_STORE_PASSWORD"],
			stderr: new PassThrough(),
			tmpRoot: work,
		};
	}

	it("a stand-in on '.' that a bare name would have found never runs, and never sees the passphrase", async () => {
		stub(join(work, "opensesame"), "opensesame 0.1.0");
		process.chdir(work);
		let code = "no error";
		try {
			await runProxied(
				input("opensesame", { PATH: `.${delimiter}${SYSTEM_PATH}` }),
			);
		} catch (error) {
			if (error instanceof OpenSesameAdapterError) code = error.code;
			else throw error;
		}
		expect(code).toBe("opensesame_bin_missing");
		expect(existsSync(join(work, "ran.jsonl"))).toBe(false);
	});

	it("an executable that does not identify itself runs once, for --version, with PATH only, and is never started for the run", async () => {
		const impostor = stub(join(work, "tools", "opensesame"), "impostor 9.9.9");
		let code = "no error";
		try {
			await runProxied(input(impostor, {}));
		} catch (error) {
			if (error instanceof OpenSesameAdapterError) code = error.code;
			else throw error;
		}
		expect(code).toBe("opensesame_bin_untrusted");
		const ran = readFileSync(join(work, "ran.jsonl"), "utf8")
			.trim()
			.split("\n");
		expect(ran).toHaveLength(1);
		expect(ran[0]).toContain("ARGS: --version");
		expect(ran[0]).not.toContain(PASSPHRASE);
		expect(ran[0]).not.toContain("OPENSESAME_STORE_PASSWORD");
	});

	it("one that does identify itself is started for the run and gets the passphrase then", async () => {
		const record = join(work, "ran.jsonl");
		const wrapper = join(work, "tools", "opensesame");
		mkdirSync(dirname(wrapper), { recursive: true });
		writeFileSync(
			wrapper,
			`#!/bin/sh\nprintf '%s\\n' "${"$"}{OPENSESAME_STORE_PASSWORD:-absent} $1" >> '${record}'\nexec '${FAKE}' "$@"\n`,
			{ mode: 0o755 },
		);
		chmodSync(wrapper, 0o755);
		const outcome = await runProxied({
			...input("opensesame", {
				PATH: `${join(work, "tools")}${delimiter}${SYSTEM_PATH}`,
				FAKE_OPENSESAME_RECORD: join(work, "fake.json"),
			}),
			passEnv: ["OPENSESAME_STORE_PASSWORD", "FAKE_OPENSESAME_RECORD"],
		});
		expect(outcome).toMatchObject({ kind: "child_exit", exitCode: 0 });
		expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
			"absent --version",
			`${PASSPHRASE} dev`,
		]);
	});
});
