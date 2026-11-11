/**
 * Resolve main push test base/scope and print balanced workspace shard indexes.
 * Used by main-gate-plan so shards start before Main full gate S0 finishes.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cliRootFileReader, mainGateScope } from "./affected-lanes.mts";
import {
	MAIN_WORKSPACE_SHARD_TARGET_SECONDS,
	planDependentTests,
	planMainWorkspaceShardCount,
	readRepo,
} from "./dependent-tests.mts";
import { resolveMainWorkspaceParallelCap } from "./load-fleet-capacity.mts";
import {
	fetchLastGreenMainSha,
	resolveMainTestBase,
} from "./resolve-main-test-base.mts";

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT?.trim();

function setOutput(name: string, value: string): void {
	if (GITHUB_OUTPUT) {
		appendFileSync(GITHUB_OUTPUT, `${name}=${value}\n`);
		return;
	}
	console.log(`${name}=${value}`);
}

async function main(): Promise<void> {
	const eventName = process.env.EVENT_NAME ?? "";
	const pushBefore = process.env.PUSH_BEFORE ?? "";
	const head = process.env.HEAD_SHA ?? process.env.GITHUB_SHA ?? "";
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
	const plan = planDependentTests(input.split("\n"), repo);
	const parallelCap = await resolveMainWorkspaceParallelCap({
		repository,
		token,
	});
	const targetSeconds = Number(
		process.env.MAIN_SHARD_TARGET_SECONDS ??
			String(MAIN_WORKSPACE_SHARD_TARGET_SECONDS),
	);
	const shardPlan = planMainWorkspaceShardCount(plan, parallelCap, {
		targetSeconds:
			Number.isFinite(targetSeconds) && targetSeconds > 0
				? targetSeconds
				: MAIN_WORKSPACE_SHARD_TARGET_SECONDS,
		workspaces: repo.workspaces,
	});
	const count = shardPlan.count;
	const shards = `[${Array.from({ length: count }, (_, index) => index).join(", ")}]`;
	console.error(
		`main gate plan: scope=${scope}, tests=${tests}, parallelCap=${parallelCap}, peakShardSeconds=${shardPlan.peakShardSeconds}, shards=${shards}`,
	);
	setOutput("main_base", base);
	setOutput("main_tests", tests);
	setOutput("main_scope", scope);
	setOutput("shards", shards);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
