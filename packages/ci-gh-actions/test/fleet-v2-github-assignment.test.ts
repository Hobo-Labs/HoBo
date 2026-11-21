import { once } from "node:events";
import { createServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createGithubAssignmentLookup,
	type GithubAssignmentScope,
} from "../src/fleet-v2/github-assignment.js";
import { authorizeStartFence } from "../src/fleet-v2/start-fence.js";
import { type GithubTransport, githubApiUrl } from "../src/github.js";

const scope: GithubAssignmentScope = {
	accountId: "account-1",
	engineId: "github",
	installationId: 10,
	repository: "owner/repository",
	repositoryId: 101,
	runId: 900,
	runAttempt: 2,
	runnerId: 44,
	runnerGroupId: 7,
	requiredLabels: ["self-hosted", "isolated-linux"],
};
const assignedJob = {
	id: 23,
	run_id: 900,
	run_attempt: 2,
	status: "in_progress",
	runner_id: 44,
	runner_name: "hobo-slot-1",
	runner_group_id: 7,
	labels: ["self-hosted", "linux", "isolated-linux"],
};
type Job = Omit<typeof assignedJob, "run_attempt"> & { run_attempt?: number };
type Run = {
	id: number;
	run_attempt: number;
	status: string;
	repository: { id: number };
};
let repositoryId: number;
let run: Run;
let jobs: Job[];
let declaredTotal: number | undefined;
let failureStatus: number | undefined;
let requests: string[];
let origin: string;
let server: ReturnType<typeof createServer>;

const github: GithubTransport = {
	async request(installationId, path) {
		if (installationId !== scope.installationId)
			throw new Error("wrong installation");
		const url = new URL(githubApiUrl(path));
		return fetch(`${origin}${url.pathname}${url.search}`);
	},
};

beforeAll(async () => {
	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", origin);
		requests.push(`${url.pathname}${url.search}`);
		response.setHeader("content-type", "application/json");
		if (failureStatus) {
			response.writeHead(failureStatus).end("{}");
			return;
		}
		if (url.pathname === "/repos/owner/repository") {
			response.end(JSON.stringify({ id: repositoryId }));
			return;
		}
		if (
			url.pathname === "/repos/owner/repository/actions/runs/900/attempts/2"
		) {
			response.end(JSON.stringify(run));
			return;
		}
		if (
			url.pathname ===
			"/repos/owner/repository/actions/runs/900/attempts/2/jobs"
		) {
			const page = Number(url.searchParams.get("page"));
			const start = (page - 1) * 100;
			response.end(
				JSON.stringify({
					total_count: declaredTotal ?? jobs.length,
					jobs: jobs.slice(start, start + 100),
				}),
			);
			return;
		}
		response.writeHead(404).end("{}");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!(address instanceof Object) || !("port" in address))
		throw new Error("server did not bind");
	origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
	await new Promise<void>((resolveClose, rejectClose) =>
		server.close((error) => (error ? rejectClose(error) : resolveClose())),
	);
});

beforeEach(() => {
	repositoryId = 101;
	run = {
		id: 900,
		run_attempt: 2,
		status: "in_progress",
		repository: { id: 101 },
	};
	jobs = [{ ...assignedJob }];
	declaredTotal = undefined;
	failureStatus = undefined;
	requests = [];
});

function lookup() {
	return createGithubAssignmentLookup(github, scope);
}

describe("GitHub strict assignment verification", () => {
	it("uses the GitHub assignment to authorize the exact job", async () => {
		const verified = await lookup().lookupAssignment("hobo-slot-1");
		expect(verified).toEqual({
			runnerName: "hobo-slot-1",
			accountId: "account-1",
			executionKey: {
				githubJob: {
					kind: "github-job",
					accountId: "account-1",
					engineId: "github",
					installationId: "10",
					repositoryId: "101",
					runId: "900",
					jobId: "23",
					runAttempt: 2,
				},
			},
		});
		const request = {
			slotId: "slot-1",
			claimId: "claim-1",
			bindingSecret: "a".repeat(32),
			accountId: "account-1",
			runnerName: "hobo-slot-1",
			profileId: "isolated-linux",
			executionKey: verified?.executionKey,
		};
		expect((await authorizeStartFence(request, lookup())).ok).toBe(true);
		expect(
			(
				await authorizeStartFence(
					{
						...request,
						executionKey: {
							githubJob: { ...verified?.executionKey.githubJob, jobId: "99" },
						},
					},
					lookup(),
				)
			).ok,
		).toBe(false);
	});

	it("uses the attempt endpoint when job attempt metadata is omitted", async () => {
		const { run_attempt: _, ...withoutAttempt } = assignedJob;
		jobs = [withoutAttempt];
		const verified = await lookup().lookupAssignment("hobo-slot-1");
		expect(verified?.executionKey.githubJob.runAttempt).toBe(2);
	});

	it("accepts a queued run with an in-progress job", async () => {
		run.status = "queued";
		expect(await lookup().lookupAssignment("hobo-slot-1")).toBeDefined();
	});

	it.each([
		["runner ID", { runner_id: 45 }],
		["runner group", { runner_group_id: 8 }],
		["runner name", { runner_name: "hobo-other" }],
		["job status", { status: "completed" }],
		["run ID", { run_id: 901 }],
		["run attempt", { run_attempt: 1 }],
		["required labels", { labels: ["self-hosted"] }],
	])("rejects a mismatched %s", async (_name, change) => {
		jobs = [{ ...assignedJob, ...change }];
		expect(await lookup().lookupAssignment("hobo-slot-1")).toBeUndefined();
	});

	it("rejects an incorrect repository and non-live run", async () => {
		repositoryId = 102;
		await expect(lookup().lookupAssignment("hobo-slot-1")).rejects.toThrow(
			"repository identity",
		);
		repositoryId = 101;
		run.status = "completed";
		expect(await lookup().lookupAssignment("hobo-slot-1")).toBeUndefined();
		expect(requests).not.toContain(
			"/repos/owner/repository/actions/runs/900/attempts/2/jobs?per_page=100&page=1",
		);
	});

	it("checks every page before confirming a unique assignment", async () => {
		jobs = Array.from({ length: 100 }, (_, index) => ({
			...assignedJob,
			id: index + 100,
			status: "completed",
			runner_id: 0,
		}));
		jobs.push({ ...assignedJob });
		expect(
			(await lookup().lookupAssignment("hobo-slot-1"))?.executionKey.githubJob
				.jobId,
		).toBe("23");
		expect(requests).toContain(
			"/repos/owner/repository/actions/runs/900/attempts/2/jobs?per_page=100&page=2",
		);
	});

	it("rejects incomplete listings, ambiguous assignments, and API failures", async () => {
		declaredTotal = 2;
		await expect(lookup().lookupAssignment("hobo-slot-1")).rejects.toThrow(
			"Incomplete",
		);
		declaredTotal = undefined;
		jobs.push({ ...assignedJob, id: 24 });
		await expect(lookup().lookupAssignment("hobo-slot-1")).rejects.toThrow(
			"Ambiguous",
		);
		failureStatus = 503;
		await expect(lookup().lookupAssignment("hobo-slot-1")).rejects.toThrow(
			"lookup failed",
		);
	});

	it("rejects scopes that do not identify a restricted runner group", () => {
		expect(() =>
			createGithubAssignmentLookup(github, { ...scope, runnerGroupId: 0 }),
		).toThrow();
		expect(() =>
			createGithubAssignmentLookup(github, { ...scope, requiredLabels: [] }),
		).toThrow();
		expect(() =>
			createGithubAssignmentLookup(github, {
				...scope,
				repository: "owner/../other",
			}),
		).toThrow();
	});
});
