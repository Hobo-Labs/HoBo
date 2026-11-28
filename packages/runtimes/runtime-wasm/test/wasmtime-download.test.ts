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

const WASMTIME_BODY = `process.stdout.write("wasmtime ${PINNED_WASMTIME_VERSION} (abc123)\\n");`;

function fakeCurl(dir: string, options: { fails?: boolean } = {}): void {
	script(
		join(dir, "curl"),
		options.fails
			? `process.stderr.write("could not resolve host\\n");process.exit(7);`
			: `const a=process.argv.slice(2);const o=a[a.indexOf("-o")+1];
require("node:fs").writeFileSync(o,"archive-bytes");`,
	);
}

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
		const { home } = await install();
		expect(statSync(toolsPath(home)).mode & 0o111).toBeGreaterThan(0);
	});

	it("leaves no partial temp file behind", async () => {
		const { home } = await install();
		expect(
			readdirSync(join(home, "tools")).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});

	it("is resolved directly on the next call, without downloading again", async () => {
		const { home } = await install();
		const second = await ensureWasmtimeBinary({ hoboHome: home, env: {} });
		expect(second.source).toBe("tools");
	});

	it("announces the download and the install", async () => {
		const { progress } = await install();
		expect(progress.some((line) => /downloading wasmtime/u.test(line))).toBe(
			true,
		);
		expect(progress.some((line) => /ready at/u.test(line))).toBe(true);
	});

	it("does not require a progress callback", async () => {
		const tools = scratch();
		fakeCurl(tools);
		fakeTar(tools);
		const resolved = await withTools(tools, () =>
			ensureWasmtimeBinary({ hoboHome: scratch(), env: {} }),
		);
		expect(resolved.source).toBe("downloaded");
	});
});
