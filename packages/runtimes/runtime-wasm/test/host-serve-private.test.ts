/**
 * The Camp host adapter: what `servePrivate` does before it boots anything.
 *
 * `host.test.ts` covers the adapter's identity and `ensure`. This covers the
 * front half of `servePrivate` — resolving and checking declared wasm
 * dependencies — which runs before any sandbox is started and is where a
 * misconfigured bindle is supposed to be caught.
 *
 * **The check exists so the failure names the bindle, not wasmtime.** A
 * `b.wasmComponent(...)` pointing at a path that is not there would otherwise
 * reach `bootWasmtimeSandbox` and fail somewhere inside a spawned process, with
 * an error about a module wasmtime could not load. The `existsSync` gate turns
 * that into a refusal naming the resource and the path it resolved to, which is
 * the difference between "fix your bindle" and "debug the runtime".
 *
 * **Path resolution is tested through that refusal.** `resolveWasmSource` is
 * private, but the path it produces is interpolated into the error message, so
 * the three cases it distinguishes — absolute, `file:` URL, project-relative —
 * are observable without reaching past the port for a helper.
 *
 * These need a real toolchain because the dependency loop runs after
 * `ensureIsolatedWasmToolchain`; the suite's globalSetup warms one, so the
 * cost is a probe rather than a download. None of them boots a sandbox: every
 * case either refuses before the first boot or declares nothing to boot.
 */
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

/** A serve context with nothing to serve, in a throwaway project + home. */
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
			// A bindle with no private components and no wasm dependencies is a
			// legitimate configuration — the Camp may be serving everything from
			// another host. Refusing here would make the wasm host unusable
			// alongside others.
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
			// The isolation record is what the Camp reports as its actual posture.
			// It has to be truthful when nothing was booted: claiming a boundary
			// while running no sandboxes is the shape of an overstated guarantee.
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
			// `close` awaits a terminate per sandbox; over an empty list that must
			// resolve rather than reject on `Promise.all` of nothing.
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
			// `ctx.emitProgress ?? (() => {})` — the toolchain ensure emits into it
			// unconditionally, so a caller omitting it must not crash on the first
			// message. The context below names no `emitProgress` at all.
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
	/**
	 * Serves one declared dependency and returns the path named in the refusal.
	 *
	 * The message is `... source not found: <path>`, so the resolved path is
	 * everything after the last ": ". Returning it rather than matching a regex
	 * against the whole message is what lets the cases below assert on the
	 * *whole* path: `join(projectDir, "/opt/wasm/cache.wasm")` still ends with
	 * "/opt/wasm/cache.wasm", so an "ends with" check cannot tell a correctly
	 * passed-through absolute path from a wrongly joined one.
	 */
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
			// Named, because a bindle may declare several dependencies and the
			// operator needs to know which one is wrong.
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
			// Relative paths in a bindle are relative to the project, not to
			// whatever directory the Camp process happens to be running in.
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
			// An absolute path is already an answer; joining it onto the project
			// dir would produce a nonsense path and a confusing error.
			expect(
				await resolvedPathFor("/opt/wasm/cache.wasm", await scratch()),
			).toBe("/opt/wasm/cache.wasm");
		},
		TIMEOUT,
	);

	it(
		"strips a file:// prefix rather than treating it as a relative path",
		async () => {
			// `file:///opt/...` is how a URL-shaped source arrives. Left intact it
			// would be neither absolute nor a real path, and joining it onto the
			// project dir would bury the mistake.
			expect(
				await resolvedPathFor("file:///opt/wasm/cache.wasm", await scratch()),
			).toBe("/opt/wasm/cache.wasm");
		},
		TIMEOUT,
	);
});
