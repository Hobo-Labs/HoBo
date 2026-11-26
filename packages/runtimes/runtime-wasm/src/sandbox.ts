/**
 * Real Wasmtime OS-process sandboxes for private Camp components.
 *
 * Framework-agnostic (no Hono / Express / etc. in this package):
 *   - Bundles the app module (e.g. `src/api.ts` exporting `{ app }` with `.fetch`)
 *     into a wasi:http/proxy component — no hand-written guest required
 *   - Optional override: prebuilt `dist/wasm/<name>.wasm` or `src/wasm/<name>-guest.mjs`
 *   - HTTP frameworks live in `packages/adapters/*` (e.g. `@hobo/adapter-hono`), never core
 *
 * Driven through HoBo CLI (Yard component host = wasm | isolated-wasm):
 *   - `hobo yard ensure` / `init --host wasm` / `doctor` → toolchain under HOBO_HOME
 *   - Camp mesh injects bindle env on every hop (`x-hobo-env-*` / `x-hobo-bindle-env`)
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonString } from "./json.js";

/** Fetch handler shape shared with Camp mesh. */
export type FetchHandler = (input: Request) => Response | Promise<Response>;

// public-contract: the wasmtime version the isolated-wasm toolchain pins to.
export const PINNED_WASMTIME_VERSION = "46.0.1";

// public-contract: wire prefix for per-key bindle env injected over mesh hops.
export const HOBO_ENV_HEADER_PREFIX = "x-hobo-env-";
// public-contract: wire header carrying the whole bindle env as one JSON map.
export const HOBO_BINDLE_ENV_HEADER = "x-hobo-bindle-env";

export function applyHoboMeshEnvHeaders(
	headers: Headers,
	bindleEnv: Readonly<Record<string, string>>,
): Headers {
	const next = new Headers(headers);
	for (const [key, value] of Object.entries(bindleEnv)) {
		next.set(`${HOBO_ENV_HEADER_PREFIX}${key.toLowerCase()}`, value);
	}
	next.set(HOBO_BINDLE_ENV_HEADER, JSON.stringify(bindleEnv));
	return next;
}

export function defaultHoboHome(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.HOBO_HOME;
	if (isJsonString(fromEnv) && fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".hobo");
}

export interface WasmtimeBinary {
	readonly binPath: string;
	readonly version: string;
	readonly source: "env" | "tools" | "path" | "downloaded";
}

export interface JcoTool {
	readonly binPath: string;
	readonly version: string;
	readonly source: "package";
}

export interface IsolatedWasmToolchain {
	readonly hoboHome: string;
	readonly wasmtime: WasmtimeBinary;
	readonly jco: JcoTool;
	readonly ready: true;
	readonly notes: readonly string[];
}

export interface ComponentizeResult {
	readonly wasmPath: string;
	readonly guestSourcePath: string;
	readonly workDir: string;
	readonly resourceName: string;
}

export interface WasmtimeSandbox {
	readonly resourceName: string;
	readonly pid: number;
	readonly loopbackUrl: string;
	readonly port: number;
	readonly wasmPath: string;
	readonly wasmtimeBin: string;
	readonly isolateBoundary: "wasmtime_process";
	readonly invoke: FetchHandler;
	readonly terminate: () => Promise<void>;
}

function toolsDir(hoboHome: string): string {
	return join(hoboHome, "tools");
}

function platformTriple(): string {
	const arch =
		process.arch === "x64"
			? "x86_64"
			: process.arch === "arm64"
				? "aarch64"
				: process.arch;
	const os =
		process.platform === "linux"
			? "linux"
			: process.platform === "darwin"
				? "macos"
				: process.platform === "win32"
					? "windows"
					: process.platform;
	return `${arch}-${os}`;
}

function parseVersion(output: string): string | null {
	const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
	return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

function tryWasmtime(binPath: string): { version: string } | null {
	if (!existsSync(binPath) && binPath.includes("/")) return null;
	// Parallel test sweeps load the box: the first exec of a freshly written
	// ~40MB binary can exceed one 10s probe. Retry only on spawn timeout —
	// real failures (missing, wrong arch, old version) fail immediately.
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const result = spawnSync(binPath, ["--version"], {
			encoding: "utf8",
			timeout: 15_000,
		});
		if (result.error && result.signal === "SIGTERM") continue;
		if (result.status !== 0) return null;
		const version = parseVersion(result.stdout || result.stderr || "");
		if (!version) return null;
		return { version };
	}
	return null;
}

function meetsFloor(version: string, floor = PINNED_WASMTIME_VERSION): boolean {
	const parts = version.split(".").map((p) => Number.parseInt(p, 10));
	const floorParts = floor.split(".").map((p) => Number.parseInt(p, 10));
	for (let i = 0; i < floorParts.length; i += 1) {
		const current = parts[i] ?? 0;
		const want = floorParts[i] ?? 0;
		if (current > want) return true;
		if (current < want) return false;
	}
	return true;
}

/**
 * Resolve a wasmtime binary meeting the floor version, downloading into
 * `$HOBO_HOME/tools/wasmtime` when needed. Prefer calling
 * {@link ensureIsolatedWasmToolchain} from CLI surfaces.
 */
export async function ensureWasmtimeBinary(
	options: {
		readonly hoboHome?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly binPath?: string;
		readonly download?: boolean;
		readonly emitProgress?: (message: string) => void;
	} = {},
): Promise<WasmtimeBinary> {
	const env = options.env ?? process.env;
	const hoboHome = options.hoboHome ?? defaultHoboHome(env);
	const download = options.download ?? true;
	const emit = options.emitProgress ?? (() => {});

	if (options.binPath) {
		const probed = tryWasmtime(options.binPath);
		if (probed && meetsFloor(probed.version)) {
			return {
				binPath: options.binPath,
				version: probed.version,
				source: "env",
			};
		}
		throw new Error(
			`HOBO_WASMTIME_BIN=${options.binPath} is missing or below ${PINNED_WASMTIME_VERSION}`,
		);
	}

	const fromEnv = env.HOBO_WASMTIME_BIN;
	if (isJsonString(fromEnv) && fromEnv.length > 0) {
		const probed = tryWasmtime(fromEnv);
		if (probed && meetsFloor(probed.version)) {
			return { binPath: fromEnv, version: probed.version, source: "env" };
		}
	}

	const toolsPath = join(toolsDir(hoboHome), "wasmtime");
	const toolsProbe = tryWasmtime(toolsPath);
	if (toolsProbe && meetsFloor(toolsProbe.version)) {
		return {
			binPath: toolsPath,
			version: toolsProbe.version,
			source: "tools",
		};
	}

	const pathProbe = tryWasmtime("wasmtime");
	if (pathProbe && meetsFloor(pathProbe.version)) {
		return {
			binPath: "wasmtime",
			version: pathProbe.version,
			source: "path",
		};
	}

	if (!download) {
		throw new Error(
			`wasmtime >= ${PINNED_WASMTIME_VERSION} not found; run \`hobo yard ensure\` (or \`hobo yard init --host isolated-wasm\`)`,
		);
	}

	const triple = platformTriple();
	if (!triple.endsWith("-linux") && !triple.endsWith("-macos")) {
		throw new Error(
			`automatic wasmtime download unsupported for ${triple}; install wasmtime ${PINNED_WASMTIME_VERSION} and set HOBO_WASMTIME_BIN, or run hobo yard ensure on linux/macos`,
		);
	}

	const version = PINNED_WASMTIME_VERSION;
	const archiveName = `wasmtime-v${version}-${triple}.tar.xz`;
	const url = `https://github.com/bytecodealliance/wasmtime/releases/download/v${version}/${archiveName}`;
	// Unique staging dir per call (vitest runs concurrent ensures in one PID).
	const staging = join(
		tmpdir(),
		`hobo-wasmtime-${version}-${process.pid}-${randomUUID()}`,
	);
	mkdirSync(staging, { recursive: true });
	const archivePath = join(staging, archiveName);

	emit(
		`hobo: downloading wasmtime ${version} (${triple}) into ${toolsDir(hoboHome)}`,
	);
	const curl = spawnSync("curl", ["-fsSL", "-o", archivePath, url], {
		encoding: "utf8",
		timeout: 120_000,
	});
	if (curl.status !== 0) {
		throw new Error(
			`failed to download wasmtime ${version} from ${url}: ${curl.stderr || curl.stdout}`,
		);
	}

	const tar = spawnSync("tar", ["-xJf", archivePath, "-C", staging], {
		encoding: "utf8",
		timeout: 60_000,
	});
	if (tar.status !== 0) {
		throw new Error(`failed to extract wasmtime archive: ${tar.stderr}`);
	}

	const extracted = join(staging, `wasmtime-v${version}-${triple}`, "wasmtime");
	if (!existsSync(extracted)) {
		throw new Error(`wasmtime binary missing after extract: ${extracted}`);
	}

	mkdirSync(toolsDir(hoboHome), { recursive: true });
	// Atomic install: concurrent ensures (parallel test sweeps, `hobo dev` +
	// `hobo yard ensure`) must never observe a partially written binary.
	// Write to a unique sibling temp file, then rename over the target.
	const tmpTarget = join(
		toolsDir(hoboHome),
		`.wasmtime-${process.pid}-${randomUUID()}.tmp`,
	);
	writeFileSync(tmpTarget, readFileSync(extracted));
	chmodSync(tmpTarget, 0o755);
	renameSync(tmpTarget, toolsPath);
	rmSync(staging, { recursive: true, force: true });

	const verified = tryWasmtime(toolsPath);
	if (!verified) {
		throw new Error(`downloaded wasmtime at ${toolsPath} failed --version`);
	}
	emit(`hobo: wasmtime ${verified.version} ready at ${toolsPath}`);
	return {
		binPath: toolsPath,
		version: verified.version,
		source: "downloaded",
	};
}

function packageRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	if (existsSync(join(here, "wit", "wasi-http", "proxy.wit"))) return here;
	if (existsSync(join(here, "..", "wit", "wasi-http", "proxy.wit"))) {
		return join(here, "..");
	}
	if (existsSync(join(here, "..", "..", "wit", "wasi-http", "proxy.wit"))) {
		return join(here, "..", "..");
	}
	return join(here, "..");
}

function wasiHttpWitDir(): string {
	const root = packageRoot();
	const wit = join(root, "wit", "wasi-http");
	if (!existsSync(join(wit, "proxy.wit"))) {
		throw new Error(
			`wasi-http WIT not found at ${wit}; package is missing vendored wit/wasi-http`,
		);
	}
	return wit;
}

function resolveJcoBin(): string {
	const require = createRequire(import.meta.url);
	try {
		const jcoPkg = require.resolve("@bytecodealliance/jco/package.json");
		const bin = join(dirname(jcoPkg), "src", "jco.js");
		if (existsSync(bin)) return bin;
	} catch {
		// fall through
	}
	let dir = packageRoot();
	for (let i = 0; i < 6; i += 1) {
		const candidate = join(
			dir,
			"node_modules",
			"@bytecodealliance",
			"jco",
			"src",
			"jco.js",
		);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		"@bytecodealliance/jco not found; reinstall @hobo/hobo dependencies, then run `hobo yard ensure`",
	);
}

function resolveJcoTool(): JcoTool {
	const binPath = resolveJcoBin();
	let version = "unknown";
	// jco.js lives at <pkg>/src/jco.js — package.json is two levels up from the file.
	const pkgJson = join(dirname(binPath), "..", "package.json");
	if (existsSync(pkgJson)) {
		try {
			// SAFETY: assertion required at this I/O or test boundary.
			const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
				version?: string;
			};
			if (isJsonString(pkg.version)) version = pkg.version;
		} catch {
			// keep unknown
		}
	}
	return { binPath, version, source: "package" };
}

/**
 * Ensure the isolated-wasm Camp component host can run: wasmtime + jco.
 * Called from `hobo yard ensure|init|doctor` and automatically from `hobo dev`.
 */
export async function ensureIsolatedWasmToolchain(
	options: {
		readonly hoboHome?: string;
		readonly env?: NodeJS.ProcessEnv;
		readonly download?: boolean;
		readonly emitProgress?: (message: string) => void;
	} = {},
): Promise<IsolatedWasmToolchain> {
	const env = options.env ?? process.env;
	const hoboHome = options.hoboHome ?? defaultHoboHome(env);
	const emit = options.emitProgress ?? (() => {});
	const notes: string[] = [];

	const wasmtime = await ensureWasmtimeBinary({
		hoboHome,
		env,
		download: options.download ?? true,
		emitProgress: emit,
	});
	notes.push(
		`wasmtime ${wasmtime.version} (${wasmtime.source}) at ${wasmtime.binPath}`,
	);

	const jco = resolveJcoTool();
	notes.push(`jco ${jco.version} at ${jco.binPath}`);
	emit(
		`hobo: isolated-wasm toolchain ready (wasmtime ${wasmtime.version}, jco ${jco.version})`,
	);

	return {
		hoboHome,
		wasmtime,
		jco,
		ready: true,
		notes,
	};
}

export interface ResolvedPrivateGuest {
	readonly resourceName: string;
	readonly projectDir: string;
	/** Prebuilt wasi:http/proxy component, if the app already componentized. */
	readonly wasmPath: string | null;
	/**
	 * Explicit wasi:http guest source (optional override).
	 * When null, HoBo bundles the app module (`src/<resourceName>.ts` etc.).
	 */
	readonly guestSourcePath: string | null;
	/**
	 * App module to bundle. Any resource name: exports `app` | `default` |
	 * `handler` | `fetch` | named export matching the resource, with `.fetch`
	 * or as a fetch function.
	 */
	readonly appModulePath: string | null;
}

/**
 * Resolve sources for **any** private bindle resource (not hello-bindle-specific).
 *
 * Priority:
 *   1. `modulePath` override (explicit path)
 *   2. Prebuilt `dist/wasm/<resourceName>.wasm`
 *   3. Explicit guest `src/wasm/<resourceName>-guest.mjs` (optional)
 *   4. App module by resource name: `src/<resourceName>.ts` (default)
 */
export function resolvePrivateWasmGuest(options: {
	readonly projectDir: string;
	readonly resourceName: string;
	/** Absolute or project-relative path to the app module (optional). */
	readonly modulePath?: string;
}): ResolvedPrivateGuest {
	const { projectDir, resourceName } = options;
	const name = resourceName;

	if (options.modulePath !== undefined && options.modulePath.length > 0) {
		const absolute = options.modulePath.startsWith("/")
			? options.modulePath
			: join(projectDir, options.modulePath);
		if (!existsSync(absolute)) {
			throw new Error(
				`isolated-wasm: modulePath not found for resource '${name}': ${absolute}`,
			);
		}
		return {
			resourceName: name,
			projectDir,
			wasmPath: null,
			guestSourcePath: null,
			appModulePath: absolute,
		};
	}

	const candidatesWasm = [
		join(projectDir, "dist", "wasm", `${name}.wasm`),
		join(projectDir, "src", "wasm", `${name}.wasm`),
	];
	for (const wasmPath of candidatesWasm) {
		if (existsSync(wasmPath)) {
			return {
				resourceName: name,
				projectDir,
				wasmPath,
				guestSourcePath: null,
				appModulePath: null,
			};
		}
	}

	const candidatesGuest = [
		join(projectDir, "src", "wasm", `${name}-guest.mjs`),
		join(projectDir, "src", "wasm", `${name}-guest.js`),
	];
	let guestSourcePath: string | null = null;
	for (const candidate of candidatesGuest) {
		if (existsSync(candidate)) {
			guestSourcePath = candidate;
			break;
		}
	}

	// Generic layout: one module per bindle resource name.
	const candidatesApp = [
		join(projectDir, "src", `${name}.ts`),
		join(projectDir, "src", `${name}.tsx`),
		join(projectDir, "src", `${name}.mts`),
		join(projectDir, "src", `${name}.js`),
		join(projectDir, "src", `${name}.mjs`),
		join(projectDir, "src", name, "index.ts"),
		join(projectDir, "src", name, "index.tsx"),
		join(projectDir, "src", name, "index.js"),
		join(projectDir, "src", name, "index.mjs"),
		join(projectDir, "dist", `${name}.js`),
		join(projectDir, "dist", `${name}.mjs`),
		join(projectDir, "dist", name, "index.js"),
	];
	let appModulePath: string | null = null;
	for (const candidate of candidatesApp) {
		if (existsSync(candidate)) {
			appModulePath = candidate;
			break;
		}
	}

	return {
		resourceName: name,
		projectDir,
		wasmPath: null,
		guestSourcePath,
		appModulePath,
	};
}

/**
 * Bundle any app module into a wasi:http fetch-event guest.
 *
 * Accepted exports (first match):
 *   - `app` / `default` / `handler` / `fetch` / named export == resourceName
 *   - object with `.fetch`, or a bare `(Request) => Response` function
 *
 * Camp env is applied from mesh headers at request time (not baked in).
 */
export async function bundleAppModuleAsWasiHttpGuest(options: {
	readonly projectDir: string;
	readonly resourceName: string;
	readonly appModulePath: string;
	readonly outPath: string;
}): Promise<void> {
	const esbuild = await import("esbuild");
	const appImport = options.appModulePath.replaceAll("\\", "/");
	const resourceLiteral = JSON.stringify(options.resourceName);
	const entry = `
import * as mod from ${JSON.stringify(appImport)};

const RESOURCE = ${resourceLiteral};

function resolveFetchHandler(mod, resourceName) {
  const candidates = [
    mod.app,
    mod.default,
    mod.handler,
    mod.fetch,
    mod[resourceName],
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (candidate.fetch instanceof Function) {
      return (request) => candidate.fetch(request);
    }
    if (candidate instanceof Function) {
      return (request) => candidate(request);
    }
  }
  throw new Error(
    "wasm guest for resource " + resourceName +
    ": export app|default|handler|fetch|{" + resourceName + "} " +
    "as a fetch handler (function or { fetch })",
  );
}

const handler = resolveFetchHandler(mod, RESOURCE);

const isJsonObject = (value) => Object.prototype.toString.call(value) === "[object Object]";
const isJsonString = (value) => typeof value === "string";

function applyMeshEnv(request) {
  const g = globalThis;
  g.process = g.process || {};
  g.process.env = g.process.env || {};
  const raw = request.headers.get("x-hobo-bindle-env");
  if (raw) {
    try {
      const map = JSON.parse(raw);
      if (map && typeof map === "object" && !Array.isArray(map)) {
        for (const [key, value] of Object.entries(map)) {
          if (typeof value === "string") g.process.env[key] = value;
        }
      }
    } catch {
      // ignore malformed mesh header
    }
  }
  // x-hobo-env-<key> (key lowercased by the mesh); set both cases for app code.
  for (const [header, value] of request.headers) {
    if (!header.startsWith("x-hobo-env-")) continue;
    const key = header.slice("x-hobo-env-".length);
    g.process.env[key.toUpperCase()] = value;
    g.process.env[key] = value;
  }
}

addEventListener("fetch", (event) => {
  event.respondWith(
    (async () => {
      applyMeshEnv(event.request);
      return handler(event.request);
    })(),
  );
});
`;
	const result = await esbuild.build({
		stdin: {
			contents: entry,
			resolveDir: options.projectDir,
			sourcefile: `${options.resourceName}-wasm-entry.mjs`,
			loader: "js",
		},
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "es2022",
		absWorkingDir: options.projectDir,
		logLevel: "silent",
		// App deps (hono, etc.) resolve from the project, not from @hobo/hobo.
		nodePaths: [
			join(options.projectDir, "node_modules"),
			join(packageRoot(), "node_modules"),
		],
	});
	const file = result.outputFiles?.[0];
	if (!file) {
		throw new Error(
			`esbuild produced no output for private resource ${options.resourceName}`,
		);
	}
	mkdirSync(dirname(options.outPath), { recursive: true });
	writeFileSync(options.outPath, file.text, "utf8");
}

/**
 * Componentize a wasi:http/proxy guest .js/.mjs into .wasm for wasmtime serve.
 */
export async function componentizePrivateGuest(options: {
	readonly resourceName: string;
	readonly guestSourcePath: string;
	readonly workDir?: string;
	readonly hoboHome?: string;
	readonly jcoBin?: string;
	readonly emitProgress?: (message: string) => void;
}): Promise<ComponentizeResult> {
	const emit = options.emitProgress ?? (() => {});
	if (!existsSync(options.guestSourcePath)) {
		throw new Error(
			`private wasm guest not found: ${options.guestSourcePath} (resource ${options.resourceName})`,
		);
	}
	const guestBytes = readFileSync(options.guestSourcePath);
	const hoboHome = options.hoboHome ?? defaultHoboHome();
	const hash = createHash("sha256")
		.update(options.resourceName)
		.update("\0")
		.update(options.guestSourcePath)
		.update("\0")
		.update(guestBytes)
		.digest("hex")
		.slice(0, 16);
	const workDir =
		options.workDir ?? join(hoboHome, "sandboxes", options.resourceName, hash);
	mkdirSync(workDir, { recursive: true });

	const guestSourcePath = join(workDir, "guest.mjs");
	const wasmPath = join(workDir, "guest.wasm");
	writeFileSync(guestSourcePath, guestBytes);

	if (existsSync(wasmPath) && existsSync(join(workDir, ".componentize-ok"))) {
		emit(`hobo: reusing componentized ${options.resourceName} at ${wasmPath}`);
		return {
			wasmPath,
			guestSourcePath,
			workDir,
			resourceName: options.resourceName,
		};
	}

	const jco = options.jcoBin ?? resolveJcoBin();
	const witDir = wasiHttpWitDir();
	emit(
		`hobo: componentizing private ${options.resourceName} → wasi:http/proxy .wasm`,
	);
	const args = [
		jco,
		"componentize",
		guestSourcePath,
		"-w",
		witDir,
		"-n",
		"proxy",
		"-o",
		wasmPath,
		// Disable stdio so wasmtime serve can link (no terminal-input import).
		// Camp config is injected by HoBo mesh headers, not WASI env/stdio.
		"--disable",
		"stdio",
	];
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 180_000,
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(
			`jco componentize failed for ${options.resourceName}: ${result.stderr || result.stdout}`,
		);
	}
	if (!existsSync(wasmPath)) {
		throw new Error(`jco componentize produced no wasm at ${wasmPath}`);
	}
	writeFileSync(join(workDir, ".componentize-ok"), `${Date.now()}\n`, "utf8");
	emit(`hobo: wrote ${wasmPath}`);
	return {
		wasmPath,
		guestSourcePath,
		workDir,
		resourceName: options.resourceName,
	};
}

/**
 * Resolve + componentize **any** private bindle resource for isolated-wasm.
 *
 * Default: bundle `src/<resourceName>.ts` (export app|default|handler|fetch).
 * Optional: `modulePath`, prebuilt `.wasm`, or explicit `-guest.mjs`.
 */
export async function preparePrivateWasmComponent(options: {
	readonly projectDir: string;
	readonly resourceName: string;
	/** Override module path (absolute or project-relative). */
	readonly modulePath?: string;
	readonly hoboHome?: string;
	readonly jcoBin?: string;
	readonly emitProgress?: (message: string) => void;
}): Promise<ComponentizeResult> {
	const emit = options.emitProgress ?? (() => {});
	const resolved = resolvePrivateWasmGuest({
		projectDir: options.projectDir,
		resourceName: options.resourceName,
		...(options.modulePath !== undefined
			? { modulePath: options.modulePath }
			: undefined),
	});
	if (resolved.wasmPath !== null) {
		emit(
			`hobo: using prebuilt wasm for private ${options.resourceName} at ${resolved.wasmPath}`,
		);
		return {
			wasmPath: resolved.wasmPath,
			guestSourcePath: resolved.guestSourcePath ?? resolved.wasmPath,
			workDir: dirname(resolved.wasmPath),
			resourceName: options.resourceName,
		};
	}

	const stagingDir = join(
		tmpdir(),
		`hobo-wasm-stage-${process.pid}-${randomUUID()}`,
	);
	mkdirSync(stagingDir, { recursive: true });
	const bundledGuest = join(stagingDir, "guest.mjs");

	try {
		// Prefer app source (generic). Explicit guest only when no app module.
		if (resolved.appModulePath !== null) {
			emit(
				`hobo: bundling ${resolved.appModulePath} → wasi:http guest for private ${options.resourceName}`,
			);
			await bundleAppModuleAsWasiHttpGuest({
				projectDir: options.projectDir,
				resourceName: options.resourceName,
				appModulePath: resolved.appModulePath,
				outPath: bundledGuest,
			});
		} else if (resolved.guestSourcePath !== null) {
			emit(
				`hobo: using explicit wasm guest ${resolved.guestSourcePath} for ${options.resourceName}`,
			);
			writeFileSync(bundledGuest, readFileSync(resolved.guestSourcePath));
		} else {
			throw new Error(
				`isolated-wasm: no source for private resource '${options.resourceName}' in ${options.projectDir}. ` +
					`Add src/${options.resourceName}.ts exporting app|default|handler|fetch ` +
					`(function or { fetch }), or dist/wasm/${options.resourceName}.wasm.`,
			);
		}

		return await componentizePrivateGuest({
			resourceName: options.resourceName,
			guestSourcePath: bundledGuest,
			...(options.hoboHome !== undefined
				? { hoboHome: options.hoboHome }
				: undefined),
			...(options.jcoBin !== undefined
				? { jcoBin: options.jcoBin }
				: undefined),
			emitProgress: emit,
		});
	} finally {
		rmSync(stagingDir, { recursive: true, force: true });
	}
}

async function freeLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			if (addr === null || isJsonString(addr)) {
				server.close();
				reject(new Error("failed to allocate loopback port"));
				return;
			}
			const port = addr.port;
			server.close((error) => {
				if (error) reject(error);
				else resolve(port);
			});
		});
		server.once("error", reject);
	});
}

async function waitForListen(
	port: number,
	child: ChildProcess,
	timeoutMs = 30_000,
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) {
			throw new Error(`wasmtime exited before listen (code ${child.exitCode})`);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}/`, {
				signal: AbortSignal.timeout(500),
			});
			void response.arrayBuffer().catch(() => {});
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	throw new Error(`wasmtime serve did not listen on 127.0.0.1:${port} in time`);
}

/**
 * Spawn a sandboxed `wasmtime serve` process for a wasi-http proxy component.
 */
export async function bootWasmtimeSandbox(options: {
	readonly resourceName: string;
	readonly wasmPath: string;
	readonly wasmtimeBin: string;
	readonly port?: number;
	readonly emitProgress?: (message: string) => void;
}): Promise<WasmtimeSandbox> {
	const emit = options.emitProgress ?? (() => {});
	const port = options.port ?? (await freeLoopbackPort());
	const addr = `127.0.0.1:${port}`;
	const loopbackUrl = `http://${addr}`;

	const args = [
		"serve",
		"--addr",
		addr,
		"-Sinherit-network=n",
		"-Sallow-ip-name-lookup=n",
		"-Stcp=n",
		"-Sudp=n",
		options.wasmPath,
	];

	emit(
		`hobo: spawning wasmtime sandbox for private ${options.resourceName} on ${loopbackUrl}`,
	);

	const child = spawn(options.wasmtimeBin, args, {
		stdio: ["ignore", "pipe", "pipe"],
		env: process.env,
	});

	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});

	try {
		await waitForListen(port, child);
	} catch (error) {
		child.kill("SIGTERM");
		const detail = stderr.trim() || String(error);
		throw new Error(
			`wasmtime sandbox failed for ${options.resourceName}: ${detail}`,
		);
	}

	const pid = child.pid ?? 0;
	emit(
		`hobo: wasmtime sandbox ready pid=${pid} component=${options.resourceName}`,
	);

	const invoke: FetchHandler = async (request) => {
		const url = new URL(request.url);
		const target = `${loopbackUrl}${url.pathname}${url.search}`;
		const method = request.method;
		// Forward HoBo mesh-injected env headers into the sandbox process.
		const headers = Object.fromEntries(request.headers.entries());
		const init: RequestInit = { method, headers };
		if (method !== "GET" && method !== "HEAD") {
			init.body = await request.arrayBuffer();
		}
		return fetch(target, init);
	};

	let terminated = false;
	const terminate = async () => {
		if (terminated) return;
		terminated = true;
		if (child.exitCode !== null) return;
		child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				resolve();
			}, 3_000);
			child.once("exit", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	};

	return {
		resourceName: options.resourceName,
		pid,
		loopbackUrl,
		port,
		wasmPath: options.wasmPath,
		wasmtimeBin: options.wasmtimeBin,
		isolateBoundary: "wasmtime_process",
		invoke,
		terminate,
	};
}
