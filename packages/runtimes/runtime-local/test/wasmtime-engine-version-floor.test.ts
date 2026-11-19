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
		expect(engineFor("wasmtime 46.0.1\n").version).toBe("wasmtime@46.0.1");
	});

	it("accepts a higher patch", () => {
		expect(engineFor("wasmtime 46.0.2\n").version).toBe("wasmtime@46.0.2");
	});

	it("accepts a higher minor even with a lower patch", () => {
		expect(engineFor("wasmtime 46.1.0\n").version).toBe("wasmtime@46.1.0");
	});

	it("accepts a higher major even with a lower minor and patch", () => {
		expect(engineFor("wasmtime 47.0.0\n").version).toBe("wasmtime@47.0.0");
	});

	it("finds the version inside a longer banner", () => {
		expect(
			engineFor("wasmtime-cli 46.0.1 (abc1234 2026-01-01)\n").version,
		).toBe("wasmtime@46.0.1");
	});

	it("reports the version it found, not the one it was configured with", () => {
		expect(engineFor("wasmtime 49.2.3\n").version).toBe("wasmtime@49.2.3");
	});
});

describe("versions the floor refuses", () => {
	it("refuses a lower patch", () => {
		expect(() => engineFor("wasmtime 46.0.0\n")).toThrow(ComponentHostError);
	});

	it("refuses a lower minor", () => {
		expect(() => engineFor("wasmtime 45.9.9\n")).toThrow(
			/wasmtime_version_floor/,
		);
	});

	it("names both the version it found and the floor it wanted", () => {
		expect(() => engineFor("wasmtime 45.9.9\n")).toThrow(/45\.9\.9.*46\.0\.1/);
	});
});

describe("binaries that cannot report a version", () => {
	it("refuses one that exits non-zero", () => {
		expect(() => engineFor("", 1, "not a wasmtime\n")).toThrow(
			/wasmtime_version_floor/,
		);
	});

	it("carries the binary's own stderr into the refusal", () => {
		expect(() => engineFor("", 1, "libssl.so.3: not found\n")).toThrow(
			/libssl\.so\.3/,
		);
	});

	it("still refuses when the failing binary said nothing at all", () => {
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
		expect(() => engineFor("wasmtime 46.0\n")).toThrow(/unparseable version/);
	});

	it("refuses a binary that does not exist", () => {
		expect(() =>
			createWasmtimeCliEngine({ binPath: join(tmpdir(), "no-such-wasmtime") }),
		).toThrow(/wasmtime_version_floor/);
	});

	it("carries the spawn reason for a binary that does not exist", () => {
		expect(() =>
			createWasmtimeCliEngine({ binPath: join(tmpdir(), "no-such-wasmtime") }),
		).toThrow(/ENOENT/);
	});

	it("refuses a binary that is present but not executable", () => {
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
		process.env.HOBO_WASMTIME_BIN = standIn("wasmtime 46.0.0\n");
		expect(engineFor("wasmtime 47.0.0\n").version).toBe("wasmtime@47.0.0");
	});

	it("falls back to HOBO_WASMTIME_BIN", () => {
		process.env.HOBO_WASMTIME_BIN = standIn("wasmtime 46.0.1\n");
		expect(createWasmtimeCliEngine().version).toBe("wasmtime@46.0.1");
	});

	it("falls back to `wasmtime` on PATH when neither is set", () => {
		delete process.env.HOBO_WASMTIME_BIN;
		expect(() => createWasmtimeCliEngine()).toThrow(/wasmtime_version_floor/);
	});
});

describe("the in-process engine", () => {
	it("needs no binary at all", () => {
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
		const engine = createInProcessWasmtimeEngine();
		expect(Object.isFrozen(engine)).toBe(true);
	});

	it("carries the descriptor's id, imports and exports onto the instance", () => {
		const instance = createInProcessWasmtimeEngine().instantiate({
			id: "api",
			imports: ["wasi:keyvalue/store@0.2.0"],
			exports: { "wasi:http/handler@0.2.0": {} },
		} as never);
		expect(instance.id).toBe("api");
		expect(instance.imports).toStrictEqual(["wasi:keyvalue/store@0.2.0"]);
	});

	it("copies the imports rather than aliasing the descriptor's array", () => {
		const descriptor = {
			id: "api",
			imports: ["wasi:keyvalue/store@0.2.0"],
			exports: {},
		};
		const instance = createInProcessWasmtimeEngine().instantiate(
			descriptor as never,
		);
		descriptor.imports.push("wasi:blobstore/blobstore@0.2.0");
		expect(instance.imports).toHaveLength(1);
	});
});

describe("the harness itself", () => {
	it("runs the stand-in through the engine's own spawnSync", () => {
		const bin = standIn("wasmtime 46.0.1\n");
		expect(dirname(bin)).toMatch(/hobo-wasmtime-/);
		expect(createWasmtimeCliEngine({ binPath: bin }).version).toBe(
			"wasmtime@46.0.1",
		);
	});
});
