/**
 * Decide which turbo lanes the PR impact gate runs for a set of changed paths.
 *
 * Package lanes run for changed packages and examples, including packages one
 * level down in a pnpm-workspace group (`packages/providers/<name>`). Root build inputs that
 * every turbo task hashes (lockfile, workspace, turbo, tsconfig and biome config,
 * toolchain pins, vendored sources) and any deleted package run the whole
 * workspace. Everything outside packages/ and examples/ (workflows, root
 * scripts, root tests, draft proofs, docs) is not a package-lane input: the
 * same gate covers it with test:root, the contract guard and agent:check, and
 * the main full gate runs the whole workspace after merge. Dependents are not
 * added, matching the previous rg-based filter.
 *
 * CLI: `git diff --name-only BASE...HEAD | node --import tsx scripts/ci/affected-lanes.mts`
 * prints one turbo argument per line (empty output = skip, `--filter=*`-free
 * output with no args = run all). With `--main-gate` it prints `repo-wide` or
 * `affected` instead (see mainGateScope).
 */
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

export type AffectedLanes =
	| { readonly mode: "skip"; readonly reason: string }
	| { readonly mode: "all"; readonly reason: string }
	| { readonly mode: "filtered"; readonly filters: readonly string[] };

const GLOBAL_INPUTS = [
	/^pnpm-lock\.yaml$/,
	/^pnpm-workspace\.yaml$/,
	/^package\.json$/,
	/^turbo\.json$/,
	/^tsconfig[^/]*\.json$/,
	/^biome\.jsonc?$/,
	/^\.npmrc$/,
	/^mise\.toml$/,
	/^\.node-version$/,
	/^vendor\//,
];
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
): AffectedLanes {
	const changed = paths
		.map((path) => path.trim())
		.filter((path) => path !== "");
	if (changed.length === 0)
		return { mode: "all", reason: "empty diff (base unresolved?)" };
	const dirs = new Set<string>();
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
		if (GLOBAL_INPUTS.some((pattern) => pattern.test(path)))
			return { mode: "all", reason: `workspace-wide input changed: ${path}` };
	}
	if (dirs.size === 0)
		return { mode: "skip", reason: "no package-lane inputs changed" };
	return {
		mode: "filtered",
		filters: [...dirs]
			.sort()
			.flatMap((dir) =>
				dir === "packages/pricing"
					? [
							"packages/broker",
							"packages/ci",
							"packages/cloud",
							"packages/dispatcher",
							"packages/events",
							"packages/pricing",
						].map((integration) => `--filter=./${integration}`)
					: [`--filter=./${dir}`],
			),
	};
}

export type MainGateScope =
	| { readonly mode: "repo-wide"; readonly reason: string }
	| { readonly mode: "affected" };

const CI_INPUTS = /^mise\.lock$/;

/**
 * Whether Main full gate runs every gate (`check:all`) or only the affected ones
 * (`agent:check --base=<previous main commit>`). Repo-wide for root config, the
 * lockfile and toolchain pins; affected for everything else. Workflow and action
 * files are affected-only: the PR and merge-group runs already executed the
 * changed workflow, agent:check selects the automation lanes for `.github/`, and
 * the weekly schedule still runs the whole sweep.
 */
export function mainGateScope(
	paths: readonly string[],
	exists: (dir: string) => boolean = existsSync,
): MainGateScope {
	const ci = paths
		.map((path) => path.trim())
		.find((path) => CI_INPUTS.test(path));
	if (ci) return { mode: "repo-wide", reason: `CI input changed: ${ci}` };
	const lanes = affectedLanes(paths, exists);
	return lanes.mode === "all"
		? { mode: "repo-wide", reason: lanes.reason }
		: { mode: "affected" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
		const scope = mainGateScope(input.split("\n"));
		if (scope.mode === "repo-wide")
			console.error(`affected-lanes: repo-wide (${scope.reason})`);
		process.stdout.write(`${scope.mode}\n`);
		process.exit(0);
	}
	const lanes = affectedLanes(input.split("\n"));
	if (lanes.mode === "filtered") {
		process.stdout.write(`${lanes.filters.join("\n")}\n`);
	} else {
		console.error(`affected-lanes: ${lanes.mode} (${lanes.reason})`);
		if (lanes.mode === "all") process.stdout.write("--filter=*\n");
	}
}
