/**
 * Decide which turbo lanes the PR impact gate runs for a set of changed paths.
 *
 * Package lanes run for changed packages and examples, including packages one
 * level down in a pnpm-workspace group (`packages/providers/<name>`). Root build inputs that
 * every turbo task hashes (workspace, tsconfig and biome config, toolchain pins,
 * vendored sources) and any deleted package run the whole workspace. Root
 * package.json and turbo.json edits are compared with their base: scripts-only
 * manifest edits, root `//#` task edits and globalDependencies edits do not
 * change workspace package tasks. Every other edit to those files, or a missing
 * or unparsable base/head, runs the whole workspace.
 * `pnpm-lock.yaml` alone runs the whole workspace too; with changed
 * package paths it only filters those packages (Turbo still hashes the lockfile).
 * Everything outside packages/ and examples/ (workflows, root
 * scripts, root tests, draft proofs, docs) is not a package-lane input: the
 * same gate covers it with test:root, the contract guard and agent:check, and
 * the main full gate runs the whole workspace after merge. Dependents are not
 * added, matching the previous rg-based filter.
 *
 * CLI: `git diff --name-only BASE...HEAD | node --import tsx scripts/ci/affected-lanes.mts --base=BASE`
 * prints one turbo argument per line (empty output = skip, `--filter=*` = run
 * all). With `--main-gate` it prints `repo-wide` or `affected` instead (see
 * mainGateScope). Omitting `--base` retains fail-closed path-only behavior.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

export type AffectedLanes =
	| { readonly mode: "skip"; readonly reason: string }
	| { readonly mode: "all"; readonly reason: string }
	| { readonly mode: "filtered"; readonly filters: readonly string[] };

export type RootConfigPath = "package.json" | "turbo.json";
export type ReadRootFile = (
	path: RootConfigPath,
	side: "base" | "head",
) => string | undefined;

type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;
interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;

function isJsonObject<T>(value: T): value is T & JsonObject {
	return tagOf.call(value) === "[object Object]";
}

function parseRootObject(text: string | undefined): JsonObject | undefined {
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return isJsonObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function jsonEqual(
	base: JsonValue | undefined,
	head: JsonValue | undefined,
): boolean {
	if (base === head) return true;
	if (Array.isArray(base) || Array.isArray(head)) {
		return (
			Array.isArray(base) &&
			Array.isArray(head) &&
			base.length === head.length &&
			base.every((entry, index) => jsonEqual(entry, head[index]))
		);
	}
	if (!isJsonObject(base) || !isJsonObject(head)) return false;
	const baseKeys = Object.keys(base);
	const headKeys = Object.keys(head);
	return (
		baseKeys.length === headKeys.length &&
		baseKeys.every(
			(key) => Object.hasOwn(head, key) && jsonEqual(base[key], head[key]),
		)
	);
}

function rootConfigIsPackageLaneInput(
	path: RootConfigPath,
	readRootFile: ReadRootFile | undefined,
): boolean {
	if (!readRootFile) return true;
	const base = parseRootObject(readRootFile(path, "base"));
	const head = parseRootObject(readRootFile(path, "head"));
	if (!base || !head) return true;
	const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
	const differing = [...keys].filter((key) => !jsonEqual(base[key], head[key]));
	if (path === "package.json")
		return differing.some((key) => key !== "scripts");
	return differing.some((key) => {
		// globalDependencies changes cache hashes, never task behavior or environment.
		if (key === "globalDependencies") return false;
		if (key !== "tasks") return true;
		const baseTasks = base.tasks;
		const headTasks = head.tasks;
		if (!isJsonObject(baseTasks) || !isJsonObject(headTasks)) return true;
		const taskKeys = new Set([
			...Object.keys(baseTasks),
			...Object.keys(headTasks),
		]);
		return [...taskKeys].some(
			(task) =>
				!task.startsWith("//#") && !jsonEqual(baseTasks[task], headTasks[task]),
		);
	});
}

const GLOBAL_INPUTS = [
	/^pnpm-workspace\.yaml$/,
	/^tsconfig[^/]*\.json$/,
	/^biome\.jsonc?$/,
	/^\.npmrc$/,
	/^mise\.toml$/,
	/^\.node-version$/,
	/^vendor\//,
];
/** Lockfile edits invalidate Turbo hashes but must not force a full-workspace PR test sweep when package-scoped paths are also present. */
const LOCKFILE_ONLY_GLOBAL = /^pnpm-lock\.yaml$/;
const WORKSPACE = /^(packages|examples)\/([^/]+)\//;
const GROUP_GLOB =
	/^\s*-\s*["']?((?:packages|examples)\/[^/"'*]+)\/\*["']?\s*$/;

/**
 * Directories whose children are workspace packages (`packages/providers/*`),
 * read from pnpm-workspace.yaml's `packages/<group>/*` entries.
 */
export function workspaceGroups(workspaceYaml: string): ReadonlySet<string> {
	const groups = new Set<string>();
	for (const line of workspaceYaml.split("\n")) {
		const match = GROUP_GLOB.exec(line);
		if (match?.[1]) groups.add(match[1]);
	}
	return groups;
}

const WORKSPACE_GROUPS = workspaceGroups(
	readFileSync(new URL("../../pnpm-workspace.yaml", import.meta.url), "utf8"),
);

export function affectedLanes(
	paths: readonly string[],
	exists: (dir: string) => boolean = existsSync,
	groups: ReadonlySet<string> = WORKSPACE_GROUPS,
	readRootFile?: ReadRootFile,
): AffectedLanes {
	const changed = paths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	if (changed.length === 0)
		return { mode: "all", reason: "empty diff (base unresolved?)" };
	const dirs = new Set<string>();
	let lockfileChanged = false;
	for (const path of changed) {
		if (path.split("/").some((part) => part === ".." || part === "."))
			return { mode: "all", reason: `unnormalised path: ${path}` };
		const match = WORKSPACE.exec(path);
		if (match) {
			let dir = `${match[1]}/${match[2]}`;
			if (groups.has(dir)) {
				const child = path.slice(dir.length + 1).split("/");
				if (child.length < 2)
					return { mode: "all", reason: `${path} is not inside a package` };
				dir = `${dir}/${child[0]}`;
			}
			if (!exists(`${dir}/package.json`))
				return { mode: "all", reason: `${dir} removed or not a package` };
			dirs.add(dir);
			continue;
		}
		if (
			(path === "package.json" || path === "turbo.json") &&
			rootConfigIsPackageLaneInput(path, readRootFile)
		)
			return { mode: "all", reason: `workspace-wide input changed: ${path}` };
		if (GLOBAL_INPUTS.some((pattern) => pattern.test(path)))
			return { mode: "all", reason: `workspace-wide input changed: ${path}` };
		if (LOCKFILE_ONLY_GLOBAL.test(path)) {
			lockfileChanged = true;
			continue;
		}
	}
	if (dirs.size === 0) {
		if (lockfileChanged)
			return { mode: "all", reason: "pnpm-lock.yaml changed" };
		return { mode: "skip", reason: "no package-lane inputs changed" };
	}
	return {
		mode: "filtered",
		filters: [...dirs].sort().map((dir) => `--filter=./${dir}`),
	};
}

export type MainGateScope =
	| { readonly mode: "repo-wide"; readonly reason: string }
	| { readonly mode: "affected" };

const CI_INPUTS = /^mise\.lock$/;

/**
 * Whether Main full gate runs every gate (`check:all`) or only the affected ones
 * (`agent:check --base=<previous main commit>`). Repo-wide for behavior-changing
 * root config, the lockfile and toolchain pins; affected for everything else.
 * Workflow and action files are affected-only: the PR and merge-group runs
 * already executed the changed workflow, agent:check selects the automation
 * lanes for `.github/`, and the weekly schedule still runs the whole sweep.
 */
export function mainGateScope(
	paths: readonly string[],
	exists: (dir: string) => boolean = existsSync,
	readRootFile?: ReadRootFile,
): MainGateScope {
	const ci = paths
		.map((path) => path.trim())
		.find((path) => CI_INPUTS.test(path));
	if (ci) return { mode: "repo-wide", reason: `CI input changed: ${ci}` };
	const lanes = affectedLanes(paths, exists, WORKSPACE_GROUPS, readRootFile);
	return lanes.mode === "all"
		? { mode: "repo-wide", reason: lanes.reason }
		: { mode: "affected" };
}

function cliRootFileReader(baseRef: string): ReadRootFile {
	let mergeBase = baseRef;
	try {
		mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		// An unrelated or unavailable history falls back to the ref itself.
	}
	if (mergeBase === "") mergeBase = baseRef;
	return (path, side) => {
		try {
			return side === "head"
				? readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
				: execFileSync("git", ["show", `${mergeBase}:${path}`], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					});
		} catch {
			return undefined;
		}
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const baseArgument = process.argv.find((argument) =>
		argument.startsWith("--base="),
	);
	const readRootFile =
		baseArgument === undefined
			? undefined
			: cliRootFileReader(baseArgument.slice("--base=".length));
	const input = await new Promise<string>((resolve, reject) => {
		let text = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk: string) => {
			text += chunk;
		});
		process.stdin.on("end", () => resolve(text));
		process.stdin.on("error", reject);
	});
	if (process.argv.includes("--main-gate")) {
		const scope = mainGateScope(input.split("\n"), existsSync, readRootFile);
		if (scope.mode === "repo-wide")
			console.error(`affected-lanes: repo-wide (${scope.reason})`);
		process.stdout.write(`${scope.mode}\n`);
		process.exit(0);
	}
	const lanes = affectedLanes(
		input.split("\n"),
		existsSync,
		WORKSPACE_GROUPS,
		readRootFile,
	);
	if (lanes.mode === "filtered") {
		process.stdout.write(`${lanes.filters.join("\n")}\n`);
	} else {
		console.error(`affected-lanes: ${lanes.mode} (${lanes.reason})`);
		if (lanes.mode === "all") process.stdout.write("--filter=*\n");
	}
}
