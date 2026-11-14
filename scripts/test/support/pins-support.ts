/**
 * Shared fixtures for the sibling-pin tests: scratch directories, manifests,
 * the real script run as a child process, and a loopback HTTP server that
 * counts requests. The git fixtures are `pins-git-support.ts`, re-exported here.
 *
 * Nothing here touches the network beyond 127.0.0.1, the user's git
 * configuration, or the real `external/ts-autocode` submodule.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

import { PINS_FILE, parsePins } from "../../lib/pins.ts";
import { overrideEnv } from "../../lib/pins-assets.ts";
import { type GitConfig, gitEnv } from "./pins-git-support.ts";

export * from "./pins-git-support.ts";

export const SCRIPT = join(REPO_ROOT, "scripts/bootstrap-siblings.mts");

const made: string[] = [];
/** What `mkdtemp` makes of `pins-<label>-`: six random characters. */
const SCRATCH_NAME = /^pins-[a-z-]+-[A-Za-z0-9]{6}$/u;
const STALE_AFTER_MS = 10 * 60_000;

/** Directories an earlier run leaked (a killed one); young ones may be live runs. */
function sweepStale(): void {
	for (const name of readdirSync(tmpdir())) {
		if (!SCRATCH_NAME.test(name)) continue;
		const path = join(tmpdir(), name);
		try {
			const info = statSync(path);
			const mine = info.uid === process.getuid?.();
			if (
				mine &&
				info.isDirectory() &&
				Date.now() - info.mtimeMs > STALE_AFTER_MS
			) {
				rmSync(path, { recursive: true, force: true });
			}
		} catch {
			// Gone already, or not ours to read: leave it.
		}
	}
}

function removeMade(): void {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
}

/**
 * A fresh temp directory that is removed when this process exits. Stale ones
 * left by an earlier run are swept the first time it is called.
 */
export function scratch(label: string): string {
	if (made.length === 0) {
		sweepStale();
		process.once("exit", removeMade);
	}
	const dir = mkdtempSync(join(tmpdir(), `pins-${label}-`));
	made.push(dir);
	return dir;
}

/**
 * Wait for a condition another process makes true (a file with bytes in it).
 * Not a pause: it returns the moment `probe` answers, and says what it was
 * waiting for when it never does.
 */
export async function waitUntil<T>(
	what: string,
	probe: () => T | undefined,
	ms = 10_000,
): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** A root with only a manifest: no git pins, the given `assets` section. */
export function writeManifest(
	root: string,
	assets: string,
	vendor = "{}",
): void {
	mkdirSync(join(root, "tools/pins"), { recursive: true });
	const manifest = {
		schemaVersion: 1,
		git: {},
		assets: JSON.parse(assets),
		vendor: JSON.parse(vendor),
	};
	writeFileSync(
		join(root, "tools/pins/siblings.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
}

export interface ScriptRun {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * The asset names the script and these tests know: the real manifest's and the
 * fixtures' (`kit`, `tool`, `x`). Each one's override variable is one the
 * script reads.
 */
const ASSET_NAMES = [
	...Object.keys(
		parsePins(readFileSync(join(REPO_ROOT, PINS_FILE), "utf8")).assets,
	),
	"kit",
	"tool",
	"x",
];

/**
 * What the script reads to decide that it is in CI and that an override is
 * set or allowed (`refuseOverridesInCi`, `statusAsset`). A GitHub-hosted
 * runner sets `CI` and `GITHUB_ACTIONS`, so a child that inherits them sees
 * CI whatever the test meant; none of these reach the child unless the test
 * sets it.
 */
export const AMBIENT_PINS_ENV: readonly string[] = [
	"CI",
	"GITHUB_ACTIONS",
	"TF_BUILD",
	"HOBO_PINS_ALLOW_OVERRIDE",
	...new Set(ASSET_NAMES.map(overrideEnv)),
];

/** The argv (after `node`) and environment `runBootstrap` runs the script with. */
export function scriptCall(
	root: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	more: GitConfig,
) {
	const base = gitEnv(
		{
			NODE_NO_WARNINGS: "1",
			HOME: join(root, ".home"),
			XDG_CACHE_HOME: join(root, ".cache"),
			HOBO_PINS_ALLOW_LOCAL: "1",
		},
		more,
	);
	for (const name of AMBIENT_PINS_ENV) delete base[name];
	return {
		argv: ["--experimental-strip-types", SCRIPT, "--root", root, ...args],
		env: { ...base, ...env },
	};
}

/** Runs the real script under Node's native type stripping, no loader. */
export function runBootstrap(
	root: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
	more: GitConfig = [],
): ScriptRun {
	const call = scriptCall(root, args, env, more);
	const result = spawnSync(process.execPath, call.argv, {
		cwd: root,
		encoding: "utf8",
		env: call.env,
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

/**
 * The same, without blocking this process: a test that serves the script's
 * downloads from an in-process HTTP server must not freeze its own event loop.
 */
export async function runBootstrapAsync(
	root: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
): Promise<ScriptRun> {
	return await spawnBootstrap(root, args, env).done;
}

export interface RunningScript {
	readonly child: ChildProcess;
	/** Resolves when the script ends, by exit or by signal. */
	readonly done: Promise<
		ScriptRun & { readonly signal: NodeJS.Signals | null }
	>;
}

/** The script as a child the test can signal; `runBootstrapAsync` is this, awaited. */
export function spawnBootstrap(
	root: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
): RunningScript {
	const call = scriptCall(root, args, env, []);
	const child = spawn(process.execPath, call.argv, {
		cwd: root,
		env: call.env,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const done = new Promise<ScriptRun & { signal: NodeJS.Signals | null }>(
		(resolve, reject) => {
			child.on("error", reject);
			child.on("close", (status, signal) =>
				resolve({ status, signal, stdout, stderr }),
			);
		},
	);
	return { child, done };
}

export interface FileServer {
	readonly origin: string;
	/** `METHOD path` of every request, in order. */
	readonly hits: string[];
	setFile(path: string, bytes: Uint8Array | string): void;
	setRedirect(path: string, location: string): void;
	/** Answer `path` with `first` and then stall: the declared length is `total`, the rest never comes. */
	setStall(path: string, first: Uint8Array | string, total: number): void;
	/** Accept the request for `path` and never answer it, not even with headers. */
	setHang(path: string): void;
	/** Answer `path` with `first`, hold the rest until `release()`, then send `rest`. */
	setGate(
		path: string,
		first: Uint8Array | string,
		rest: Uint8Array | string,
	): { release(): void };
	/** Resolves once a request for `path` has reached the server. */
	requested(path: string): Promise<void>;
	close(): Promise<void>;
}

/** Loopback HTTP server over an in-memory file table. */
export async function startServer(): Promise<FileServer> {
	const files = new Map<string, Uint8Array>();
	const redirects = new Map<string, string>();
	const stalls = new Map<string, { first: Uint8Array; total: number }>();
	const hangs = new Set<string>();
	const gates = new Map<
		string,
		{ first: Uint8Array; rest: Uint8Array; open: Promise<void> }
	>();
	const waiting = new Map<string, (() => void)[]>();
	const hits: string[] = [];
	const server = createServer(
		(request: IncomingMessage, response: ServerResponse) => {
			const path = request.url ?? "/";
			hits.push(`${request.method ?? "GET"} ${path}`);
			for (const wake of waiting.get(path) ?? []) wake();
			if (hangs.has(path)) return;
			const gate = gates.get(path);
			if (gate !== undefined) {
				response.writeHead(200, {
					"content-length": String(
						gate.first.byteLength + gate.rest.byteLength,
					),
				});
				response.write(gate.first);
				void gate.open.then(() => response.end(gate.rest));
				return;
			}
			const location = redirects.get(path);
			if (location !== undefined) {
				response.writeHead(302, { location });
				response.end();
				return;
			}
			const stall = stalls.get(path);
			if (stall !== undefined) {
				response.writeHead(200, { "content-length": String(stall.total) });
				response.write(stall.first);
				return;
			}
			const bytes = files.get(path);
			if (bytes === undefined) {
				response.writeHead(404);
				response.end("not found");
				return;
			}
			response.writeHead(200, { "content-length": String(bytes.byteLength) });
			response.end(bytes);
		},
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	// SAFETY: listen(0, host) binds a TCP socket, so address() is an AddressInfo.
	const { port } = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		hits,
		setFile(path, bytes) {
			files.set(path, bytes instanceof Uint8Array ? bytes : Buffer.from(bytes));
		},
		setRedirect(path, location) {
			redirects.set(path, location);
		},
		setStall(path, first, total) {
			stalls.set(path, {
				first: first instanceof Uint8Array ? first : Buffer.from(first),
				total,
			});
		},
		setHang(path) {
			hangs.add(path);
		},
		setGate(path, first, rest) {
			let release = (): void => undefined;
			const open = new Promise<void>((resolve) => {
				release = resolve;
			});
			const bytes = (value: Uint8Array | string): Uint8Array =>
				value instanceof Uint8Array ? value : Buffer.from(value);
			gates.set(path, { first: bytes(first), rest: bytes(rest), open });
			return { release };
		},
		requested(path) {
			if (hits.some((hit) => hit.endsWith(` ${path}`)))
				return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiting.set(path, [...(waiting.get(path) ?? []), resolve]);
			});
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) =>
					error === undefined ? resolve() : reject(error),
				);
			}),
	};
}
