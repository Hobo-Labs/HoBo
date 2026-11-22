import { z } from "zod";
import {
	type GithubRunWorkflowJob,
	type GithubTransport,
	getJob,
	getRun,
	listInProgressWorkflowRunIds,
	listRunWorkflowJobs,
} from "../github.js";
import type { GithubAssignmentLookup } from "./start-fence.js";

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
