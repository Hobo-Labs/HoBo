import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ciRunnerImageVersion } from "./ci-runner-contract.mts";

export const DEPS_LAYER_BUCKET_SCRIPT_PATH =
	"scripts/ci/deps-layer-buckets.mts";
export const DEPS_LAYOUT_RECIPE_PATHS = [
	"packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile",
	"packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh",
	DEPS_LAYER_BUCKET_SCRIPT_PATH,
] as const;
/** Bump version when a recipe edit changes image contents or paths (payload paths, install flags, rebuilt packages, or bucket assignment); otherwise update only recipeSha256. */
export const DEPS_LAYOUT = {
	version: 1,
	recipeSha256:
		"3119b39e30e012710d3dc0e4a706866a4395a235fa5ea99ba7e31c04bf29e6c0",
} as const;

export type DepsKeyInputs = Readonly<{
	lockfile: string;
	workspace: string;
	npmrc?: string;
	pnpmfile?: string;
	patches: Readonly<Record<string, string>>;
	manifests: Readonly<Record<string, string>>;
	platform: string;
	toolchainVersion: string;
}>;

function importerPath(value: string): string {
	if (value === ".") return value;
	if (
		!value ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error(`invalid workspace importer path: ${value}`);
	return value;
}

export function listWorkspaceImporters(lockfile: string): string[] {
	const lines = lockfile.split(/\r?\n/);
	const start = lines.findIndex((line) => line === "importers:");
	if (start === -1) throw new Error("pnpm-lock.yaml has no importers section");
	const importers: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line && !line.startsWith(" ")) break;
		const match = line.match(/^  (?:'([^']+)'|"([^"]+)"|([^:\s][^:]*)):\s*$/);
		const value = match?.[1] ?? match?.[2] ?? match?.[3];
		if (value !== undefined) importers.push(importerPath(value));
	}
	if (!importers.includes("."))
		throw new Error("pnpm-lock.yaml has no root importer");
	return [...new Set(importers)].sort();
}

export function importerManifestPath(importer: string): string {
	return importer === "." ? "package.json" : `${importer}/package.json`;
}

function updateHash(
	hash: ReturnType<typeof createHash>,
	name: string,
	value: string,
): void {
	const nameBytes = Buffer.from(name);
	const valueBytes = Buffer.from(value);
	hash.update(String(nameBytes.length)).update(":").update(nameBytes);
	hash.update(String(valueBytes.length)).update(":").update(valueBytes);
}

export function depsLayoutRecipeSha256(root: string): string {
	const hash = createHash("sha256");
	for (const path of DEPS_LAYOUT_RECIPE_PATHS)
		updateHash(hash, path, readFileSync(join(root, path), "utf8"));
	return hash.digest("hex");
}

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
interface JsonObject {
	readonly [key: string]: JsonValue;
}

function sortJsonObjectKeys(value: JsonValue): JsonValue {
	if (value === null) return value;
	if (Array.isArray(value)) return value.map(sortJsonObjectKeys);
	if (Object.getPrototypeOf(value) !== Object.prototype) return value;
	const sorted: JsonObject = Object.fromEntries(
		Object.entries(value)
			.sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
			.map(([key, entry]) => [key, sortJsonObjectKeys(entry)]),
	);
	return sorted;
}

const DEPENDENCY_MANIFEST_FIELDS = new Set([
	"name",
	"version",
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"peerDependenciesMeta",
	"dependenciesMeta",
	"bundleDependencies",
	"bundledDependencies",
	"bin",
	"directories",
	"publishConfig",
	"os",
	"cpu",
	"libc",
	"engines",
	"devEngines",
	"packageManager",
	"workspaces",
	"overrides",
	"resolutions",
]);
const DIRECTORY_MANIFEST_FIELDS = new Set(["bin"]);
const PUBLISH_CONFIG_MANIFEST_FIELDS = new Set([
	"directory",
	"bin",
	"linkDirectory",
]);

function pickNestedManifestFields(
	value: JsonValue,
	fields: ReadonlySet<string>,
): JsonObject {
	if (
		value === null ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		return {};
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => fields.has(key)),
	);
}

export function normalizeDepsManifest(
	manifest: string,
	rootManifest = false,
): string {
	const parsed: JsonObject = JSON.parse(manifest);
	const installInputs: JsonObject = Object.fromEntries(
		Object.entries(parsed)
			.filter(
				([key]) =>
					DEPENDENCY_MANIFEST_FIELDS.has(key) ||
					(rootManifest && key === "pnpm"),
			)
			.flatMap(([key, value]): Array<[string, JsonValue]> => {
				if (key === "directories" || key === "publishConfig") {
					const nested = pickNestedManifestFields(
						value,
						key === "directories"
							? DIRECTORY_MANIFEST_FIELDS
							: PUBLISH_CONFIG_MANIFEST_FIELDS,
					);
					return Object.keys(nested).length === 0
						? []
						: [[key, sortJsonObjectKeys(nested)]];
				}
				return [[key, sortJsonObjectKeys(value)]];
			})
			.sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1)),
	);
	return `${JSON.stringify(installInputs)}\n`;
}

export function depsKeyFromInputs(inputs: DepsKeyInputs): string {
	if (!/^linux\/[a-z0-9]+$/.test(inputs.platform))
		throw new Error(`invalid deps platform: ${inputs.platform}`);
	if (!inputs.toolchainVersion) throw new Error("missing toolchain version");
	const hash = createHash("sha256");
	updateHash(hash, "pnpm-lock.yaml", inputs.lockfile);
	updateHash(hash, "pnpm-workspace.yaml", inputs.workspace);
	if (inputs.npmrc !== undefined) updateHash(hash, ".npmrc", inputs.npmrc);
	if (inputs.pnpmfile !== undefined)
		updateHash(hash, ".pnpmfile.cjs", inputs.pnpmfile);
	for (const path of Object.keys(inputs.patches).sort()) {
		const patch = inputs.patches[path];
		if (patch === undefined) throw new Error(`missing deps patch: ${path}`);
		updateHash(hash, path, patch);
	}
	for (const importer of listWorkspaceImporters(inputs.lockfile)) {
		const path = importerManifestPath(importer);
		const manifest = inputs.manifests[path];
		if (manifest === undefined)
			throw new Error(`missing importer manifest: ${path}`);
		updateHash(hash, path, normalizeDepsManifest(manifest, importer === "."));
	}
	updateHash(hash, "deps-layout", String(DEPS_LAYOUT.version));
	updateHash(hash, "platform", inputs.platform);
	return `${inputs.toolchainVersion}-${hash.digest("hex").slice(0, 16)}`;
}

function patchFiles(root: string): Record<string, string> {
	const patches = new Map<string, string>();
	const directory = join(root, "patches");
	if (!existsSync(directory)) return Object.fromEntries(patches);
	const visit = (relative: string): void => {
		for (const entry of readdirSync(join(root, relative), {
			withFileTypes: true,
		})) {
			const path = `${relative}/${entry.name}`;
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile())
				patches.set(path, readFileSync(join(root, path), "utf8"));
			else throw new Error(`deps patch is not a regular file: ${path}`);
		}
	};
	visit("patches");
	return Object.fromEntries(patches);
}

function optionalFile(root: string, path: string): string | undefined {
	const absolute = join(root, path);
	return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

export function readDepsInputs(
	root: string,
	platform: string,
): Omit<DepsKeyInputs, "toolchainVersion"> {
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	const manifests: Record<string, string> = {};
	for (const importer of listWorkspaceImporters(lockfile)) {
		const path = importerManifestPath(importer);
		manifests[path] = readFileSync(join(root, path), "utf8");
	}
	const npmrc = optionalFile(root, ".npmrc");
	const pnpmfile = optionalFile(root, ".pnpmfile.cjs");
	type MutableDepsKeyInputs = {
		-readonly [Key in keyof Omit<DepsKeyInputs, "toolchainVersion">]: Omit<
			DepsKeyInputs,
			"toolchainVersion"
		>[Key];
	};
	const inputs: MutableDepsKeyInputs = {
		lockfile,
		workspace: readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
		patches: patchFiles(root),
		manifests,
		platform,
	};
	if (npmrc !== undefined) inputs.npmrc = npmrc;
	if (pnpmfile !== undefined) inputs.pnpmfile = pnpmfile;
	return inputs;
}

export function depsContextPaths(root: string): string[] {
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	return [
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		...listWorkspaceImporters(lockfile).map(importerManifestPath),
		...(optionalFile(root, ".npmrc") === undefined ? [] : [".npmrc"]),
		...(optionalFile(root, ".pnpmfile.cjs") === undefined
			? []
			: [".pnpmfile.cjs"]),
		...Object.keys(patchFiles(root)).sort(),
		DEPS_LAYER_BUCKET_SCRIPT_PATH,
	];
}

export function readDepsContextFiles(
	root: string,
): Readonly<Record<string, string>> {
	const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
	const manifests = new Set(
		listWorkspaceImporters(lockfile).map(importerManifestPath),
	);
	return Object.fromEntries(
		depsContextPaths(root).map((path) => {
			const contents = readFileSync(join(root, path), "utf8");
			return [
				path,
				manifests.has(path)
					? normalizeDepsManifest(contents, path === importerManifestPath("."))
					: contents,
			];
		}),
	);
}

export function depsKeyForRoot(
	root: string,
	platform: string,
	toolchainVersion = ciRunnerImageVersion(root),
): string {
	return depsKeyFromInputs({
		...readDepsInputs(root, platform),
		toolchainVersion,
	});
}
