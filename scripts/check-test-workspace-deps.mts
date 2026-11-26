#!/usr/bin/env node
/**
 * Every workspace package a test loads must be built before the turbo task
 * that runs the test.
 *
 * turbo orders a task only on what `turbo.json` and `package.json` say. A test
 * that loads a sibling package — by name (`@hobo/runtime-local`) or by a
 * relative path into the sibling's directory
 * (`../../../runtimes/runtime-local/dist/actor-host/in-memory.js`) — passes
 * only when something else happened to build that sibling first, and fails on
 * a clean checkout or a filtered run. This check finds those imports.
 *
 * - Scope: the workspace packages under `packages/`, `examples/` and
 *   `src/draft/` that have the script for the task.
 * - Files: everything under a `test/`, `tests/` or `__tests__/` directory
 *   (fixtures and helpers included), `*.test.*` and `*.spec.*` anywhere, and
 *   `vitest*.config.*`; and every file those import by a relative path,
 *   transitively, in their own package (`src/`, `services/`, anything) or in a
 *   sibling's source. In a git repository only tracked files are read.
 * - A relative import that lands on a tracked source file needs no build of
 *   the package it is in: the test runs it as written, and what it loads is
 *   checked in turn. One that lands on a path git does not track (`dist/`)
 *   needs that package built, as a by-name import does.
 * - Tasks: every test file runs under `test`; a file under
 *   `contracts/consumer/` or `contracts/provider/` also runs under
 *   `test:contract:consumer` / `test:contract:provider` where the package has
 *   that script. A file a test loads runs under every task of the files that
 *   import it, so a `test/` helper a `contracts/consumer/` test imports is
 *   checked under `test:contract:consumer` too, and a sibling's source under
 *   the importing package's tasks. Each task must have every build such a
 *   file needs (lib/turbo-task-graph); a task's own package is built where the
 *   task needs it.
 * - A type-only import counts only in a file of the task's own package that
 *   its tsconfig compiles: anywhere else it is erased before the test runs.
 * - Imports are read from the syntax tree (lib/test-import-specifiers). A
 *   specifier computed at run time cannot be read.
 * - A path a loaded file assembles at run time that names another package's
 *   build output directory (its tsconfig `outDir`, else `dist/`), or ends at
 *   its directory in a file that spawns, links, copies or loads by a computed
 *   path, or does either for a package it names by a computed segment
 *   (`join(root, "packages", name, "dist")`), fails unless
 *   `scripts/test-deps-runtime-reaches.json` declares what the file needs.
 *   lib/test-runtime-reaches says exactly which paths count, and which it
 *   cannot see: a path assembled across files or behind a name, one with no
 *   literal anchor, and what a child process loads. Every test task that loads a declared file must have those builds, and a
 *   declaration no test task reaches, that names no workspace package, or
 *   whose needs name no package other than that of some task that loads the
 *   file (an empty `needs`), fails too, as does a file declared twice, and one whose needs
 *   leave out a package the reader sees it reach (a need the reader sees no
 *   reach for may stand: it cannot see every reach). A path rooted at a
 *   temporary directory is a stub tree, and needs no build; a file whose only
 *   reaches are stubs is declared `{ "from", "stubOnly": true, "reason" }`,
 *   which fails if the reader sees it reach anything outside a temporary
 *   root.
 * - A declaration orders the sibling's build only with a `workspace:`
 *   specifier, unless pnpm's link-workspace-packages is on
 *   (lib/turbo-task-graph `orderedDependency`); a violation says how the
 *   package declared the sibling, and which file sets the setting or which
 *   default applies.
 * - What it does not model fails, naming the file and why, rather than
 *   passing unseen: a `catalog:` specifier that may name a workspace package;
 *   with link-workspace-packages on, a version range or tag on one; a
 *   submodule inside a submodule, or one git cannot list; and an undeclared
 *   runtime reach (above).
 * - Files git tracks that the checkout leaves out (a sparse checkout, or a
 *   submodule never initialised) cannot be read: a manifest, a test file, or
 *   any file the follow reaches. The check names how many it skipped and
 *   passes with a warning; under `--strict`, or in CI (`CI` set,
 *   and not `0` or `false`), it fails instead.
 *
 * Fix one by declaring the sibling in `devDependencies` as `"workspace:*"`
 * where the test imports it by name, or, for a relative import (which needs no
 * declaration to resolve), by naming its build on the task:
 * `"@hobo/runtime#test": { "dependsOn": ["build", "@hobo/runtime-local#build"] }`.
 * A devDependency widens the package's own `build` and `typecheck`, and every
 * dependent's; a task override orders that task only. A runtime reach is fixed
 * the same way, once its declaration says which builds it needs.
 *
 * Usage: node --import tsx scripts/check-test-workspace-deps.mts [--json] [--strict] [--root <dir>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { GIT_OUTPUT_MAX_BUFFER } from "./lib/git-output.ts";
import { type ModuleFacts, readModule } from "./lib/test-import-specifiers.mts";
import {
	parseRuntimeReaches,
	RUNTIME_REACHES_FILE,
	type RuntimeReaches,
	runtimeReachReader,
	shownPath,
} from "./lib/test-runtime-reaches.mts";
import {
	catalogValues,
	type GraphPackage,
	type LinkWorkspacePackages,
	linkWorkspacePackages,
	orderedDependency,
	type TaskConfig,
	TurboTaskGraph,
	UnreadYaml,
	type WorkspaceIndex,
} from "./lib/turbo-task-graph.mts";

export interface Violation {
	/** The importing package's name. */
	readonly package: string;
	/** The test file, relative to the repository root. */
	readonly file: string;
	/** The turbo task that runs the file. */
	readonly task: string;
	/** The workspace package it reaches. */
	readonly imports: string;
	/** The specifier as written. */
	readonly specifier: string;
	/**
	 * Where the package declares the sibling in a field turbo orders and turbo
	 * does not count the declaration: the specifier, and why. Else undefined.
	 */
	readonly declared: string | undefined;
}

/** What a checkout leaves out, which the check cannot read. */
export interface Skipped {
	/** Tracked files the check reads that are not on disk (a sparse checkout, or deleted). */
	readonly files: readonly string[];
	/** Submodules with no checkout, none of whose files git lists. */
	readonly submodules: readonly string[];
}

/** A declaration or a checkout this check does not model, so it fails rather than guesses. */
export interface Unmodelled {
	/** The manifest that declares it, or the nested submodule's path. */
	readonly file: string;
	readonly reason: string;
}

export interface Report {
	readonly violations: readonly Violation[];
	readonly unmodelled: readonly Unmodelled[];
	/** Declarations in the runtime-reach registry that no longer hold. */
	readonly stale: readonly Unmodelled[];
	readonly skipped: Skipped;
}

export interface CheckOptions {
	/** Repository-relative paths to read; by default git's tracked files, or a walk outside a repository. */
	readonly files?: readonly string[];
}

interface Manifest {
	readonly name?: string;
	readonly version?: string;
	readonly packageManager?: string;
	readonly scripts?: Readonly<Record<string, string>>;
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface WorkspacePackage extends GraphPackage {
	/** Repository-relative, `/`-separated. */
	readonly dir: string;
	/** Its `build` script, if it has one. */
	readonly build: string | undefined;
	/** Workspace packages it declares in an ordering field with a specifier turbo does not count, and why. */
	readonly unordered: ReadonlyMap<string, string>;
}

/** The workspace as turbo sees it. */
export interface Workspace {
	readonly packages: readonly WorkspacePackage[];
	readonly graph: TurboTaskGraph;
	readonly link: LinkWorkspacePackages;
	/** Declarations whose ordering this check cannot tell. */
	readonly unmodelled: readonly Unmodelled[];
}

const ORDERING_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
] as const;

const SCOPES = ["packages/", "examples/", "src/draft/"];
const CONTRACT_TASKS = [
	["contracts/consumer/", "test:contract:consumer"],
	["contracts/provider/", "test:contract:provider"],
] as const;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_NAME = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const VITEST_CONFIG = /^vitest[^/]*\.config\.[cm]?[jt]s$/u;
const TEST_DIRS = new Set(["test", "tests", "__tests__"]);
const WALK_SKIP = new Set([
	"node_modules",
	".git",
	"dist",
	"coverage",
	".turbo",
]);

function readJson<T>(path: string): T | undefined {
	try {
		// SAFETY: the callers read only the fields their type names, each optional.
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function walk(root: string, dir = ""): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
		if (WALK_SKIP.has(entry.name)) continue;
		const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
		if (entry.isDirectory()) out.push(...walk(root, path));
		else if (entry.isFile()) out.push(path);
	}
	return out;
}

/**
 * git's tracked files (submodules' included) when `root` is a work tree's top,
 * else undefined; the submodules that are not checked out; and any submodule
 * inside a checked-out one, which this check does not model.
 */
function trackedFiles(root: string):
	| {
			files: string[];
			submodules: string[];
			nested: Unmodelled[];
	  }
	| undefined {
	try {
		const git = (cwd: string, args: string[]) =>
			execFileSync("git", ["-C", cwd, ...args], {
				encoding: "utf8",
				maxBuffer: GIT_OUTPUT_MAX_BUFFER,
				stdio: ["ignore", "pipe", "ignore"],
			});
		if (
			realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !==
			realpathSync(root)
		)
			return undefined;
		// `<mode> <object> <stage>\t<path>`; a gitlink is mode 160000.
		const gitlinks = (dir: string) =>
			git(dir, ["ls-files", "-z", "--stage"])
				.split("\0")
				.filter((line) => line.startsWith("160000 "))
				.map((line) => line.slice(line.indexOf("\t") + 1));
		const top = gitlinks(root);
		const checkedOut = top.filter((path) =>
			existsSync(join(root, path, ".git")),
		);
		return {
			files: git(root, ["ls-files", "-z", "--recurse-submodules"])
				.split("\0")
				.filter(Boolean),
			submodules: top.filter((path) => !checkedOut.includes(path)),
			nested: checkedOut.flatMap((path): Unmodelled[] => {
				try {
					return gitlinks(join(root, path)).map((inner) => ({
						file: `${path}/${inner}`,
						reason: `a submodule inside the submodule ${path}, which this check does not model`,
					}));
				} catch {
					return [
						{
							file: path,
							reason:
								"a submodule git cannot list, so this check cannot tell what is inside it",
						},
					];
				}
			}),
		};
	} catch {
		return undefined;
	}
}

/** The `packages:` globs of pnpm-workspace.yaml (`*` segments, as this repository writes them). */
function workspaceGlobs(root: string): string[][] {
	const globs: string[][] = [];
	let inPackages = false;
	for (const line of readFileSync(
		join(root, "pnpm-workspace.yaml"),
		"utf8",
	).split("\n")) {
		if (line.startsWith("packages:")) {
			inPackages = true;
			continue;
		}
		if (!inPackages) continue;
		const match = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/u.exec(line);
		if (match?.[1] && !match[1].startsWith("!"))
			globs.push(match[1].split("/"));
		else if (/^\S/u.test(line)) break;
	}
	return globs;
}

function matches(glob: readonly string[], dir: string): boolean {
	const parts = dir.split("/");
	return (
		glob.length === parts.length &&
		glob.every((part, i) => part === "*" || part === parts[i])
	);
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** The workspace packages among `files`, their dependencies as turbo orders them, and the graph over them. */
export function readWorkspace(
	root: string,
	files: readonly string[],
): Workspace {
	const globs = workspaceGlobs(root);
	const listed = new Set(files);
	const found: { dir: string; manifest: Manifest }[] = [];
	for (const file of files) {
		if (!file.endsWith("/package.json")) continue;
		const dir = file.slice(0, -"/package.json".length);
		if (!globs.some((glob) => matches(glob, dir))) continue;
		const manifest = readJson<Manifest>(join(root, file));
		if (manifest?.name) found.push({ dir, manifest });
	}
	const workspaceYaml = readText(join(root, "pnpm-workspace.yaml")) ?? "";
	// A catalog entry with a workspace: specifier can order a build under any key.
	const unmodelled: Unmodelled[] = [];
	let catalogNamesWorkspace: boolean;
	try {
		catalogNamesWorkspace = catalogValues(workspaceYaml).some((value) =>
			value.includes("workspace:"),
		);
	} catch (error) {
		if (!(error instanceof UnreadYaml)) throw error;
		// It cannot tell, so it fails, and holds any catalog to it.
		unmodelled.push({ file: "pnpm-workspace.yaml", reason: error.message });
		catalogNamesWorkspace = true;
	}
	const link = linkWorkspacePackages({
		packageManager: readJson<Manifest>(join(root, "package.json"))
			?.packageManager,
		npmrc: readText(join(root, ".npmrc")),
		workspaceYaml,
	});
	const names = new Set(found.map((item) => item.manifest.name!));
	const atDir = new Map(found.map((item) => [item.dir, item.manifest.name!]));
	const versions = new Map(
		found.map((item) => [item.manifest.name!, item.manifest.version]),
	);
	const packages = found.map(({ dir, manifest }): WorkspacePackage => {
		const index: WorkspaceIndex = {
			byName: (name) => (names.has(name) ? name : undefined),
			versionOf: (name) => versions.get(name),
			catalogNamesWorkspace,
			// From the dependent's directory, else (as turbo also tries) from the root.
			byPath: (path) =>
				atDir.get(posix.normalize(posix.join(dir, path))) ??
				atDir.get(posix.normalize(path)),
			inside: (path) => {
				const target = posix.normalize(posix.join(dir, path));
				return (
					posix.isAbsolute(path) ||
					(target !== ".." && !target.startsWith("../"))
				);
			},
		};
		const dependencies: string[] = [];
		const unordered = new Map<string, string>();
		for (const field of ORDERING_FIELDS)
			for (const [key, specifier] of Object.entries(manifest[field] ?? {})) {
				if (
					!specifier.startsWith("workspace:") &&
					!specifier.startsWith("catalog:") &&
					!names.has(key)
				)
					continue;
				const ordered = orderedDependency(key, specifier, link, index);
				if (ordered.kind === "ordered") dependencies.push(ordered.target);
				else if (ordered.kind === "unmodelled")
					unmodelled.push({
						file: `${dir}/package.json`,
						reason: `"${key}": "${specifier}", ${ordered.reason}`,
					});
				else if (names.has(key)) unordered.set(key, ordered.reason);
			}
		return {
			name: manifest.name!,
			dir,
			build: manifest.scripts?.build,
			scripts: new Set(Object.keys(manifest.scripts ?? {})),
			dependencies,
			unordered,
			tasks: listed.has(`${dir}/turbo.json`)
				? readJson<{ tasks?: Record<string, TaskConfig> }>(
						join(root, dir, "turbo.json"),
					)?.tasks
				: undefined,
		};
	});
	const graph = new TurboTaskGraph(
		new Map(packages.map((pkg) => [pkg.name, pkg])),
		readJson<{ tasks?: Record<string, TaskConfig> }>(join(root, "turbo.json"))
			?.tasks ?? {},
	);
	return { packages, graph, link, unmodelled };
}

/** Whether `path` (relative to its package) is a test file, a test helper or a vitest config. */
function isTestFile(path: string): boolean {
	if (!SOURCE.test(path) || path.endsWith(".d.ts")) return false;
	const parts = path.split("/");
	const name = parts.at(-1)!;
	return (
		(parts.length === 1 && VITEST_CONFIG.test(name)) ||
		TEST_NAME.test(name) ||
		parts.slice(0, -1).some((part) => TEST_DIRS.has(part))
	);
}

/** The tasks that run `path` (relative to its package) by where it is, or none. */
function tasksRunning(path: string, scripts: ReadonlySet<string>): string[] {
	if (!isTestFile(path)) return [];
	const config = !path.includes("/") && VITEST_CONFIG.test(path);
	const tasks = scripts.has("test") ? ["test"] : [];
	for (const [prefix, task] of CONTRACT_TASKS)
		if ((config || path.includes(prefix)) && scripts.has(task))
			tasks.push(task);
	return tasks;
}

const RESOLVE_SUFFIXES = [
	"",
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".mjs",
	".cjs",
	".jsx",
	"/index.ts",
	"/index.tsx",
	"/index.js",
];

/** The TypeScript sources a compiled extension stands for, as vite and TypeScript map them. */
const SOURCES_FOR: readonly (readonly [RegExp, readonly string[]])[] = [
	[/\.js$/u, [".ts", ".tsx"]],
	[/\.jsx$/u, [".tsx"]],
	[/\.mjs$/u, [".mts"]],
	[/\.cjs$/u, [".cts"]],
];

/** The listed file a relative import of `path` loads: its TypeScript source, as written, or with an extension or `/index` added. */
function resolveLocal(
	path: string,
	files: ReadonlySet<string>,
): string | undefined {
	const candidates = [
		...SOURCES_FOR.flatMap(([extension, sources]) =>
			extension.test(path)
				? sources.map((source) => path.replace(extension, source))
				: [],
		),
		...RESOLVE_SUFFIXES.map((suffix) => path + suffix),
	];
	return candidates.find((candidate) => files.has(candidate));
}

function isRelative(specifier: string): boolean {
	return (
		specifier === "." ||
		specifier === ".." ||
		specifier.startsWith("./") ||
		specifier.startsWith("../")
	);
}

/** Reads a tsconfig and what it extends, listing no files: only its options are wanted. */
const OPTIONS_ONLY: ts.ParseConfigHost = {
	...ts.sys,
	readDirectory: () => [],
};

/** The tsconfig files a build script compiles with (`tsc -p <file>`), else `tsconfig.json`. */
function buildProjects(build: string | undefined): string[] {
	const named = [
		...(build ?? "").matchAll(
			/(?:^|\s)(?:-p|--project|-b|--build)\s+([^\s&|;-][^\s&|;]*)/gu,
		),
	].map((match) => match[1]!);
	return named.length > 0 ? named : ["tsconfig.json"];
}

/**
 * A package's build output directories, each one segment under it: the first
 * segment of the `outDir` of each tsconfig its build compiles with (following
 * `extends`), else `dist`, the default of tsc's configs here, vite and astro.
 */
function outputDirs(
	root: string,
	dir: string,
	build: string | undefined,
): string[] {
	const base = join(root, dir);
	const out = new Set<string>();
	for (const project of buildProjects(build)) {
		const path = resolve(
			base,
			project.endsWith(".json") ? project : join(project, "tsconfig.json"),
		);
		const read = ts.readConfigFile(path, ts.sys.readFile);
		if (read.config === undefined) continue;
		const outDir = ts.parseJsonConfigFileContent(
			read.config,
			OPTIONS_ONLY,
			dirname(path),
			undefined,
			path,
		).options.outDir;
		if (outDir === undefined) continue;
		const first = relative(base, outDir).split(sep)[0];
		if (first && first !== ".." && !isAbsolute(first)) out.add(first);
	}
	return out.size > 0 ? [...out] : ["dist"];
}

/** Whether the package's tsconfig compiles `file` (an absolute path). */
function compiledBy(
	root: string,
	pkg: WorkspacePackage,
	cache: Map<string, Set<string>>,
	file: string,
): boolean {
	let names = cache.get(pkg.dir);
	if (names === undefined) {
		names = new Set<string>();
		const dir = join(root, pkg.dir);
		const configPath = join(dir, "tsconfig.json");
		const read = ts.readConfigFile(configPath, ts.sys.readFile);
		if (read.config !== undefined)
			for (const name of ts.parseJsonConfigFileContent(
				read.config,
				ts.sys,
				dir,
				undefined,
				configPath,
			).fileNames)
				names.add(resolve(name));
		cache.set(pkg.dir, names);
	}
	return names.has(resolve(file));
}

/** The violations under `root` (see the header). */
export function checkTestWorkspaceDeps(
	root: string,
	options: CheckOptions = {},
): Violation[] {
	return [...scanTestWorkspaceDeps(root, options).violations];
}

/** The tracked files under a workspace package that the check reads and that are not on disk. */
function missingFiles(
	root: string,
	files: readonly string[],
	isPackageDir: (dir: string) => boolean,
): string[] {
	const missing = files.filter(
		(file) =>
			(SOURCE.test(file) ||
				file.endsWith("/package.json") ||
				file.endsWith("/turbo.json")) &&
			!existsSync(join(root, file)),
	);
	if (missing.length === 0) return [];
	const dirs = files
		.filter((file) => file.endsWith("/package.json"))
		.map((file) => file.slice(0, -"/package.json".length))
		.filter(isPackageDir)
		.sort((a, b) => b.length - a.length);
	return missing.filter((file) => {
		const dir = dirs.find((item) => file.startsWith(`${item}/`));
		if (dir === undefined) return false;
		const path = file.slice(dir.length + 1);
		return (
			path === "package.json" ||
			path === "turbo.json" ||
			(SCOPES.some((scope) => dir.startsWith(scope)) && isTestFile(path))
		);
	});
}

/** The violations under `root`, what it cannot model, and what the checkout left out (see the header). */
export function scanTestWorkspaceDeps(
	root: string,
	options: CheckOptions = {},
): Report {
	const tracked = options.files === undefined ? trackedFiles(root) : undefined;
	const files = options.files ?? tracked?.files ?? walk(root);
	const globs = workspaceGlobs(root);
	const workspace = readWorkspace(root, files);
	const { packages, graph } = workspace;
	const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
	const byDir = [...packages].sort((a, b) => b.dir.length - a.dir.length);
	const owners = new Map<string, WorkspacePackage | undefined>();
	const owner = (path: string): WorkspacePackage | undefined => {
		if (!owners.has(path))
			owners.set(
				path,
				byDir.find((pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`)),
			);
		return owners.get(path);
	};
	const tsconfigs = new Map<string, Set<string>>();
	const compiled = (pkg: WorkspacePackage, file: string) =>
		compiledBy(root, pkg, tsconfigs, join(root, file));
	const listed = new Set(files);
	const modules = new Map<string, ModuleFacts>();
	// Tracked files the follow reached and could not read: a sparse checkout.
	const unread = new Set<string>();
	const factsOf = (file: string): ModuleFacts => {
		let found = modules.get(file);
		if (found === undefined) {
			let source = "";
			try {
				source = readFileSync(join(root, file), "utf8");
			} catch {
				if (listed.has(file)) unread.add(file);
			}
			found = readModule(source, file);
			modules.set(file, found);
		}
		return found;
	};
	const specifiersOf = (file: string) => factsOf(file).imports;
	/**
	 * Where a relative specifier lands: a tracked source file, which runs as
	 * written and is followed; or a path in a package that git does not track
	 * (its build output), which needs that package built.
	 */
	const reach = (
		file: string,
		specifier: string,
	):
		| { readonly source: string }
		| { readonly built: WorkspacePackage }
		| undefined => {
		const path = posix.normalize(posix.join(posix.dirname(file), specifier));
		const local = resolveLocal(path, listed);
		if (local !== undefined)
			return SOURCE.test(local) &&
				!local.endsWith(".d.ts") &&
				owner(local) !== undefined
				? { source: local }
				: undefined;
		const target = owner(path);
		return target === undefined ? undefined : { built: target };
	};
	// The tasks that load each file, as `<package>#<task>`: a test file's by
	// where it is, and every file a loaded file imports by a relative path
	// inherits the tasks that load the importer (its package's helpers and
	// source, and a sibling's source).
	const tasks = new Map<string, { pkg: WorkspacePackage; task: string }>();
	const id = (pkg: WorkspacePackage, task: string) => {
		const key = `${pkg.name}#${task}`;
		if (!tasks.has(key)) tasks.set(key, { pkg, task });
		return key;
	};
	// A type-only import loads only under the file's own package's tasks, and
	// only where its tsconfig compiles the file; a test elsewhere erases it.
	const carries = (key: string, file: string, typeOnly: boolean) => {
		if (!typeOnly) return true;
		const pkg = tasks.get(key)!.pkg;
		return owner(file) === pkg && compiled(pkg, file);
	};
	const running = new Map<string, Set<string>>();
	for (const file of files) {
		const pkg = owner(file);
		if (pkg === undefined || !SCOPES.some((scope) => pkg.dir.startsWith(scope)))
			continue;
		const own = tasksRunning(file.slice(pkg.dir.length + 1), pkg.scripts);
		if (own.length > 0)
			running.set(file, new Set(own.map((task) => id(pkg, task))));
	}
	const queue = [...running.keys()];
	while (queue.length > 0) {
		const file = queue.pop()!;
		const loading = running.get(file)!;
		for (const { specifier, typeOnly } of specifiersOf(file)) {
			if (!isRelative(specifier)) continue;
			const landed = reach(file, specifier);
			if (landed === undefined || !("source" in landed)) continue;
			const inherited = running.get(landed.source) ?? new Set<string>();
			const before = inherited.size;
			for (const key of loading)
				if (!inherited.has(key) && carries(key, file, typeOnly))
					inherited.add(key);
			running.set(landed.source, inherited);
			if (inherited.size > before) queue.push(landed.source);
		}
	}
	const seen = new Set<string>();
	const violations: Violation[] = [];
	for (const [file, loading] of running) {
		for (const { specifier, typeOnly } of specifiersOf(file)) {
			let target: WorkspacePackage | undefined;
			if (isRelative(specifier)) {
				const landed = reach(file, specifier);
				if (landed === undefined || !("built" in landed)) continue;
				target = landed.built;
			} else {
				const parts = specifier.split("/");
				target = byName.get(
					specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!,
				);
			}
			if (target === undefined) continue;
			const needed = graph.needsBuilt(target.name);
			for (const key of loading) {
				const { pkg, task } = tasks.get(key)!;
				// A task builds its own package where it needs it (`test` on `build`).
				if (target === pkg) continue;
				const built = graph.buildsBefore(pkg.name, task);
				if (needed.every((name) => built.has(name))) continue;
				if (!carries(key, file, typeOnly)) continue;
				const unique = `${file}\0${key}\0${target.name}\0${specifier}`;
				if (seen.has(unique)) continue;
				seen.add(unique);
				violations.push({
					package: pkg.name,
					file,
					task,
					imports: target.name,
					specifier,
					declared: pkg.unordered.get(target.name),
				});
			}
		}
	}
	// Reaches made at run time by an assembled path: declared, or unmodelled.
	const registry = parseRuntimeReaches(
		readText(join(root, RUNTIME_REACHES_FILE)),
	);
	const declared = new Map(
		registry.reaches.map((entry) => [entry.from, entry]),
	);
	const readReaches = runtimeReachReader(
		packages.map(({ name, dir, build }) => ({
			name,
			dir,
			out: outputDirs(root, dir, build),
		})),
	);
	const reachedBy = new Map<string, RuntimeReaches>();
	const reachesOf = (file: string) => {
		let reached = reachedBy.get(file);
		if (reached === undefined) {
			reached = readReaches(factsOf(file), file);
			reachedBy.set(file, reached);
		}
		return reached;
	};
	const neededBuild = (need: string) => /^(.+)#build$/u.exec(need)?.[1];
	const undeclared = new Map<
		string,
		{ named: Map<string, string>; computed: string | undefined }
	>();
	const reachesAnother = new Set<string>();
	// A declared file's reaches its entry does not name the build of: a package
	// the reader sees, and the path that names it.
	const uncovered = new Map<string, Map<string, string>>();
	// A stubOnly file's first reach outside a temporary root: what, and the path.
	const notStub = new Map<string, readonly [string, string]>();
	for (const [file, loading] of running) {
		const { named, computed, stubs } = reachesOf(file);
		if (
			named.size === 0 &&
			computed === undefined &&
			stubs.named.size === 0 &&
			stubs.computed === undefined
		)
			continue;
		const entry = declared.get(file);
		for (const key of loading) {
			const { pkg, task } = tasks.get(key)!;
			// A computed segment may name any package, so it counts as another.
			const others = [...named].filter(([name]) => name !== pkg.name);
			const stubbed = [...stubs.named].filter(([name]) => name !== pkg.name);
			const real = others.length > 0 || computed !== undefined;
			if (!real && stubbed.length === 0 && stubs.computed === undefined)
				continue;
			reachesAnother.add(file);
			if (entry === undefined) {
				// A stub reach needs an entry too: the reader may misjudge a root.
				const found = undeclared.get(file) ?? {
					named: new Map<string, string>(),
					computed: computed ?? stubs.computed,
				};
				for (const [name, text] of [...others, ...stubbed])
					if (!found.named.has(name)) found.named.set(name, text);
				undeclared.set(file, found);
				continue;
			}
			if ("stubOnly" in entry) {
				const [first] = others;
				if (real && !notStub.has(file))
					notStub.set(
						file,
						first ?? [
							"a package it names by a computed segment",
							computed ?? "",
						],
					);
				continue;
			}
			// A stub tree needs no build, so only a real reach must be a need.
			for (const [name, text] of others)
				if (!entry.needs.includes(`${name}#build`)) {
					const missing = uncovered.get(file) ?? new Map<string, string>();
					if (!missing.has(name)) missing.set(name, text);
					uncovered.set(file, missing);
				}
			const built = graph.buildsBefore(pkg.name, task);
			for (const need of entry.needs) {
				const name = neededBuild(need);
				if (name === undefined || !byName.has(name) || name === pkg.name)
					continue;
				if (graph.needsBuilt(name).every((item) => built.has(item))) continue;
				const unique = `${file}\0${key}\0${name}\0runtime`;
				if (seen.has(unique)) continue;
				seen.add(unique);
				violations.push({
					package: pkg.name,
					file,
					task,
					imports: name,
					specifier: `declared in ${RUNTIME_REACHES_FILE}`,
					declared: undefined,
				});
			}
		}
	}
	const stale: Unmodelled[] = registry.problems.map((reason) => ({
		file: RUNTIME_REACHES_FILE,
		reason,
	}));
	const staleness = (reason: string) =>
		stale.push({ file: RUNTIME_REACHES_FILE, reason });
	for (const entry of registry.reaches) {
		const { from } = entry;
		if (!listed.has(from)) staleness(`"${from}" is not a tracked file`);
		else if (!running.has(from))
			staleness(`"${from}" is loaded by no test task`);
		else if (!reachesAnother.has(from))
			staleness(`"${from}" no longer reaches another package at run time`);
		if ("stubOnly" in entry) {
			const reach = notStub.get(from);
			if (reach !== undefined)
				staleness(
					`"${from}" is marked stubOnly, but reaches ${reach[0]} ("${shownPath(reach[1])}") outside a temporary root`,
				);
			continue;
		}
		const { needs } = entry;
		for (const need of needs) {
			const name = neededBuild(need);
			if (name === undefined)
				staleness(`"${from}" needs "${need}", which is not "<package>#build"`);
			else if (!byName.has(name))
				staleness(
					`"${from}" needs "${need}", and ${name} is not a workspace package`,
				);
		}
		// Each package the reader sees the file reach must be a need; a need it
		// sees no reach for may stand, since it cannot see every reach.
		for (const [name, text] of [...(uncovered.get(from) ?? [])].sort())
			staleness(
				`"${from}" reaches ${name} ("${shownPath(text)}"), and its entry does not name "${name}#build"`,
			);
		// An entry that needs nothing of another package's would silence the
		// reach it declares: a task builds its own package anyway. A need counts
		// where it is another package for at least one task that loads the file
		// (a's test helper, which b's test loads too, may need @s/a#build).
		const loaders = new Set(
			[...(running.get(from) ?? [])].map((key) => tasks.get(key)!.pkg.name),
		);
		if (loaders.size === 0) loaders.add(owner(from)?.name ?? "");
		if (
			!needs.some((need) => {
				const name = neededBuild(need);
				return (
					name !== undefined &&
					byName.has(name) &&
					[...loaders].some((loader) => loader !== name)
				);
			})
		)
			staleness(
				`"${from}" names no build of another package it needs; name one as "<package>#build", or remove the entry`,
			);
	}
	const order = (item: Violation) =>
		`${item.file}\0${item.package}\0${item.task}\0${item.imports}\0${item.specifier}`;
	violations.sort((a, b) =>
		order(a) < order(b) ? -1 : order(a) > order(b) ? 1 : 0,
	);
	const byFile = (a: Unmodelled, b: Unmodelled) =>
		`${a.file}\0${a.reason}` < `${b.file}\0${b.reason}` ? -1 : 1;
	const unmodelled = [
		...workspace.unmodelled,
		...(tracked?.nested ?? []),
		...[...undeclared].map(([file, { named, computed }]) => {
			const names = [...named.keys()].sort();
			const reached = [
				...names,
				...(computed === undefined
					? []
					: ["a package it names by a computed segment"]),
			];
			const text = names.length > 0 ? named.get(names[0]!) : computed;
			return {
				file,
				reason: `reaches ${reached.join(", ")} at run time through a path it assembles ("${shownPath(text ?? "")}"), which this check cannot follow; declare what it needs in ${RUNTIME_REACHES_FILE}`,
			};
		}),
	].sort(byFile);
	const skipped: Skipped = {
		files: [
			...new Set([
				...missingFiles(root, files, (dir) =>
					globs.some((glob) => matches(glob, dir)),
				),
				...unread,
			]),
		].sort(),
		submodules: tracked?.submodules ?? [],
	};
	return { violations, unmodelled, stale: stale.sort(byFile), skipped };
}

/** Whether `CI` names a CI run: set, and not empty, `0` or `false`. */
export function inCi(ci: string | undefined): boolean {
	return ci !== undefined && !["", "0", "false"].includes(ci.toLowerCase());
}

/** What the CLI says about a checkout's left-out files, as `warning` or, failing, `error`. */
export function skippedLines(
	skipped: Skipped,
	level: "warning" | "error",
): string[] {
	const lines: string[] = [];
	const { files, submodules } = skipped;
	if (files.length > 0) {
		const one = files.length === 1;
		const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
		lines.push(
			`${level}: ${files.length} tracked ${one ? "file this check reads is" : "files this check reads are"} not checked out, so it skipped ${one ? "it" : "them"}: ${files.slice(0, 5).join(", ")}${more} (git sparse-checkout disable checks ${one ? "it" : "them"} out)`,
		);
	}
	if (submodules.length > 0) {
		const one = submodules.length === 1;
		lines.push(
			`${level}: ${submodules.length} ${one ? "submodule is" : "submodules are"} not checked out, so none of ${one ? "its" : "their"} files were read: ${submodules.join(", ")} (pnpm run pins:fetch checks ${one ? "it" : "them"} out)`,
		);
	}
	if (lines.length > 0 && level === "warning")
		lines.push(
			"warning: this pass covers only what is checked out; --strict, or CI=1, fails instead",
		);
	return lines;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	const rootArg = args.indexOf("--root");
	const root =
		rootArg >= 0 && args[rootArg + 1]
			? resolve(args[rootArg + 1]!)
			: join(dirname(fileURLToPath(import.meta.url)), "..");
	const strict = args.includes("--strict") || inCi(process.env.CI);
	const { violations, unmodelled, stale, skipped } =
		scanTestWorkspaceDeps(root);
	if (args.includes("--json"))
		process.stdout.write(
			`${JSON.stringify({ violations, unmodelled, stale, skipped }, null, "\t")}\n`,
		);
	else
		for (const item of violations)
			process.stderr.write(
				item.specifier === `declared in ${RUNTIME_REACHES_FILE}`
					? `${item.file}: ${item.package}#${item.task} reaches ${item.imports} at run time (declared in ${RUNTIME_REACHES_FILE}), and turbo builds it after; add "${item.imports}#build" to "${item.package}#${item.task}".dependsOn in turbo.json\n`
					: item.declared === undefined
						? `${item.file}: ${item.package}#${item.task} loads ${item.imports} (${item.specifier}), and turbo builds it after; declare it in devDependencies with "workspace:*" where ${item.package}'s own file imports it by name, else add "${item.imports}#build" to "${item.package}#${item.task}".dependsOn in turbo.json\n`
						: `${item.file}: ${item.package}#${item.task} loads ${item.imports} (${item.specifier}), and turbo builds it after: ${item.package} declares it as ${item.declared}; write "workspace:*"\n`,
			);
	for (const item of [...unmodelled, ...stale])
		process.stderr.write(`error: ${item.file}: ${item.reason}\n`);
	const lines = skippedLines(skipped, strict ? "error" : "warning");
	for (const line of lines) process.stderr.write(`${line}\n`);
	process.exitCode =
		violations.length === 0 &&
		unmodelled.length === 0 &&
		stale.length === 0 &&
		(!strict || lines.length === 0)
			? 0
			: 1;
}
