import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface BrowserWitComponentizeModule {
	componentize(options: {
		sourcePath: string;
		witPath: string;
		worldName: string;
		disableFeatures: string[];
		env?: { XDG_CACHE_HOME: string } | undefined;
	}): Promise<{ component: Uint8Array }>;
}

export interface BrowserWitToolchainVersions {
	readonly jco: string;
	readonly componentizeJs: string;
	readonly esbuild: string;
}

export interface BrowserWitComponentizeToolchain {
	readonly componentize: BrowserWitComponentizeModule;
	readonly versions: BrowserWitToolchainVersions;
	readonly componentizePackageRoot: string;
}

export async function resolveBrowserWitComponentizeToolchain(
	repoRoot: string,
): Promise<BrowserWitComponentizeToolchain> {
	const runtimeRequire = createRequire(
		path.join(repoRoot, "packages", "runtimes", "runtime-wasm", "package.json"),
	);
	const jcoEntry = runtimeRequire.resolve("@bytecodealliance/jco");
	const jcoManifestPath = path.join(
		path.dirname(jcoEntry),
		"..",
		"package.json",
	);
	const componentizeRoot = path.join(
		path.dirname(jcoManifestPath),
		"..",
		"componentize-js",
	);
	const componentizeEntry = path.join(
		componentizeRoot,
		"src",
		"componentize.js",
	);
	const componentizeManifestPath = path.join(componentizeRoot, "package.json");
	const esbuildEntry = runtimeRequire.resolve("esbuild");
	const esbuildManifestPath = path.join(
		path.dirname(esbuildEntry),
		"..",
		"package.json",
	);
	const [componentize, jcoManifest, componentizeManifest, esbuildManifest] =
		await Promise.all([
			// SAFETY: import target is resolved from @hobo/runtime-wasm's dependency graph.
			import(
				pathToFileURL(componentizeEntry).href
			) as Promise<BrowserWitComponentizeModule>,
			readPackageVersion(jcoManifestPath),
			readPackageVersion(componentizeManifestPath),
			readPackageVersion(esbuildManifestPath),
		]);
	return {
		componentize,
		componentizePackageRoot: componentizeRoot,
		versions: {
			jco: jcoManifest,
			componentizeJs: componentizeManifest,
			esbuild: esbuildManifest,
		},
	};
}

export function logBrowserWitComponentizeToolchain(
	toolchain: BrowserWitComponentizeToolchain,
	context: {
		sourcePath: string;
		witPath: string;
		workRoot: string;
	},
): void {
	process.stderr.write(
		`browser-wit: toolchain jco@${toolchain.versions.jco} componentize-js@${toolchain.versions.componentizeJs} esbuild@${toolchain.versions.esbuild} (resolved ${toolchain.componentizePackageRoot})\n`,
	);
	process.stderr.write(
		`browser-wit: componentize host paths workRoot=${context.workRoot} source=${context.sourcePath} wit=${context.witPath} (wizer --mapdir=/::dirname(source); wit is host-resolved, not guest-only)\n`,
	);
}

async function readPackageVersion(packageJsonPath: string): Promise<string> {
	const manifest: { version?: unknown } = JSON.parse(
		await readFile(packageJsonPath, "utf8"),
	);
	if (Object.prototype.toString.call(manifest.version) !== "[object String]") {
		throw new Error(`Toolchain package has no version: ${packageJsonPath}`);
	}
	// SAFETY: `manifest.version` was verified to be a string above.
	return manifest.version as string;
}
