import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readStdin } from "../lib/read-stdin.mts";
import { cliRootFileReader } from "./affected-lanes.mts";
import {
	planDependentTests,
	readRepo,
	shardTestPlan,
	type TestPlan,
} from "./dependent-tests.mts";
import { readWorkspaces } from "./job-scope.mts";

const PLAYWRIGHT_BROWSER_TEST =
	/(?:^|\/)test\/.*\.browser\.test\.(?:[cm]?ts|[cm]?tsx)$/u;
const PLAYWRIGHT_OWNER_PAGE = /(?:^|\/)test\/mcp-owner-page\.test\.ts$/u;

export function repoPathNeedsPlaywright(path: string): boolean {
	return PLAYWRIGHT_BROWSER_TEST.test(path) || PLAYWRIGHT_OWNER_PAGE.test(path);
}

export function packageDirNeedsPlaywright(
	repo: ReturnType<typeof readRepo>,
	dir: string,
): boolean {
	for (const path of repo.files) {
		if (!path.startsWith(`${dir}/`)) continue;
		if (repoPathNeedsPlaywright(path)) return true;
	}
	return false;
}

function planExercisesBrowserTests(
	plan: TestPlan,
	repo: ReturnType<typeof readRepo>,
	workspaces: ReturnType<typeof readWorkspaces>,
): boolean {
	if (plan.mode === "all") {
		return workspaces.some((ws) => packageDirNeedsPlaywright(repo, ws.dir));
	}
	for (const dir of plan.full) {
		if (packageDirNeedsPlaywright(repo, dir)) return true;
	}
	for (const [dir, files] of plan.subsets) {
		if (files.some((file) => repoPathNeedsPlaywright(`${dir}/${file}`))) {
			return true;
		}
		if (packageDirNeedsPlaywright(repo, dir) && files.length === 0) return true;
	}
	const sliced = plan.vitestShards;
	if (sliced) {
		for (const dir of sliced.keys()) {
			if (packageDirNeedsPlaywright(repo, dir)) return true;
		}
	}
	return false;
}

export function workspaceShardNeedsPlaywright(options: {
	readonly plan: TestPlan;
	readonly shard: number;
	readonly shardTotal: number;
}): boolean {
	const repo = readRepo();
	const workspaces = readWorkspaces();
	const shardPlan = shardTestPlan(
		options.plan,
		workspaces,
		options.shard,
		options.shardTotal,
		undefined,
		undefined,
		repo,
	);
	return planExercisesBrowserTests(shardPlan, repo, workspaces);
}

function affectedPathsNeedDomOrBrowser(base: string): boolean {
	const diff = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
		encoding: "utf8",
	});
	if (diff.status !== 0 || !diff.stdout.trim()) return false;
	return diff.stdout
		.split("\n")
		.some(
			(path) =>
				path.trim() &&
				(repoPathNeedsPlaywright(path.trim()) ||
					/^(packages\/(site|ci-dashboard|hobo|connection-ui)\/|site\/)/u.test(
						path.trim(),
					)),
		);
}

function mainGateNeedsPlaywright(scope: string, base: string): boolean {
	if (scope === "repo-wide") return true;
	if (!base) return false;
	return affectedPathsNeedDomOrBrowser(base);
}

function parseShard(
	value: string,
): { index: number; total: number } | undefined {
	const match = /^(\d+)\/(\d+)$/u.exec(value.trim());
	if (!match) return undefined;
	const index = Number(match[1]);
	const total = Number(match[2]);
	if (
		!Number.isSafeInteger(index) ||
		!Number.isSafeInteger(total) ||
		total < 1 ||
		index < 0 ||
		index >= total
	)
		return undefined;
	return { index, total };
}

function parseArgs(argv: readonly string[]) {
	let shard = "";
	let tests = "affected";
	let base = "";
	let scope = "";
	let force = "";
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--shard") {
			shard = argv[++index] ?? "";
		} else if (arg.startsWith("--shard=")) {
			shard = arg.slice("--shard=".length);
		} else if (arg === "--tests") {
			tests = argv[++index] ?? "affected";
		} else if (arg.startsWith("--tests=")) {
			tests = arg.slice("--tests=".length);
		} else if (arg === "--base") {
			base = argv[++index] ?? "";
		} else if (arg.startsWith("--base=")) {
			base = arg.slice("--base=".length);
		} else if (arg === "--scope") {
			scope = argv[++index] ?? "";
		} else if (arg.startsWith("--scope=")) {
			scope = arg.slice("--scope=".length);
		} else if (arg === "--force") {
			force = argv[++index] ?? "";
		} else if (arg.startsWith("--force=")) {
			force = arg.slice("--force=".length);
		}
	}
	return { shard, tests, base, scope, force };
}

async function run(): Promise<void> {
	const { shard, tests, base, scope, force } = parseArgs(process.argv.slice(2));
	if (force === "true") {
		process.stdout.write("true\n");
		return;
	}
	if (force === "false") {
		process.stdout.write("false\n");
		return;
	}
	if (scope) {
		process.stdout.write(
			`${mainGateNeedsPlaywright(scope, base) ? "true" : "false"}\n`,
		);
		return;
	}
	const shardParts = parseShard(shard);
	if (!shardParts) {
		process.stdout.write("false\n");
		return;
	}
	const changed = await readStdin();
	const repo = readRepo();
	const readRoot = base ? cliRootFileReader(base) : undefined;
	const plan =
		tests === "all"
			? ({ mode: "all", reason: "cli" } as const)
			: planDependentTests(changed.split("\n").filter(Boolean), repo, readRoot);
	process.stdout.write(
		`${
			workspaceShardNeedsPlaywright({
				plan,
				shard: shardParts.index,
				shardTotal: shardParts.total,
			})
				? "true"
				: "false"
		}\n`,
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	run().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
