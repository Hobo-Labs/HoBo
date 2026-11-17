import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, type Hash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonString } from "./json.js";

export type FetchHandler = (input: Request) => Response | Promise<Response>;

// public-contract:
export const PINNED_WASMTIME_VERSION = "46.0.1";

// public-contract:
export const HOBO_ENV_HEADER_PREFIX = "x-hobo-env-";
// public-contract:
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
	} catch {}
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
	const pkgJson = join(dirname(binPath), "..", "package.json");
	if (existsSync(pkgJson)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
				version?: string;
			};
			if (isJsonString(pkg.version)) version = pkg.version;
		} catch {}
	}
	return { binPath, version, source: "package" };
}

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
	readonly wasmPath: string | null;
	readonly guestSourcePath: string | null;
	readonly appModulePath: string | null;
}

export function resolvePrivateWasmGuest(options: {
	readonly projectDir: string;
	readonly resourceName: string;
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
    } catch {}
  }
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

function hashWitDirectory(hash: Hash, root: string): void {
	const activeDirectories = new Set<string>();
	function visit(directory: string): void {
		const realDirectory = realpathSync(directory);
		if (activeDirectories.has(realDirectory)) {
			throw new Error(
				`WIT directory contains a symbolic link cycle: ${directory}`,
			);
		}
		activeDirectories.add(realDirectory);
		try {
			const entries = readdirSync(directory, { withFileTypes: true }).sort(
				(a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
			);
			for (const entry of entries) {
				const file = join(directory, entry.name);
				const target = entry.isSymbolicLink() ? statSync(file) : entry;
				if (target.isDirectory()) {
					visit(file);
				} else if (target.isFile() && entry.name.endsWith(".wit")) {
					hash.update("\0wit\0");
					hash.update(relative(root, file).replaceAll("\\", "/"));
					hash.update("\0");
					hash.update(createHash("sha256").update(readFileSync(file)).digest());
				}
			}
		} finally {
			activeDirectories.delete(realDirectory);
		}
	}
	visit(root);
}

function componentizeRunner(): string {
	const sibling = join(
		dirname(fileURLToPath(import.meta.url)),
		"componentize-runner.js",
	);
	if (existsSync(sibling)) return sibling;
	const built = join(packageRoot(), "dist", "componentize-runner.js");
	if (existsSync(built)) return built;
	throw new Error(
		"componentize runner is missing; build @hobo/runtime-wasm first",
	);
}

export async function componentizePrivateGuest(options: {
	readonly resourceName: string;
	readonly guestSourcePath: string;
	readonly workDir?: string;
	readonly hoboHome?: string;
	readonly jcoBin?: string;
	readonly witDir?: string;
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
	const witDir = options.witDir ?? wasiHttpWitDir();
	const runner = options.jcoBin ?? componentizeRunner();
	const hash = createHash("sha256")
		.update(options.resourceName)
		.update("\0")
		.update(options.guestSourcePath)
		.update("\0")
		.update(createHash("sha256").update(guestBytes).digest())
		.update("\0componentizer\0")
		.update(options.jcoBin === undefined ? "componentize-js@0.19.3" : "jco")
		.update(createHash("sha256").update(readFileSync(runner)).digest());
	hashWitDirectory(hash, witDir);
	const digest = hash.digest("hex");
	const workDir =
		options.workDir ??
		join(hoboHome, "sandboxes", options.resourceName, digest.slice(0, 16));
	mkdirSync(workDir, { recursive: true });

	const guestSourcePath = join(workDir, "guest.mjs");
	const wasmPath = join(workDir, "guest.wasm");
	const markerPath = join(workDir, ".componentize-ok");
	writeFileSync(guestSourcePath, guestBytes);

	if (
		existsSync(wasmPath) &&
		existsSync(markerPath) &&
		readFileSync(markerPath, "utf8") === `${digest}\n`
	) {
		emit(`hobo: reusing componentized ${options.resourceName} at ${wasmPath}`);
		return {
			wasmPath,
			guestSourcePath,
			workDir,
			resourceName: options.resourceName,
		};
	}

	rmSync(markerPath, { force: true });
	rmSync(wasmPath, { force: true });
	emit(
		`hobo: componentizing private ${options.resourceName} → HoBo HTTP world .wasm`,
	);
	const args = options.jcoBin
		? [
				runner,
				"componentize",
				guestSourcePath,
				"-w",
				witDir,
				"-n",
				"proxy",
				"-o",
				wasmPath,
				"--disable",
				"stdio",
			]
		: [runner, guestSourcePath, witDir, wasmPath, join(hoboHome, "cache")];
	const result = spawnSync(process.execPath, args, {
		encoding: "utf8",
		timeout: 180_000,
		env: process.env,
	});
	if (result.status !== 0) {
		throw new Error(
			`componentization failed for ${options.resourceName}: ${result.stderr || result.stdout}`,
		);
	}
	if (!existsSync(wasmPath)) {
		throw new Error(`jco componentize produced no wasm at ${wasmPath}`);
	}
	writeFileSync(markerPath, `${digest}\n`, "utf8");
	emit(`hobo: wrote ${wasmPath}`);
	return {
		wasmPath,
		guestSourcePath,
		workDir,
		resourceName: options.resourceName,
	};
}

export async function preparePrivateWasmComponent(options: {
	readonly projectDir: string;
	readonly resourceName: string;
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
