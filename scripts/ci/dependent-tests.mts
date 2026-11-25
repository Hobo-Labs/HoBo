import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { posix } from "node:path";
import process from "node:process";
import { readStdin } from "../lib/read-stdin.mts";
import {
	affectedLanes,
	cliRootFileReader,
	type ReadRootFile,
} from "./affected-lanes.mts";
import { readWorkspaces, type Workspace } from "./job-scope.mts";
import { spawnTurbo } from "./turbo-invoke.mts";
import {
	loadWorkspaceDurations,
	type WorkspaceDurationTable,
	workspaceTestSeconds,
} from "./workspace-test-durations.mts";

export type Repo = Readonly<{
	files: ReadonlySet<string>;
	read: (path: string) => string | undefined;
	workspaces: readonly Workspace[];
}>;

export type TestPlan =
	| { readonly mode: "all"; readonly reason: string }
	| {
			readonly mode: "scoped";
			readonly full: readonly string[];
			readonly subsets: ReadonlyMap<string, readonly string[]>;
			readonly vitestShards?:
				| ReadonlyMap<string, VitestShardSlices>
				| undefined;
			readonly skipped: readonly string[];
	  };

export type VitestShardSlices = Readonly<{
	count: number;
	indexes: readonly number[];
}>;

export function planUnits(
	plan: TestPlan,
	workspaces: readonly Workspace[],
): string[] {
	const full =
		plan.mode === "all"
			? [...new Set(workspaces.map((ws) => ws.dir))]
			: [...plan.full];
	const subsets =
		plan.mode === "all" ? new Map<string, readonly string[]>() : plan.subsets;
	const sliced =
		plan.mode === "all"
			? new Map<string, VitestShardSlices>()
			: plan.vitestShards;
	const wholeDirs = new Set(full);
	if (
		[...subsets.keys()].some(
			(dir) => wholeDirs.has(dir) || sliced?.has(dir) === true,
		)
	)
		throw new Error("workspace cannot be both a whole suite and a subset");
	return [
		...new Set([...full, ...subsets.keys(), ...(sliced?.keys() ?? [])]),
	].sort();
}

export function testWorkspaceUnits(
	plan: TestPlan,
	workspaces: readonly Workspace[],
	graph: TestGraph = turboTestGraph,
): string[] {
	if (plan.mode !== "all") return planUnits(plan, workspaces);
	const workspaceDirs = new Set(workspaces.map((ws) => ws.dir));
	const tests = graph([]).filter((task) => task.task === "test");
	const dirs = tests
		.map((task) => task.directory)
		.filter((dir) => workspaceDirs.has(dir));
	if (
		tests.length === 0 ||
		tests.some((task) => !workspaceDirs.has(task.directory))
	)
		throw new Error("repo-wide test graph includes an undiscovered workspace");
	return [...new Set(dirs)].sort();
}

function countPackageTestFiles(repo: Repo, packageDir: string): number {
	const testFile = /\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
	let count = 0;
	for (const path of repo.files) {
		if (!path.startsWith(`${packageDir}/`)) continue;
		if (!testFile.test(path)) continue;
		if (/(?:^|\/)(?:node_modules|dist)\//.test(path)) continue;
		count += 1;
	}
	return count;
}

export function planUnitLoadSeconds(
	plan: TestPlan,
	unit: string,
	repo?: Repo,
	durations: WorkspaceDurationTable = loadWorkspaceDurations(),
): number {
	const packageSeconds = workspaceTestSeconds(unit, durations);
	if (plan.mode === "all") return packageSeconds;
	if (plan.full.includes(unit)) return packageSeconds;
	const subset = plan.subsets.get(unit);
	if (!subset || subset.length === 0 || repo === undefined)
		return packageSeconds;
	const totalFiles = countPackageTestFiles(repo, unit);
	if (totalFiles <= subset.length) return packageSeconds;
	return Math.max(
		durations.defaultSeconds,
		(packageSeconds * subset.length) / totalFiles,
	);
}

export const VITEST_SHARDABLE_PACKAGES: ReadonlySet<string> = new Set([
	"packages/hobo",
]);

export const VITEST_SHARD_TARGET_SECONDS = 45;

export const MAX_VITEST_SHARDS_PER_PACKAGE = 4;

export function vitestShardCountForWeight(
	seconds: number,
	shardable: boolean,
): number {
	if (!shardable || seconds <= VITEST_SHARD_TARGET_SECONDS) return 1;
	return Math.min(
		MAX_VITEST_SHARDS_PER_PACKAGE,
		Math.ceil(seconds / VITEST_SHARD_TARGET_SECONDS),
	);
}

export function vitestShardsForUnit(
	plan: TestPlan,
	dir: string,
	durations: WorkspaceDurationTable = loadWorkspaceDurations(),
	repo?: Repo,
): number {
	if (!VITEST_SHARDABLE_PACKAGES.has(dir)) return 1;
	if (plan.mode === "scoped" && !plan.full.includes(dir)) return 1;
	if (repo !== undefined) {
		const manifest = parseManifest(repo.read(`${dir}/package.json`));
		const scripts = manifest?.scripts;
		const test = isObject(scripts) ? scripts.test : undefined;
		if (!isString(test) || !PLAIN_VITEST.test(test.trim())) return 1;
	}
	return vitestShardCountForWeight(workspaceTestSeconds(dir, durations), true);
}

const SHARD_UNIT_SEPARATOR = "\u0000";

export function formatVitestShardUnit(
	dir: string,
	index: number,
	count: number,
): string {
	return `${dir}${SHARD_UNIT_SEPARATOR}${index}/${count}`;
}

export type ParsedVitestShardUnit = Readonly<{
	dir: string;
	slice?: VitestShardSlice;
}>;

export type VitestShardSlice = Readonly<{ index: number; count: number }>;

export function parseVitestShardUnit(unit: string): ParsedVitestShardUnit {
	const separator = unit.indexOf(SHARD_UNIT_SEPARATOR);
	if (separator < 0) return { dir: unit };
	const dir = unit.slice(0, separator);
	const match = /^(\d+)\/(\d+)$/u.exec(unit.slice(separator + 1));
	if (!match) return { dir: unit };
	return {
		dir,
		slice: { index: Number(match[1]), count: Number(match[2]) },
	};
}

export function expandShardUnits(
	plan: TestPlan,
	units: readonly string[],
	durations: WorkspaceDurationTable = loadWorkspaceDurations(),
	repo?: Repo,
): string[] {
	const expanded: string[] = [];
	for (const dir of units) {
		const count = vitestShardsForUnit(plan, dir, durations, repo);
		for (let index = 0; index < count; index++)
			expanded.push(
				count === 1 ? dir : formatVitestShardUnit(dir, index, count),
			);
	}
	return expanded;
}

export function maxVitestShardCount(
	plan: TestPlan,
	durations: WorkspaceDurationTable = loadWorkspaceDurations(),
	repo?: Repo,
	units?: readonly string[],
): number {
	const base = units ?? (plan.mode === "all" ? [] : [...plan.full]);
	const dirs = base.map((unit) => parseVitestShardUnit(unit).dir);
	return Math.max(
		1,
		...dirs.map((dir) => vitestShardsForUnit(plan, dir, durations, repo)),
	);
}

export function shardUnitSeconds(
	plan: TestPlan,
	unit: string,
	repo: Repo | undefined,
	durations: WorkspaceDurationTable,
): number {
	const { dir, slice } = parseVitestShardUnit(unit);
	const seconds = planUnitLoadSeconds(plan, dir, repo, durations);
	return slice ? seconds / slice.count : seconds;
}

export function partitionUnitsByWeight(
	units: readonly string[],
	durations: WorkspaceDurationTable,
	count: number,
	weightFor?: (unit: string) => number,
): readonly (readonly string[])[] {
	if (count < 1 || count > 64) throw new Error("invalid workspace test shard");
	const weight =
		weightFor ?? ((unit: string) => workspaceTestSeconds(unit, durations));
	const shards: Array<{ load: number; units: string[] }> = Array.from(
		{ length: count },
		() => ({
			load: 0,
			units: [],
		}),
	);
	const sorted = [...units].sort((a, b) => weight(b) - weight(a));
	for (const unit of sorted) {
		const unitWeight = weight(unit);
		let targetIdx = 0;
		for (let index = 1; index < shards.length; index++) {
			const shard = shards[index];
			const best = shards[targetIdx];
			if (shard && best && shard.load < best.load) targetIdx = index;
		}
		const target = shards[targetIdx];
		if (!target) throw new Error("partitionUnitsByWeight: empty shard set");
		target.units.push(unit);
		target.load += unitWeight;
	}
	return shards.map((shard) => shard.units);
}

export function shardLoadSpreadSeconds(
	units: readonly string[],
	durations: WorkspaceDurationTable,
	count: number,
	weightFor?: (unit: string) => number,
): number {
	const weight =
		weightFor ?? ((unit: string) => workspaceTestSeconds(unit, durations));
	const parts = partitionUnitsByWeight(units, durations, count, weight);
	const loads = parts.map((part) =>
		part.reduce((sum, dir) => sum + weight(dir), 0),
	);
	if (loads.length === 0) return 0;
	return Math.max(...loads) - Math.min(...loads);
}

export function maxShardLoadSeconds(
	units: readonly string[],
	durations: WorkspaceDurationTable,
	count: number,
	weightFor?: (unit: string) => number,
): number {
	const weight =
		weightFor ?? ((unit: string) => workspaceTestSeconds(unit, durations));
	const parts = partitionUnitsByWeight(units, durations, count, weight);
	return Math.max(
		0,
		...parts.map((part) => part.reduce((sum, dir) => sum + weight(dir), 0)),
	);
}

export function shardTestPlan(
	plan: TestPlan,
	workspaces: readonly Workspace[],
	index: number,
	count: number,
	durations: WorkspaceDurationTable = loadWorkspaceDurations(),
	graph: TestGraph = turboTestGraph,
	repo?: Repo,
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
	const dirs = testWorkspaceUnits(plan, workspaces, graph);
	const units = expandShardUnits(plan, dirs, durations, repo);
	const weightFor = (unit: string) =>
		shardUnitSeconds(plan, unit, repo, durations);
	const selectedPart = partitionUnitsByWeight(
		units,
		durations,
		count,
		weightFor,
	)[index];
	if (selectedPart === undefined)
		throw new Error("invalid workspace test shard");
	const selected: readonly string[] = selectedPart;
	const sliced = new Map<string, { count: number; indexes: number[] }>();
	const selectedDirs = new Set<string>();
	for (const unit of selected) {
		const { dir, slice } = parseVitestShardUnit(unit);
		selectedDirs.add(dir);
		if (!slice) continue;
		const entry = sliced.get(dir) ?? { count: slice.count, indexes: [] };
		if (entry.count !== slice.count)
			throw new Error(`inconsistent vitest shard count for ${dir}`);
		entry.indexes.push(slice.index);
		sliced.set(dir, entry);
	}
	const baseFull = plan.mode === "all" ? dirs : [...plan.full];
	const subsets =
		plan.mode === "all" ? new Map<string, readonly string[]>() : plan.subsets;
	const sortedSlices =
		sliced.size > 0
			? new Map(
					[...sliced]
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([dir, entry]) => [
							dir,
							{
								count: entry.count,
								indexes: [...entry.indexes].sort((a, b) => a - b),
							},
						]),
				)
			: undefined;
	return {
		mode: "scoped",
		full: baseFull.filter((dir) => selectedDirs.has(dir) && !sliced.has(dir)),
		vitestShards: sortedSlices,
		subsets: new Map([...subsets].filter(([dir]) => selectedDirs.has(dir))),
		skipped: [],
	};
}

const SUITES_PER_SHARD = 4;

export function planShardCountBalanced(
	plan: TestPlan,
	workspaces: readonly Workspace[],
	max: number,
	targetSeconds: number,
	durations: WorkspaceDurationTable = loadWorkspaceDurations(),
	graph: TestGraph = turboTestGraph,
	repo?: Repo,
	maxSpreadSeconds = MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS,
): number {
	if (!Number.isSafeInteger(max) || max < 1 || max > 64)
		throw new Error("invalid workspace test shard");
	if (!(targetSeconds > 0)) throw new Error("invalid workspace shard target");
	const units = expandShardUnits(
		plan,
		testWorkspaceUnits(plan, workspaces, graph),
		durations,
		repo,
	);
	if (units.length === 0) return 1;
	const weightFor = (unit: string) =>
		shardUnitSeconds(plan, unit, repo, durations);
	let count = 1;
	const fits = (shards: number) => {
		if (
			maxShardLoadSeconds(units, durations, shards, weightFor) > targetSeconds
		)
			return false;
		if (
			shardLoadSpreadSeconds(units, durations, shards, weightFor) >
			maxSpreadSeconds
		)
			return false;
		return true;
	};
	while (count < max) {
		if (fits(count)) return count;
		count += 1;
	}
	return max;
}

export function planShardCount(
	plan: TestPlan,
	max: number,
	options?: Readonly<{
		targetSeconds?: number;
		workspaces?: readonly Workspace[];
		durations?: WorkspaceDurationTable;
		repo?: Repo;
	}>,
): number {
	if (!Number.isSafeInteger(max) || max < 1 || max > 64)
		throw new Error("invalid workspace test shard");
	const target = options?.targetSeconds;
	if (target !== undefined) {
		return planShardCountBalanced(
			plan,
			options?.workspaces ?? readWorkspaces(),
			max,
			target,
			options?.durations,
			turboTestGraph,
			options?.repo,
		);
	}
	if (plan.mode === "all") return max;
	const durations = options?.durations ?? loadWorkspaceDurations();
	const units = expandShardUnits(
		plan,
		[...plan.full, ...plan.subsets.keys()],
		durations,
		options?.repo,
	);
	const slices = maxVitestShardCount(plan, durations, options?.repo, units);
	return Math.min(
		max,
		Math.max(1, Math.ceil(units.length / SUITES_PER_SHARD), slices),
	);
}

export const MAIN_WORKSPACE_SHARD_TARGET_SECONDS = 180;

export const MAIN_WORKSPACE_COLD_CACHE_PATH_THRESHOLD = 40;
export const MAIN_WORKSPACE_COLD_CACHE_DURATION_SCALE = 2;

export function scaleWorkspaceDurations(
	table: WorkspaceDurationTable,
	factor: number,
): WorkspaceDurationTable {
	if (!(factor > 1)) return table;
	const seconds = new Map<string, number>();
	for (const [dir, value] of table.seconds) seconds.set(dir, value * factor);
	return { defaultSeconds: table.defaultSeconds * factor, seconds };
}

export const MAIN_WORKSPACE_SHARD_BUDGET_SECONDS = 12 * 60;
export const MAX_MAIN_WORKSPACE_SHARDS = 16;

export const MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS = 10;

export type MainWorkspaceShardPlan = Readonly<{
	count: number;
	parallelCap: number;
	peakShardSeconds: number;
}>;

export function minimumScopedShardCount(
	plan: TestPlan,
	parallelCap: number,
): number {
	if (plan.mode !== "scoped") return 1;
	const units = plan.full.length + plan.subsets.size;
	if (units <= 3) return 1;
	return Math.min(parallelCap, Math.max(2, Math.ceil(units / 2)));
}

export function planMainWorkspaceShardCount(
	plan: TestPlan,
	parallelCap: number,
	options?: Readonly<{
		targetSeconds?: number;
		workspaces?: readonly Workspace[];
		durations?: WorkspaceDurationTable;
		repo?: Repo;
		maxSpreadSeconds?: number;
	}>,
): MainWorkspaceShardPlan {
	if (!Number.isSafeInteger(parallelCap) || parallelCap < 1 || parallelCap > 64)
		throw new Error("invalid main workspace parallel cap");
	const workspaces = options?.workspaces ?? readWorkspaces();
	const durations = options?.durations ?? loadWorkspaceDurations();
	const repo = options?.repo ?? readRepo();
	const targetSeconds =
		options?.targetSeconds ?? MAIN_WORKSPACE_SHARD_TARGET_SECONDS;
	const maxSpreadSeconds =
		options?.maxSpreadSeconds ?? MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS;
	let count = planShardCountBalanced(
		plan,
		workspaces,
		parallelCap,
		targetSeconds,
		durations,
		turboTestGraph,
		repo,
		maxSpreadSeconds,
	);
	count = Math.max(count, minimumScopedShardCount(plan, parallelCap));
	const units = expandShardUnits(
		plan,
		testWorkspaceUnits(plan, workspaces),
		durations,
		repo,
	);
	const weightFor = (unit: string) =>
		shardUnitSeconds(plan, unit, repo, durations);
	const peakAt = (shards: number) =>
		maxShardLoadSeconds(units, durations, shards, weightFor);
	let peak = peakAt(count);
	while (
		count < MAX_MAIN_WORKSPACE_SHARDS &&
		peak > MAIN_WORKSPACE_SHARD_BUDGET_SECONDS
	) {
		const next = peakAt(count + 1);
		if (next >= peak) break;
		count += 1;
		peak = next;
	}
	return { count, parallelCap, peakShardSeconds: peak };
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
const BARE_DIR = /^\.\.?\/$/;
const TSCONFIG = /(?:[\w.-]+\/)*tsconfig(?:\.[\w-]+)?\.json\b/g;
const EXTENDS = /"extends"\s*:\s*(\[[^\]]*\]|"[^"\n]*")/;
const BUNDLERS = ["tsup", "vite"];
const CONFIG_EXTENSIONS = ["ts", "mts", "js", "mjs", "cjs"];

const STRING_TEST_ARGUMENT =
	/\.(?:startsWith|endsWith|includes|replace|replaceAll)\(\s*$/;
const COMPARED_TO = /[!=]==?\s*$/;
const COMPARED_WITH = /^\s*[!=]==?/;
const CASE_LABEL = /\bcase\s+$/;

function isStringTest(
	text: string,
	match: RegExpExecArray | RegExpMatchArray,
): boolean {
	const start = match.index ?? 0;
	const end = start + match[0].length;
	const from = text.lastIndexOf("\n", Math.max(0, start - 200)) + 1;
	const before = text
		.slice(from, start)
		.split("\n")
		.map(withoutTrailingComment)
		.join("\n");
	const after = text.slice(end, end + 200).replace(/^\s*\/\/.*\n/, "");
	return (
		STRING_TEST_ARGUMENT.test(before) ||
		COMPARED_TO.test(before) ||
		COMPARED_WITH.test(after) ||
		(CASE_LABEL.test(before) && /^\s*:/.test(after))
	);
}

function withoutTrailingComment(line: string): string {
	let quote = "";
	for (let index = 0; index < line.length; index++) {
		const char = line[index];
		if (quote !== "") {
			if (char === "\\") index++;
			else if (char === quote) quote = "";
		} else if (char === '"' || char === "'" || char === "`") quote = char;
		else if (char === "/" && line[index + 1] === "/")
			return line.slice(0, index);
	}
	return line;
}

const VITEST_CONFIGS = [
	"vitest.config.ts",
	"vitest.config.mts",
	"vitest.config.js",
	"vitest.config.mjs",
];
const CONDITIONS = ["import", "node", "default", "require"];

function withoutComments(source: string): string {
	return source
		.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
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
	named?: readonly string[];
	dirs: readonly string[];
	unscoped?: string | undefined;
}>;

export function createWalker(repo: Repo) {
	const byName = new Map(repo.workspaces.map((ws) => [ws.name, ws]));
	const dirs = new Set<string>(["."]);
	for (const file of repo.files)
		for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir))
			dirs.add(dir);
	const manifests = new Map<string, JsonObject | undefined>();
	const edgeCache = new Map<string, Edges>();

	const byDir = new Map(repo.workspaces.map((ws) => [ws.dir, ws]));
	const owners = new Map<string, Workspace | undefined>();
	const ownerOf = (path: string): Workspace | undefined => {
		if (owners.has(path)) return owners.get(path);
		let owner: Workspace | undefined;
		for (let dir = path; dir !== "." && dir !== "/"; dir = posix.dirname(dir)) {
			owner = byDir.get(dir);
			if (owner) break;
		}
		owners.set(path, owner);
		return owner;
	};
	const manifestOf = (ws: Workspace) => {
		if (!manifests.has(ws.dir))
			manifests.set(ws.dir, parseManifest(repo.read(`${ws.dir}/package.json`)));
		return manifests.get(ws.dir);
	};

	const inputs = new Map<string, readonly string[]>();
	function packageInputs(ws: Workspace): readonly string[] {
		const cached = inputs.get(ws.dir);
		if (cached) return cached;
		const scripts = manifestOf(ws)?.scripts;
		const commands = isObject(scripts)
			? Object.values(scripts).filter(isString)
			: [];
		const inside = (path: string) =>
			path.startsWith(`${ws.dir}/`) && repo.files.has(path);
		const found = new Set(
			[
				"package.json",
				"turbo.json",
				...BUNDLERS.filter((tool) =>
					commands.some((command) =>
						new RegExp(`(?:^|[\\s;&|])${tool}(?:[\\s;&|]|$)`).test(command),
					),
				).flatMap((tool) =>
					CONFIG_EXTENSIONS.map((extension) => `${tool}.config.${extension}`),
				),
			]
				.map((name) => `${ws.dir}/${name}`)
				.filter(inside),
		);
		const tsconfigs = ["tsconfig.json"]
			.concat(commands.flatMap((command) => command.match(TSCONFIG) ?? []))
			.map((name) => posix.normalize(posix.join(ws.dir, name)));
		for (let path = tsconfigs.shift(); path; path = tsconfigs.shift()) {
			if (found.has(path) || !inside(path)) continue;
			found.add(path);
			const extended = EXTENDS.exec(repo.read(path) ?? "")?.[1] ?? "";
			for (const [, target = ""] of extended.matchAll(/"([^"]*)"/g)) {
				if (!target.startsWith(".")) continue;
				const next = posix.normalize(posix.join(posix.dirname(path), target));
				tsconfigs.push(next.endsWith(".json") ? next : `${next}.json`);
			}
		}
		const list = [...found];
		inputs.set(ws.dir, list);
		return list;
	}
	function changedInput(
		path: string,
		changed: ReadonlySet<string>,
	): string | undefined {
		const owner = ownerOf(path);
		return owner && packageInputs(owner).find((input) => changed.has(input));
	}

	const sources = new Map<string, string | undefined>();
	function sourceFile(path: string): string | undefined {
		if (!sources.has(path)) sources.set(path, findSourceFile(path));
		return sources.get(path);
	}
	function findSourceFile(path: string): string | undefined {
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

	const holdsPackages = (dir: string, owner: Workspace | undefined) =>
		repo.workspaces.some(
			(ws) =>
				ws.dir !== owner?.dir && (dir === "." || ws.dir.startsWith(`${dir}/`)),
		);

	const isOtherPackageRoot = (dir: string, owner: Workspace | undefined) =>
		dir !== owner?.dir && repo.workspaces.some((ws) => ws.dir === dir);

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
		const loadsWhatItNames = VITEST_CONFIGS.includes(posix.basename(file));
		const named = new Set<string>();
		const text = withoutComments(source);
		for (const match of text.matchAll(PATH_LITERAL)) {
			const literal = match[1] ?? "";
			const bare = BARE_DIR.test(literal);
			if (bare && isStringTest(text, match)) continue;
			const prefix = literal.endsWith("/");
			const bases = /^(?:packages|examples)\//.test(literal)
				? ["."]
				: [posix.dirname(file), ...(owner ? [owner.dir] : [])];
			for (const base of bases) {
				const path = posix
					.normalize(posix.join(base, literal))
					.replace(/\/$/, "");
				if (path === ".." || path.startsWith("../")) continue;
				const target = bare ? undefined : sourceFile(path);
				if (target && (loadsWhatItNames || ownerOf(target) === owner))
					files.add(target);
				else if (target) named.add(target);
				else if (!dirs.has(path)) continue;
				else if (holdsPackages(path, owner) && prefix) continue;
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
			const input = changedInput(file, changed);
			if (input) return input;
			const next = edges(file);
			if (next.unscoped && !lenient) return next.unscoped;
			for (const path of next.named ?? []) {
				if (changed.has(path)) return path;
				const namedInput = changedInput(path, changed);
				if (namedInput) return namedInput;
			}
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
	const bystanders = repo.workspaces
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
		const plain = PLAIN_VITEST.test(test.trim());
		if (!plain && !lenient) {
			full.push(dir);
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
		} else if (!plain || selected.length === tests.length) full.push(dir);
		else
			subsets.set(
				dir,
				selected.map((path) => path.slice(dir.length + 1)).sort(),
			);
	}
	return { mode: "scoped", full: full.sort(), subsets, skipped };
}

export type GraphTask = Readonly<{
	taskId: string;
	task: string;
	directory: string;
}>;

export type TestGraph = (dirs: readonly string[]) => readonly GraphTask[];

function turboAffectedArgs(): readonly string[] {
	return process.env.HOBO_TURBO_USE_AFFECTED === "1" ? ["--affected"] : [];
}

export const BUILD_TASK_MB = 1024;
export const BUILD_RESERVE_MB = 768;

export function buildTaskConcurrency(
	input: Readonly<{ cpuCount: number; limitMb: number }>,
): number {
	const byMemory = Math.floor(
		(input.limitMb - BUILD_RESERVE_MB) / BUILD_TASK_MB,
	);
	return Math.max(1, Math.min(Math.floor(input.cpuCount), byMemory));
}

const MIB = 1024 * 1024;

function cgroupMemoryMaxMb(): number | undefined {
	try {
		const max = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
		return /^\d+$/u.test(max) ? Math.floor(Number(max) / MIB) : undefined;
	} catch {
		return undefined;
	}
}

function jobMemoryLimitMb(): number {
	const cgroup = cgroupMemoryMaxMb();
	if (cgroup !== undefined) return cgroup;
	const configured = Number(process.env.HOBO_CI_JOB_MEMORY_MB);
	return Number.isFinite(configured) && configured >= 1
		? Math.floor(configured)
		: Math.floor(totalmem() / MIB);
}

function buildConcurrencyFromEnv(): string {
	const configured = process.env.HOBO_TURBO_BUILD_CONCURRENCY?.trim();
	if (configured) return configured;
	return String(
		buildTaskConcurrency({
			cpuCount: availableParallelism(),
			limitMb: jobMemoryLimitMb(),
		}),
	);
}

export function planCommands(
	plan: TestPlan,
	turboArgs: readonly string[],
	concurrency: string,
	graph: TestGraph,
	buildConcurrency?: string,
): readonly (readonly string[])[] {
	const test = ["exec", "turbo", "run", "test"];
	const parallel = `--concurrency=${concurrency}`;
	const affected = turboAffectedArgs();
	if (plan.mode === "all")
		return [[...test, ...affected, parallel, ...turboArgs]];
	const slices = plan.vitestShards ?? new Map<string, VitestShardSlices>();
	const commands: string[][] = [];
	const buildFirst = buildConcurrency !== undefined && affected.length === 0;
	const buildPass = (tasks: readonly GraphTask[]) => {
		const builds = tasks
			.filter((task) => task.task === "build")
			.map((task) => task.taskId);
		if (buildFirst && builds.length > 0)
			commands.push([
				"exec",
				"turbo",
				"run",
				...builds,
				"--continue",
				`--concurrency=${buildConcurrency}`,
				...turboArgs,
			]);
	};
	if (plan.subsets.size === 0 && slices.size === 0) {
		if (plan.full.length > 0 && buildFirst) buildPass(graph(plan.full));
		if (plan.full.length > 0)
			commands.push([
				...test,
				...affected,
				...plan.full.map((dir) => `--filter=./${dir}`),
				"--continue",
				parallel,
				...turboArgs,
			]);
		return commands;
	}
	const separateTests = new Set(
		[...plan.subsets.keys(), ...slices.keys()].map((dir) => `${dir}\0test`),
	);
	const planned = graph([
		...plan.full,
		...plan.subsets.keys(),
		...slices.keys(),
	]);
	buildPass(planned);
	const tasks = planned
		.filter((task) => !separateTests.has(`${task.directory}\0${task.task}`))
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
	for (const [dir, spec] of [...slices].sort(([a], [b]) => a.localeCompare(b)))
		for (const index of [...spec.indexes].sort((a, b) => a - b))
			commands.push([
				...test,
				`--filter=./${dir}`,
				"--only",
				parallel,
				"--",
				"--passWithNoTests",
				`--shard=${index + 1}/${spec.count}`,
			]);
	return commands;
}

export type TurboGraphOptions = Readonly<{
	affected?: boolean;
	scmBase?: string;
}>;

export function turboTestGraph(
	dirs: readonly string[],
	options?: TurboGraphOptions,
): readonly GraphTask[] {
	const turboArgs = [
		"run",
		"test",
		...(options?.affected
			? ["--affected"]
			: dirs.map((dir) => `--filter=./${dir}`)),
		"--dry=json",
	];
	const env = { ...process.env };
	if (options?.scmBase) env.TURBO_SCM_BASE = options.scmBase;
	const dry = spawnTurbo(turboArgs, env);
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

export function turboAffectedTestDirectories(
	scmBase: string,
): ReadonlySet<string> {
	const tasks = turboTestGraph([], { affected: true, scmBase });
	return new Set(
		tasks.filter((task) => task.task === "test").map((task) => task.directory),
	);
}

export function intersectScopedPlanWithTurboAffected(
	plan: TestPlan,
	affected: ReadonlySet<string>,
	workspaces: readonly Workspace[],
): TestPlan {
	if (plan.mode === "all") return plan;
	const workspaceDirs = new Set(workspaces.map((ws) => ws.dir));
	const keep = (dir: string) => affected.has(dir) && workspaceDirs.has(dir);
	const full = plan.full.filter(keep);
	const subsets = new Map([...plan.subsets].filter(([dir]) => keep(dir)));
	const vitestShards =
		plan.vitestShards === undefined
			? undefined
			: new Map(
					[...plan.vitestShards].filter(
						([dir]) => keep(dir) && !subsets.has(dir),
					),
				);
	for (const dir of affected) {
		if (!workspaceDirs.has(dir) || full.includes(dir) || subsets.has(dir))
			continue;
		full.push(dir);
	}
	full.sort();
	return {
		mode: "scoped",
		full,
		subsets,
		vitestShards,
		skipped: plan.skipped.filter((dir) => !keep(dir)),
	};
}

export function planDependentTestsForTurboAffected(
	changedPaths: readonly string[],
	repo: Repo,
	scmBase: string,
	readRootFile?: ReadRootFile,
): TestPlan {
	const plan = planDependentTests(changedPaths, repo, readRootFile);
	if (plan.mode === "all") return plan;
	const affected = turboAffectedTestDirectories(scmBase);
	if (affected.size === 0)
		return { mode: "scoped", full: [], subsets: new Map(), skipped: [] };
	return intersectScopedPlanWithTurboAffected(plan, affected, repo.workspaces);
}

function alignPlanWithTurboAffectedFromEnv(
	plan: TestPlan,
	workspaces: readonly Workspace[],
): TestPlan {
	if (plan.mode === "all" || process.env.HOBO_TURBO_USE_AFFECTED !== "1")
		return plan;
	const scmBase = process.env.TURBO_SCM_BASE?.trim();
	if (!scmBase) return plan;
	return intersectScopedPlanWithTurboAffected(
		plan,
		turboAffectedTestDirectories(scmBase),
		workspaces,
	);
}

export function planHasWorkspaceWork(plan: TestPlan): boolean {
	if (plan.mode === "all") return true;
	return (
		plan.full.length > 0 ||
		plan.subsets.size > 0 ||
		(plan.vitestShards?.size ?? 0) > 0
	);
}

function runPlan(plan: TestPlan, turboArgs: readonly string[]): number {
	if (!planHasWorkspaceWork(plan)) {
		console.error("dependent-tests: no workspace tests selected");
		return 0;
	}
	let status = 0;
	for (const args of planCommands(
		plan,
		turboArgs,
		process.env.HOBO_TURBO_CONCURRENCY ?? "100%",
		turboTestGraph,
		buildConcurrencyFromEnv(),
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
		`dependent-tests: ${plan.full.length} whole suite(s), ${plan.subsets.size} subset(s), ${plan.vitestShards?.size ?? 0} vitest-sharded suite(s), ${plan.skipped.length} dependent(s) skipped`,
		...plan.full.map((dir) => `  whole  ${dir}`),
		...[...plan.subsets].map(
			([dir, files]) => `  subset ${dir}: ${files.join(" ")}`,
		),
		...[...(plan.vitestShards ?? new Map<string, VitestShardSlices>())].map(
			([dir, spec]) =>
				`  sliced ${dir}: vitest ${spec.indexes.map((index) => `${index + 1}/${spec.count}`).join(" ")}`,
		),
		...(plan.skipped.length > 20
			? []
			: plan.skipped.map((dir) => `  skip   ${dir}`)),
	];
	return lines.join("\n");
}

export function readRepo(): Repo {
	const listed = spawnSync("git", ["ls-files", "-z"], {
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (listed.status !== 0)
		throw new Error("dependent-tests: git ls-files failed");
	return {
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const input = readStdin();
	const repo = readRepo();
	const args = process.argv.slice(2);
	const baseArgument = args.find((arg) => arg.startsWith("--base="));
	const shardArgs = args.filter((arg) => arg.startsWith("--shard"));
	const planShards = args.find((arg) => arg.startsWith("--plan-shards"));
	const targetSecondsArg = args.find((arg) =>
		arg.startsWith("--target-seconds="),
	);
	const targetSeconds = Number(
		/^--target-seconds=(\d+(?:\.\d+)?)$/u.exec(targetSecondsArg ?? "")?.[1],
	);
	const shardCap = Number(/^--plan-shards=(\d+)$/u.exec(planShards ?? "")?.[1]);
	if (planShards !== undefined && !(shardCap >= 1 && shardCap <= 64)) {
		console.error(
			"dependent-tests: invalid shard cap; expected --plan-shards=MAX, 1 to 64",
		);
		process.exit(2);
	}
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
	plan = alignPlanWithTurboAffectedFromEnv(plan, repo.workspaces);
	if (planShards !== undefined) {
		const count = planShardCount(
			plan,
			shardCap,
			targetSecondsArg
				? { targetSeconds, workspaces: repo.workspaces, repo }
				: { durations: loadWorkspaceDurations(), repo },
		);
		if (targetSecondsArg) {
			const units = expandShardUnits(
				plan,
				plan.mode === "all"
					? testWorkspaceUnits(plan, repo.workspaces)
					: planUnits(plan, repo.workspaces),
				loadWorkspaceDurations(),
				repo,
			);
			const peak = maxShardLoadSeconds(
				units,
				loadWorkspaceDurations(),
				count,
				(unit) => shardUnitSeconds(plan, unit, repo, loadWorkspaceDurations()),
			);
			console.error(
				`dependent-tests: balanced ${count} shard(s), peak ${peak.toFixed(1)}s (target ${targetSeconds}s)`,
			);
		}
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
			loadWorkspaceDurations(),
			turboTestGraph,
			repo,
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
