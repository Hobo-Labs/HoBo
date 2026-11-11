/**
 * Decide whether a PR job whose whole subject is a few entry files can skip its
 * install and work because the diff cannot reach them.
 *
 * The job runs when the diff touches a workspace-wide input (see
 * affected-lanes.mts), CI configuration, the sibling pins or submodules, the
 * runner image, or anything the entry files reach: every file in their
 * relative-import closure (`new URL("./x", import.meta.url)` included) and,
 * for each workspace package that closure enters or imports by name, the whole
 * package directory plus its workspace dependencies. Anything the walk cannot
 * follow (a computed `import()`, an unresolvable relative import, a missing
 * entry) runs the job.
 *
 * Node builtins only: it runs before `pnpm install`, which is what it decides.
 *
 * CLI: `git diff --name-only HEAD^1 HEAD | node --experimental-strip-types scripts/ci/job-scope.mts <entry>...`
 * prints `run=true` or `run=false` (for $GITHUB_OUTPUT) and the reason on stderr.
 */
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

/** Repository access, injectable so tests can describe a tree in memory. */
export type Tree = Readonly<{
	read: (path: string) => string | undefined;
	isFile: (path: string) => boolean;
	workspaces: readonly Workspace[];
}>;

const ALWAYS = [
	/^\.github\//,
	/^mise\.lock$/,
	/^\.gitmodules$/,
	/^external\//,
	/^tools\/pins\//,
	/^vitest\.config\.[^/]+$/,
	/^scripts\/ci\/(job-scope|affected-lanes)\.mts$/,
	/^scripts\/lib\/read-stdin\.mts$/,
	// The runner image the jobs and the cold dev loop's container run in.
	/^packages\/ci-gh-actions\/deploy\/ci-runner\//,
	/^scripts\/(lib\/ci-runner-contract|ci-runner-preflight)\.mts$/,
];
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const STATIC_IMPORT =
	/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:(["'])([^"'\n]+)\1\s*\))?/g;
const MODULE_URL =
	/\bnew\s+URL\(\s*["'](\.[^"'\n]*)["']\s*,\s*import\.meta\.url/g;

function candidates(base: string): string[] {
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

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? "");
}

/**
 * Every repository path the entry files reach, as exact files and package
 * directories, or the reason the walk had to give up.
 */
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
		const specifiers: string[] = [];
		for (const match of source.matchAll(STATIC_IMPORT))
			if (match[1]) specifiers.push(match[1]);
		for (const match of source.matchAll(MODULE_URL))
			if (match[1]) specifiers.push(match[1]);
		for (const match of source.matchAll(DYNAMIC_IMPORT)) {
			if (!match[2]) return { unscoped: `computed import() in ${file}` };
			specifiers.push(match[2]);
		}
		for (const specifier of specifiers) {
			if (specifier.startsWith(".")) {
				const base = posix.normalize(
					posix.join(posix.dirname(file), specifier),
				);
				if (base.startsWith("../"))
					return { unscoped: `${file} imports outside the repository` };
				const target = candidates(base).find((path) => tree.isFile(path));
				if (target) queue.push(target);
				// Inside its own package the target is covered by the package
				// directory, even when it is generated or only quoted in a template.
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
	// A path in any workspace package is judged by the walk, not by
	// affected-lanes.
	const outside = changed.filter(
		(path) => !tree.workspaces.some((ws) => path.startsWith(`${ws.dir}/`)),
	);
	const lanes = affectedLanes(outside, tree.isFile);
	if (outside.length > 0 && lanes.mode === "all")
		return { run: true, reason: lanes.reason };
	const always = changed.find((path) =>
		ALWAYS.some((pattern) => pattern.test(path)),
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

/** Workspace packages named by `pnpm-workspace.yaml` (literal and `*` segments). */
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

if (import.meta.url === `file://${process.argv[1]}`) {
	const entries = process.argv.slice(2);
	if (entries.length === 0) {
		console.error("usage: job-scope.mts <entry file>... < changed-paths");
		process.exit(2);
	}
	const input = readStdin();
	const tree: Tree = {
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
	const scope = jobScope(input.split("\n"), entries, tree);
	console.error(`job-scope: ${scope.run ? "run" : "skip"} (${scope.reason})`);
	process.stdout.write(`run=${scope.run}\n`);
}
