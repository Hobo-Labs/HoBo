import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServePrivateContext } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";

import { createWasmRuntimeHost } from "../src/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "hobo-wasm-host-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function context(
	overrides: Partial<ServePrivateContext> = {},
): Promise<ServePrivateContext> {
	return {
		hoboHome: await scratch(),
		projectDir: await scratch(),
		privateComponents: [],
		...overrides,
	};
}

const TIMEOUT = 180_000;

describe("serving with nothing declared", () => {
	it(
		"returns an empty handler map rather than refusing",
		async () => {
			const result = await createWasmRuntimeHost().servePrivate(
				await context(),
			);
			cleanups.push(() => result.close?.() ?? Promise.resolve());
			expect(result.kind).toBe("wasm");
			expect(result.handlers.size).toBe(0);
		},
		TIMEOUT,
	);

	it(
		"reports the isolate boundary and a zero sandbox count",
		async () => {
			const result = await createWasmRuntimeHost().servePrivate(
				await context(),
			);
			cleanups.push(() => result.close?.() ?? Promise.resolve());
			expect(result.isolation?.isolateBoundary).toBe("wasmtime_process");
			expect(result.isolation?.privateSandboxes).toBe(0);
			expect(result.isolation?.details?.dependencyCount).toBe(0);
		},
		TIMEOUT,
	);

	it(
		"closes cleanly with nothing to terminate",
		async () => {
			const result = await createWasmRuntimeHost().servePrivate(
				await context(),
			);
			await expect(result.close?.()).resolves.not.toThrow();
		},
		TIMEOUT,
	);

	it(
		"does not require a progress callback",
		async () => {
			const result = await createWasmRuntimeHost().servePrivate(
				await context(),
			);
			cleanups.push(() => result.close?.() ?? Promise.resolve());
			expect(result.kind).toBe("wasm");
		},
		TIMEOUT,
	);
});

describe("a wasm dependency whose source is missing", () => {
	async function resolvedPathFor(
		source: string,
		projectDir: string,
	): Promise<string> {
		const host = createWasmRuntimeHost({
			wasmDependencies: [{ resourceName: "cache", source }],
		});
		try {
			await host.servePrivate(await context({ projectDir }));
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			const { message } = error;
			expect(message).toMatch(/wasm dependency 'cache' source not found/u);
			return message.slice(message.lastIndexOf(": ") + 2);
		}
		throw new Error(`serving ${source} should have been refused`);
	}

	it(
		"refuses before booting anything, naming the resource",
		async () => {
			const host = createWasmRuntimeHost({
				wasmDependencies: [
					{ resourceName: "cache", source: "does-not-exist.wasm" },
				],
			});
			await expect(host.servePrivate(await context())).rejects.toThrow(
				/wasm dependency 'cache' source not found/u,
			);
		},
		TIMEOUT,
	);

	it(
		"resolves a relative source against the project directory",
		async () => {
			const projectDir = await scratch();
			expect(await resolvedPathFor("build/cache.wasm", projectDir)).toBe(
				join(projectDir, "build", "cache.wasm"),
			);
		},
		TIMEOUT,
	);

	it(
		"uses an absolute source as given",
		async () => {
			expect(
				await resolvedPathFor("/opt/wasm/cache.wasm", await scratch()),
			).toBe("/opt/wasm/cache.wasm");
		},
		TIMEOUT,
	);

	it(
		"strips a file:// prefix rather than treating it as a relative path",
		async () => {
			expect(
				await resolvedPathFor("file:///opt/wasm/cache.wasm", await scratch()),
			).toBe("/opt/wasm/cache.wasm");
		},
		TIMEOUT,
	);
});
