import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_MAX_WAIT_SECONDS,
	fleetLabelFor,
	labelWait,
	MAX_RUN_LOOKUPS,
	main,
	observeQueue,
	parseRouteMode,
	type QueuedJob,
	queuedJobs,
	routeRunner,
	STALE_WAIT_SECONDS,
	unfinishedRunIds,
} from "../ci/route-runner.mts";

const NOW = Date.parse("2026-11-10T18:00:00Z");
const waiting = (label: string, seconds: number, runId = 1): QueuedJob => ({
	runId,
	labels: [label],
	createdAtMs: NOW - seconds * 1000,
});
const nothing = { queued: 0, oldestWaitSeconds: 0 };
const decide = (overrides: Partial<Parameters<typeof routeRunner>[0]> = {}) =>
	routeRunner({
		mode: "auto",
		fleetLabel: "hobo",
		localEnrolled: false,
		maxWaitSeconds: DEFAULT_MAX_WAIT_SECONDS,
		fleet: nothing,
		local: nothing,
		...overrides,
	});

describe("how long a label has been waiting", () => {
	it("is the oldest job asking for exactly that label", () => {
		const jobs = [
			waiting("hobo", 40),
			waiting("hobo", 900),
			waiting("hobo-trunk", 5000),
			{ runId: 2, labels: ["hobo", "gpu"], createdAtMs: NOW - 9_000_000 },
		];
		assert.deepEqual(labelWait(jobs, "hobo", NOW), {
			queued: 2,
			oldestWaitSeconds: 900,
		});
		assert.deepEqual(labelWait(jobs, "hobo-local-host", NOW), nothing);
	});

	it("matches the label whatever its case", () => {
		assert.equal(labelWait([waiting("HoBo", 30)], "hobo", NOW).queued, 1);
	});

	it("ignores a job queued so long it was abandoned", () => {
		const jobs = [waiting("hobo", STALE_WAIT_SECONDS + 1), waiting("hobo", 10)];
		assert.deepEqual(labelWait(jobs, "hobo", NOW), {
			queued: 1,
			oldestWaitSeconds: 10,
		});
	});
});

describe("the routing decision", () => {
	it("stays on the fleet while nothing has waited past the limit", () => {
		assert.deepEqual([decide().tier, decide().runner], ["fleet", "hobo"]);
		const busy = decide({
			fleet: { queued: 9, oldestWaitSeconds: DEFAULT_MAX_WAIT_SECONDS - 1 },
		});
		assert.equal(busy.runner, "hobo");
	});

	it("goes to GitHub-hosted when the fleet is not taking jobs and no local box is enrolled", () => {
		const routed = decide({
			fleet: { queued: 38, oldestWaitSeconds: 3600 },
		});
		assert.equal(routed.tier, "github");
		assert.equal(routed.runner, "ubuntu-24.04");
		assert.match(routed.reason, /38 waiting, the oldest for 3600 s/);
		assert.match(routed.reason, /no local box is enrolled/);
	});

	it("prefers an enrolled local box over GitHub-hosted", () => {
		const routed = decide({
			localEnrolled: true,
			fleet: { queued: 4, oldestWaitSeconds: 900 },
		});
		assert.equal(routed.tier, "local");
		assert.equal(routed.runner, "hobo-local-host");
	});

	it("passes over a local box that is enrolled but not taking jobs", () => {
		const routed = decide({
			localEnrolled: true,
			fleet: { queued: 4, oldestWaitSeconds: 900 },
			local: { queued: 1, oldestWaitSeconds: 600 },
		});
		assert.equal(routed.tier, "github");
		assert.match(routed.reason, /the local box has 1 waiting/);
	});

	it("never asks an unenrolled local box, however idle its label looks", () => {
		const routed = decide({ fleet: { queued: 1, oldestWaitSeconds: 301 } });
		assert.equal(routed.tier, "github");
	});

	it("asks the fleet for the trunk label on trunk events", () => {
		assert.equal(decide({ fleetLabel: "hobo-trunk" }).runner, "hobo-trunk");
	});

	it("honours a pinned tier without looking at the queue", () => {
		const down = { queued: 50, oldestWaitSeconds: 9000 };
		assert.equal(decide({ mode: "fleet", fleet: down }).runner, "hobo");
		assert.equal(decide({ mode: "github" }).runner, "ubuntu-24.04");
		assert.equal(decide({ mode: "local" }).runner, "hobo-local-host");
	});

	it("reads anything but a known mode as auto", () => {
		assert.equal(parseRouteMode(undefined), "auto");
		assert.equal(parseRouteMode(""), "auto");
		assert.equal(parseRouteMode("hosted"), "auto");
		assert.equal(parseRouteMode(" github "), "github");
	});
});

describe("the fleet label a run asks for", () => {
	it("is the trunk label for trunk events unless that is switched off", () => {
		assert.equal(fleetLabelFor("pull_request", undefined), "hobo");
		assert.equal(fleetLabelFor("merge_group", undefined), "hobo-trunk");
		assert.equal(fleetLabelFor("push", ""), "hobo-trunk");
		assert.equal(fleetLabelFor("push", "false"), "hobo");
	});
});

describe("reading GitHub's queue", () => {
	const runsPage = {
		workflow_runs: [
			{ id: 30, status: "queued" },
			{ id: 10, status: "in_progress" },
			{ id: 20, status: "completed" },
			{ id: 40, status: "pending" },
			{ id: 7, status: "queued" },
		],
	};
	const jobsPage = (runId: number, seconds: number, label = "hobo") => ({
		jobs: [
			{
				run_id: runId,
				status: "queued",
				labels: [label],
				created_at: new Date(NOW - seconds * 1000).toISOString(),
			},
			{
				run_id: runId,
				status: "in_progress",
				labels: [label],
				created_at: new Date(NOW - 99_000).toISOString(),
			},
		],
	});

	it("takes unfinished runs oldest first and leaves out this run", () => {
		assert.deepEqual(unfinishedRunIds(runsPage, 7), [10, 30, 40]);
		assert.deepEqual(unfinishedRunIds({ message: "Not Found" }, 7), []);
	});

	it("keeps only queued jobs with a readable creation time", () => {
		assert.deepEqual(queuedJobs(jobsPage(10, 60)), [waiting("hobo", 60, 10)]);
		assert.deepEqual(
			queuedJobs({
				jobs: [{ run_id: 1, status: "queued", labels: ["hobo"] }, "junk"],
			}),
			[],
		);
	});

	it("stops reading once the label is seen waiting past the limit", async () => {
		const paths: string[] = [];
		const jobs = await observeQueue({
			read: async (path) => {
				paths.push(path);
				if (path.includes("/jobs")) return jobsPage(10, 4000);
				return runsPage;
			},
			repository: "acme/app",
			ownRunId: 7,
			labels: ["hobo"],
			maxWaitSeconds: 300,
			nowMs: NOW,
		});
		assert.equal(paths.length, 2);
		assert.equal(paths[0], "/repos/acme/app/actions/runs?per_page=100");
		assert.match(paths[1] ?? "", /\/actions\/runs\/10\/jobs/);
		assert.equal(labelWait(jobs, "hobo", NOW).oldestWaitSeconds, 4000);
	});

	it("reads a bounded number of runs when nothing is waiting long", async () => {
		const many = {
			workflow_runs: Array.from({ length: 40 }, (_, index) => ({
				id: index + 100,
				status: "queued",
			})),
		};
		let jobLists = 0;
		await observeQueue({
			read: async (path) => {
				if (!path.includes("/jobs")) return many;
				jobLists += 1;
				return jobsPage(100, 20);
			},
			repository: "acme/app",
			ownRunId: 1,
			labels: ["hobo"],
			maxWaitSeconds: 300,
			nowMs: NOW,
		});
		assert.equal(jobLists, MAX_RUN_LOOKUPS);
	});
});

describe("the script as a whole", () => {
	it("stays on the fleet, and says why, when the queue cannot be read", async () => {
		const decision = await main({
			GITHUB_EVENT_NAME: "merge_group",
			GITHUB_REPOSITORY: "acme/app",
			GITHUB_RUN_ID: "1",
			GITHUB_API_URL: "http://127.0.0.1:9",
		});
		assert.equal(decision.runner, "hobo-trunk");
		assert.equal(decision.tier, "fleet");
		assert.match(decision.reason, /could not be read/);
	});

	it("does not read the queue for a pinned tier", async () => {
		const decision = await main({
			GITHUB_EVENT_NAME: "pull_request",
			HOBO_CI_ROUTE: "github",
			GITHUB_API_URL: "http://127.0.0.1:9",
		});
		assert.equal(decision.runner, "ubuntu-24.04");
	});
});
