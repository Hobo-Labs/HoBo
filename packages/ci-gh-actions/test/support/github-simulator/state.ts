import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type RelayJobAnswer,
	type RelayJobMessage,
	RelayJobMessageSchema,
} from "@hobo/ci";
import type { QueueJobInput } from "../github-simulator-port.js";
import {
	type AttemptState,
	jobJson,
	repositoryJson,
	runJson,
} from "./payloads.js";
import type {
	AttemptRecord,
	BillingUsageItem,
	DeliveryRecord,
	JobConclusion,
	JobRecord,
	RepositoryRecord,
	RunnerLabelRecord,
	RunnerRecord,
	RunRecord,
	SimulatedAnnotation,
	SimulatedStepResult,
} from "./records.js";

export const JOB_QUEUE_LIMIT_MS = 24 * 60 * 60_000;
export const SIMULATOR_EPOCH_MS = Date.UTC(2026, 10, 16, 12);
export const SIMULATED_ACTOR_ID = "42";

export type JobCompletion = Readonly<{
	conclusion: "success" | "failure" | "cancelled";
	outputs?: ReadonlyMap<string, string>;
	annotations?: readonly SimulatedAnnotation[];
	log?: string;
	steps?: readonly SimulatedStepResult[];
}>;

export type RegisterRunnerInput = Readonly<{
	name: string;
	labels: readonly string[];
	repository?: string | undefined;
	org?: string | undefined;
	ephemeral?: boolean;
	online?: boolean;
}>;

const NEEDS_OUTPUT =
	/\$\{\{\s*needs\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*\}\}/gu;

function sha1(text: string): string {
	return createHash("sha1").update(text).digest("hex");
}

function guid(kind: number, value: number): string {
	return `0000000${kind}-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function sameLabel(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

export function runnerHoldsLabels(
	runnerLabels: readonly string[],
	jobLabels: readonly string[],
): boolean {
	return jobLabels.every((wanted) =>
		runnerLabels.some((held) => sameLabel(held, wanted)),
	);
}

export class SimulatorState {
	readonly installationId: number;
	private clock: number;
	private nextRepositoryId = 101;
	private nextRunId = 5001;
	private nextJobId = 70001;
	private nextRunnerId = 1;
	private nextLabelId = 1;
	private nextDeliveryId = 1;
	private dropsPending = 0;

	readonly repositories = new Map<string, RepositoryRecord>();
	readonly runs = new Map<number, RunRecord>();
	readonly jobs = new Map<number, JobRecord>();
	readonly runners = new Map<number, RunnerRecord>();
	readonly deliveries: DeliveryRecord[] = [];
	private readonly pending: DeliveryRecord[] = [];
	readonly trees = new Map<string, string>();
	readonly commits = new Map<
		string,
		{ message: string; tree: string; parents: readonly string[] }
	>();
	readonly refs = new Map<string, Map<string, string>>();
	readonly billing = new Map<string, BillingUsageItem[]>();

	constructor(installationId: number, startMs: number) {
		this.installationId = installationId;
		this.clock = startMs;
	}

	now(): number {
		return this.clock;
	}

	advance(ms: number): void {
		if (!Number.isFinite(ms) || ms < 0)
			throw new RangeError("the simulator's clock only moves forward");
		this.clock += ms;
		for (const job of this.jobs.values())
			if (
				job.status === "queued" &&
				!job.blocked &&
				this.clock - job.queuedAtMs >= JOB_QUEUE_LIMIT_MS
			)
				this.finish(job, { conclusion: "cancelled" });
	}

	ensureRepository(fullName: string, isPrivate?: boolean): RepositoryRecord {
		const known = this.repositories.get(fullName);
		if (known) return known;
		const [owner = fullName] = fullName.split("/");
		const repository: RepositoryRecord = {
			id: this.nextRepositoryId++,
			fullName,
			ownerLogin: owner,
			ownerId: 9000 + this.repositories.size,
			private: isPrivate ?? true,
			defaultBranch: "main",
			files: new Map(),
		};
		this.repositories.set(fullName, repository);
		this.refsOf(fullName).set(
			`refs/heads/${repository.defaultBranch}`,
			this.createCommit(
				`initial commit of ${fullName}`,
				this.createTree(""),
				[],
			),
		);
		return repository;
	}

	refsOf(repository: string): Map<string, string> {
		let refs = this.refs.get(repository);
		if (!refs) {
			refs = new Map();
			this.refs.set(repository, refs);
		}
		return refs;
	}

	createTree(content: string): string {
		const sha = sha1(`tree\0${content}`);
		this.trees.set(sha, content);
		return sha;
	}

	createCommit(
		message: string,
		tree: string,
		parents: readonly string[],
	): string {
		const sha = sha1(
			`commit\0${tree}\0${parents.join(",")}\0${message}\0${this.commits.size}`,
		);
		this.commits.set(sha, { message, tree, parents: [...parents] });
		return sha;
	}

	putFile(
		repository: string,
		path: string,
		text: string,
		branch?: string,
	): void {
		const record = this.ensureRepository(repository);
		const name = branch ?? record.defaultBranch;
		let files = record.files.get(name);
		if (!files) {
			files = new Map();
			record.files.set(name, files);
		}
		files.set(path, text);
	}

	readFile(
		repository: string,
		path: string,
		ref: string | undefined,
	): string | undefined {
		const record = this.repositories.get(repository);
		if (!record) return undefined;
		let branch = ref ?? record.defaultBranch;
		for (const [name, sha] of this.refsOf(repository))
			if (sha === ref && name.startsWith("refs/heads/"))
				branch = name.slice("refs/heads/".length);
		return record.files.get(branch.replace(/^refs\/heads\//u, ""))?.get(path);
	}

	addBilling(account: string, item: BillingUsageItem): void {
		const items = this.billing.get(account) ?? [];
		items.push(item);
		this.billing.set(account, items);
	}

	queueJob(input: QueueJobInput, serviceJobId?: string): JobRecord {
		const repository = this.ensureRepository(input.repository, input.private);
		const run = this.runFor(input, repository);
		const attempt = this.attemptOf(run, input.runAttempt ?? run.latestAttempt);
		const id = this.nextJobId++;
		const job: JobRecord = {
			id,
			runId: run.id,
			runAttempt: attempt.attempt,
			repository: run.repository,
			name: input.name,
			labelTemplates: [...input.labels],
			labels: [...input.labels],
			blocked: (input.needs ?? []).length > 0,
			status: "queued",
			conclusion: undefined,
			runnerId: undefined,
			runnerName: undefined,
			session: undefined,
			createdAtMs: this.clock,
			queuedAtMs: this.clock,
			startedAtMs: undefined,
			completedAtMs: undefined,
			outputs: new Map(),
			annotations: [],
			steps: [],
			log: "",
			needs: [...(input.needs ?? [])],
			inputs: new Map(input.inputs ?? []),
			workflowSteps: [...(input.steps ?? [])],
			serviceJobId: serviceJobId ?? guid(1, id),
		};
		this.jobs.set(id, job);
		attempt.jobIds.push(id);
		attempt.completedAtMs = undefined;
		if (job.blocked) this.release(job);
		else this.emitJob(job, "queued");
		return job;
	}

	private runFor(
		input: QueueJobInput,
		repository: RepositoryRecord,
	): RunRecord {
		const known =
			input.runId === undefined ? undefined : this.runs.get(input.runId);
		if (known) {
			if (known.repository !== repository.fullName)
				throw new Error(`run ${known.id} belongs to ${known.repository}`);
			return known;
		}
		const id = input.runId ?? this.nextRunId++;
		if (id >= this.nextRunId) this.nextRunId = id + 1;
		const workflowRef =
			input.workflowRef ??
			`${repository.fullName}/.github/workflows/ci.yml@refs/heads/${repository.defaultBranch}`;
		const ref = workflowRef.slice(workflowRef.lastIndexOf("@") + 1);
		const run: RunRecord = {
			id,
			repository: repository.fullName,
			event: input.event ?? "push",
			actorId: input.actorId ?? SIMULATED_ACTOR_ID,
			workflowRef,
			fork: input.fork ?? false,
			headSha: sha1(`${repository.fullName}:${id}`),
			headBranch: ref.startsWith("refs/heads/")
				? ref.slice("refs/heads/".length)
				: repository.defaultBranch,
			attempts: new Map(),
			latestAttempt: 1,
		};
		this.runs.set(id, run);
		return run;
	}

	private attemptOf(run: RunRecord, attempt: number): AttemptRecord {
		const known = run.attempts.get(attempt);
		if (known) return known;
		const created: AttemptRecord = {
			attempt,
			createdAtMs: this.clock,
			jobIds: [],
			completedAtMs: undefined,
		};
		run.attempts.set(attempt, created);
		if (attempt > run.latestAttempt) run.latestAttempt = attempt;
		return created;
	}

	run(runId: number): RunRecord | undefined {
		return this.runs.get(runId);
	}

	attemptJobs(run: RunRecord, attempt: number): JobRecord[] {
		return (run.attempts.get(attempt)?.jobIds ?? []).flatMap((id) => {
			const job = this.jobs.get(id);
			return job && !job.blocked ? [job] : [];
		});
	}

	private neededJob(job: JobRecord, name: string): JobRecord | undefined {
		const run = this.runs.get(job.runId);
		const ids = run?.attempts.get(job.runAttempt)?.jobIds ?? [];
		const matches = ids.flatMap((id) => {
			const found = this.jobs.get(id);
			return found && found.name === name ? [found] : [];
		});
		return (
			matches.find((found) => found.runAttempt === job.runAttempt) ?? matches[0]
		);
	}

	private release(job: JobRecord): void {
		const needed = job.needs.map((name) => this.neededJob(job, name));
		if (needed.some((found) => found?.status !== "completed")) return;
		job.blocked = false;
		if (needed.some((found) => found?.conclusion !== "success")) {
			this.finish(job, { conclusion: "skipped" });
			return;
		}
		job.labels = job.labelTemplates.map((template) =>
			template.replace(
				NEEDS_OUTPUT,
				(_, name: string, output: string) =>
					this.neededJob(job, name)?.outputs.get(output) ?? "",
			),
		);
		job.queuedAtMs = this.clock;
		if (job.labels.some((label) => label.trim() === "")) {
			this.finish(job, {
				conclusion: "failure",
				annotations: [
					{ level: "failure", message: "runs-on resolved to an empty label" },
				],
			});
			return;
		}
		this.emitJob(job, "queued");
	}

	runnerServes(runner: RunnerRecord, job: JobRecord): boolean {
		const scoped = runner.repository
			? runner.repository === job.repository
			: runner.org
				? job.repository.startsWith(`${runner.org}/`)
				: true;
		return (
			scoped &&
			runnerHoldsLabels(
				runner.labels.map((label) => label.name),
				job.labels,
			)
		);
	}

	runnerByName(name: string): RunnerRecord | undefined {
		for (const runner of this.runners.values())
			if (runner.name === name) return runner;
		return undefined;
	}

	claim(runnerName: string, session?: string): JobRecord | undefined {
		const runner = this.runnerByName(runnerName);
		if (runner?.status !== "online" || runner.busy) return undefined;
		let chosen: JobRecord | undefined;
		for (const job of this.jobs.values())
			if (
				job.status === "queued" &&
				!job.blocked &&
				this.runnerServes(runner, job) &&
				(!chosen || job.queuedAtMs < chosen.queuedAtMs)
			)
				chosen = job;
		if (!chosen) return undefined;
		runner.busy = true;
		runner.jobId = chosen.id;
		chosen.status = "in_progress";
		chosen.runnerId = runner.id;
		chosen.runnerName = runner.name;
		chosen.session = session;
		chosen.startedAtMs = this.clock;
		this.emitJob(chosen, "in_progress");
		return chosen;
	}

	complete(jobId: number, completion: JobCompletion): JobRecord {
		const job = this.jobs.get(jobId);
		if (!job) throw new Error(`no job ${jobId}`);
		if (job.status !== "in_progress")
			throw new Error(
				`job ${jobId} is ${job.conclusion ?? job.status}, not in progress`,
			);
		this.finish(job, completion);
		return job;
	}

	completeFromService(session: string, answer: RelayJobAnswer): JobRecord {
		let job: JobRecord | undefined;
		for (const found of this.jobs.values())
			if (found.serviceJobId === answer.jobId) job = found;
		if (!job || job.session !== session || job.status !== "in_progress")
			throw new Error(`job ${answer.jobId} was not taken by this session`);
		return this.complete(job.id, {
			conclusion: answer.conclusion === "succeeded" ? "success" : "failure",
			outputs: new Map(
				answer.outputs.map((output) => [output.name, output.value]),
			),
			annotations: answer.annotations.map((annotation) => ({
				level:
					annotation.level === "error"
						? "failure"
						: annotation.level === "warning"
							? "warning"
							: "notice",
				message: annotation.message,
			})),
		});
	}

	private finish(
		job: JobRecord,
		completion: { conclusion: JobConclusion } & Omit<
			JobCompletion,
			"conclusion"
		>,
	): void {
		job.status = "completed";
		job.conclusion = completion.conclusion;
		job.blocked = false;
		job.completedAtMs = this.clock;
		for (const [name, value] of completion.outputs ?? [])
			job.outputs.set(name, value);
		job.annotations.push(...(completion.annotations ?? []));
		job.steps = [...(completion.steps ?? [])];
		job.log = completion.log ?? job.log;
		const runner =
			job.runnerId === undefined ? undefined : this.runners.get(job.runnerId);
		if (runner && runner.jobId === job.id) {
			runner.busy = false;
			runner.jobId = undefined;
			if (runner.ephemeral) this.runners.delete(runner.id);
		}
		this.emitJob(job, "completed");
		const run = this.runs.get(job.runId);
		if (!run) return;
		for (const other of this.jobs.values())
			if (
				other.blocked &&
				other.runId === job.runId &&
				other.needs.includes(job.name)
			)
				this.release(other);
		for (const [number, attempt] of run.attempts)
			if (
				attempt.completedAtMs === undefined &&
				attempt.jobIds.includes(job.id)
			)
				this.settleAttempt(run, number);
	}

	private settleAttempt(run: RunRecord, number: number): void {
		const attempt = run.attempts.get(number);
		if (!attempt) return;
		const all = attempt.jobIds.flatMap((id) => this.jobs.get(id) ?? []);
		if (all.some((job) => job.status !== "completed")) return;
		attempt.completedAtMs = this.clock;
		this.emit(
			"workflow_run",
			{
				action: "completed",
				workflow_run: runJson(
					run,
					number,
					this.attemptState(run, number),
					this.repo(run),
				),
			},
			run.repository,
			run.actorId,
		);
	}

	attemptState(run: RunRecord, number: number): AttemptState {
		const attempt = run.attempts.get(number);
		const all = (attempt?.jobIds ?? []).flatMap(
			(id) => this.jobs.get(id) ?? [],
		);
		const started = attempt?.createdAtMs ?? this.clock;
		if (attempt?.completedAtMs !== undefined) {
			const conclusions = all.map((job) => job.conclusion);
			const conclusion = conclusions.includes("failure")
				? "failure"
				: conclusions.includes("cancelled")
					? "cancelled"
					: "success";
			return {
				status: "completed",
				conclusion,
				startedAtMs: started,
				updatedAtMs: attempt.completedAtMs,
			};
		}
		return {
			status: all.some((job) => job.status === "in_progress")
				? "in_progress"
				: "queued",
			conclusion: null,
			startedAtMs: started,
			updatedAtMs: this.clock,
		};
	}

	repo(run: RunRecord): RepositoryRecord {
		return this.ensureRepository(run.repository);
	}

	cancelRun(run: RunRecord): void {
		const ids = run.attempts.get(run.latestAttempt)?.jobIds ?? [];
		for (const id of ids) {
			const job = this.jobs.get(id);
			if (job && job.status !== "completed")
				this.finish(job, { conclusion: "cancelled" });
		}
	}

	rerun(
		run: RunRecord,
		failedOnly: boolean,
	): "started" | "running" | "nothing-failed" {
		const previous = run.latestAttempt;
		const state = this.attemptState(run, previous);
		if (state.status !== "completed") return "running";
		const jobs = (run.attempts.get(previous)?.jobIds ?? []).flatMap(
			(id) => this.jobs.get(id) ?? [],
		);
		const again = new Set(
			jobs
				.filter((job) => !failedOnly || job.conclusion !== "success")
				.map((job) => job.name),
		);
		if (again.size === 0) return "nothing-failed";
		let grew = true;
		while (grew) {
			grew = false;
			for (const job of jobs)
				if (!again.has(job.name) && job.needs.some((name) => again.has(name))) {
					again.add(job.name);
					grew = true;
				}
		}
		const attempt = this.attemptOf(run, previous + 1);
		for (const job of jobs)
			if (!again.has(job.name)) attempt.jobIds.push(job.id);
		for (const job of jobs)
			if (again.has(job.name))
				this.queueJob({
					repository: run.repository,
					name: job.name,
					labels: job.labelTemplates,
					runId: run.id,
					runAttempt: attempt.attempt,
					inputs: job.inputs,
					steps: job.workflowSteps,
					needs: job.needs,
				});
		return "started";
	}

	registerRunner(input: RegisterRunnerInput): RunnerRecord {
		if (this.runnerByName(input.name))
			throw new Error(`a runner named ${input.name} is registered`);
		if (input.repository !== undefined) this.ensureRepository(input.repository);
		const runner: RunnerRecord = {
			id: this.nextRunnerId++,
			name: input.name,
			labels: [],
			status: input.online === false ? "offline" : "online",
			busy: false,
			repository: input.repository,
			org: input.org,
			ephemeral: input.ephemeral ?? false,
			jobId: undefined,
			sessions: 0,
		};
		runner.labels.push(this.label("self-hosted", "read-only"));
		this.addLabels(runner, input.labels);
		this.runners.set(runner.id, runner);
		return runner;
	}

	label(name: string, type: RunnerLabelRecord["type"]): RunnerLabelRecord {
		return { id: this.nextLabelId++, name, type };
	}

	addLabels(runner: RunnerRecord, names: readonly string[]): void {
		for (const name of names)
			if (!runner.labels.some((label) => sameLabel(label.name, name)))
				runner.labels.push(this.label(name, "custom"));
	}

	removeRunner(runner: RunnerRecord): void {
		const job =
			runner.jobId === undefined ? undefined : this.jobs.get(runner.jobId);
		this.runners.delete(runner.id);
		if (job && job.status === "in_progress")
			this.finish(job, {
				conclusion: "failure",
				annotations: [
					{
						level: "failure",
						message: `The runner ${runner.name} was removed while it ran this job`,
					},
				],
			});
	}

	relayJobMessage(job: JobRecord): RelayJobMessage {
		const run = this.runs.get(job.runId);
		const repository = this.ensureRepository(job.repository);
		return create(RelayJobMessageSchema, {
			jobId: job.serviceJobId,
			planId: guid(2, job.runId * 100 + job.runAttempt),
			repository: job.repository,
			runId: job.runId,
			runAttempt: job.runAttempt,
			job: job.name,
			event: run?.event ?? "push",
			actorId: run?.actorId ?? SIMULATED_ACTOR_ID,
			triggeringActorId: run?.actorId ?? SIMULATED_ACTOR_ID,
			private: repository.private,
			fork: run?.fork ?? false,
			workflowRef: run?.workflowRef ?? "",
			inputs: [...job.inputs].map(([name, value]) => ({ name, value })),
			steps: job.workflowSteps.map((step) => ({
				uses: step.uses,
				inputs: [...step.with].map(([name, value]) => ({ name, value })),
			})),
		});
	}

	private emitJob(
		job: JobRecord,
		action: "queued" | "in_progress" | "completed",
	): void {
		const run = this.runs.get(job.runId);
		if (!run) return;
		this.emit(
			"workflow_job",
			{ action, workflow_job: jobJson(job, run) },
			job.repository,
			run.actorId,
		);
	}

	private emit(
		event: DeliveryRecord["event"],
		payload: Readonly<{ action: string }> &
			Readonly<
				Partial<{
					workflow_job: ReturnType<typeof jobJson>;
					workflow_run: ReturnType<typeof runJson>;
				}>
			>,
		repository: string,
		actorId: string,
	): void {
		const record = this.ensureRepository(repository);
		const body = JSON.stringify({
			...payload,
			repository: repositoryJson(record),
			installation: { id: this.installationId },
			sender: { login: `user-${actorId}`, id: Number(actorId) },
		});
		const delivery: DeliveryRecord = {
			id: guid(3, this.nextDeliveryId++),
			event,
			body,
			dropped: false,
			delivered: 0,
		};
		this.deliveries.push(delivery);
		this.pending.push(delivery);
	}

	dropNext(): void {
		this.dropsPending += 1;
	}

	takePending(): DeliveryRecord[] {
		const due = this.pending.splice(0);
		return due.filter((delivery) => {
			if (this.dropsPending === 0) return true;
			this.dropsPending -= 1;
			delivery.dropped = true;
			return false;
		});
	}

	redeliver(id: string): void {
		const delivery = this.deliveries.find((found) => found.id === id);
		if (!delivery) throw new Error(`no delivery ${id}`);
		this.pending.push(delivery);
	}
}
