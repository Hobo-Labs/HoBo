import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	logBrowserWitComponentizeSplicerContext,
	logBrowserWitReleaseEnvironment,
} from "../../scripts/lib/browser-wit-componentize-diagnostics.mts";
import {
	assertGuestSourceUnderWorkRoot,
	assertSandboxWitBeforeComponentize,
	BROWSER_WIT_GUEST_SOURCE_NAME,
	copyHostWitTreeIntoWorkRoot,
	guestSourcePathInWorkRoot,
	readInlineComponentizeWit,
	resolveComponentizeHostWitPath,
} from "../../scripts/lib/browser-wit-componentize-sandbox.mts";
import {
	logBrowserWitComponentizeToolchain,
	resolveBrowserWitComponentizeToolchain,
} from "../../scripts/lib/browser-wit-toolchain.mts";
import {
	browserWitComponentizeProofPath,
	createBrowserWitComponentizeWorkRoot,
	removeBrowserWitWorkRoot,
} from "../../scripts/lib/browser-wit-work-root.mts";
import { loadExamplesCatalog } from "../src/lib/examples/catalog.js";
import { buildBrowserStationGuestSource } from "../src/lib/examples/runtime/guest-source.js";
import {
	parseBrowserRuntimeManifest,
	type BrowserRuntimeManifest,
} from "../src/lib/examples/runtime-manifest.js";

const SITE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = path.resolve(SITE_ROOT, "..");
const WIT_DIR = path.join(REPO_ROOT, "examples", "browser-runtime", "wit");
const OUTPUT_ROOT = path.join(
	SITE_ROOT,
	"public",
	"examples",
	"runtime",
);
const WIT_WORLD = "hobo:try/browser-station@0.1.0" as const;

interface ToolchainModule {
	componentize(options: {
		sourcePath: string;
		witWorld: string;
		worldName: string;
		disableFeatures: string[];
		env?: { XDG_CACHE_HOME: string } | undefined;
	}): Promise<{ component: Uint8Array }>;
}

interface JcoModule {
	transpile(
		component: Uint8Array,
		options: {
			name: string;
			nodejsCompat: boolean;
			tlaCompat: boolean;
			minify: boolean;
		},
	): Promise<{ files: Record<string, Uint8Array> }>;
}

interface EsbuildModule {
	build(options: {
		stdin: {
			contents: string;
			resolveDir: string;
			sourcefile: string;
			loader: "js";
		};
		bundle: true;
		write: false;
		format: "esm";
		platform: "browser";
		target: "es2022";
		minify: true;
		logLevel: "silent";
	}): Promise<{ outputFiles?: { contents: Uint8Array }[] }>;
}

export async function buildBrowserWitRuntime(
	outputRoot = OUTPUT_ROOT,
): Promise<{ readonly outputRoot: string; readonly componentDigest: string }> {
	const catalog = await loadExamplesCatalog(REPO_ROOT);
	if (catalog.length === 0) {
		throw new Error("No try-site examples found for the browser WIT runtime");
	}
	const guestSource = buildBrowserStationGuestSource(catalog);
	const sourceDigest = sha256(new TextEncoder().encode(guestSource));
	const toolchain = await resolveToolchain();
	const buildDigest = await calculateBuildDigest(sourceDigest, toolchain.versions);
	const forceComponentize =
		process.env.HOBO_BROWSER_WIT_FORCE_COMPONENTIZE === "1";
	if (!forceComponentize) {
		const cached = await reuseVerifiedRuntime(outputRoot, {
			sourceDigest,
			buildDigest,
			toolchain: toolchain.versions,
		});
		if (cached) {
			process.stderr.write("browser-wit: verified runtime cache hit\n");
			return { outputRoot, componentDigest: cached };
		}
	} else {
		process.stderr.write(
			"browser-wit: HOBO_BROWSER_WIT_FORCE_COMPONENTIZE=1 (skip runtime cache)\n",
		);
	}
	const { logical: workRootLogical, canonical: workRoot } =
		await createBrowserWitComponentizeWorkRoot(REPO_ROOT);
	const outputParent = path.dirname(outputRoot);
	await mkdir(outputParent, { recursive: true });
	const staging = await mkdtemp(path.join(outputParent, ".runtime-build-"));
	const cleanup = async () => {
		await Promise.all([
			removeBrowserWitWorkRoot(workRootLogical),
			rm(staging, { recursive: true, force: true }),
		]);
	};
	const interrupt = () => {
		void cleanup().finally(() => process.exit(130));
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);

	try {
		const guestPath = guestSourcePathInWorkRoot(workRoot);
		await writeFile(guestPath, guestSource, "utf8");
		const gitRef =
			process.env.HOBO_RELEASE_CHECKOUT_REF?.trim() ||
			process.env.GITHUB_SHA?.trim() ||
			"HEAD";
		const sandboxWitDir = await copyHostWitTreeIntoWorkRoot(WIT_DIR, workRoot);
		const hostWitPath = await resolveComponentizeHostWitPath(sandboxWitDir);
		assertGuestSourceUnderWorkRoot(guestPath, workRoot);
		await assertSandboxWitBeforeComponentize(
			sandboxWitDir,
			workRoot,
			REPO_ROOT,
			WIT_DIR,
			gitRef,
		);
		const hostSourcePath = await realpath(guestPath);
		await logBrowserWitReleaseEnvironment({
			repoRoot: REPO_ROOT,
			workRoot,
			workRootLogical,
			toolchain: {
				componentize: toolchain.componentize,
				componentizePackageRoot: toolchain.componentizePackageRoot,
				versions: toolchain.versions,
			},
		});
		const inlineWit = await readInlineComponentizeWit(sandboxWitDir);
		logBrowserWitComponentizeToolchain(
			{
				componentize: toolchain.componentize,
				componentizePackageRoot: toolchain.componentizePackageRoot,
				versions: toolchain.versions,
			},
			{
				workRoot,
				sourcePath: hostSourcePath,
				hostWitPath,
				componentizeWitPath: "wit/station.wit",
				witDelivery: "inline-witWorld",
			},
		);
		await logBrowserWitComponentizeSplicerContext({
			workRoot,
			guestRelativePath: BROWSER_WIT_GUEST_SOURCE_NAME,
			hostWitPath,
			inlineWitBytes: Buffer.byteLength(inlineWit, "utf8"),
			componentizeJsVersion: toolchain.versions.componentizeJs,
			witDelivery: "inline-witWorld",
		});
		process.stderr.write("browser-wit: componentizing real guest\n");
		await writeFile(
			browserWitComponentizeProofPath(REPO_ROOT),
			`${JSON.stringify({
				schemaVersion: "hobo.browser-wit-componentize-proof/v1",
				workRoot,
				workRootLogical,
				startedAt: new Date().toISOString(),
			})}\n`,
			"utf8",
		);
		const cacheHome = process.env.XDG_CACHE_HOME;
		const previousWorkingDirectory = process.cwd();
		process.chdir(workRoot);
		let built: { component: Uint8Array };
		try {
			built = await toolchain.componentize.componentize({
				env: cacheHome ? { XDG_CACHE_HOME: cacheHome } : undefined,
				sourcePath: BROWSER_WIT_GUEST_SOURCE_NAME,
				witWorld: inlineWit,
				worldName: "browser-station",
				disableFeatures: ["random", "clocks", "stdio", "http"],
			});
		} finally {
			process.chdir(previousWorkingDirectory);
		}
		const componentDigest = sha256(built.component);
		process.stderr.write("browser-wit: transpiling component for browser\n");
		const transpiled = await toolchain.jco.transpile(built.component, {
			name: "station",
			nodejsCompat: false,
			tlaCompat: true,
			minify: true,
		});

		let browserAssets = Object.entries(transpiled.files).filter(
			([name]) => name.endsWith(".js") || name.endsWith(".wasm"),
		);
		if (!browserAssets.some(([name]) => name === "station.js")) {
			throw new Error("jco transpile did not emit station.js");
		}
		if (browserAssets.filter(([name]) => name.endsWith(".js")).length !== 1) {
			throw new Error("jco transpile emitted unsupported extra JavaScript modules");
		}
		const stationSource = new TextDecoder().decode(
			browserAssets.find(([name]) => name === "station.js")?.[1],
		);
		const bundled = await toolchain.esbuild.build({
			stdin: {
				contents: stationSource,
				resolveDir: path.dirname(toolchain.jcoEntry),
				sourcefile: "station.js",
				loader: "js",
			},
			bundle: true,
			write: false,
			format: "esm",
			platform: "browser",
			target: "es2022",
			minify: true,
			logLevel: "silent",
		});
		const bundledStation = bundled.outputFiles?.[0]?.contents;
		if (bundledStation === undefined) {
			throw new Error("esbuild produced no browser station module");
		}
		browserAssets = browserAssets.map(([name, bytes]) =>
			name === "station.js" ? [name, bundledStation] : [name, bytes],
		);
		for (const [name, bytes] of browserAssets) {
			if (name.includes("/") || name.includes("\\")) {
				throw new Error(`jco emitted an unsafe browser asset path: ${name}`);
			}
			await writeFile(path.join(staging, name), bytes);
		}
		await writeFile(
			path.join(staging, "station.component.wasm"),
			built.component,
		);
		const assets = [
			...browserAssets.map(([name]) => name),
			"station.component.wasm",
		].sort();
		const assetDigests = Object.fromEntries(
			[
				...browserAssets,
				["station.component.wasm", built.component] as const,
			].map(([name, bytes]) => [name, sha256(bytes)]),
		);
		await writeFile(
			path.join(staging, "manifest.json"),
			`${JSON.stringify(
				{
					schemaVersion: "hobo.browser-wit-runtime/v1",
					entryModule: "station.js",
					componentDigest,
					witWorld: WIT_WORLD,
					toolchain: toolchain.versions,
					sourceDigest,
					buildDigest,
					assets,
					assetDigests,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		await rm(outputRoot, { recursive: true, force: true });
		await rename(staging, outputRoot);
		await writeFile(
			browserWitComponentizeProofPath(REPO_ROOT),
			`${JSON.stringify({
				schemaVersion: "hobo.browser-wit-componentize-proof/v1",
				workRoot,
				workRootLogical,
				componentDigest,
				finishedAt: new Date().toISOString(),
			})}\n`,
			"utf8",
		);
		process.stderr.write("browser-wit: runtime assets ready\n");
		return { outputRoot, componentDigest };
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		await cleanup();
	}
}

export async function reuseVerifiedRuntime(
	outputRoot: string,
	expected: Pick<BrowserRuntimeManifest, "sourceDigest" | "buildDigest" | "toolchain">,
): Promise<string | null> {
	try {
		const manifestPath = path.join(outputRoot, "manifest.json");
		const manifest = parseBrowserRuntimeManifest(
			JSON.parse(await readFile(manifestPath, "utf8")),
		);
		if (
			manifest.sourceDigest !== expected.sourceDigest ||
			manifest.buildDigest !== expected.buildDigest ||
			JSON.stringify(manifest.toolchain) !== JSON.stringify(expected.toolchain)
		) {
			return null;
		}
		const assets = await Promise.all(
			manifest.assets.map(async (name) => [
				name,
				await readFile(path.join(outputRoot, name)),
			] as const),
		);
		const component = assets.find(
			([name]) => name === "station.component.wasm",
		)?.[1];
		if (!component || sha256(component) !== manifest.componentDigest) return null;
		for (const [name, bytes] of assets) {
			if (manifest.assetDigests[name] !== sha256(bytes)) return null;
		}
		return manifest.componentDigest;
	} catch (error) {
		if (error instanceof SyntaxError || error instanceof TypeError) return null;
		if (
			error instanceof Error &&
			"code" in error &&
			// SAFETY: assertion required at this I/O boundary.
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

async function resolveToolchain(): Promise<{
	readonly componentize: ToolchainModule;
	readonly componentizePackageRoot: string;
	readonly jco: JcoModule;
	readonly jcoEntry: string;
	readonly esbuild: EsbuildModule;
	readonly versions: BrowserRuntimeManifest["toolchain"];
}> {
	const runtimeRequire = createRequire(
		path.join(REPO_ROOT, "packages", "runtimes", "runtime-wasm", "package.json"),
	);
	const componentizeToolchain =
		await resolveBrowserWitComponentizeToolchain(REPO_ROOT);
	const jcoEntry = runtimeRequire.resolve("@bytecodealliance/jco");
	const esbuildEntry = runtimeRequire.resolve("esbuild");
	const esbuildManifestPath = path.join(
		path.dirname(esbuildEntry),
		"..",
		"package.json",
	);
	const [jco, esbuild, esbuildManifest] = await Promise.all([
		// SAFETY: toolchain entries are loaded from resolved package paths.
		import(pathToFileURL(jcoEntry).href) as Promise<JcoModule>,
		// SAFETY: toolchain entries are loaded from resolved package paths.
		import(pathToFileURL(esbuildEntry).href) as Promise<EsbuildModule>,
		readPackageVersion(esbuildManifestPath),
	]);
	return {
		jco,
		jcoEntry,
		componentize: componentizeToolchain.componentize,
		componentizePackageRoot: componentizeToolchain.componentizePackageRoot,
		esbuild,
		versions: {
			jco: componentizeToolchain.versions.jco,
			componentizeJs: componentizeToolchain.versions.componentizeJs,
			esbuild: esbuildManifest,
		},
	};
}

async function calculateBuildDigest(
	sourceDigest: string,
	toolchain: BrowserRuntimeManifest["toolchain"],
): Promise<`sha256:${string}`> {
	const witFiles = (await readdir(WIT_DIR)).sort();
	const witDigests = await Promise.all(
		witFiles.map(async (name) => [name, sha256(await readFile(path.join(WIT_DIR, name)))]),
	);
	return sha256(
		new TextEncoder().encode(
			JSON.stringify({
				sourceDigest,
				toolchain,
				witDigests,
				buildScriptDigest: sha256(await readFile(fileURLToPath(import.meta.url))),
			}),
		),
	);
}

async function readPackageVersion(packageJsonPath: string): Promise<string> {
	// SAFETY: assertion required at this I/O boundary.
	const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
		version?: unknown;
	};
	if (Object.prototype.toString.call(manifest.version) !== "[object String]") {
		throw new Error(`Toolchain package has no version: ${packageJsonPath}`);
	}
	// SAFETY: `manifest.version` was verified to be a string above.
	return manifest.version as string;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

if (
	process.argv[1] !== undefined &&
	pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
	const result = await buildBrowserWitRuntime();
	process.stdout.write(`${JSON.stringify(result)}\n`);
}
