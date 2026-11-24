import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";
import { readStdin } from "../lib/read-stdin.mts";
import { affectedLanes } from "./affected-lanes.mts";

export type JobScope =
	| { readonly run: true; readonly reason: string }
	| { readonly run: false; readonly reason: string };

export type Workspace = Readonly<{
	dir: string;
	name: string;
	dependencies: readonly string[];
}>;

export type Tree = Readonly<{
	read: (path: string) => string | undefined;
	isFile: (path: string) => boolean;
	workspaces: readonly Workspace[];
}>;

export const CI_INPUTS: readonly RegExp[] = [
	/^\.github\//,
	/^mise\.lock$/,
	/^\.gitmodules$/,
	/^external\//,
	/^tools\/pins\//,
	/^vitest\.config\.[^/]+$/,
	/^scripts\/ci\/(job-scope|affected-lanes)\.mts$/,
	/^scripts\/test\/release-integration-job\.test\.ts$/,
	/^scripts\/lib\/read-stdin\.mts$/,
	/^packages\/ci-gh-actions\/deploy\/ci-runner\//,
	/^scripts\/(lib\/ci-runner-contract|ci-runner-preflight)\.mts$/,
];
export const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const STATIC_IMPORT =
	/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:(["'])([^"'\n]+)\1\s*\))?/g;
const MODULE_URL =
	/\bnew\s+URL\(\s*["'](\.[^"'\n]*)["']\s*,\s*import\.meta\.url/g;

export function candidates(base: string): string[] {
	const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
	if (stem !== base)
		return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`];
	return [
		base,
		`${base}.ts`,
		`${base}.tsx`,
		`${base}.mts`,
		`${base}.js`,
		`${base}/index.ts`,
		`${base}/index.js`,
	];
}

export function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? "");
}

export function literalSpecifiers(source: string): string[] {
	return [
		...[...source.matchAll(STATIC_IMPORT)].map((match) => match[1]),
		...[...source.matchAll(MODULE_URL)].map((match) => match[1]),
		...[...source.matchAll(DYNAMIC_IMPORT)].map((match) => match[2]),
	].filter((specifier): specifier is string => Boolean(specifier));
}

export function reach(
	entries: readonly string[],
	tree: Tree,
): { files: Set<string>; dirs: Set<string> } | { unscoped: string } {
	const byName = new Map(tree.workspaces.map((ws) => [ws.name, ws]));
	const byDepth = [...tree.workspaces].sort(
		(a, b) => b.dir.length - a.dir.length,
	);
	const files = new Set<string>();
	const dirs = new Set<string>();
	const addPackage = (ws: Workspace) => {
		if (dirs.has(ws.dir)) return;
		dirs.add(ws.dir);
		for (const dependency of ws.dependencies) {
			const next = byName.get(dependency);
			if (next) addPackage(next);
		}
	};
	const queue = [...entries];
	const seen = new Set<string>();
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (seen.has(file)) continue;
		seen.add(file);
		const owner = byDepth.find((ws) => file.startsWith(`${ws.dir}/`));
		if (owner) addPackage(owner);
		else files.add(file);
		if (!CODE.test(file)) continue;
		const source = tree.read(file);
		if (source === undefined) return { unscoped: `cannot read ${file}` };
		if ([...source.matchAll(DYNAMIC_IMPORT)].some((match) => !match[2]))
			return { unscoped: `computed import() in ${file}` };
		for (const specifier of literalSpecifiers(source)) {
			if (specifier.startsWith(".")) {
				const base = posix.normalize(
					posix.join(posix.dirname(file), specifier),
				);
				if (base.startsWith("../"))
					return { unscoped: `${file} imports outside the repository` };
				const target = candidates(base).find((path) => tree.isFile(path));
				if (target) queue.push(target);
				else if (!owner || !base.startsWith(`${owner.dir}/`))
					return { unscoped: `cannot resolve ${specifier} from ${file}` };
				continue;
			}
			const ws = byName.get(packageName(specifier));
			if (ws) addPackage(ws);
		}
	}
	return { files, dirs };
}

export function jobScope(
	changedPaths: readonly string[],
	entries: readonly string[],
	tree: Tree,
): JobScope {
	const changed = changedPaths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	if (changed.length === 0)
		return { run: true, reason: "empty diff (base unresolved?)" };
	const outside = changed.filter(
		(path) => !tree.workspaces.some((ws) => path.startsWith(`${ws.dir}/`)),
	);
	const lanes = affectedLanes(outside, tree.isFile);
	if (outside.length > 0 && lanes.mode === "all")
		return { run: true, reason: lanes.reason };
	const always = changed.find((path) =>
		CI_INPUTS.some((pattern) => pattern.test(path)),
	);
	if (always)
		return { run: true, reason: `CI or pin input changed: ${always}` };
	const reached = reach(entries, tree);
	if ("unscoped" in reached) return { run: true, reason: reached.unscoped };
	const hit = changed.find(
		(path) =>
			reached.files.has(path) ||
			[...reached.dirs].some((dir) => path.startsWith(`${dir}/`)),
	);
	if (hit)
		return {
			run: true,
			reason: `${hit} is reached from ${entries.join(", ")}`,
		};
	return {
		run: false,
		reason: `no changed path reaches ${entries.join(", ")} (${reached.dirs.size} package(s), ${reached.files.size} file(s))`,
	};
}

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

const tag = (value: Json | undefined): string =>
	Object.prototype.toString.call(value);
function isObject(value: Json | undefined): value is JsonObject {
	return tag(value) === "[object Object]";
}
function isString(value: Json | undefined): value is string {
	return tag(value) === "[object String]";
}

function dependencyNames(manifest: JsonObject): string[] {
	return [
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	].flatMap((field) => {
		const block = manifest[field];
		return isObject(block) ? Object.keys(block) : [];
	});
}

function directories(path: string): string[] {
	try {
		return readdirSync(path, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => posix.join(path, entry.name));
	} catch {
		return [];
	}
}

export function readWorkspaces(): Workspace[] {
	const yaml = readFileSync("pnpm-workspace.yaml", "utf8");
	const block = /^packages:\n((?:[ \t]+-[^\n]*\n)+)/m.exec(yaml)?.[1] ?? "";
	const patterns = [...block.matchAll(/-\s*["']?([^"'\n]+?)["']?\s*$/gm)]
		.map((match) => match[1] ?? "")
		.filter((pattern) => pattern !== "" && !pattern.startsWith("!"));
	const workspaces: Workspace[] = [];
	for (const pattern of patterns) {
		let dirs = ["."];
		for (const segment of pattern.split("/"))
			dirs =
				segment === "*"
					? dirs.flatMap(directories)
					: dirs.map((dir) => posix.join(dir, segment));
		for (const dir of dirs) {
			const path = posix.join(dir, "package.json");
			if (!existsSync(path)) continue;
			const manifest: Json = JSON.parse(readFileSync(path, "utf8"));
			if (!isObject(manifest) || !isString(manifest.name)) continue;
			workspaces.push({
				dir,
				name: manifest.name,
				dependencies: dependencyNames(manifest),
			});
		}
	}
	return workspaces;
}

export function diskTree(): Tree {
	return {
		read: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		isFile: (path) => {
			try {
				return statSync(path).isFile();
			} catch {
				return false;
			}
		},
		workspaces: readWorkspaces(),
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const entries = process.argv.slice(2);
	if (entries.length === 0) {
		console.error("usage: job-scope.mts <entry file>... < changed-paths");
		process.exit(2);
	}
	const input = readStdin();
	const scope = jobScope(input.split("\n"), entries, diskTree());
	console.error(`job-scope: ${scope.run ? "run" : "skip"} (${scope.reason})`);
	process.stdout.write(`run=${scope.run}\n`);
}
