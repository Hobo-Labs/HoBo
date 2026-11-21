import fc from "fast-check";
import { expect, it } from "vitest";
import { createStrictGithubAssignmentLookup } from "../src/fleet-v2/github-assignment.js";
import { authorizeStartFence } from "../src/fleet-v2/start-fence.js";

const scope = {
	installationId: 10,
	repository: "org/repo",
	repositoryId: 101,
	accountId: "account",
	engineId: "gh-actions",
	runnerId: 42,
	runnerGroupId: 7,
	runnerName: "hobo-slot-1",
	requiredLabels: ["self-hosted", "hobo"],
	inProgressRunLimit: 3,
};
const job = {
	id: 1,
	run_id: 9,
	run_attempt: 1,
	status: "in_progress",
	runner_id: 42,
	runner_group_id: 7,
	runner_name: "hobo-slot-1",
	labels: ["self-hosted", "hobo"],
};
const run = {
	id: 9,
	run_attempt: 1,
	event: "push",
	head_sha: "abc",
	head_branch: "main",
	path: ".github/workflows/ci.yml",
	display_title: "CI",
	status: "in_progress",
	conclusion: null,
	run_started_at: null,
	updated_at: "2026-01-01T00:00:00Z",
	actor: { id: 1 },
	repository: { id: 101, private: true },
	head_repository: { id: 101 },
};
function apiFor(
	options: {
		jobs?: Array<typeof job>;
		latest?: typeof job;
		run?: typeof run;
		fail?: boolean;
	} = {},
) {
	return {
		async request(installationId: number, path: string) {
			expect(installationId).toBe(10);
			if (options.fail) return new Response("", { status: 503 });
			if (path.includes("/actions/runs?"))
				return Response.json({ workflow_runs: [{ id: 9 }] });
			if (path.includes("/actions/runs/9/jobs?"))
				return Response.json({ jobs: options.jobs ?? [job] });
			if (path.endsWith("/actions/runs/9"))
				return Response.json(options.run ?? run);
			if (path.endsWith("/actions/jobs/1"))
				return Response.json(options.latest ?? job);
			if (path.endsWith("/actions/jobs/2"))
				return Response.json({ ...job, id: 2 });
			throw new Error(`unexpected request ${path}`);
		},
	};
}
it("derives a current assignment from centrally authenticated GitHub responses", async () => {
	const actual = await createStrictGithubAssignmentLookup(
		apiFor(),
		scope,
	).lookupAssignment(scope.runnerName);
	expect(actual).toEqual({
		runnerName: scope.runnerName,
		accountId: scope.accountId,
		executionKey: {
			githubJob: {
				kind: "github-job",
				accountId: "account",
				engineId: "gh-actions",
				installationId: "10",
				repositoryId: "101",
				runId: "9",
				jobId: "1",
				runAttempt: 1,
			},
		},
	});
});
it("rejects a hook claim that disagrees with the GitHub-derived job", async () => {
	const body = {
		slotId: "slot-1",
		claimId: "claim-1",
		bindingSecret: "x".repeat(64),
		accountId: "account",
		runnerName: scope.runnerName,
		profileId: "profile",
		executionKey: {
			githubJob: {
				kind: "github-job",
				accountId: "account",
				engineId: "gh-actions",
				installationId: "10",
				repositoryId: "101",
				runId: "9",
				jobId: "2",
				runAttempt: 1,
			},
		},
	};
	const result = await authorizeStartFence(
		body,
		createStrictGithubAssignmentLookup(apiFor(), scope),
	);
	expect(result).toMatchObject({
		ok: false,
		reason: "assignment job identity mismatch",
	});
	const matching = {
		...body,
		executionKey: { githubJob: { ...body.executionKey.githubJob, jobId: "1" } },
	};
	await expect(
		authorizeStartFence(
			matching,
			createStrictGithubAssignmentLookup(apiFor(), scope),
		),
	).resolves.toMatchObject({ ok: true });
});
it("does not query for a runner name outside its trusted scope", async () => {
	const api = apiFor({ fail: true });
	await expect(
		createStrictGithubAssignmentLookup(api, scope).lookupAssignment("other"),
	).rejects.toThrow(/runner/i);
});
it.each([
	{ jobs: [{ ...job, runner_id: 43 }] },
	{ jobs: [{ ...job, runner_name: "other" }] },
	{ jobs: [{ ...job, status: "future_status" }] },
	{ jobs: [{ ...job, runner_group_id: 8 }] },
	{ jobs: [{ ...job, labels: ["self-hosted"] }] },
	{ latest: { ...job, runner_group_id: 8 } },
	{ latest: { ...job, labels: ["self-hosted"] } },
	{ jobs: [job, { ...job, id: 2 }] },
	{ latest: { ...job, status: "completed" } },
	{ latest: { ...job, runner_id: 43 } },
	{ latest: { ...job, run_attempt: 2 } },
	{ run: { ...run, repository: { ...run.repository, id: 102 } } },
	{ run: { ...run, run_attempt: 2 } },
	{ run: { ...run, status: "completed" } },
	{ fail: true },
])("fails closed for conflicting, ambiguous, changed, or unavailable evidence", async (options) => {
	await expect(
		createStrictGithubAssignmentLookup(apiFor(options), scope).lookupAssignment(
			scope.runnerName,
		),
	).rejects.toThrow();
});
it("returns no assignment when the only matching job is complete", async () => {
	await expect(
		createStrictGithubAssignmentLookup(
			apiFor({ jobs: [{ ...job, status: "completed" }] }),
			scope,
		).lookupAssignment(scope.runnerName),
	).resolves.toBeUndefined();
});
it("rejects a truncated run listing before treating the scan as complete", async () => {
	const api = {
		async request(_installationId: number, path: string) {
			if (path.includes("/actions/runs?"))
				return Response.json({
					workflow_runs: path.includes("page=1")
						? [{ id: 9 }, { id: 10 }, { id: 11 }]
						: [{ id: 12 }],
				});
			if (path.includes("/actions/runs/9/jobs?"))
				return Response.json({ jobs: [job] });
			if (path.includes("/jobs?")) return Response.json({ jobs: [] });
			if (path.endsWith("/actions/jobs/1")) return Response.json(job);
			if (path.endsWith("/actions/runs/9")) return Response.json(run);
			throw new Error(`unexpected request ${path}`);
		},
	};
	await expect(
		createStrictGithubAssignmentLookup(api, scope).lookupAssignment(
			scope.runnerName,
		),
	).rejects.toThrow(/incomplete/i);
});
it("pins trusted scope even if the caller later mutates its configuration", async () => {
	const mutable = { ...scope, requiredLabels: [...scope.requiredLabels] };
	const lookup = createStrictGithubAssignmentLookup(apiFor(), mutable);
	mutable.runnerId = 43;
	mutable.requiredLabels.splice(0);
	await expect(
		lookup.lookupAssignment(scope.runnerName),
	).resolves.toBeDefined();
});
it("rejects unsafe runner identifiers in the trusted scope", () => {
	expect(() =>
		createStrictGithubAssignmentLookup(apiFor(), {
			...scope,
			runnerId: Number.MAX_SAFE_INTEGER + 1,
		}),
	).toThrow(/runner/i);
});
it("binds generated GitHub job and run identities to the verified response", async () => {
	await fc.assert(
		fc.asyncProperty(fc.integer({ min: 1, max: 1000000 }), async (id) => {
			const generated = { ...job, id };
			const api = {
				async request(installationId: number, path: string) {
					expect(installationId).toBe(10);
					if (path.includes("/actions/runs?"))
						return Response.json({ workflow_runs: [{ id: 9 }] });
					if (path.includes("/actions/runs/9/jobs?"))
						return Response.json({ jobs: [generated] });
					if (path.endsWith("/actions/runs/9")) return Response.json(run);
					if (path.endsWith(`/actions/jobs/${id}`))
						return Response.json(generated);
					throw new Error(`unexpected request ${path}`);
				},
			};
			const actual = await createStrictGithubAssignmentLookup(
				api,
				scope,
			).lookupAssignment(scope.runnerName);
			expect(actual?.executionKey.githubJob.jobId).toBe(String(id));
		}),
		{ seed: 614477, numRuns: 50 },
	);
});
