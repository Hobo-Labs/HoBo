import { z } from "zod";
import {
	type GithubRunWorkflowJob,
	type GithubTransport,
	getJob,
	getRun,
	listInProgressWorkflowRunIds,
	listRunWorkflowJobs,
} from "../github.js";
import type {
	GithubAssignmentLookup,
	VerifiedGithubAssignment,
} from "./start-fence.js";

export type StrictGithubAssignmentScope = Readonly<{
	installationId: number;
	repository: string;
	repositoryId: number;
	accountId: string;
	engineId: string;
	runnerId: number;
	runnerGroupId: number;
	runnerName: string;
	requiredLabels: readonly string[];
	inProgressRunLimit?: number;
}>;
const positiveSafe = (value: number) =>
	Number.isSafeInteger(value) && value > 0;
const positiveId = z
	.number()
	.refine(positiveSafe, "must be a positive safe integer");
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const nonblank = z
	.string()
	.refine(
		(value) => value.length > 0 && value.trim() === value,
		"must be a nonblank exact string",
	);
const scopeSchema = z.strictObject({
	installationId: positiveId,
	repository: z
		.string()
		.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
		.refine((value) =>
			value.split("/").every((part) => part !== "." && part !== ".."),
		),
	repositoryId: positiveId,
	accountId: id,
	engineId: id,
	runnerId: positiveId,
	runnerGroupId: positiveId,
	runnerName: nonblank,
	requiredLabels: z
		.array(nonblank)
		.min(1)
		.refine((labels) => new Set(labels).size === labels.length),
	inProgressRunLimit: positiveId.optional(),
});
export function createStrictGithubAssignmentLookup(
	api: GithubTransport,
	scope: StrictGithubAssignmentScope,
): GithubAssignmentLookup {
	const trusted = scopeSchema.parse(scope);
	return {
		async lookupAssignment(runnerName) {
			if (runnerName !== trusted.runnerName)
				throw new Error("runner name differs from trusted slot");
			const runs = await listInProgressWorkflowRunIds(
				api,
				trusted.installationId,
				trusted.repository,
				trusted.inProgressRunLimit,
			);
			let candidate: GithubRunWorkflowJob | undefined;
			for (const runId of runs) {
				if (!positiveSafe(runId)) throw new Error("unsafe GitHub run identity");
				const jobs = await listRunWorkflowJobs(
					api,
					trusted.installationId,
					trusted.repository,
					runId,
				);
				for (const job of jobs) {
					if (job.status === "completed") continue;
					const idMatches = job.runner_id === trusted.runnerId;
					const nameMatches = job.runner_name === trusted.runnerName;
					if (idMatches !== nameMatches)
						throw new Error("conflicting GitHub runner identity");
					if (!idMatches) continue;
					if (job.status !== "in_progress")
						throw new Error("GitHub runner status is uncertain");
					if (
						job.runner_group_id !== trusted.runnerGroupId ||
						!job.labels ||
						!trusted.requiredLabels.every((label) =>
							job.labels?.includes(label),
						)
					)
						throw new Error(
							"GitHub runner group or required labels do not match",
						);
					if (
						!positiveSafe(job.id) ||
						!positiveSafe(job.run_id) ||
						!job.run_attempt ||
						!positiveSafe(job.run_attempt) ||
						job.run_attempt > 0xffffffff
					)
						throw new Error("invalid GitHub job identity");
					if (candidate)
						throw new Error("multiple GitHub jobs match the runner");
					candidate = job;
				}
			}
			if (!candidate) return undefined;
			const latest = await getJob(
				api,
				trusted.installationId,
				trusted.repository,
				candidate.id,
			);
			if (
				latest.id !== candidate.id ||
				latest.run_id !== candidate.run_id ||
				latest.run_attempt !== candidate.run_attempt ||
				latest.status !== "in_progress" ||
				latest.runner_id !== trusted.runnerId ||
				latest.runner_name !== trusted.runnerName ||
				latest.runner_group_id !== trusted.runnerGroupId ||
				!trusted.requiredLabels.every((label) => latest.labels.includes(label))
			)
				throw new Error("GitHub job assignment changed during lookup");
			const run = await getRun(
				api,
				trusted.installationId,
				trusted.repository,
				candidate.run_id,
			);
			if (
				run.id !== candidate.run_id ||
				run.repository.id !== trusted.repositoryId ||
				run.run_attempt !== candidate.run_attempt ||
				run.status !== "in_progress"
			)
				throw new Error("GitHub run identity or status changed during lookup");
			return {
				runnerName: trusted.runnerName,
				accountId: trusted.accountId,
				executionKey: {
					githubJob: {
						kind: "github-job",
						accountId: trusted.accountId,
						engineId: trusted.engineId,
						installationId: String(trusted.installationId),
						repositoryId: String(trusted.repositoryId),
						runId: String(run.id),
						jobId: String(candidate.id),
						runAttempt: run.run_attempt,
					},
				},
			};
		},
	};
}

const githubId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repositorySchema = z.object({ id: githubId });
const runSchema = z.object({
	id: githubId,
	run_attempt: z.number().int().positive(),
	status: z.string(),
	repository: repositorySchema,
});
const jobSchema = z.object({
	id: githubId,
	run_id: githubId,
	run_attempt: z.number().int().positive().optional(),
	status: z.string(),
	runner_id: z.number().int().nonnegative().nullable().optional(),
	runner_name: z.string().nullable().optional(),
	runner_group_id: z.number().int().nonnegative().nullable().optional(),
	labels: z.array(z.string()),
});
const jobPageSchema = z.object({
	total_count: z.number().int().nonnegative(),
	jobs: z.array(jobSchema),
});

export type GithubAssignmentScope = {
	accountId: string;
	engineId: string;
	installationId: number;
	repository: string;
	repositoryId: number;
	runId: number;
	runAttempt: number;
	runnerId: number;
	runnerGroupId: number;
	requiredLabels: readonly string[];
};

const PAGE_SIZE = 100;
const MAX_JOBS = 1000;
const LIVE_RUN_STATES = new Set([
	"queued",
	"in_progress",
	"waiting",
	"pending",
]);

export function createGithubAssignmentLookup(
	github: GithubTransport,
	scope: GithubAssignmentScope,
): GithubAssignmentLookup {
	const [owner, repository, ...rest] = scope.repository.split("/");
	const validIds = [
		scope.installationId,
		scope.repositoryId,
		scope.runId,
		scope.runAttempt,
		scope.runnerId,
		scope.runnerGroupId,
	].every((value) => Number.isSafeInteger(value) && value > 0);
	if (
		!owner ||
		!repository ||
		rest.length ||
		!/^[A-Za-z0-9][A-Za-z0-9-]*$/u.test(owner) ||
		!/^[A-Za-z0-9_.-]+$/u.test(repository) ||
		repository === "." ||
		repository === ".." ||
		!scope.accountId ||
		!scope.engineId ||
		!validIds ||
		scope.requiredLabels.length === 0 ||
		scope.requiredLabels.some((label) => !label)
	)
		throw new Error("Invalid GitHub assignment scope");
	const prefix = `/repos/${owner}/${repository}`;

	async function get(path: string): Promise<Response> {
		const response = await github.request(scope.installationId, path);
		if (!response.ok)
			throw new Error(`GitHub assignment lookup failed (${response.status})`);
		return response;
	}

	return {
		async lookupAssignment(
			runnerName,
		): Promise<VerifiedGithubAssignment | undefined> {
			const repositoryResponse = await get(prefix);
			const actualRepository = repositorySchema.parse(
				await repositoryResponse.json(),
			);
			if (actualRepository.id !== scope.repositoryId)
				throw new Error("GitHub repository identity mismatch");

			const attemptPath = `${prefix}/actions/runs/${scope.runId}/attempts/${scope.runAttempt}`;
			const runResponse = await get(attemptPath);
			const run = runSchema.parse(await runResponse.json());
			if (
				run.id !== scope.runId ||
				run.run_attempt !== scope.runAttempt ||
				run.repository.id !== scope.repositoryId ||
				!LIVE_RUN_STATES.has(run.status)
			)
				return undefined;

			let found: z.infer<typeof jobSchema> | undefined;
			let total: number | undefined;
			let seen = 0;
			for (let page = 1; seen < (total ?? 1); page++) {
				const pageResponse = await get(
					`${attemptPath}/jobs?per_page=${PAGE_SIZE}&page=${page}`,
				);
				const result = jobPageSchema.parse(await pageResponse.json());
				total ??= result.total_count;
				if (
					result.total_count !== total ||
					total > MAX_JOBS ||
					result.jobs.length !== Math.min(PAGE_SIZE, total - seen)
				) {
					throw new Error("Incomplete GitHub assignment listing");
				}
				seen += result.jobs.length;
				for (const job of result.jobs) {
					if (
						job.status !== "in_progress" ||
						job.runner_name !== runnerName ||
						job.runner_id !== scope.runnerId ||
						job.runner_group_id !== scope.runnerGroupId ||
						job.run_id !== scope.runId ||
						(job.run_attempt !== undefined &&
							job.run_attempt !== scope.runAttempt) ||
						!scope.requiredLabels.every((label) => job.labels.includes(label))
					)
						continue;
					if (found) throw new Error("Ambiguous GitHub runner assignment");
					found = job;
				}
			}
			if (!found) return undefined;
			return {
				runnerName,
				accountId: scope.accountId,
				executionKey: {
					githubJob: {
						kind: "github-job",
						accountId: scope.accountId,
						engineId: scope.engineId,
						installationId: String(scope.installationId),
						repositoryId: String(scope.repositoryId),
						runId: String(found.run_id),
						jobId: String(found.id),
						runAttempt: scope.runAttempt,
					},
				},
			};
		},
	};
}
