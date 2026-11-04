import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ciRunnerImageVersion } from "./ci-runner-contract.mts";

export type DepsKeyInputs = Readonly<{
	lockfile: string;
	workspace: string;
	npmrc?: string;
	pnpmfile?: string;
	patches: Readonly<Record<string, string>>;
	manifests: Readonly<Record<string, string>>;
	miseLock: string;
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

function miseToolEntries(miseLock: string): string[] {
	const entries: string[] = [];
	let selected = false;
	for (const line of miseLock.split(/\r?\n/)) {
		const tool = line.match(/^\[\[tools\.([A-Za-z0-9_-]+)\]\]\s*$/)?.[1];
		if (tool !== undefined) selected = tool === "node" || tool === "pnpm";
		if (selected) entries.push(line);
	}
	for (const tool of ["node", "pnpm"]) {
		if (!entries.some((line) => line === `[[tools.${tool}]]`))
			throw new Error(`mise.lock has no ${tool} entry`);
	}
	return entries;
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
	for (const path of Object.keys(inputs.patches).sort())
		updateHash(hash, path, inputs.patches[path]!);
	for (const importer of listWorkspaceImporters(inputs.lockfile)) {
		const path = importerManifestPath(importer);
		const manifest = inputs.manifests[path];
		if (manifest === undefined)
			throw new Error(`missing importer manifest: ${path}`);
		updateHash(hash, path, manifest);
	}
	updateHash(
		hash,
		"mise.lock:node+pnpm",
		`${miseToolEntries(inputs.miseLock).join("\n")}\n`,
	);
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
	const inputs: Omit<DepsKeyInputs, "toolchainVersion"> = {
		lockfile,
		workspace: readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
		patches: patchFiles(root),
		manifests,
		miseLock: readFileSync(join(root, "mise.lock"), "utf8"),
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
	];
}

export function depsKeyForRoot(root: string, platform: string): string {
	return depsKeyFromInputs({
		...readDepsInputs(root, platform),
		toolchainVersion: ciRunnerImageVersion(root),
	});
}
