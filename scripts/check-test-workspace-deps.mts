#!/usr/bin/env node
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
	readonly package: string;
	readonly file: string;
	readonly task: string;
	readonly imports: string;
	readonly specifier: string;
	readonly declared: string | undefined;
}

export interface Skipped {
	readonly files: readonly string[];
	readonly submodules: readonly string[];
}

export interface Unmodelled {
	readonly file: string;
	readonly reason: string;
}

export interface Report {
	readonly violations: readonly Violation[];
	readonly unmodelled: readonly Unmodelled[];
	readonly stale: readonly Unmodelled[];
	readonly skipped: Skipped;
}

export interface CheckOptions {
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
	readonly dir: string;
	readonly build: string | undefined;
	readonly unordered: ReadonlyMap<string, string>;
}

export interface Workspace {
	readonly packages: readonly WorkspacePackage[];
	readonly graph: TurboTaskGraph;
	readonly link: LinkWorkspacePackages;
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
	const unmodelled: Unmodelled[] = [];
	let catalogNamesWorkspace: boolean;
	try {
		catalogNamesWorkspace = catalogValues(workspaceYaml).some((value) =>
			value.includes("workspace:"),
		);
	} catch (error) {
		if (!(error instanceof UnreadYaml)) throw error;
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

const SOURCES_FOR: readonly (readonly [RegExp, readonly string[]])[] = [
	[/\.js$/u, [".ts", ".tsx"]],
	[/\.jsx$/u, [".tsx"]],
	[/\.mjs$/u, [".mts"]],
	[/\.cjs$/u, [".cts"]],
];

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

const OPTIONS_ONLY: ts.ParseConfigHost = {
	...ts.sys,
	readDirectory: () => [],
};

function buildProjects(build: string | undefined): string[] {
	const named = [
		...(build ?? "").matchAll(
			/(?:^|\s)(?:-p|--project|-b|--build)\s+([^\s&|;-][^\s&|;]*)/gu,
		),
	].map((match) => match[1]!);
	return named.length > 0 ? named : ["tsconfig.json"];
}

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

export function checkTestWorkspaceDeps(
	root: string,
	options: CheckOptions = {},
): Violation[] {
	return [...scanTestWorkspaceDeps(root, options).violations];
}

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
	const tasks = new Map<string, { pkg: WorkspacePackage; task: string }>();
	const id = (pkg: WorkspacePackage, task: string) => {
		const key = `${pkg.name}#${task}`;
		if (!tasks.has(key)) tasks.set(key, { pkg, task });
		return key;
	};
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
	const uncovered = new Map<string, Map<string, string>>();
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
			const others = [...named].filter(([name]) => name !== pkg.name);
			const stubbed = [...stubs.named].filter(([name]) => name !== pkg.name);
			const real = others.length > 0 || computed !== undefined;
			if (!real && stubbed.length === 0 && stubs.computed === undefined)
				continue;
			reachesAnother.add(file);
			if (entry === undefined) {
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
		for (const [name, text] of [...(uncovered.get(from) ?? [])].sort())
			staleness(
				`"${from}" reaches ${name} ("${shownPath(text)}"), and its entry does not name "${name}#build"`,
			);
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

export function inCi(ci: string | undefined): boolean {
	return ci !== undefined && !["", "0", "false"].includes(ci.toLowerCase());
}

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
