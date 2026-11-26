/**
 * Resolving a wasmtime binary that meets the pinned floor.
 *
 * Unlike the kubectl resolver, this one has a **version floor**, and that
 * changes every decision. A binary being present is not enough — an older
 * wasmtime will happily run a component built against a newer WASI world and
 * fail somewhere inside it, with an error about a missing import rather than
 * about a version. So each candidate is probed *and* compared against the floor,
 * and one that is present but too old is passed over rather than used.
 *
 * The one exception is an explicitly-supplied `binPath`. That is a caller
 * saying "use this one", and if it does not meet the floor the resolver refuses
 * outright rather than quietly substituting something else — because silently
 * running a different binary than the one you named is worse than failing.
 *
 * `spawnSync` is not injectable, so these tests put real executables on disk.
 * That exercises the probe for real, including its retry: the first exec of a
 * freshly written ~40MB binary can exceed one timeout under a parallel test
 * sweep, so a spawn timeout is retried while a genuine failure is not.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	applyHoboMeshEnvHeaders,
	defaultHoboHome,
	ensureWasmtimeBinary,
	HOBO_BINDLE_ENV_HEADER,
	HOBO_ENV_HEADER_PREFIX,
	PINNED_WASMTIME_VERSION,
} from "../src/sandbox.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-wasmtime-"));
	dirs.push(dir);
	return dir;
}

/** A stand-in wasmtime that answers `--version` with `version`, or fails. */
function fakeWasmtime(
	path: string,
	options: { version?: string; broken?: boolean; silent?: boolean } = {},
): string {
	const body = options.broken
		? "process.exit(1);"
		: options.silent
			? "process.exit(0);"
			: `process.stdout.write("wasmtime ${options.version ?? PINNED_WASMTIME_VERSION} (abc123)\\n");`;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

const toolsPath = (home: string) => join(home, "tools", "wasmtime");

/** Runs with a PATH holding no wasmtime, so the PATH probe reliably misses. */
async function withEmptyPath<T>(run: () => Promise<T> | T): Promise<T> {
	const saved = process.env.PATH;
	process.env.PATH = `${scratch()}:${dirname(process.execPath)}`;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.PATH;
		else process.env.PATH = saved;
	}
}

describe("the pinned floor", () => {
	it("is an exact three-part version", () => {
		expect(PINNED_WASMTIME_VERSION).toMatch(/^\d+\.\d+\.\d+$/u);
	});
});

describe("defaultHoboHome", () => {
	it("honours an explicit HOBO_HOME", () => {
		expect(defaultHoboHome({ HOBO_HOME: "/custom/hobo" })).toBe("/custom/hobo");
	});

	it("falls back to a stable path when none is set", () => {
		// Stable, because a downloaded toolchain has to be findable on the next
		// run. A per-process path would re-download every command.
		const home = defaultHoboHome({});
		expect(typeof home).toBe("string");
		expect(home.length).toBeGreaterThan(0);
		expect(defaultHoboHome({})).toBe(home);
	});
});

describe("applyHoboMeshEnvHeaders", () => {
	it("adds one lowercased header per key plus a JSON map", () => {
		// The guest cannot read the host's process.env, so camp config arrives as
		// headers on the mesh hop. Two representations, so a guest can take a
		// single value or parse the lot once.
		const headers = applyHoboMeshEnvHeaders(new Headers(), {
			LOG_LEVEL: "debug",
		});
		expect(headers.get(`${HOBO_ENV_HEADER_PREFIX}log_level`)).toBe("debug");
		expect(JSON.parse(headers.get(HOBO_BINDLE_ENV_HEADER) ?? "{}")).toEqual({
			LOG_LEVEL: "debug",
		});
	});

	it("preserves the caller's existing headers", () => {
		const headers = applyHoboMeshEnvHeaders(
			new Headers({ "content-type": "application/json" }),
			{ A: "1" },
		);
		expect(headers.get("content-type")).toBe("application/json");
	});

	it("returns a new Headers rather than mutating the caller's", () => {
		// The original may be reused on a retry; mutating would accumulate env
		// headers on every attempt.
		const original = new Headers();
		expect(applyHoboMeshEnvHeaders(original, { A: "1" })).not.toBe(original);
		expect(original.get(`${HOBO_ENV_HEADER_PREFIX}a`)).toBeNull();
	});
});

describe("an explicitly supplied binary", () => {
	it("is used when it meets the floor", async () => {
		const binPath = fakeWasmtime(join(scratch(), "wasmtime"));
		const resolved = await ensureWasmtimeBinary({
			binPath,
			env: {},
			download: false,
		});
		expect(resolved.binPath).toBe(binPath);
		expect(resolved.source).toBe("env");
		expect(resolved.version).toBe(PINNED_WASMTIME_VERSION);
	});

	it("is refused rather than substituted when it is below the floor", async () => {
		// The important asymmetry. A caller naming a binary means that one; the
		// resolver must not quietly run a different wasmtime than the one asked
		// for, because the caller's reason for naming it is invisible here.
		const binPath = fakeWasmtime(join(scratch(), "wasmtime"), {
			version: "1.0.0",
		});
		await expect(
			ensureWasmtimeBinary({ binPath, env: {}, download: false }),
		).rejects.toThrow(new RegExp(`below ${PINNED_WASMTIME_VERSION}`, "u"));
	});

	it("is refused when it does not exist", async () => {
		await expect(
			ensureWasmtimeBinary({
				binPath: join(scratch(), "absent"),
				env: {},
				download: false,
			}),
		).rejects.toThrow(/missing or below/u);
	});

	it("names the path it refused", async () => {
		// So an operator with several wasmtime installs knows which one their
		// variable actually pointed at.
		const binPath = fakeWasmtime(join(scratch(), "wasmtime"), {
			version: "1.0.0",
		});
		await expect(
			ensureWasmtimeBinary({ binPath, env: {}, download: false }),
		).rejects.toThrow(new RegExp(binPath.replace(/[/.]/gu, "."), "u"));
	});
});

describe("resolution order", () => {
	it("prefers HOBO_WASMTIME_BIN over the managed copy", async () => {
		const home = scratch();
		const explicit = fakeWasmtime(join(scratch(), "wasmtime"), {
			version: "99.0.0",
		});
		fakeWasmtime(toolsPath(home));
		const resolved = await ensureWasmtimeBinary({
			hoboHome: home,
			env: { HOBO_WASMTIME_BIN: explicit },
			download: false,
		});
		expect(resolved.source).toBe("env");
		expect(resolved.version).toBe("99.0.0");
	});

	it("falls past an environment binary below the floor", async () => {
		// Unlike the explicit `binPath`, the environment variable is ambient — it
		// may have been set for something else entirely — so a too-old one is
		// skipped rather than made fatal.
		const home = scratch();
		fakeWasmtime(toolsPath(home));
		const resolved = await ensureWasmtimeBinary({
			hoboHome: home,
			env: {
				HOBO_WASMTIME_BIN: fakeWasmtime(join(scratch(), "wasmtime"), {
					version: "1.0.0",
				}),
			},
			download: false,
		});
		expect(resolved.source).toBe("tools");
	});

	it("ignores an empty HOBO_WASMTIME_BIN", async () => {
		const home = scratch();
		fakeWasmtime(toolsPath(home));
		const resolved = await ensureWasmtimeBinary({
			hoboHome: home,
			env: { HOBO_WASMTIME_BIN: "" },
			download: false,
		});
		expect(resolved.source).toBe("tools");
	});

	it("prefers the managed copy over PATH", async () => {
		// If PATH won, a download performed to meet the floor would be ignored on
		// the next call in favour of the too-old binary it was fetched to replace.
		const home = scratch();
		fakeWasmtime(toolsPath(home));
		const resolved = await ensureWasmtimeBinary({
			hoboHome: home,
			env: {},
			download: false,
		});
		expect(resolved.source).toBe("tools");
		expect(resolved.binPath).toBe(toolsPath(home));
	});

	it("falls past a managed copy that is below the floor", async () => {
		// An old download left by a previous HoBo version. It has to be passed
		// over, or the floor could never be raised.
		await withEmptyPath(async () => {
			const home = scratch();
			fakeWasmtime(toolsPath(home), { version: "1.0.0" });
			await expect(
				ensureWasmtimeBinary({ hoboHome: home, env: {}, download: false }),
			).rejects.toThrow(/not found/u);
		});
	});

	it("refuses with both remedies when nothing is found and download is off", async () => {
		await withEmptyPath(async () => {
			try {
				await ensureWasmtimeBinary({
					hoboHome: scratch(),
					env: {},
					download: false,
				});
				expect.unreachable("a missing wasmtime must be refused");
			} catch (error) {
				const message = (error as Error).message;
				expect(message).toContain(PINNED_WASMTIME_VERSION);
				expect(message).toContain("hobo yard ensure");
			}
		});
	});
});

describe("the version probe", () => {
	it("reads a version out of wasmtime's banner", async () => {
		// The output is `wasmtime 46.0.1 (abc123)`, not a bare version — a probe
		// that expected only digits would reject every real binary.
		const resolved = await ensureWasmtimeBinary({
			binPath: fakeWasmtime(join(scratch(), "wasmtime"), {
				version: "46.0.1",
			}),
			env: {},
			download: false,
		});
		expect(resolved.version).toBe("46.0.1");
	});

	it("treats a binary that prints no version as absent", async () => {
		// Exit zero with nothing to parse. Returning a null version would let an
		// unidentifiable binary past the floor check by comparing against
		// nothing.
		await expect(
			ensureWasmtimeBinary({
				binPath: fakeWasmtime(join(scratch(), "wasmtime"), { silent: true }),
				env: {},
				download: false,
			}),
		).rejects.toThrow(/missing or below/u);
	});

	it("treats a binary that exits non-zero as absent", async () => {
		await expect(
			ensureWasmtimeBinary({
				binPath: fakeWasmtime(join(scratch(), "wasmtime"), { broken: true }),
				env: {},
				download: false,
			}),
		).rejects.toThrow(/missing or below/u);
	});
});

describe("the version floor comparison", () => {
	/** Resolve an explicit binary at `version`, reporting whether it passed. */
	async function accepts(version: string): Promise<boolean> {
		try {
			await ensureWasmtimeBinary({
				binPath: fakeWasmtime(join(scratch(), "wasmtime"), { version }),
				env: {},
				download: false,
			});
			return true;
		} catch {
			return false;
		}
	}

	it("accepts the pinned version exactly", async () => {
		// The floor is inclusive. An exclusive comparison would reject the very
		// version the project pinned, which is the one CI installs.
		expect(await accepts(PINNED_WASMTIME_VERSION)).toBe(true);
	});

	it("accepts a higher major version", async () => {
		expect(await accepts("999.0.0")).toBe(true);
	});

	it("rejects a lower major version", async () => {
		expect(await accepts("1.0.0")).toBe(false);
	});

	it("compares numerically, not lexically", async () => {
		// The classic version-comparison bug. As strings `"9.0.0" > "46.0.1"`,
		// so a lexical compare would accept wasmtime 9 as newer than 46 — and the
		// component would fail deep inside with a missing-import error.
		const [major = "0"] = PINNED_WASMTIME_VERSION.split(".");
		const lowerButLexicallyGreater = `${Number(major) - 37}.0.0`;
		expect(await accepts(lowerButLexicallyGreater)).toBe(false);
	});

	it("compares the minor and patch parts when the major matches", async () => {
		const [major = "0", minor = "0", patch = "0"] =
			PINNED_WASMTIME_VERSION.split(".");
		expect(await accepts(`${major}.${Number(minor) + 1}.0`)).toBe(true);
		expect(await accepts(`${major}.${minor}.${Number(patch) + 1}`)).toBe(true);
		if (Number(patch) > 0) {
			expect(await accepts(`${major}.${minor}.${Number(patch) - 1}`)).toBe(
				false,
			);
		}
	});

	it("rejects a two-part version before the floor comparison sees it", async () => {
		// Worth pinning because the outcome is right for the wrong-looking
		// reason. `meetsFloor` handles a missing component with `parts[i] ?? 0`,
		// so on its own it would read `47.0` as `47.0.0` and accept it. But the
		// version never gets that far: the probe's regex is
		// `(\d+)\.(\d+)\.(\d+)`, which does not match a two-part banner at
		// all, so the binary is reported as unidentifiable and treated as absent.
		//
		// So the `?? 0` arm is unreachable through this entry point. Recorded
		// rather than removed — it is correct defensive code, and refusing an
		// unparseable version is the safer of the two behaviours anyway: a
		// wasmtime whose banner we cannot read is not one to trust against a
		// floor.
		const [major = "0"] = PINNED_WASMTIME_VERSION.split(".");
		expect(await accepts(`${Number(major) + 1}.0`)).toBe(false);
	});
});
