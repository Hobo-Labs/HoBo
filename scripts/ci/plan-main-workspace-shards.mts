/**
 * Resolve main push test base/scope and print balanced workspace shard indexes.
 * Used by main-gate-plan so shards start before Main full gate S0 finishes.
 */
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cliRootFileReader, mainGateScope } from "./affected-lanes.mts";
import {
	MAIN_WORKSPACE_COLD_CACHE_DURATION_SCALE,
	MAIN_WORKSPACE_COLD_CACHE_PATH_THRESHOLD,
	MAIN_WORKSPACE_SHARD_TARGET_SECONDS,
	planDependentTests,
	planDependentTestsForTurboAffected,
	planMainWorkspaceShardCount,
	readRepo,
	scaleWorkspaceDurations,
} from "./dependent-tests.mts";
import {
	fetchFleetCapacityVariable,
	resolveMainWorkspaceParallelCap,
	resolveMainWorkspaceShardRunner,
} from "./load-fleet-capacity.mts";
import {
	fetchLastGreenMainSha,
	resolveMainTestBase,
} from "./resolve-main-test-base.mts";
import { loadWorkspaceDurations } from "./workspace-test-durations.mts";

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT?.trim();
const CACHE_DIR = process.env.MAIN_GATE_PLAN_CACHE_DIR?.trim();

function formatOutputs(entries: Record<string, string>): string {
	return Object.entries(entries)
		.map(([name, value]) => `${name}=${value}\n`)
		.join("");
}

function setOutput(name: string, value: string): void {
	if (GITHUB_OUTPUT) {
		appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
		return;
	}
	console.log(`${name}=${value}`);
}

function tryRestorePlanCache(head: string): boolean {
	if (!CACHE_DIR || !GITHUB_OUTPUT) return false;
	const manifest = join(CACHE_DIR, "manifest.json");
	try {
		// SAFETY: manifest.json is written by savePlanCache in this script as { head: string }.
		const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
			head?: string;
		};
		if (parsed.head !== head) return false;
		appendFileSync(
			GITHUB_OUTPUT,
			readFileSync(join(CACHE_DIR, "outputs.env"), "utf8"),
		);
		console.error(`main gate plan: restored cache for ${head}`);
		return true;
	} catch {
		return false;
	}
}

function savePlanCache(head: string, outputs: Record<string, string>): void {
	if (!CACHE_DIR) return;
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(join(CACHE_DIR, "outputs.env"), formatOutputs(outputs));
	writeFileSync(join(CACHE_DIR, "manifest.json"), JSON.stringify({ head }));
}

async function main(): Promise<void> {
	// Install-free on the worker: turbo via mise, no pnpm install for planning.
	process.env.HOBO_TURBO_INVOKER ??= "mise";
	const eventName = process.env.EVENT_NAME ?? "";
	const pushBefore = process.env.PUSH_BEFORE ?? "";
	const head = process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? "";
	if (head && tryRestorePlanCache(head)) {
		const fleetOptions = { repository, token };
		const shardRunner = resolveMainWorkspaceShardRunner(
			await fetchFleetCapacityVariable(fleetOptions),
		);
		setOutput("shard_runner", shardRunner);
		return;
	}
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	let base = "";
	if (eventName === "push") {
		let lastGreen: string | undefined;
		if (token && repository) {
			lastGreen = await fetchLastGreenMainSha({
				repository,
				token,
				workflowBasename: "hobo-ci.yml",
				head,
				fetch: globalThis.fetch,
			});
		}
		const resolved = resolveMainTestBase(
			lastGreen === undefined
				? { eventName, pushBefore, head }
				: { eventName, pushBefore, head, lastGreenSha: lastGreen },
		);
		base = resolved.base;
	}
	if (eventName === "workflow_dispatch") {
		base = spawnSync("git", ["rev-parse", "HEAD~1"], {
			encoding: "utf8",
		}).stdout.trim();
	}
	if (
		base &&
		spawnSync("git", ["cat-file", "-e", `${base}^{commit}`]).status !== 0
	) {
		base = "";
	}
	let scope = "repo-wide";
	let tests = "all";
	if (base) {
		const changed = spawnSync("git", ["diff", "--name-only", base, "HEAD"], {
			encoding: "utf8",
		}).stdout;
		const changedPaths = changed.split("\n");
		const readRootFile = cliRootFileReader(base);
		const gateScope = mainGateScope(changedPaths, undefined, readRootFile);
		scope = gateScope.mode;
		// Repo-wide workspace tests only when root config or the lockfile widens
		// the main gate; every other push runs turbo against last-green main.
		tests = gateScope.mode === "repo-wide" ? "all" : "affected";
	}
	const repo = readRepo();
	const input =
		tests === "affected" && base
			? spawnSync("git", ["diff", "--name-only", base, "HEAD"], {
					encoding: "utf8",
				}).stdout
			: "";
	if (base) process.env.TURBO_SCM_BASE = base;
	const plan =
		tests === "affected" && base
			? planDependentTestsForTurboAffected(
					input.split("\n"),
					repo,
					base,
					cliRootFileReader(base),
				)
			: planDependentTests(
					input.split("\n"),
					repo,
					base ? cliRootFileReader(base) : undefined,
				);
	const fleetOptions = { repository, token };
	const fleetCapacity = await fetchFleetCapacityVariable(fleetOptions);
	const shardRunner = resolveMainWorkspaceShardRunner(fleetCapacity);
	const parallelCap = await resolveMainWorkspaceParallelCap(fleetOptions);
	const targetSeconds = Number(
		process.env.MAIN_SHARD_TARGET_SECONDS ??
			String(MAIN_WORKSPACE_SHARD_TARGET_SECONDS),
	);
	const changedCount = input
		.split("\n")
		.filter((line) => line.trim() !== "").length;
	let durations = loadWorkspaceDurations();
	if (
		tests === "affected" &&
		changedCount >= MAIN_WORKSPACE_COLD_CACHE_PATH_THRESHOLD
	) {
		durations = scaleWorkspaceDurations(
			durations,
			MAIN_WORKSPACE_COLD_CACHE_DURATION_SCALE,
		);
	}
	const shardPlan = planMainWorkspaceShardCount(plan, parallelCap, {
		targetSeconds:
			Number.isFinite(targetSeconds) && targetSeconds > 0
				? targetSeconds
				: MAIN_WORKSPACE_SHARD_TARGET_SECONDS,
		workspaces: repo.workspaces,
		durations,
		repo,
	});
	const count = shardPlan.count;
	const shards = `[${Array.from({ length: count }, (_, index) => index).join(", ")}]`;
	console.error(
		`main gate plan: scope=${scope}, tests=${tests}, parallelCap=${parallelCap}, shardRunner=${shardRunner}, peakShardSeconds=${shardPlan.peakShardSeconds}, shards=${shards}`,
	);
	const outputs = {
		main_base: base,
		main_tests: tests,
		main_scope: scope,
		shards,
	};
	for (const [name, value] of Object.entries(outputs)) setOutput(name, value);
	setOutput("shard_runner", shardRunner);
	if (head) savePlanCache(head, outputs);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
