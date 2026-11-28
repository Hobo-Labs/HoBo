import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	abandonedRuns,
	parseRunsPage,
	type QueueRun,
	reap,
	shouldDryRun,
} from "../ci/merge-queue-reaper.mts";

const REPO = "Hobo-Labs/HoBo";
const run = (id: number, branch: string, sha = `sha${id}`): QueueRun => ({
	id,
	name: "HoBo CI Fabric",
	headBranch: branch,
	headSha: sha,
});

interface World {
	runs: Record<string, QueueRun[]>;
	liveRefs: Set<string>;
	inMain: Set<string>;
	finished?: Set<number>;
}

function github(world: World) {
	const cancelled: number[] = [];
	const fetcher: typeof fetch = async (request, init) => {
		const url = new URL(String(request));
		const method = init?.method ?? "GET";
		const path = url.pathname;
		if (method === "GET" && path === `/repos/${REPO}/actions/runs`) {
			const page = Number(url.searchParams.get("page"));
			const runs =
				page === 1
					? (world.runs[url.searchParams.get("status") ?? ""] ?? [])
					: [];
			return Response.json({
				workflow_runs: runs.map((r) => ({
					id: r.id,
					name: r.name,
					event: "merge_group",
					head_branch: r.headBranch,
					head_sha: r.headSha,
				})),
			});
		}
		const refPrefix = `/repos/${REPO}/git/ref/heads/`;
		if (method === "GET" && path.startsWith(refPrefix)) {
			const branch = decodeURIComponent(path.slice(refPrefix.length));
			return world.liveRefs.has(branch)
				? Response.json({ ref: `refs/heads/${branch}` })
				: Response.json({ message: "Not Found" }, { status: 404 });
		}
		const comparePrefix = `/repos/${REPO}/compare/`;
		if (method === "GET" && path.startsWith(comparePrefix)) {
			const sha = path.slice(comparePrefix.length).split("...")[0] ?? "";
			return Response.json({
				status: world.inMain.has(sha) ? "ahead" : "diverged",
			});
		}
		const cancel = path.match(/\/actions\/runs\/(\d+)\/cancel$/u);
		if (method === "POST" && cancel) {
			const id = Number(cancel[1]);
			if (world.finished?.has(id))
				return Response.json({ message: "Cannot cancel" }, { status: 409 });
			cancelled.push(id);
			return Response.json({}, { status: 202 });
		}
		return Response.json({ message: "Not Found" }, { status: 404 });
	};
	return { fetcher, cancelled };
}

const quiet = () => undefined;

describe("merge queue reaper", () => {
	it("cancels only runs whose group the queue dropped without landing", async () => {
		const live = "gh-readonly-queue/main/pr-3331-aaa";
		const dropped = "gh-readonly-queue/main/pr-3330-bbb";
		const landed = "gh-readonly-queue/main/pr-3324-ccc";
		const { fetcher, cancelled } = github({
			runs: {
				queued: [run(1, dropped), run(2, live), run(3, landed, "merged")],
				in_progress: [run(4, dropped), run(1, dropped)],
			},
			liveRefs: new Set([live]),
			inMain: new Set(["merged"]),
		});
		const found = await reap(fetcher, {
			token: "t",
			repository: REPO,
			base: "main",
			dryRun: false,
			write: quiet,
		});
		assert.deepEqual(
			found.map((r) => r.id),
			[1, 4],
		);
		assert.deepEqual(cancelled, [1, 4]);
	});

	it("cancels nothing in a dry run", async () => {
		const { fetcher, cancelled } = github({
			runs: { queued: [run(1, "gh-readonly-queue/main/pr-1-x")] },
			liveRefs: new Set(),
			inMain: new Set(),
		});
		const lines: string[] = [];
		const found = await reap(fetcher, {
			token: "t",
			repository: REPO,
			base: "main",
			dryRun: true,
			write: (line) => lines.push(line),
		});
		assert.equal(found.length, 1);
		assert.deepEqual(cancelled, []);
		assert.match(lines.join("\n"), /would cancel 1/u);
	});

	it("never cancels its own run and treats an already finished run as done", async () => {
		const gone = "gh-readonly-queue/main/pr-9-z";
		const { fetcher, cancelled } = github({
			runs: { queued: [run(7, gone), run(8, gone)] },
			liveRefs: new Set(),
			inMain: new Set(),
			finished: new Set([8]),
		});
		const lines: string[] = [];
		await reap(fetcher, {
			token: "t",
			repository: REPO,
			base: "main",
			dryRun: false,
			self: 7,
			write: (line) => lines.push(line),
		});
		assert.deepEqual(cancelled, []);
		assert.match(lines.join("\n"), /finished 8/u);
	});

	it("leaves runs that are not on a merge-queue branch alone", () => {
		assert.deepEqual(
			abandonedRuns([run(1, "main"), run(2, "feature")], () => "abandoned"),
			[],
		);
	});

	it("reads only merge-group runs from a page", () => {
		assert.deepEqual(
			parseRunsPage({
				workflow_runs: [
					{
						id: 1,
						name: "a",
						event: "push",
						head_branch: "main",
						head_sha: "s",
					},
					{
						id: 2,
						name: "b",
						event: "merge_group",
						head_branch: "gh-readonly-queue/main/pr-1-s",
						head_sha: "s",
					},
					{ id: "3", event: "merge_group", head_branch: "x", head_sha: "s" },
				],
			}).map((r) => r.id),
			[2],
		);
		assert.deepEqual(parseRunsPage(null), []);
	});

	it("runs for real unless dry run is exactly true", () => {
		assert.equal(shouldDryRun(undefined), false);
		assert.equal(shouldDryRun(""), false);
		assert.equal(shouldDryRun("false"), false);
		assert.equal(shouldDryRun("true"), true);
	});
});
