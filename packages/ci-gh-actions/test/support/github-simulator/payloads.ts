import type {
	JobRecord,
	RepositoryRecord,
	RunnerRecord,
	RunRecord,
} from "./records.js";

export function githubTime(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function optionalTime(ms: number | undefined): string | null {
	return ms === undefined ? null : githubTime(ms);
}

export function repositoryJson(repository: RepositoryRecord) {
	const [, name = repository.fullName] = repository.fullName.split("/");
	return {
		id: repository.id,
		name,
		full_name: repository.fullName,
		private: repository.private,
		visibility: repository.private ? "private" : "public",
		fork: false,
		default_branch: repository.defaultBranch,
		owner: { login: repository.ownerLogin, id: repository.ownerId },
	};
}

export function workflowPath(run: RunRecord): string {
	const at = run.workflowRef.lastIndexOf("@");
	const path = at < 0 ? run.workflowRef : run.workflowRef.slice(0, at);
	const prefix = `${run.repository}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

export type AttemptState = Readonly<{
	status: "queued" | "in_progress" | "completed";
	conclusion: string | null;
	startedAtMs: number;
	updatedAtMs: number;
}>;

export function runJson(
	run: RunRecord,
	attempt: number,
	state: AttemptState,
	repository: RepositoryRecord,
) {
	const actor = { login: `user-${run.actorId}`, id: Number(run.actorId) };
	const path = workflowPath(run);
	return {
		id: run.id,
		name: path.replace(/^.*\//u, "").replace(/\.ya?ml$/u, ""),
		path,
		display_title: `${run.event} on ${run.headBranch}`,
		run_number: run.id,
		run_attempt: attempt,
		event: run.event,
		status: state.status,
		conclusion: state.conclusion,
		head_branch: run.headBranch,
		head_sha: run.headSha,
		created_at: githubTime(state.startedAtMs),
		run_started_at: githubTime(state.startedAtMs),
		updated_at: githubTime(state.updatedAtMs),
		actor,
		triggering_actor: actor,
		repository: repositoryJson(repository),
		head_repository: {
			...repositoryJson(repository),
			id: run.fork ? repository.id + 1_000_000 : repository.id,
			fork: run.fork,
		},
		pull_requests: [],
	};
}

export function jobJson(job: JobRecord, run: RunRecord) {
	return {
		id: job.id,
		run_id: job.runId,
		run_attempt: job.runAttempt,
		name: job.name,
		workflow_name: workflowPath(run),
		head_sha: run.headSha,
		head_branch: run.headBranch,
		status: job.status,
		conclusion: job.conclusion ?? null,
		labels: [...job.labels],
		runner_id: job.runnerId ?? null,
		runner_name: job.runnerName ?? null,
		runner_group_id: job.runnerId === undefined ? null : 1,
		runner_group_name: job.runnerId === undefined ? null : "Default",
		created_at: githubTime(job.createdAtMs),
		started_at: optionalTime(job.startedAtMs),
		completed_at: optionalTime(job.completedAtMs),
		steps: job.steps.map((step, index) => ({
			name: step.name,
			number: index + 1,
			status: "completed",
			conclusion: step.conclusion,
			started_at: optionalTime(job.startedAtMs),
			completed_at: optionalTime(job.completedAtMs),
		})),
	};
}

export function runnerJson(runner: RunnerRecord) {
	return {
		id: runner.id,
		runner_group_id: 1,
		name: runner.name,
		os: "linux",
		status: runner.status,
		busy: runner.busy,
		ephemeral: runner.ephemeral,
		labels: runner.labels.map((label) => ({ ...label })),
	};
}
