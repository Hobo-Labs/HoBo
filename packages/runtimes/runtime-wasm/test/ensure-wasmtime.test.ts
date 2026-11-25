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
		const home = defaultHoboHome({});
		expect(typeof home).toBe("string");
		expect(home.length).toBeGreaterThan(0);
		expect(defaultHoboHome({})).toBe(home);
	});
});

describe("applyHoboMeshEnvHeaders", () => {
	it("adds one lowercased header per key plus a JSON map", () => {
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
		expect(await accepts(PINNED_WASMTIME_VERSION)).toBe(true);
	});

	it("accepts a higher major version", async () => {
		expect(await accepts("999.0.0")).toBe(true);
	});

	it("rejects a lower major version", async () => {
		expect(await accepts("1.0.0")).toBe(false);
	});

	it("compares numerically, not lexically", async () => {
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
		const [major = "0"] = PINNED_WASMTIME_VERSION.split(".");
		expect(await accepts(`${Number(major) + 1}.0`)).toBe(false);
	});
});
