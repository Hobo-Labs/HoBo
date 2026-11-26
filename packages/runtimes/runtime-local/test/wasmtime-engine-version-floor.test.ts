/**
 * The wasmtime version floor, and why it is checked at construction.
 *
 * The component model reached its stable shape in wasmtime 46.0.1. An older
 * runtime does not fail loudly on a component built against it — it fails
 * partway through instantiation, or silently mis-links an import, and the
 * symptom surfaces as a component that behaves wrongly rather than one that
 * refuses to start. So the engine checks the binary's version *before* it will
 * hand back an engine at all, and refuses by name when the floor is not met.
 *
 * Three properties follow from that:
 *
 * **The refusal names the version it found and the floor it wanted.** An
 * operator seeing `wasmtime_version_floor` alone has to go and run
 * `wasmtime --version` themselves to learn anything.
 *
 * **Every way of not learning the version is the same refusal.** A binary that
 * is missing, one that exits non-zero, and one that prints something
 * unrecognisable all mean "this engine cannot be trusted to run components",
 * and each raises `wasmtime_version_floor` rather than three different errors
 * a caller would have to handle separately.
 *
 * **The in-process engine has no floor.** It does not run wasm at all — it
 * resolves a descriptor into an instance shape — so gating it on a binary
 * nobody invokes would make the local dev loop depend on an install it does
 * not use.
 *
 * These drive the real `spawnSync` against stand-in `wasmtime` binaries
 * written per test. Mocking `child_process` instead would prove the parsing
 * and nothing about whether the engine actually invokes the binary it was
 * given.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createInProcessWasmtimeEngine,
	createWasmtimeCliEngine,
} from "../src/engine/wasmtime.js";
import { ComponentHostError } from "../src/errors.js";

const dirs: string[] = [];
const originalBin = process.env.HOBO_WASMTIME_BIN;

afterEach(() => {
	if (originalBin === undefined) delete process.env.HOBO_WASMTIME_BIN;
	else process.env.HOBO_WASMTIME_BIN = originalBin;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * A stand-in `wasmtime` that prints `stdout` and exits with `status`.
 *
 * A shebang script, so the engine's own `spawnSync` runs it exactly as it
 * would run the real binary — argument handling, exit status and all.
 */
function standIn(stdout: string, status = 0, stderr = ""): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-wasmtime-"));
	dirs.push(dir);
	const bin = join(dir, "wasmtime");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			`process.stdout.write(${JSON.stringify(stdout)});`,
			`process.stderr.write(${JSON.stringify(stderr)});`,
			`process.exit(${status});`,
		].join("\n"),
		{ mode: 0o755 },
	);
	chmodSync(bin, 0o755);
	return bin;
}

const engineFor = (stdout: string, status = 0, stderr = "") =>
	createWasmtimeCliEngine({ binPath: standIn(stdout, status, stderr) });

describe("versions the floor accepts", () => {
	it("accepts exactly the floor", () => {
		// 46.0.1 is the floor, not the exclusive bound below it. An off-by-one
		// here would reject the very version the platform pins.
		expect(engineFor("wasmtime 46.0.1\n").version).toBe("wasmtime@46.0.1");
	});

	it("accepts a higher patch", () => {
		expect(engineFor("wasmtime 46.0.2\n").version).toBe("wasmtime@46.0.2");
	});

	it("accepts a higher minor even with a lower patch", () => {
		// 46.1.0 > 46.0.1 despite `0 < 1` in the patch position: comparison is
		// positional and stops at the first difference.
		expect(engineFor("wasmtime 46.1.0\n").version).toBe("wasmtime@46.1.0");
	});

	it("accepts a higher major even with a lower minor and patch", () => {
		expect(engineFor("wasmtime 47.0.0\n").version).toBe("wasmtime@47.0.0");
	});

	it("finds the version inside a longer banner", () => {
		// Real builds print a suffix — `wasmtime-cli 46.0.1 (abc1234 2026-01-01)`.
		// Requiring a bare version would refuse every distribution build.
		expect(
			engineFor("wasmtime-cli 46.0.1 (abc1234 2026-01-01)\n").version,
		).toBe("wasmtime@46.0.1");
	});

	it("reports the version it found, not the one it was configured with", () => {
		// The engine's `version` is evidence about the binary that will run
		// components, so it has to come from the binary rather than from a
		// caller's expectation.
		expect(engineFor("wasmtime 49.2.3\n").version).toBe("wasmtime@49.2.3");
	});
});

describe("versions the floor refuses", () => {
	it("refuses a lower patch", () => {
		expect(() => engineFor("wasmtime 46.0.0\n")).toThrow(ComponentHostError);
	});

	it("refuses a lower minor", () => {
		// 45.9.9 is refused despite the higher minor and patch: the major
		// decides first.
		expect(() => engineFor("wasmtime 45.9.9\n")).toThrow(
			/wasmtime_version_floor/,
		);
	});

	it("names both the version it found and the floor it wanted", () => {
		// `wasmtime_version_floor` alone leaves an operator to go and run
		// `wasmtime --version` themselves.
		expect(() => engineFor("wasmtime 45.9.9\n")).toThrow(/45\.9\.9.*46\.0\.1/);
	});
});

describe("binaries that cannot report a version", () => {
	it("refuses one that exits non-zero", () => {
		// A wasmtime that cannot answer `--version` is not one to run
		// components on, whatever the reason.
		expect(() => engineFor("", 1, "not a wasmtime\n")).toThrow(
			/wasmtime_version_floor/,
		);
	});

	it("carries the binary's own stderr into the refusal", () => {
		// The binary usually knows why it failed — a missing shared library, a
		// bad architecture — and discarding that leaves nothing to act on.
		expect(() => engineFor("", 1, "libssl.so.3: not found\n")).toThrow(
			/libssl\.so\.3/,
		);
	});

	it("still refuses when the failing binary said nothing at all", () => {
		// Silence is the hardest case: the refusal must still say what was
		// attempted rather than surfacing an empty message.
		expect(() => engineFor("", 1, "")).toThrow(/wasmtime --version failed/);
	});

	it("refuses output with no version in it", () => {
		expect(() => engineFor("wasmtime, a WebAssembly runtime\n")).toThrow(
			/unparseable version/,
		);
	});

	it("quotes the unrecognised output in the refusal", () => {
		expect(() => engineFor("totally unexpected\n")).toThrow(
			/totally unexpected/,
		);
	});

	it("refuses a two-part version", () => {
		// `46.0` is not a wasmtime version. Padding the missing part with zero
		// would accept `46.0` as `46.0.0` — below the floor, and silently.
		expect(() => engineFor("wasmtime 46.0\n")).toThrow(/unparseable version/);
	});

	it("refuses a binary that does not exist", () => {
		// The most likely failure in the field — wasmtime simply not installed.
		// `spawnSync` reports it as `status: null` with *null* streams rather
		// than throwing, so the version check has to reach it without touching
		// `stderr`. Before the guard alongside this test, it did not: reading
		// `.stderr.trim()` raised `Cannot read properties of undefined`, and
		// the commonest misconfiguration surfaced as a TypeError with no
		// mention of wasmtime at all.
		expect(() =>
			createWasmtimeCliEngine({ binPath: join(tmpdir(), "no-such-wasmtime") }),
		).toThrow(/wasmtime_version_floor/);
	});

	it("carries the spawn reason for a binary that does not exist", () => {
		// ENOENT is the actionable half. A refusal that only said "failed"
		// would not distinguish "not installed" from "installed and broken".
		expect(() =>
			createWasmtimeCliEngine({ binPath: join(tmpdir(), "no-such-wasmtime") }),
		).toThrow(/ENOENT/);
	});

	it("refuses a binary that is present but not executable", () => {
		// EACCES rather than ENOENT: a file at the configured path that the
		// process may not run. Distinct cause, same named refusal.
		const dir = mkdtempSync(join(tmpdir(), "hobo-wasmtime-"));
		dirs.push(dir);
		const bin = join(dir, "wasmtime");
		writeFileSync(bin, "#!/usr/bin/env node\n", { mode: 0o644 });
		expect(() => createWasmtimeCliEngine({ binPath: bin })).toThrow(
			/wasmtime_version_floor/,
		);
	});
});

describe("choosing the binary", () => {
	it("prefers an explicit path over the environment", () => {
		// A caller naming a binary means it; an ambient variable is a default,
		// and a default that overrode an explicit argument would make the
		// engine unconfigurable in a shell that happened to export it.
		process.env.HOBO_WASMTIME_BIN = standIn("wasmtime 46.0.0\n");
		expect(engineFor("wasmtime 47.0.0\n").version).toBe("wasmtime@47.0.0");
	});

	it("falls back to HOBO_WASMTIME_BIN", () => {
		// The escape hatch for a machine where wasmtime is not on PATH.
		process.env.HOBO_WASMTIME_BIN = standIn("wasmtime 46.0.1\n");
		expect(createWasmtimeCliEngine().version).toBe("wasmtime@46.0.1");
	});

	it("falls back to `wasmtime` on PATH when neither is set", () => {
		// No wasmtime is installed here, so this asserts the *fallback*, not a
		// successful launch: it must look for a bare `wasmtime` and refuse by
		// the same named error rather than crashing on an undefined path.
		delete process.env.HOBO_WASMTIME_BIN;
		expect(() => createWasmtimeCliEngine()).toThrow(/wasmtime_version_floor/);
	});
});

describe("the in-process engine", () => {
	it("needs no binary at all", () => {
		// It resolves a descriptor into an instance shape rather than running
		// wasm, so gating it on an install it never invokes would make the
		// local dev loop depend on something it does not use.
		expect(createInProcessWasmtimeEngine().kind).toBe("wasmtime");
	});

	it("reports the pinned version by default", () => {
		expect(createInProcessWasmtimeEngine().version).toBe("wasmtime@46.0.1");
	});

	it("accepts a version label", () => {
		expect(
			createInProcessWasmtimeEngine({ version: "wasmtime@99.0.0" }).version,
		).toBe("wasmtime@99.0.0");
	});

	it("is frozen, so an instantiated engine cannot be re-pointed", () => {
		// The engine is evidence about what will run components. A caller that
		// could rewrite `version` after the floor check would defeat the check.
		const engine = createInProcessWasmtimeEngine();
		expect(Object.isFrozen(engine)).toBe(true);
	});

	it("carries the descriptor's id, imports and exports onto the instance", () => {
		const instance = createInProcessWasmtimeEngine().instantiate({
			id: "api",
			imports: ["wasi:keyvalue/store@0.2.0"],
			exports: { "wasi:http/handler@0.2.0": {} },
			// SAFETY: the engine reads exactly the fields a descriptor names.
		} as never);
		expect(instance.id).toBe("api");
		expect(instance.imports).toStrictEqual(["wasi:keyvalue/store@0.2.0"]);
	});

	it("copies the imports rather than aliasing the descriptor's array", () => {
		// A shared array would let a later mutation of the descriptor change
		// what an already-instantiated component claims to import.
		const descriptor = {
			id: "api",
			imports: ["wasi:keyvalue/store@0.2.0"],
			exports: {},
		};
		// SAFETY: the engine reads exactly the fields a descriptor names.
		const instance = createInProcessWasmtimeEngine().instantiate(
			descriptor as never,
		);
		descriptor.imports.push("wasi:blobstore/blobstore@0.2.0");
		expect(instance.imports).toHaveLength(1);
	});
});

describe("the harness itself", () => {
	it("runs the stand-in through the engine's own spawnSync", () => {
		// Guards the technique: if PATH were replaced wholesale the shebang
		// could not find node, and every test above would pass for the wrong
		// reason — a binary that never ran looks the same as one that failed.
		const bin = standIn("wasmtime 46.0.1\n");
		expect(dirname(bin)).toMatch(/hobo-wasmtime-/);
		expect(createWasmtimeCliEngine({ binPath: bin }).version).toBe(
			"wasmtime@46.0.1",
		);
	});
});
