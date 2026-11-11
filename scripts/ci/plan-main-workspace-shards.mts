/**
 * Resolve main push test base/scope and print balanced workspace shard indexes.
 * Used by main-gate-plan so shards start before Main full gate S0 finishes.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	affectedLanes,
	cliRootFileReader,
	mainGateScope,
} from "./affected-lanes.mts";
import {
	planDependentTests,
	planShardCount,
	readRepo,
} from "./dependent-tests.mts";
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
				// The branch that was pushed, as in resolve-main-test-base.mts.
				branch: process.env.GITHUB_REF_NAME?.trim() || "main",
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
		scope = mainGateScope(changedPaths, undefined, readRootFile).mode;
		const lanes = affectedLanes(
			changedPaths,
			undefined,
			undefined,
			readRootFile,
		);
		if (lanes.mode !== "all") tests = "affected";
	}
	const repo = readRepo();
	const input =
		tests === "affected" && base
			? spawnSync("git", ["diff", "--name-only", base, "HEAD"], {
					encoding: "utf8",
				}).stdout
			: "";
	const plan = planDependentTests(input.split("\n"), repo);
	const shardCap = Number(process.env.MAIN_SHARD_CAP ?? "64");
	const targetSeconds = Number(process.env.MAIN_SHARD_TARGET_SECONDS ?? "90");
	const count = planShardCount(plan, shardCap, {
		targetSeconds,
		workspaces: repo.workspaces,
	});
	const shards = `[${Array.from({ length: count }, (_, index) => index).join(", ")}]`;
	console.error(
		`main gate plan: scope=${scope}, tests=${tests}, shards=${shards}`,
	);
	setOutput("main_base", base);
	setOutput("main_tests", tests);
	setOutput("main_scope", scope);
	setOutput("shards", shards);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	void main();
}
