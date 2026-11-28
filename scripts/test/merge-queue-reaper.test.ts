import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	MIN_AGE_MS,
	main,
	orphanedRuns,
	parseQueueRefs,
	parseRunsPage,
	type QueueRun,
	shouldDryRun,
} from "../ci/merge-queue-reaper.mts";

const NOW = Date.parse("2026-11-28T15:40:00Z");
const live =
	"gh-readonly-queue/main/pr-3324-3474ceb3c8de5f01e3f2462c194a6aa90d207973";
const gone =
	"gh-readonly-queue/main/pr-3330-8763f74c0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const run = (id: number, branch: string, createdAt: string): QueueRun => ({
	id,
	branch,
	createdAt,
	workflow: "HoBo CI Fabric",
});

describe("orphaned merge-group runs", () => {
	it("selects runs whose queue branch is gone, and only those", () => {
		const orphans = orphanedRuns(
			[
				run(1, gone, "2026-11-28T08:00:33Z"),
				run(2, live, "2026-11-28T15:27:21Z"),
				run(3, "main", "2026-11-28T08:00:00Z"),
			],
			new Set([live]),
			NOW,
		);
		assert.deepEqual(
			orphans.map((found) => found.id),
			[1],
		);
	});

	it("leaves a run younger than the minimum age, whose branch may still be appearing", () => {
		const young = new Date(NOW - MIN_AGE_MS + 1000).toISOString();
		assert.deepEqual(orphanedRuns([run(4, gone, young)], new Set(), NOW), []);
		const old = new Date(NOW - MIN_AGE_MS).toISOString();
		assert.equal(orphanedRuns([run(5, gone, old)], new Set(), NOW).length, 1);
	});

	it("keeps a run whose creation time cannot be read", () => {
		assert.deepEqual(orphanedRuns([run(6, gone, "soon")], new Set(), NOW), []);
	});

	it("reads merge-group runs and queue refs, ignoring anything else", () => {
		assert.deepEqual(
			parseRunsPage({
				workflow_runs: [
					{
						id: 7,
						event: "merge_group",
						head_branch: gone,
						created_at: "2026-11-28T08:00:33Z",
						name: "HoBo CI Fabric",
					},
					{ id: 8, event: "push", head_branch: "main", created_at: "x" },
					{ id: "9", event: "merge_group" },
				],
			}),
			[run(7, gone, "2026-11-28T08:00:33Z")],
		);
		assert.deepEqual(parseRunsPage(null), []);
		assert.deepEqual(
			[
				...parseQueueRefs([
					{ ref: `refs/heads/${live}` },
					{ ref: "refs/heads/main" },
					{},
				]),
			],
			[live],
		);
	});

	it("is a dry run unless told otherwise", () => {
		assert.equal(shouldDryRun(undefined), true);
		assert.equal(shouldDryRun("true"), true);
		assert.equal(shouldDryRun("false"), false);
	});
});

describe("the reaper run", () => {
	const fakeApi =
		(cancelled: string[]): typeof fetch =>
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "POST") {
				cancelled.push(url);
				return new Response("", { status: 202 });
			}
			if (url.includes("/git/matching-refs/"))
				return Response.json([{ ref: `refs/heads/${live}` }]);
			if (url.includes("status=queued&") && url.endsWith("page=1"))
				return Response.json({
					workflow_runs: [
						{
							id: 11,
							event: "merge_group",
							head_branch: gone,
							created_at: "2026-11-28T08:00:33Z",
							name: "HoBo CI Fabric",
						},
						{
							id: 12,
							event: "merge_group",
							head_branch: live,
							created_at: "2026-11-28T15:27:21Z",
							name: "HoBo CI Fabric",
						},
					],
				});
			return Response.json({ workflow_runs: [] });
		};
	const env = (dryRun: string) => ({
		GITHUB_TOKEN: "token",
		GITHUB_REPOSITORY: "Hobo-Labs/HoBo",
		MERGE_QUEUE_REAPER_DRY_RUN: dryRun,
	});

	it("cancels the orphaned run and not the live one", async () => {
		const cancelled: string[] = [];
		const lines: string[] = [];
		const code = await main(env("false"), fakeApi(cancelled), NOW, (line) =>
			lines.push(line),
		);
		assert.equal(code, 0);
		assert.deepEqual(cancelled, [
			"https://api.github.com/repos/Hobo-Labs/HoBo/actions/runs/11/cancel",
		]);
		assert.match(
			lines[0] ?? "",
			/2 pending merge-group run\(s\), 1 live queue branch\(es\), 1 orphaned$/,
		);
	});

	it("cancels nothing in a dry run", async () => {
		const cancelled: string[] = [];
		const code = await main(env("true"), fakeApi(cancelled), NOW, () => {});
		assert.equal(code, 0);
		assert.deepEqual(cancelled, []);
	});

	it("refuses to run without a token or repository", async () => {
		assert.equal(await main({}, fakeApi([]), NOW, () => {}), 2);
	});
});

describe("the reaper workflow", () => {
	const workflow = readFileSync(
		join(import.meta.dirname, "../../.github/workflows/merge-queue-reaper.yml"),
		"utf8",
	);
	it("runs every five minutes on GitHub-hosted with only actions: write", () => {
		assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
		assert.match(workflow, /runs-on: ubuntu-24.04/);
		assert.match(
			workflow,
			/permissions:\n {2}actions: write\n {2}contents: read\n/,
		);
		assert.match(workflow, /run: node scripts\/ci\/merge-queue-reaper\.mts/);
		assert.match(
			workflow,
			/MERGE_QUEUE_REAPER_DRY_RUN: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry-run \|\| 'false' \}\}/,
		);
	});
});
