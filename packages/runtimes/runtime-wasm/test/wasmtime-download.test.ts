/**
 * The automatic download: what happens when no wasmtime is anywhere to be found.
 *
 * `ensure-wasmtime.test.ts` covers resolution — the four places a binary can
 * come from and the version floor each is held to. Every one of its tests
 * passes `download: false`, so the entire fetch-and-install path below that
 * fallthrough was unexercised. It is the part that runs `curl`, unpacks an
 * archive, and writes an executable into the user's HOBO_HOME, which makes it
 * the part where a silent failure is least acceptable: a half-installed
 * wasmtime is worse than none, because the next run finds it and trusts it.
 *
 * `spawnSync` is not injectable here — the same constraint the resolution
 * tests hit — so these put fake `curl` and `tar` executables on PATH and let
 * the real spawn find them. That exercises the actual argv the module passes,
 * which a mock would only assert about. The fake `tar` derives the extracted
 * directory name from the archive filename it is handed, exactly as the real
 * one would, so a change to the naming convention breaks these tests rather
 * than sliding past them.
 *
 * **The install is atomic on purpose.** It writes to a unique sibling temp file
 * and renames over the target, because parallel `hobo dev` and `hobo yard
 * ensure` runs must never observe a partially written binary. The rename is
 * checked here by its observable consequence: what lands at the target path is
 * executable and answers `--version`, and no `.tmp` leftovers remain.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	ensureWasmtimeBinary,
	PINNED_WASMTIME_VERSION,
} from "../src/sandbox.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-wasmtime-dl-"));
	dirs.push(dir);
	return dir;
}

function script(path: string, body: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
	chmodSync(path, 0o755);
	return path;
}

/** A wasmtime stand-in that answers `--version`. */
const WASMTIME_BODY = `process.stdout.write("wasmtime ${PINNED_WASMTIME_VERSION} (abc123)\\n");`;

/**
 * A fake `curl` that writes the file it was asked for.
 *
 * argv is `-fsSL -o <archivePath> <url>`, so the output path is read out of
 * argv rather than guessed — if the module ever stops passing `-o`, this fake
 * writes nothing and the test fails, which is the point.
 */
function fakeCurl(dir: string, options: { fails?: boolean } = {}): void {
	script(
		join(dir, "curl"),
		options.fails
			? `process.stderr.write("could not resolve host\\n");process.exit(7);`
			: `const a=process.argv.slice(2);const o=a[a.indexOf("-o")+1];
require("node:fs").writeFileSync(o,"archive-bytes");`,
	);
}

/**
 * A fake `tar` that creates what the real one would.
 *
 * argv is `-xJf <archivePath> -C <staging>`. The extracted directory name is
 * derived from the archive's own filename, the same convention the module
 * relies on when it looks for the binary afterwards.
 */
function fakeTar(
	dir: string,
	options: {
		fails?: boolean;
		omitBinary?: boolean;
		brokenBinary?: boolean;
	} = {},
): void {
	if (options.fails) {
		script(
			join(dir, "tar"),
			`process.stderr.write("unexpected EOF\\n");process.exit(2);`,
		);
		return;
	}
	// The payload is written to disk here and merely copied by the fake `tar`.
	// Embedding it in the fake's source would mean escaping a script inside a
	// script inside a template literal, which is how the first version of this
	// file silently produced a mangled binary that failed `--version` for
	// reasons that had nothing to do with the code under test.
	const payload = options.omitBinary
		? undefined
		: script(
				join(dir, "payload-wasmtime"),
				options.brokenBinary ? "process.exit(1);" : WASMTIME_BODY,
			);
	script(
		join(dir, "tar"),
		`const fs=require("node:fs"),p=require("node:path");
const a=process.argv.slice(2);
const archive=a[a.indexOf("-xJf")+1];
const staging=a[a.indexOf("-C")+1];
const name=p.basename(archive).replace(/\\.tar\\.xz$/u,"");
const out=p.join(staging,name);
fs.mkdirSync(out,{recursive:true});
const payload=${JSON.stringify(payload ?? null)};
if(payload){const t=p.join(out,"wasmtime");fs.copyFileSync(payload,t);fs.chmodSync(t,0o755);}`,
	);
}

/**
 * Runs with PATH holding only the fake tools and node.
 *
 * Both halves matter: the fakes have to be findable, and a real wasmtime on the
 * developer's PATH has to not be — otherwise the PATH probe short-circuits
 * ahead of the download and these tests silently stop testing anything.
 */
async function withTools<T>(dir: string, run: () => Promise<T>): Promise<T> {
	const saved = process.env.PATH;
	process.env.PATH = `${dir}:${dirname(process.execPath)}`;
	try {
		return await run();
	} finally {
		if (saved === undefined) delete process.env.PATH;
		else process.env.PATH = saved;
	}
}

/** Runs with `process.platform` reported as `value`. */
function withPlatform<T>(value: string, run: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
	try {
		return run();
	} finally {
		if (descriptor) Object.defineProperty(process, "platform", descriptor);
	}
}

const toolsPath = (home: string) => join(home, "tools", "wasmtime");

describe("platforms the download does not cover", () => {
	it("refuses on windows with an actionable remedy", async () => {
		// There is no wasmtime tarball for this triple at the URL the module
		// builds, so downloading would fail with a 404 from curl rather than
		// with anything an operator could act on. Refusing early names both ways
		// out: install it yourself and set HOBO_WASMTIME_BIN, or run the ensure
		// on a platform that is covered.
		const tools = scratch();
		await withTools(tools, async () => {
			const promise = withPlatform("win32", () =>
				ensureWasmtimeBinary({ hoboHome: scratch(), env: {} }),
			);
			await expect(promise).rejects.toThrow(/unsupported for .*-windows/u);
			await expect(promise).rejects.toThrow(/HOBO_WASMTIME_BIN/u);
		});
	});

	it("names the triple it could not serve", async () => {
		// So the operator can tell a genuinely unsupported platform from a
		// mis-detected one.
		const tools = scratch();
		await withTools(tools, async () => {
			await expect(
				withPlatform("sunos", () =>
					ensureWasmtimeBinary({ hoboHome: scratch(), env: {} }),
				),
			).rejects.toThrow(/-sunos/u);
		});
	});
});

describe("when the fetch fails", () => {
	it("reports the URL and curl's own output", async () => {
		// A download failure is usually a proxy or an offline runner, and the
		// operator needs the URL to test it by hand. Swallowing curl's stderr
		// would reduce every one of those to "download failed".
		const tools = scratch();
		fakeCurl(tools, { fails: true });
		fakeTar(tools);
		await withTools(tools, async () => {
			const promise = ensureWasmtimeBinary({ hoboHome: scratch(), env: {} });
			await expect(promise).rejects.toThrow(/failed to download wasmtime/u);
			await expect(promise).rejects.toThrow(/could not resolve host/u);
			await expect(promise).rejects.toThrow(
				new RegExp(`releases/download/v${PINNED_WASMTIME_VERSION}`, "u"),
			);
		});
	});

	it("installs nothing", async () => {
		// The failure must leave HOBO_HOME as it found it. A truncated binary at
		// the target path would be picked up and trusted by the next run.
		const tools = scratch();
		const home = scratch();
		fakeCurl(tools, { fails: true });
		fakeTar(tools);
		await withTools(tools, async () => {
			await expect(
				ensureWasmtimeBinary({ hoboHome: home, env: {} }),
			).rejects.toThrow();
		});
		expect(existsSync(toolsPath(home))).toBe(false);
	});
});

describe("when the archive will not extract", () => {
	it("reports tar's error", async () => {
		const tools = scratch();
		fakeCurl(tools);
		fakeTar(tools, { fails: true });
		await withTools(tools, async () => {
			const promise = ensureWasmtimeBinary({ hoboHome: scratch(), env: {} });
			await expect(promise).rejects.toThrow(/failed to extract/u);
			await expect(promise).rejects.toThrow(/unexpected EOF/u);
		});
	});
});

describe("when the archive extracts but holds no binary", () => {
	it("refuses and names the path it looked at", async () => {
		// Distinct from an extract failure: tar succeeded, so the archive was
		// well-formed but laid out differently than expected. Naming the path is
		// what makes an upstream layout change diagnosable rather than a mystery.
		const tools = scratch();
		fakeCurl(tools);
		fakeTar(tools, { omitBinary: true });
		await withTools(tools, async () => {
			await expect(
				ensureWasmtimeBinary({ hoboHome: scratch(), env: {} }),
			).rejects.toThrow(/wasmtime binary missing after extract/u);
		});
	});
});

describe("when the downloaded binary will not run", () => {
	it("refuses rather than reporting a successful install", async () => {
		// Everything mechanical succeeded and the file is on disk; it just is not
		// a working wasmtime. Returning success here would hand back a binPath
		// that fails at the first component invocation instead of at ensure time.
		const tools = scratch();
		fakeCurl(tools);
		fakeTar(tools, { brokenBinary: true });
		await withTools(tools, async () => {
			await expect(
				ensureWasmtimeBinary({ hoboHome: scratch(), env: {} }),
			).rejects.toThrow(/failed --version/u);
		});
	});
});

describe("a successful download", () => {
	async function install() {
		const tools = scratch();
		const home = scratch();
		const progress: string[] = [];
		fakeCurl(tools);
		fakeTar(tools);
		const resolved = await withTools(tools, () =>
			ensureWasmtimeBinary({
				hoboHome: home,
				env: {},
				emitProgress: (message) => progress.push(message),
			}),
		);
		return { resolved, home, progress };
	}

	it("reports the managed path and the downloaded source", async () => {
		const { resolved, home } = await install();
		expect(resolved.source).toBe("downloaded");
		expect(resolved.binPath).toBe(toolsPath(home));
		expect(resolved.version).toBe(PINNED_WASMTIME_VERSION);
	});

	it("leaves an executable binary at the managed path", async () => {
		// Mode matters: a downloaded file is not executable by default, and a
		// non-executable wasmtime fails at spawn with EACCES rather than
		// anything that names the cause.
		const { home } = await install();
		expect(statSync(toolsPath(home)).mode & 0o111).toBeGreaterThan(0);
	});

	it("leaves no partial temp file behind", async () => {
		// The install writes to a unique sibling and renames over the target. A
		// leftover `.tmp` would mean the rename did not happen and something else
		// put the binary there.
		const { home } = await install();
		expect(
			readdirSync(join(home, "tools")).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});

	it("is resolved directly on the next call, without downloading again", async () => {
		// The whole point of installing into HOBO_HOME. If the second call
		// downloaded again, every command would pay for it — and here it would
		// fail outright, because this runs with no fake curl on PATH.
		const { home } = await install();
		const second = await ensureWasmtimeBinary({ hoboHome: home, env: {} });
		expect(second.source).toBe("tools");
	});

	it("announces the download and the install", async () => {
		// `hobo yard ensure` fetching ~40MB looks like a hang without it.
		const { progress } = await install();
		expect(progress.some((line) => /downloading wasmtime/u.test(line))).toBe(
			true,
		);
		expect(progress.some((line) => /ready at/u.test(line))).toBe(true);
	});

	it("does not require a progress callback", async () => {
		// It defaults to a no-op; a caller that omits it must not crash on the
		// first emit.
		const tools = scratch();
		fakeCurl(tools);
		fakeTar(tools);
		const resolved = await withTools(tools, () =>
			ensureWasmtimeBinary({ hoboHome: scratch(), env: {} }),
		);
		expect(resolved.source).toBe("downloaded");
	});
});
