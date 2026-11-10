/**
 * Which test files of a changed package's dependents can see the change.
 *
 * `turbo run test --filter=...[base]` runs every dependent's whole suite when
 * one of its dependencies changed, though a dependent's test can only notice a
 * change its import closure reaches. That closure is followed file by file and
 * across packages through each package's `exports`, so a dependent importing
 * `@hobo/ci-gh-actions/client` does not see a change to the worker daemon. The
 * plan: every package with a changed file runs its whole suite; each dependent
 * runs only the test files whose closure reaches a changed file, its whole
 * suite when they all do, and nothing when none do.
 *
 * Edges: static and dynamic imports, `resolve("…")` calls, and string literals
 * naming an existing repository path relative to the file, its package or the
 * repository root (`new URL("../dist/bin/hobo.js", import.meta.url)`,
 * `join(here, "../../connectivity/contracts/pacts")`). A `dist/` path stands
 * for the `src/` file built into it. A literal naming another package's file
 * (`hobo ci serve --with-worker` spawning the worker daemon) is that one file,
 * not its imports: it runs as its own process and its package's suite covers
 * it. A package entry that maps to no source file stands for the whole package
 * and its workspace dependencies. A dependent's test with a computed `import()`
 * or a relative import that resolves to nothing runs. A dependent runs in full
 * when its `test` script is not plain `vitest run` or its vitest config's
 * closure reaches the change.
 *
 * A changed path outside every package (the root vitest config, a doc a test
 * reads) runs the tests anywhere whose closure concretely reaches it; there a
 * give-up does not count, or a docs edit would run every package.
 *
 * Node builtins only.
 *
 * CLI: `git diff --name-only BASE HEAD | node --experimental-strip-types scripts/ci/dependent-tests.mts [--base=BASE] [--run [turbo args…]]`
 * `--base` compares root package.json/turbo.json against the merge base, so
 * scripts-only manifest edits and `//#` task edits stay scoped exactly as
 * the workflow's affected-lanes step scoped them; omitting it widens.
 * prints the plan; `--run` also runs it (one turbo call for the whole suites
 * and every build the subsets need, then each subset's test task alone with
 * its files passed through to vitest; the other arguments go to the first
 * call) and exits non-zero when any of it fails.
 * `--shard=INDEX/COUNT` assigns every whole suite and dependent subset to
 * exactly one zero-based shard; a repo-wide plan covers every workspace.
 * `--plan-shards=MAX` runs nothing: it prints the JSON list of shard indexes
 * this plan needs (`[0]` to `[0, …, MAX-1]`) and the plan itself on stderr.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";
import { readStdin } from "../lib/read-stdin.mts";
import {
	affectedLanes,
	cliRootFileReader,
	type ReadRootFile,
} from "./affected-lanes.mts";
import { readWorkspaces, type Workspace } from "./job-scope.mts";

/** Repository access, injectable so tests can describe a tree in memory. */
export type Repo = Readonly<{
	/** Tracked files, repository-relative. */
	files: ReadonlySet<string>;
	read: (path: string) => string | undefined;
	workspaces: readonly Workspace[];
}>;

export type TestPlan =
	| { readonly mode: "all"; readonly reason: string }
	| {
			readonly mode: "scoped";
			/** Package dirs whose whole suite runs. */
			readonly full: readonly string[];
			/** Package dir → test files (relative to it) that run. */
			readonly subsets: ReadonlyMap<string, readonly string[]>;
			/** Dependents none of whose tests reach the change. */
			readonly skipped: readonly string[];
	  };

/** Partition by workspace so a suite or dependent subset is never split or dropped. */
export function shardTestPlan(
	plan: TestPlan,
	workspaces: readonly Workspace[],
	index: number,
	count: number,
): TestPlan {
	if (
		!Number.isSafeInteger(index) ||
		!Number.isSafeInteger(count) ||
		count < 1 ||
		count > 64 ||
		index < 0 ||
		index >= count
	)
		throw new Error("invalid workspace test shard");
	const full =
		plan.mode === "all"
			? [...new Set(workspaces.map((ws) => ws.dir))]
			: [...plan.full];
	const subsets =
		plan.mode === "all" ? new Map<string, readonly string[]>() : plan.subsets;
	const wholeDirs = new Set(full);
	if ([...subsets.keys()].some((dir) => wholeDirs.has(dir)))
		throw new Error("workspace cannot be both a whole suite and a subset");
	const dirs = [...new Set([...full, ...subsets.keys()])].sort();
	const selected = new Set(
		dirs.filter((_, position) => position % count === index),
	);
	return {
		mode: "scoped",
		full: full.filter((dir) => selected.has(dir)),
		subsets: new Map([...subsets].filter(([dir]) => selected.has(dir))),
		skipped: [],
	};
}

/**
 * Suites one scoped shard carries. Shards run their suites one at a time under
 * a 19-minute step limit and the longest suite takes about three minutes cold,
 * so four leaves room for the builds they depend on and a slow host.
 */
export const SUITES_PER_SHARD = 4;

/**
 * How many shards a plan is worth, `max` at most. A repo-wide plan takes them
 * all; a scoped one takes one per `SUITES_PER_SHARD` suites or subsets, and
 * one when it holds nothing, so the job that reports the result still runs.
 */
export function planShardCount(plan: TestPlan, max: number): number {
	if (!Number.isSafeInteger(max) || max < 1 || max > 64)
		throw new Error("invalid workspace test shard");
	if (plan.mode === "all") return max;
	const units = plan.full.length + plan.subsets.size;
	return Math.min(max, Math.max(1, Math.ceil(units / SUITES_PER_SHARD)));
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
function isList(value: Json | undefined): value is readonly Json[] {
	return tag(value) === "[object Array]";
}
function isString(value: Json | undefined): value is string {
	return tag(value) === "[object String]";
}

const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const TEST_SIDE =
	/(?:^|\/)(?:test|tests|e2e|__tests__)\/|\.(?:test|spec)\.[^/]+$/;
const PLAIN_VITEST = /^vitest run(?: [^;&|`$<>]*)?$/;
const STATIC_IMPORT =
	/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"'\n]+)["']/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(?:(["'])([^"'\n]+)\1\s*\))?/g;
const RESOLVE_CALL = /\bresolve\(\s*["']([^"'\n]+)["']\s*\)/g;
const PATH_LITERAL = /["'`]((?:\.\.?\/|packages\/|examples\/)[^"'`\n$]*)["'`]/g;
const VITEST_CONFIGS = [
	"vitest.config.ts",
	"vitest.config.mts",
	"vitest.config.js",
	"vitest.config.mjs",
];
const CONDITIONS = ["import", "node", "default", "require"];

/**
 * `source` without the comments that start a line. Only those: `"src/**\/*.ts"`
 * opens and closes a block comment mid-line.
 */
function withoutComments(source: string): string {
	return source
		.replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@")
		? parts.slice(0, 2).join("/")
		: (parts[0] ?? "");
}

function parseManifest(source: string | undefined): JsonObject | undefined {
	if (source === undefined) return undefined;
	try {
		const manifest: Json = JSON.parse(source);
		return isObject(manifest) ? manifest : undefined;
	} catch {
		return undefined;
	}
}

/** One target out of a conditional `exports` value, ignoring `types`. */
function pickTarget(value: Json | undefined): string | undefined {
	if (isString(value)) return value;
	if (isList(value)) {
		for (const entry of value) {
			const target = pickTarget(entry);
			if (target !== undefined) return target;
		}
		return undefined;
	}
	if (!isObject(value)) return undefined;
	for (const condition of CONDITIONS)
		if (condition in value) return pickTarget(value[condition]);
	return undefined;
}

/** The file a package's `exports` (or `main`) maps `subpath` to, relative to the package. */
export function exportTarget(
	manifest: JsonObject,
	subpath: string,
): string | undefined {
	const exports = manifest.exports;
	if (exports === undefined) {
		if (subpath !== ".") return subpath;
		const main = manifest.module ?? manifest.main;
		return isString(main) ? main : "./index.js";
	}
	if (
		!isObject(exports) ||
		!Object.keys(exports).some((key) => key.startsWith("."))
	)
		return subpath === "." ? pickTarget(exports) : undefined;
	if (subpath in exports) return pickTarget(exports[subpath]);
	for (const [pattern, value] of Object.entries(exports)) {
		const star = pattern.indexOf("*");
		if (star < 0) continue;
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		if (
			subpath.length < prefix.length + suffix.length ||
			!subpath.startsWith(prefix) ||
			!subpath.endsWith(suffix)
		)
			continue;
		const target = pickTarget(value);
		const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
		return target?.replaceAll("*", middle);
	}
	return undefined;
}

type Edges = Readonly<{
	files: readonly string[];
	/** Files named but not followed: another package's program, run as its own process. */
	named?: readonly string[];
	dirs: readonly string[];
	unscoped?: string | undefined;
}>;

export function createWalker(repo: Repo) {
	const byName = new Map(repo.workspaces.map((ws) => [ws.name, ws]));
	const byDepth = [...repo.workspaces].sort(
		(a, b) => b.dir.length - a.dir.length,
	);
	const dirs = new Set<string>(["."]);
	for (const file of repo.files)
		for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir))
			dirs.add(dir);
	const manifests = new Map<string, JsonObject | undefined>();
	const edgeCache = new Map<string, Edges>();

	const ownerOf = (path: string) =>
		byDepth.find((ws) => path === ws.dir || path.startsWith(`${ws.dir}/`));
	const manifestOf = (ws: Workspace) => {
		if (!manifests.has(ws.dir))
			manifests.set(ws.dir, parseManifest(repo.read(`${ws.dir}/package.json`)));
		return manifests.get(ws.dir);
	};

	/** The tracked source file `path` names, or the one a `dist/` path is built from. */
	function sourceFile(path: string): string | undefined {
		const owner = ownerOf(path);
		const bases = [path];
		if (owner && path.startsWith(`${owner.dir}/dist/`)) {
			const rest = path.slice(`${owner.dir}/dist/`.length);
			bases.push(`${owner.dir}/src/${rest}`, `${owner.dir}/${rest}`);
		}
		for (const base of bases) {
			const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
			const candidates =
				stem !== base
					? [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`]
					: [
							base,
							`${base}.ts`,
							`${base}.tsx`,
							`${base}.mts`,
							`${base}.js`,
							`${base}/index.ts`,
							`${base}/index.js`,
						];
			const found = candidates.find((candidate) => repo.files.has(candidate));
			if (found) return found;
		}
		return undefined;
	}

	/** Whether `dir` contains a workspace other than the one `file` sits in. */
	const holdsPackages = (dir: string, owner: Workspace | undefined) =>
		repo.workspaces.some(
			(ws) =>
				ws.dir !== owner?.dir && (dir === "." || ws.dir.startsWith(`${dir}/`)),
		);

	const isOtherPackageRoot = (dir: string, owner: Workspace | undefined) =>
		dir !== owner?.dir && repo.workspaces.some((ws) => ws.dir === dir);

	/** A whole package and, transitively, its workspace dependencies. */
	function wholePackage(ws: Workspace, into: Set<string>): void {
		if (into.has(ws.dir)) return;
		into.add(ws.dir);
		for (const dependency of ws.dependencies) {
			const next = byName.get(dependency);
			if (next) wholePackage(next, into);
		}
	}

	function edges(file: string): Edges {
		const cached = edgeCache.get(file);
		if (cached) return cached;
		const result = computeEdges(file);
		edgeCache.set(file, result);
		return result;
	}

	function computeEdges(file: string): Edges {
		if (!CODE.test(file)) return { files: [], dirs: [] };
		const source = repo.read(file);
		if (source === undefined)
			return { files: [], dirs: [], unscoped: `cannot read ${file}` };
		const owner = ownerOf(file);
		const files = new Set<string>();
		const reached = new Set<string>();
		let unscoped: string | undefined;
		const specifiers: string[] = [];
		for (const match of source.matchAll(STATIC_IMPORT))
			if (match[1]) specifiers.push(match[1]);
		for (const match of source.matchAll(RESOLVE_CALL))
			if (match[1]) specifiers.push(match[1]);
		for (const match of source.matchAll(DYNAMIC_IMPORT)) {
			if (match[2]) specifiers.push(match[2]);
			// A test picks what it loads. Library code loads what its caller hands
			// it (a project file, an optional dependency), and that caller's
			// literal is an edge of its own.
			else if (TEST_SIDE.test(file))
				unscoped ??= `computed import() in ${file}`;
		}
		for (const specifier of specifiers) {
			if (specifier.startsWith(".")) {
				const path = posix.normalize(
					posix.join(posix.dirname(file), specifier),
				);
				if (path.startsWith("../")) {
					unscoped ??= `${file} imports outside the repository`;
					continue;
				}
				const target = sourceFile(path);
				if (target) files.add(target);
				else if (dirs.has(path)) reached.add(path);
				// Inside its own package the target is covered by that package's own
				// suite, even when it is generated or only quoted in a template.
				else if (!owner || !path.startsWith(`${owner.dir}/`))
					unscoped ??= `cannot resolve ${specifier} from ${file}`;
				continue;
			}
			const name = packageName(specifier);
			const ws = byName.get(name);
			if (!ws) continue;
			const manifest = manifestOf(ws);
			const subpath = `.${specifier.slice(name.length)}`;
			const entry = manifest ? exportTarget(manifest, subpath) : undefined;
			const target =
				entry === undefined
					? undefined
					: sourceFile(posix.normalize(posix.join(ws.dir, entry)));
			if (target) files.add(target);
			else wholePackage(ws, reached);
		}
		// A literal naming another package's file is a program started as its own
		// process (`spawn(node, [daemon])`): its package's suite covers what it
		// imports. A vitest config's literals are setup files vitest imports.
		const loadsWhatItNames = VITEST_CONFIGS.includes(posix.basename(file));
		const named = new Set<string>();
		for (const match of withoutComments(source).matchAll(PATH_LITERAL)) {
			const literal = match[1] ?? "";
			// `startsWith("packages/connectors/")` tests a path; it reads nothing.
			const prefix = literal.endsWith("/");
			const bases = /^(?:packages|examples)\//.test(literal)
				? ["."]
				: [posix.dirname(file), ...(owner ? [owner.dir] : [])];
			for (const base of bases) {
				const path = posix
					.normalize(posix.join(base, literal))
					.replace(/\/$/, "");
				if (path === ".." || path.startsWith("../")) continue;
				const target = sourceFile(path);
				if (target && (loadsWhatItNames || ownerOf(target) === owner))
					files.add(target);
				else if (target) named.add(target);
				else if (!dirs.has(path)) continue;
				else if (holdsPackages(path, owner) && prefix) continue;
				// Library code listing package dirs (`"packages/ci-gh-actions"` in a
				// layering table) classifies them; a test naming one reads it.
				else if (isOtherPackageRoot(path, owner) && !TEST_SIDE.test(file))
					continue;
				else if (holdsPackages(path, owner))
					unscoped ??= `${file} names ${path}/, which holds other packages`;
				else reached.add(path);
			}
		}
		return {
			files: [...files],
			named: [...named],
			dirs: [...reached],
			unscoped,
		};
	}

	/**
	 * The first changed path `entry`'s closure reaches, why the walk gave up,
	 * or `undefined` when it reaches none. `lenient` walks past a give-up and
	 * answers only for a path it actually reaches.
	 */
	function reaches(
		entry: string,
		changed: ReadonlySet<string>,
		lenient = false,
	): string | undefined {
		const queue = [entry];
		const seen = new Set<string>();
		for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
			if (seen.has(file)) continue;
			seen.add(file);
			if (changed.has(file)) return file;
			const next = edges(file);
			if (next.unscoped && !lenient) return next.unscoped;
			for (const path of next.named ?? []) if (changed.has(path)) return path;
			for (const dir of next.dirs) {
				const prefix = dir === "." ? "" : `${dir}/`;
				for (const path of changed) if (path.startsWith(prefix)) return path;
			}
			queue.push(...next.files);
		}
		return undefined;
	}

	return { reaches, edges, ownerOf, manifestOf };
}

export function planDependentTests(
	changedPaths: readonly string[],
	repo: Repo,
	readRootFile?: ReadRootFile,
): TestPlan {
	const changed = changedPaths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	const outside = changed.filter(
		(path) => !repo.workspaces.some((ws) => path.startsWith(`${ws.dir}/`)),
	);
	// The root reader keeps this planner consistent with the workflow's
	// lane decision: without it a scripts-only root package.json edit the
	// workflow scoped still widens here to the whole workspace.
	const lanes = affectedLanes(
		changed,
		(path) => repo.files.has(path),
		undefined,
		readRootFile,
	);
	if (lanes.mode === "all" && (outside.length > 0 || changed.length === 0))
		return { mode: "all", reason: lanes.reason };
	const walker = createWalker(repo);
	const changedSet = new Set(changed);
	const changedPackages = new Set<string>();
	for (const path of changed) {
		const owner = walker.ownerOf(path);
		if (owner) changedPackages.add(owner.dir);
	}
	const byName = new Map(repo.workspaces.map((ws) => [ws.name, ws]));
	const dependents = new Set<string>();
	let grew = true;
	while (grew) {
		grew = false;
		for (const ws of repo.workspaces) {
			if (changedPackages.has(ws.dir) || dependents.has(ws.dir)) continue;
			const depends = ws.dependencies.some((name) => {
				const dependency = byName.get(name);
				return (
					dependency !== undefined &&
					(changedPackages.has(dependency.dir) ||
						dependents.has(dependency.dir))
				);
			});
			if (depends) {
				dependents.add(ws.dir);
				grew = true;
			}
		}
	}
	// A path outside every package (the root vitest config, a shared setup file,
	// a doc a test reads) can reach any package's tests, but only a closure that
	// actually reaches it counts: walking every package strictly would run all
	// of them for a docs edit.
	const bystanders =
		outside.length === 0
			? []
			: repo.workspaces
					.map((ws) => ws.dir)
					.filter((dir) => !changedPackages.has(dir) && !dependents.has(dir));
	const testsOf = new Map<string, string[]>();
	for (const path of repo.files) {
		if (!TEST_FILE.test(path) || /(?:^|\/)(?:node_modules|dist)\//.test(path))
			continue;
		const owner = walker.ownerOf(path);
		if (owner)
			testsOf.set(owner.dir, [...(testsOf.get(owner.dir) ?? []), path]);
	}
	// A changed package runs whole even when only its tests or docs changed:
	// its tests read sibling files by names this walk cannot follow
	// (`readPackageFile("README.md")`, a scan of the test directory).
	const full = [...changedPackages];
	const subsets = new Map<string, readonly string[]>();
	const skipped: string[] = [];
	const candidates = [
		...[...dependents].map((dir) => ({ dir, lenient: false })),
		...bystanders.map((dir) => ({ dir, lenient: true })),
	].sort((a, b) => a.dir.localeCompare(b.dir));
	for (const { dir, lenient } of candidates) {
		const ws = repo.workspaces.find((entry) => entry.dir === dir);
		const scripts = ws ? walker.manifestOf(ws)?.scripts : undefined;
		const test = isObject(scripts) ? scripts.test : undefined;
		if (!isString(test)) continue;
		if (!PLAIN_VITEST.test(test.trim())) {
			if (!lenient) full.push(dir);
			continue;
		}
		const config = VITEST_CONFIGS.map((name) => `${dir}/${name}`).find((path) =>
			repo.files.has(path),
		);
		if (config && walker.reaches(config, changedSet, lenient) !== undefined) {
			full.push(dir);
			continue;
		}
		const tests = testsOf.get(dir) ?? [];
		const selected = tests.filter(
			(path) => walker.reaches(path, changedSet, lenient) !== undefined,
		);
		if (selected.length === 0) {
			if (!lenient) skipped.push(dir);
		} else if (selected.length === tests.length) full.push(dir);
		else
			subsets.set(
				dir,
				selected.map((path) => path.slice(dir.length + 1)).sort(),
			);
	}
	return { mode: "scoped", full: full.sort(), subsets, skipped };
}

/** One task of `turbo run test --dry=json`. */
export type GraphTask = Readonly<{
	taskId: string;
	task: string;
	/** Package dir, repository-relative. */
	directory: string;
}>;

/** The task graph turbo would run for `turbo run test` over these dirs. */
export type TestGraph = (dirs: readonly string[]) => readonly GraphTask[];

/**
 * The `pnpm` argument lists that run a plan.
 *
 * Turbo hands `--` arguments to every task of a run, its dependencies' builds
 * included, and folds them into each task's hash. A subset that passed its
 * files that way rebuilt its whole dependency graph uncached, once per subset.
 * So the first call runs, by task id and with no pass-through, everything in
 * turbo's own `test` graph for these packages except the subsets' test tasks:
 * the whole suites and every build a subset's test depends on, including a
 * `<pkg>#test` override's extra `dependsOn` (`@hobo/hobo#test` needs
 * `@hobo/adapter-hono#build`). Its hashes match a plain `turbo run test`, so
 * builds share the cache. Each subset then runs only its own test task
 * (`--only`) with its files passed through to the package's `vitest run`.
 * `turboArgs` go to the first call only.
 */
export function planCommands(
	plan: TestPlan,
	turboArgs: readonly string[],
	concurrency: string,
	graph: TestGraph,
): readonly (readonly string[])[] {
	const test = ["exec", "turbo", "run", "test"];
	const parallel = `--concurrency=${concurrency}`;
	if (plan.mode === "all") return [[...test, parallel, ...turboArgs]];
	const commands: string[][] = [];
	if (plan.subsets.size === 0) {
		if (plan.full.length > 0)
			commands.push([
				...test,
				...plan.full.map((dir) => `--filter=./${dir}`),
				"--continue",
				parallel,
				...turboArgs,
			]);
		return commands;
	}
	const subsetTests = new Set(
		[...plan.subsets.keys()].map((dir) => `${dir}\0test`),
	);
	const tasks = graph([...plan.full, ...plan.subsets.keys()])
		.filter((task) => !subsetTests.has(`${task.directory}\0${task.task}`))
		.map((task) => task.taskId);
	if (tasks.length > 0)
		commands.push([
			"exec",
			"turbo",
			"run",
			...tasks,
			"--continue",
			parallel,
			...turboArgs,
		]);
	for (const [dir, files] of plan.subsets)
		commands.push([
			...test,
			`--filter=./${dir}`,
			"--only",
			parallel,
			"--",
			"--passWithNoTests",
			...files,
		]);
	return commands;
}

/** Reads the `test` task graph from `turbo run test --dry=json`. */
export function turboTestGraph(dirs: readonly string[]): readonly GraphTask[] {
	const dry = spawnSync(
		"pnpm",
		[
			"exec",
			"turbo",
			"run",
			"test",
			...dirs.map((dir) => `--filter=./${dir}`),
			"--dry=json",
		],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);
	if (dry.status !== 0)
		throw new Error(`turbo --dry=json failed:\n${dry.stderr}`);
	const parsed: Json = JSON.parse(dry.stdout);
	if (!isObject(parsed) || !isList(parsed.tasks))
		throw new Error("turbo --dry=json printed no task list");
	const tasks: GraphTask[] = [];
	for (const task of parsed.tasks) {
		if (
			!isObject(task) ||
			!isString(task.taskId) ||
			!isString(task.task) ||
			!isString(task.directory)
		)
			throw new Error(`turbo --dry=json task without an id: ${tag(task)}`);
		tasks.push({
			taskId: task.taskId,
			task: task.task,
			directory: task.directory,
		});
	}
	return tasks;
}

/** Runs the plan. Every part runs, so one failure hides no other. */
function runPlan(plan: TestPlan, turboArgs: readonly string[]): number {
	let status = 0;
	for (const args of planCommands(
		plan,
		turboArgs,
		process.env.HOBO_TURBO_CONCURRENCY ?? "100%",
		turboTestGraph,
	)) {
		console.log(`$ pnpm ${args.join(" ")}`);
		const exit = spawnSync("pnpm", args, { stdio: "inherit" }).status ?? 1;
		if (exit !== 0) status = exit;
	}
	return status;
}

function describePlan(plan: TestPlan): string {
	if (plan.mode === "all")
		return `dependent-tests: whole workspace (${plan.reason})`;
	const lines = [
		`dependent-tests: ${plan.full.length} whole suite(s), ${plan.subsets.size} subset(s), ${plan.skipped.length} dependent(s) skipped`,
		...plan.full.map((dir) => `  whole  ${dir}`),
		...[...plan.subsets].map(
			([dir, files]) => `  subset ${dir}: ${files.join(" ")}`,
		),
		...(plan.skipped.length > 20
			? []
			: plan.skipped.map((dir) => `  skip   ${dir}`)),
	];
	return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const input = readStdin();
	const listed = spawnSync("git", ["ls-files", "-z"], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (listed.status !== 0) {
		console.error("dependent-tests: git ls-files failed");
		process.exit(2);
	}
	const repo: Repo = {
		files: new Set(listed.stdout.split("\0").filter((path) => path !== "")),
		read: (path) => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		workspaces: readWorkspaces(),
	};
	const args = process.argv.slice(2);
	const baseArgument = args.find((arg) => arg.startsWith("--base="));
	const shardArgs = args.filter((arg) => arg.startsWith("--shard"));
	const planShards = args.find((arg) => arg.startsWith("--plan-shards="));
	if (
		shardArgs.length > 1 ||
		(shardArgs.length === 1 && !/^--shard=\d+\/\d+$/u.test(shardArgs[0] ?? ""))
	) {
		console.error(
			"dependent-tests: invalid shard; expected --shard=INDEX/COUNT",
		);
		process.exit(2);
	}
	let plan = planDependentTests(
		input.split("\n"),
		repo,
		baseArgument === undefined
			? undefined
			: cliRootFileReader(baseArgument.slice("--base=".length)),
	);
	if (planShards !== undefined) {
		const max = Number(planShards.slice("--plan-shards=".length));
		const count = planShardCount(plan, max);
		console.error(describePlan(plan));
		console.log(
			`[${Array.from({ length: count }, (_, index) => index).join(", ")}]`,
		);
		process.exit(0);
	}
	if (shardArgs.length === 1) {
		const match = /^--shard=(\d+)\/(\d+)$/u.exec(shardArgs[0] ?? "");
		if (!match) throw new Error("invalid workspace test shard");
		if (plan.mode === "all") {
			const workspaceDirs = new Set(repo.workspaces.map((ws) => ws.dir));
			const tests = turboTestGraph([]).filter((task) => task.task === "test");
			if (
				tests.length === 0 ||
				tests.some((task) => !workspaceDirs.has(task.directory))
			)
				throw new Error(
					"repo-wide test graph includes an undiscovered workspace",
				);
		}
		plan = shardTestPlan(
			plan,
			repo.workspaces,
			Number(match[1]),
			Number(match[2]),
		);
		console.log(`dependent-tests: shard ${match[1]}/${match[2]}`);
	}
	console.log(describePlan(plan));
	if (args.includes("--run"))
		process.exit(
			runPlan(
				plan,
				args.filter(
					(arg) =>
						arg !== "--run" && arg !== baseArgument && !shardArgs.includes(arg),
				),
			),
		);
}
