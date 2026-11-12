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
import { isNonNegativeInt, isObject, isString } from "../lib/pins-json.ts";
import { cliRootFileReader, mainGateScope } from "./affected-lanes.mts";
import {
	MAIN_WORKSPACE_COLD_CACHE_DURATION_SCALE,
	MAIN_WORKSPACE_COLD_CACHE_PATH_THRESHOLD,
	MAIN_WORKSPACE_SHARD_TARGET_SECONDS,
	planDependentTests,
	planDependentTestsForTurboAffected,
	planHasWorkspaceWork,
	planMainWorkspaceShardCount,
	readRepo,
	scaleWorkspaceDurations,
} from "./dependent-tests.mts";
import {
	mainGateShardCountFromIndexesJson,
	resolveMainWorkspaceParallelCap,
} from "./load-fleet-capacity.mts";
import {
	fetchLastGreenMainSha,
	resolveMainTestBase,
} from "./resolve-main-test-base.mts";
import { loadWorkspaceDurations } from "./workspace-test-durations.mts";

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT?.trim();
const CACHE_DIR = process.env.MAIN_GATE_PLAN_CACHE_DIR?.trim();

type PlanCacheManifest = Readonly<{
	head: string;
	parallelCap: number;
}>;

function parsePlanCacheManifest(text: string): PlanCacheManifest | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isObject(parsed)) return undefined;
		const head = parsed.head;
		const parallelCap = parsed.parallelCap;
		if (!isString(head) || head.length === 0) return undefined;
		if (!isNonNegativeInt(parallelCap) || parallelCap < 1 || parallelCap > 8) {
			return undefined;
		}
		return { head, parallelCap };
	} catch {
		return undefined;
	}
}

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

async function tryRestorePlanCache(
	head: string,
	fleetOptions: { repository?: string; token?: string },
): Promise<boolean> {
	if (!CACHE_DIR || !GITHUB_OUTPUT) return false;
	const manifest = join(CACHE_DIR, "manifest.json");
	const outputsPath = join(CACHE_DIR, "outputs.env");
	try {
		const parsed = parsePlanCacheManifest(readFileSync(manifest, "utf8"));
		if (parsed === undefined || parsed.head !== head) return false;
		const outputsText = readFileSync(outputsPath, "utf8");
		const shardsLine = outputsText
			.split("\n")
			.find((line) => line.startsWith("shards="));
		if (!shardsLine) return false;
		const shardsJson = shardsLine.slice("shards=".length).trim();
		if (mainGateShardCountFromIndexesJson(shardsJson) < 0) return false;
		const currentCap = await resolveMainWorkspaceParallelCap(fleetOptions);
		if (parsed.parallelCap !== currentCap) {
			console.error(
				`main gate plan: cache stale (parallelCap ${parsed.parallelCap} -> ${currentCap})`,
			);
			return false;
		}
		appendFileSync(GITHUB_OUTPUT, outputsText);
		console.error(`main gate plan: restored cache for ${head}`);
		return true;
	} catch {
		return false;
	}
}

function savePlanCache(
	head: string,
	outputs: Record<string, string>,
	parallelCap: number,
): void {
	if (!CACHE_DIR) return;
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(join(CACHE_DIR, "outputs.env"), formatOutputs(outputs));
	writeFileSync(
		join(CACHE_DIR, "manifest.json"),
		JSON.stringify({ head, parallelCap }),
	);
}

async function main(): Promise<void> {
	// Install-free on the worker: turbo via mise, no pnpm install for planning.
	process.env.HOBO_TURBO_INVOKER ??= "mise";
	const repository = process.env.GITHUB_REPOSITORY ?? "";
	const token = process.env.GITHUB_TOKEN?.trim() ?? "";
	const eventName = process.env.EVENT_NAME ?? "";
	const pushBefore = process.env.PUSH_BEFORE ?? "";
	const head = process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? "";
	const fleetOptions = { repository, token };
	if (head && (await tryRestorePlanCache(head, fleetOptions))) {
		return;
	}
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
	const shardPlan = planHasWorkspaceWork(plan)
		? planMainWorkspaceShardCount(plan, parallelCap, {
				targetSeconds:
					Number.isFinite(targetSeconds) && targetSeconds > 0
						? targetSeconds
						: MAIN_WORKSPACE_SHARD_TARGET_SECONDS,
				workspaces: repo.workspaces,
				durations,
				repo,
			})
		: { count: 0, parallelCap, peakShardSeconds: 0 };
	const count = shardPlan.count;
	const shards =
		count === 0
			? "[]"
			: `[${Array.from({ length: count }, (_, index) => index).join(", ")}]`;
	console.error(
		`main gate plan: scope=${scope}, tests=${tests}, parallelCap=${parallelCap}, peakShardSeconds=${shardPlan.peakShardSeconds}, shards=${shards}`,
	);
	const outputs = {
		main_base: base,
		main_tests: tests,
		main_scope: scope,
		shards,
	};
	for (const [name, value] of Object.entries(outputs)) setOutput(name, value);
	if (head) savePlanCache(head, outputs, parallelCap);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
