/**
 * Decide which turbo lanes the PR impact gate runs for a set of changed paths.
 *
 * The rule that keeps this from reporting a false green: a change may only skip
 * the lanes when every changed path is known to be inert (docs, changesets).
 * Anything unrecognised, any root-level build input, and any deleted package
 * runs the whole workspace. Changed packages are filtered with their
 * dependents (`...`), so a change to a shared package also tests its consumers.
 *
 * CLI: `git diff --name-only BASE...HEAD | node --import tsx scripts/ci/affected-lanes.mts`
 * prints one turbo argument per line (empty output = skip, `--filter=*`-free
 * output with no args = run all).
 */
import { existsSync } from "node:fs";
import process from "node:process";

export type AffectedLanes =
	| { readonly mode: "skip"; readonly reason: string }
	| { readonly mode: "all"; readonly reason: string }
	| { readonly mode: "filtered"; readonly filters: readonly string[] };

const INERT = [
	/^docs\//,
	/^\.changeset\/[^/]+\.md$/,
	/^[^/]+\.md$/,
	/^LICENSE[^/]*$/,
	/^\.github\/ISSUE_TEMPLATE\//,
	/^\.github\/[^/]+\.md$/,
];
const WORKSPACE = /^(packages|examples)\/([^/]+)\//;

export function affectedLanes(
	paths: readonly string[],
	exists: (dir: string) => boolean = existsSync,
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
			const dir = `${match[1]}/${match[2]}`;
			if (!exists(`${dir}/package.json`))
				return { mode: "all", reason: `${dir} removed or not a package` };
			dirs.add(dir);
			continue;
		}
		if (INERT.some((pattern) => pattern.test(path))) continue;
		return { mode: "all", reason: `workspace-wide input changed: ${path}` };
	}
	if (dirs.size === 0)
		return { mode: "skip", reason: "only inert paths changed" };
	return {
		mode: "filtered",
		filters: [...dirs].sort().map((dir) => `--filter=...{./${dir}}`),
	};
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
	const lanes = affectedLanes(input.split("\n"));
	if (lanes.mode === "filtered") {
		process.stdout.write(`${lanes.filters.join("\n")}\n`);
	} else {
		console.error(`affected-lanes: ${lanes.mode} (${lanes.reason})`);
		if (lanes.mode === "all") process.stdout.write("--filter=*\n");
	}
}
