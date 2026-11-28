import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";

export type AffectedLanes =
	| { readonly mode: "skip"; readonly reason: string }
	| { readonly mode: "all"; readonly reason: string }
	| { readonly mode: "filtered"; readonly filters: readonly string[] };

export type RootConfigPath =
	| "package.json"
	| "turbo.json"
	| "mise.toml"
	| "mise.lock";
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

function isJsonString(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
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

function rootManifestWidens(readRootFile: ReadRootFile | undefined): boolean {
	if (!readRootFile) return true;
	const base = parseRootObject(readRootFile("package.json", "base"));
	const head = parseRootObject(readRootFile("package.json", "head"));
	if (!base || !head) return true;
	const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
	return [...keys].some(
		(key) => key !== "scripts" && !jsonEqual(base[key], head[key]),
	);
}

function turboPackageNames(
	readRootFile: ReadRootFile | undefined,
): readonly string[] | undefined {
	if (!readRootFile) return undefined;
	const base = parseRootObject(readRootFile("turbo.json", "base"));
	const head = parseRootObject(readRootFile("turbo.json", "head"));
	if (!base || !head) return undefined;
	const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
	for (const key of keys) {
		if (key === "tasks") continue;
		if (!jsonEqual(base[key], head[key])) return undefined;
	}
	const baseTasks = base.tasks;
	const headTasks = head.tasks;
	if (jsonEqual(baseTasks, headTasks)) return [];
	if (!isJsonObject(baseTasks) || !isJsonObject(headTasks)) return undefined;
	const packages = new Set<string>();
	const taskKeys = new Set([
		...Object.keys(baseTasks),
		...Object.keys(headTasks),
	]);
	for (const task of taskKeys) {
		if (jsonEqual(baseTasks[task], headTasks[task])) continue;
		if (task.startsWith("//#")) continue;
		const hash = task.indexOf("#");
		if (hash <= 0) return undefined;
		packages.add(task.slice(0, hash));
	}
	return [...packages];
}

let cachedPackageDirs: Map<string, string> | undefined;

function workspacePackageDir(name: string): string | undefined {
	cachedPackageDirs ??= indexWorkspacePackages();
	const dir = cachedPackageDirs.get(name);
	return dir === undefined || dir === "" ? undefined : dir;
}

function indexWorkspacePackages(): Map<string, string> {
	const yaml = readFileSync(
		new URL("../../pnpm-workspace.yaml", import.meta.url),
		"utf8",
	);
	const block = /^packages:\n((?:[ \t]+-[^\n]*\n)+)/m.exec(yaml)?.[1] ?? "";
	const patterns = [...block.matchAll(/-\s*["']?([^"'\n]+?)["']?\s*$/gm)]
		.map((match) => match[1] ?? "")
		.filter((pattern) => pattern !== "" && !pattern.startsWith("!"));
	const map = new Map<string, string>();
	for (const pattern of patterns) {
		for (const dir of expandWorkspacePattern(pattern)) {
			const manifestPath = posix.join(dir, "package.json");
			if (!existsSync(manifestPath)) continue;
			let packageName: string | undefined;
			try {
				const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (isJsonObject(value) && isJsonString(value.name))
					packageName = value.name;
			} catch {
				continue;
			}
			if (packageName === undefined) continue;
			const prior = map.get(packageName);
			map.set(packageName, prior !== undefined && prior !== dir ? "" : dir);
		}
	}
	return map;
}

function expandWorkspacePattern(pattern: string): readonly string[] {
	let dirs = ["."];
	for (const segment of pattern.split("/")) {
		if (segment === "") continue;
		if (segment === "*") {
			dirs = dirs.flatMap((dir) => {
				try {
					return readdirSync(dir, { withFileTypes: true })
						.filter((entry) => entry.isDirectory())
						.map((entry) => posix.join(dir, entry.name));
				} catch {
					return [];
				}
			});
			continue;
		}
		dirs = dirs.map((dir) => posix.join(dir, segment));
	}
	return dirs;
}

/**
 * Tools pinned for the runner image and root scripts that no workspace
 * package task executes. A tool is listed here only after checking that no
 * package build or test runs it; an unlisted tool widens, so a new pin is
 * conservative until someone decides otherwise.
 */
const CI_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"betterleaks",
	"shellcheck",
	"syft",
]);

// A header may carry a comment. One this missed would leave a CI-only block
// open and hide the lines after it.
const TOML_HEADER = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(?:#.*)?$/;
// `tools.syft`, `tools.syft."platforms.linux-x64"`, `tools."aqua:x/y"`. A
// quoted name is taken whole: `tools."syft.plugin"` is not syft.
const LOCK_TOOL = /^tools\.(?:"([^"]+)"|([^."\s]+))\s*(?:\.|$)/;
const TOML_KEY = /^\s*"?([A-Za-z0-9_.:/@-]+)"?\s*=/;

/** mise.toml without the `[tools]` pins of CI-only tools, blank lines dropped. */
function withoutCiOnlyPins(toml: string): string {
	let section = "";
	return toml
		.split("\n")
		.filter((line) => {
			if (line.trim() === "") return false;
			const header = TOML_HEADER.exec(line);
			if (header?.[1] !== undefined) {
				section = header[1];
				return true;
			}
			if (section !== "tools") return true;
			const key = TOML_KEY.exec(line)?.[1];
			return key === undefined || !CI_ONLY_TOOLS.has(key);
		})
		.join("\n");
}

/** mise.lock without the `[[tools.<name>]]` blocks of CI-only tools. */
function withoutCiOnlyLocks(lock: string): string {
	let dropping = false;
	return lock
		.split("\n")
		.filter((line) => {
			if (line.trim() === "") return false;
			const header = TOML_HEADER.exec(line)?.[1];
			if (header !== undefined) {
				const match = LOCK_TOOL.exec(header);
				const tool = match?.[1] ?? match?.[2];
				dropping = tool !== undefined && CI_ONLY_TOOLS.has(tool);
			}
			return !dropping;
		})
		.join("\n");
}

/**
 * Whether a toolchain pin edit can change a workspace package task. False only
 * when base and head are identical once CI-only tools are set aside.
 */
function toolchainIsPackageLaneInput(
	path: "mise.toml" | "mise.lock",
	readRootFile: ReadRootFile | undefined,
): boolean {
	if (!readRootFile) return true;
	const base = readRootFile(path, "base");
	const head = readRootFile(path, "head");
	if (base === undefined || head === undefined) return true;
	const strip = path === "mise.toml" ? withoutCiOnlyPins : withoutCiOnlyLocks;
	return strip(base) !== strip(head);
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
	const turboPackages = new Set<string>();
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
		if (path === "package.json" && rootManifestWidens(readRootFile))
			return { mode: "all", reason: `workspace-wide input changed: ${path}` };
		if (path === "turbo.json") {
			const names = turboPackageNames(readRootFile);
			if (names === undefined)
				return { mode: "all", reason: `workspace-wide input changed: ${path}` };
			for (const name of names) turboPackages.add(name);
			continue;
		}
		if (
			path === "mise.toml" &&
			!toolchainIsPackageLaneInput(path, readRootFile)
		)
			continue;
		if (GLOBAL_INPUTS.some((pattern) => pattern.test(path)))
			return { mode: "all", reason: `workspace-wide input changed: ${path}` };
		if (LOCKFILE_ONLY_GLOBAL.test(path)) {
			lockfileChanged = true;
			continue;
		}
	}
	for (const name of [...turboPackages].sort()) {
		const dir = workspacePackageDir(name);
		if (dir === undefined)
			return {
				mode: "all",
				reason: `turbo.json task names a package outside the workspace: ${name}`,
			};
		if (!exists(`${dir}/package.json`))
			return { mode: "all", reason: `${dir} removed or not a package` };
		dirs.add(dir);
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
 * root config, globalDependencies edits, the lockfile and toolchain pins a
 * workspace task runs; affected for everything else, including a pin of a
 * CI-only tool.
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
		.find(
			(path) =>
				CI_INPUTS.test(path) &&
				toolchainIsPackageLaneInput("mise.lock", readRootFile),
		);
	if (ci) return { mode: "repo-wide", reason: `CI input changed: ${ci}` };
	const lanes = affectedLanes(paths, exists, WORKSPACE_GROUPS, readRootFile);
	return lanes.mode === "all"
		? { mode: "repo-wide", reason: lanes.reason }
		: { mode: "affected" };
}

/**
 * Root-config reader for CLI callers: base contents come from the merge
 * base with `baseRef`, head contents from the working tree.
 */
export function cliRootFileReader(baseRef: string): ReadRootFile {
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
		// An empty ref would make `git show :path` read the index, which
		// matches a clean tree and would narrow. No base means widen.
		if (side === "base" && mergeBase === "") return undefined;
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
