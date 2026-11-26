import { create } from "@bufbuild/protobuf";
import {
	defineRelayJobAnswer,
	type RelayChecks,
	type RelayJobAnswer,
	RelayJobAnswerSchema,
	type RelayJobMessage,
	type RelayJobsConfig,
} from "@hobo/ci";
import { z } from "zod";
import type { GithubTransport } from "../github.js";
import { parseJitConfig } from "../runner-protocol/jit-config.js";
import type {
	ParsedJitConfig,
	RunnerServiceClient,
	RunnerSession,
} from "../runner-protocol/port.js";
import { isRelayCheckJob } from "../runner-protocol/wire.js";
import { verifyWebhookSignature } from "../webhook-signature.js";
import { GithubCiFile, parseRelayJobs, RELAY_CONFIG_PATH } from "./ci-file.js";

export const RELAY_OFFER_WAIT_MS = 4 * 60_000;
export const RELAY_MAX_ATTEMPTS = 4;
export const RELAY_RUNNER_PREFIX = "hobo-relay-";
const RELAY_RUNNER_NAME = /^hobo-relay-(\d+)-(\d+)-(\d+)$/u;
const REMEMBERED_JOBS = 5_000;
export const RELAY_STALE_RUNNER_MS = 60_000;
export const RELAY_RESCUE_CONCURRENCY = 4;

export type QueuedRelayJob = Readonly<{
	installationId: number;
	repository: string;
	jobId: number;
	runId: number;
	runAttempt: number;
	name: string;
	labels: readonly string[];
	queuedAtMs: number;
}>;

export type RelayConnection = Readonly<{
	installationId: number;
	repository: string;
}>;

export type RelayTurn = Readonly<{
	shouldStart(
		job: Readonly<{ jobId: number; label: string; queuedAtMs: number }>,
	): Promise<
		Readonly<{
			start: boolean;
			reason: string;
		}>
	>;
}>;

export type AnsweredRelayJob = Readonly<{
	repository: string;
	runId: number;
	job: string;
	conclusion: string;
}>;

export const RELAY_SKIP_REASONS = [
	"relay-mode-off",
	"not-relay-label",
	"no-account",
	"repository-off",
	"in-flight",
	"waiting-turn",
	"claimed-elsewhere",
	"not-queued",
	"read-failed",
	"runner-exists",
	"no-job-offered",
] as const;
export type RelaySkipReason = (typeof RELAY_SKIP_REASONS)[number];

export type RelayAnswerOutcome =
	| Readonly<{
			kind: "answered";
			answered: readonly AnsweredRelayJob[];
	  }>
	| Readonly<{
			kind: "skipped";
			reason: RelaySkipReason;
			answered: readonly AnsweredRelayJob[];
	  }>
	| Readonly<{
			kind: "failed";
			message: string;
			answered: readonly AnsweredRelayJob[];
	  }>;

export type RelayAnswererOptions = Readonly<{
	relayJobs: RelayJobsConfig;
	github: GithubTransport;
	runnerService: RunnerServiceClient;
	readJitConfig?: (encoded: string, runnerName: string) => ParsedJitConfig;
	account: (job: QueuedRelayJob) => Promise<string | undefined>;
	node: string;
	turn?: RelayTurn | undefined;
	checks?: RelayChecks | undefined;
	webhookSecret?: string | undefined;
	defer?: ((task: () => Promise<void>) => void) | undefined;
	offerWaitMs?: number | undefined;
	nowMs?: (() => number) | undefined;
}>;

export type RelayRescueSummary = Readonly<{
	queued: number;
	outcomes: readonly RelayAnswerOutcome[];
	failedReads: number;
}>;

export type RelaySweepSummary = Readonly<{
	deleted: readonly string[];
	failedReads: number;
}>;

export type RelayAnswerer = Readonly<{
	answer(job: QueuedRelayJob): Promise<RelayAnswerOutcome>;
	webhook(request: Request): Promise<Response>;
	rescue(connections: readonly RelayConnection[]): Promise<RelayRescueSummary>;
	sweep(connections: readonly RelayConnection[]): Promise<RelaySweepSummary>;
}>;

const WorkflowJobHook = z.object({
	action: z.string(),
	installation: z.object({ id: z.number().int().positive() }),
	repository: z.object({ full_name: z.string().min(3) }),
	workflow_job: z.object({
		id: z.number().int().positive(),
		run_id: z.number().int().positive(),
		run_attempt: z.number().int().positive().optional(),
		name: z.string(),
		labels: z.array(z.string()),
		created_at: z.string().optional(),
	}),
});

const JobStatus = z.object({ status: z.string() });
const RunStatus = z.object({ status: z.string() });
const Runs = z.object({
	workflow_runs: z.array(z.object({ id: z.number().int().positive() })),
});
const Jobs = z.object({
	jobs: z.array(
		z.object({
			id: z.number().int().positive(),
			run_id: z.number().int().positive(),
			run_attempt: z.number().int().positive().optional(),
			name: z.string(),
			status: z.string(),
			labels: z.array(z.string()),
			created_at: z.string().optional(),
		}),
	),
});
const Runners = z.object({
	runners: z.array(
		z.object({
			id: z.number().int().positive(),
			name: z.string(),
			status: z.string(),
			busy: z.boolean(),
		}),
	),
});
const Registered = z.object({
	encoded_jit_config: z.string().min(1),
	runner: z.object({ id: z.number().int().positive(), name: z.string() }),
});

type RegisteredRunner = Readonly<{
	id: number;
	name: string;
	scope: string;
	encoded: string;
}>;

type JobState = "queued" | "gone" | "unknown";

type AnswerContext =
	| Readonly<{ kind: "answer" }>
	| Readonly<{ kind: "refuse"; reason: string }>;

type Registration =
	| Readonly<{ kind: "registered"; runner: RegisteredRunner }>
	| Readonly<{ kind: "exists" }>
	| Readonly<{ kind: "refused"; message: string }>;

function owner(repository: string): string {
	return repository.slice(0, repository.indexOf("/"));
}

function timeOf(text: string | undefined, fallback: number): number {
	const parsed = Date.parse(text ?? "");
	return Number.isFinite(parsed) ? parsed : fallback;
}

function answered(
	message: RelayJobMessage,
	answer: RelayJobAnswer,
): AnsweredRelayJob {
	return Object.freeze({
		repository: message.repository,
		runId: message.runId,
		job: message.job,
		conclusion: answer.conclusion,
	});
}

function sameRepository(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function sameRun(message: RelayJobMessage, job: QueuedRelayJob): boolean {
	return (
		sameRepository(message.repository, job.repository) &&
		message.runId === job.runId &&
		(message.runAttempt === 0 || message.runAttempt === job.runAttempt)
	);
}

function failedAnswer(message: RelayJobMessage, text: string): RelayJobAnswer {
	return create(RelayJobAnswerSchema, {
		jobId: message.jobId,
		planId: message.planId,
		conclusion: "failed",
		outputs: [],
		annotations: [{ level: "error", message: text }],
	});
}

function notRelayAnswer(message: RelayJobMessage): RelayJobAnswer {
	return failedAnswer(
		message,
		`Job ${message.job} asked for the relay label but is not made only of HoBo check steps; a relay runs check jobs and never runs a job's steps or routes it. Give it a runs-on label of a runner instead.`,
	);
}

export function relayRunnerName(job: QueuedRelayJob, attempt: number): string {
	return `${RELAY_RUNNER_PREFIX}${job.runId}-${job.jobId}-${attempt}`;
}

export function relayRunnerRun(name: string): number | undefined {
	const match = RELAY_RUNNER_NAME.exec(name);
	const runId = Number(match?.[1]);
	return Number.isSafeInteger(runId) && runId > 0 ? runId : undefined;
}

class Answerer {
	private readonly inFlight = new Set<number>();
	private readonly done = new Set<number>();
	private readonly holding = new Set<string>();
	private readonly offlineSince = new Map<string, number>();
	private readonly now: () => number;
	private readonly readJit: (
		encoded: string,
		runnerName: string,
	) => ParsedJitConfig;

	constructor(private readonly options: RelayAnswererOptions) {
		this.now = options.nowMs ?? Date.now;
		this.readJit =
			options.readJitConfig ??
			((encoded, runnerName) => parseJitConfig(encoded, { runnerName }));
	}

	private get on(): boolean {
		return this.options.relayJobs.answer;
	}

	private isRelayLabel(labels: readonly string[]): boolean {
		return (
			labels.length === 1 &&
			labels[0]?.toLowerCase() === this.options.relayJobs.label.toLowerCase()
		);
	}

	async answer(job: QueuedRelayJob): Promise<RelayAnswerOutcome> {
		if (!this.on) return skipped("relay-mode-off");
		if (!this.isRelayLabel(job.labels)) return skipped("not-relay-label");
		if (this.inFlight.has(job.jobId) || this.done.has(job.jobId))
			return skipped("in-flight");
		this.inFlight.add(job.jobId);
		try {
			const outcome = await this.answerOnce(job);
			if (
				outcome.kind === "answered" ||
				(outcome.kind === "skipped" && outcome.reason === "not-queued")
			)
				this.remember(job.jobId);
			return outcome;
		} catch (error) {
			return {
				kind: "failed",
				message: error instanceof Error ? error.message : String(error),
				answered: [],
			};
		} finally {
			this.inFlight.delete(job.jobId);
		}
	}

	private remember(jobId: number): void {
		if (this.done.size >= REMEMBERED_JOBS) this.done.clear();
		this.done.add(jobId);
	}

	private async answerOnce(job: QueuedRelayJob): Promise<RelayAnswerOutcome> {
		const label = job.labels[0] ?? this.options.relayJobs.label;
		if (this.options.turn) {
			const turn = await this.options.turn.shouldStart({
				jobId: job.jobId,
				label,
				queuedAtMs: job.queuedAtMs,
			});
			if (!turn.start)
				return skipped(
					turn.reason === "claimed-elsewhere"
						? "claimed-elsewhere"
						: "waiting-turn",
				);
		}
		const accountId = await this.options.account(job);
		if (accountId === undefined) return skipped("no-account");
		const file = new GithubCiFile(this.options.github, job.installationId);
		const repositoryJobs = parseRelayJobs(
			await file.read(job.repository, undefined),
		);
		if (
			!repositoryJobs.answer ||
			repositoryJobs.label.toLowerCase() !== label.toLowerCase()
		)
			return skipped("repository-off");
		const done: AnsweredRelayJob[] = [];
		for (let attempt = 1; attempt <= RELAY_MAX_ATTEMPTS; attempt += 1) {
			const state = await this.jobState(job);
			if (state !== "queued")
				return {
					kind: "skipped",
					reason: state === "gone" ? "not-queued" : "read-failed",
					answered: done,
				};
			const registration = await this.register(job, attempt, label);
			if (registration.kind === "exists")
				return { kind: "skipped", reason: "runner-exists", answered: done };
			if (registration.kind === "refused")
				return {
					kind: "failed",
					message: registration.message,
					answered: done,
				};
			const taken = await this.take(job, registration.runner, label, {
				kind: "answer",
			});
			if (!taken)
				return { kind: "skipped", reason: "no-job-offered", answered: done };
			done.push(taken.answered);
			if (taken.original) return { kind: "answered", answered: done };
		}
		return {
			kind: "failed",
			message: `GitHub offered ${RELAY_MAX_ATTEMPTS} relay runners other jobs before job ${job.name} of run ${job.runId}; it is left queued for the next rescue`,
			answered: done,
		};
	}

	private async jobState(job: QueuedRelayJob): Promise<JobState> {
		try {
			const response = await this.options.github.request(
				job.installationId,
				`/repos/${job.repository}/actions/jobs/${job.jobId}`,
			);
			if (response.status === 404) {
				await response.body?.cancel();
				return "gone";
			}
			if (!response.ok) {
				await response.body?.cancel();
				return "unknown";
			}
			const read = JobStatus.safeParse(await response.json());
			if (!read.success) return "unknown";
			return read.data.status === "queued" ? "queued" : "gone";
		} catch {
			return "unknown";
		}
	}

	private async register(
		job: QueuedRelayJob,
		attempt: number,
		label: string,
	): Promise<Registration> {
		const name = relayRunnerName(job, attempt);
		const body = JSON.stringify({
			name,
			runner_group_id: 1,
			labels: [label],
			work_folder: "_hobo_relay",
		});
		let refused = "";
		for (const scope of [
			`/repos/${job.repository}`,
			`/orgs/${owner(job.repository)}`,
		]) {
			const response = await this.options.github.request(
				job.installationId,
				`${scope}/actions/runners/generate-jitconfig`,
				"POST",
				body,
			);
			if (response.status === 409) {
				await response.body?.cancel();
				return { kind: "exists" };
			}
			if (response.ok) {
				const registered = Registered.safeParse(await response.json());
				if (!registered.success || registered.data.runner.name !== name)
					return {
						kind: "refused",
						message: `GitHub's answer to creating runner ${name} could not be read`,
					};
				this.holding.add(name);
				return {
					kind: "registered",
					runner: {
						id: registered.data.runner.id,
						name,
						scope,
						encoded: registered.data.encoded_jit_config,
					},
				};
			}
			await response.body?.cancel();
			refused = `${refused}${refused === "" ? "" : "; "}${scope} answered ${response.status}`;
			if (response.status !== 403 && response.status !== 404) break;
		}
		return {
			kind: "refused",
			message: `GitHub refused a one-job runner for ${job.repository}: ${refused}`,
		};
	}

	private async take(
		job: QueuedRelayJob,
		runner: RegisteredRunner,
		label: string,
		own: AnswerContext,
	): Promise<
		Readonly<{ answered: AnsweredRelayJob; original: boolean }> | undefined
	> {
		let session: RunnerSession | undefined;
		try {
			session = await this.options.runnerService.open(
				this.readJit(runner.encoded, runner.name),
			);
			const message = await session.nextJob(
				this.options.offerWaitMs ?? RELAY_OFFER_WAIT_MS,
			);
			if (!message) return undefined;
			const context = sameRepository(message.repository, job.repository)
				? own
				: await this.otherRepository(job, message, label);
			const answer =
				context.kind === "refuse"
					? failedAnswer(message, context.reason)
					: isRelayCheckJob(message)
						? await this.check(message)
						: notRelayAnswer(message);
			await session.complete(answer);
			const original =
				sameRun(message, job) &&
				(message.job === job.name || (await this.jobState(job)) === "gone");
			return { answered: answered(message, answer), original };
		} finally {
			await session?.close().catch(() => undefined);
			await this.deleteRunner(job.installationId, runner).catch(
				() => undefined,
			);
			this.holding.delete(runner.name);
		}
	}

	private async check(message: RelayJobMessage): Promise<RelayJobAnswer> {
		const checked = await this.options.checks?.(message);
		return checked
			? defineRelayJobAnswer(checked)
			: failedAnswer(
					message,
					"No relay check handler answered this job; its checks did not run.",
				);
	}

	private async otherRepository(
		job: QueuedRelayJob,
		message: RelayJobMessage,
		label: string,
	): Promise<AnswerContext> {
		const repository = message.repository;
		const accountId = await this.options.account({
			...job,
			repository,
			runId: message.runId,
			runAttempt: message.runAttempt === 0 ? 1 : message.runAttempt,
			name: message.job,
		});
		if (accountId === undefined)
			return {
				kind: "refuse",
				reason: `Relay mode is not on for ${repository}: this relay node serves no HoBo account for it. Run the job again so a node that serves it can answer, connect the repository to the relay, or give the job a runs-on label of a runner.`,
			};
		const file = new GithubCiFile(this.options.github, job.installationId);
		let jobs: RelayJobsConfig;
		try {
			jobs = parseRelayJobs(await file.read(repository, undefined));
		} catch (error) {
			return {
				kind: "refuse",
				reason: `Relay mode could not be checked for ${repository}: ${error instanceof Error ? error.message : String(error)}. Run the job again.`,
			};
		}
		if (!jobs.answer || jobs.label.toLowerCase() !== label.toLowerCase())
			return {
				kind: "refuse",
				reason: `Relay mode is not on for ${repository}: its ${RELAY_CONFIG_PATH} does not turn relayJobs.answer on for the label ${label}. Turn it on there, or give the job a runs-on label of a runner.`,
			};
		return { kind: "answer" };
	}

	private async deleteRunner(
		installationId: number,
		runner: Readonly<{ id: number; scope: string }>,
	): Promise<boolean> {
		const response = await this.options.github.request(
			installationId,
			`${runner.scope}/actions/runners/${runner.id}`,
			"DELETE",
		);
		await response.body?.cancel();
		return response.ok || response.status === 404;
	}

	async webhook(request: Request): Promise<Response> {
		if (!this.on)
			return Response.json({ ignored: "relay-mode-off" }, { status: 202 });
		const secret = this.options.webhookSecret;
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (
			secret === undefined ||
			verifyWebhookSignature(
				secret,
				bytes,
				request.headers.get("x-hub-signature-256") ?? undefined,
			) !== "valid"
		)
			return Response.json({ error: "bad signature" }, { status: 401 });
		if (request.headers.get("x-github-event") !== "workflow_job")
			return Response.json({ ignored: "event" }, { status: 202 });
		let hook: z.infer<typeof WorkflowJobHook>;
		try {
			hook = WorkflowJobHook.parse(JSON.parse(new TextDecoder().decode(bytes)));
		} catch {
			return Response.json(
				{ error: "unreadable workflow_job" },
				{ status: 400 },
			);
		}
		if (
			hook.action !== "queued" ||
			!this.isRelayLabel(hook.workflow_job.labels)
		)
			return Response.json(
				{ ignored: "not a queued relay job" },
				{ status: 202 },
			);
		const job: QueuedRelayJob = {
			installationId: hook.installation.id,
			repository: hook.repository.full_name,
			jobId: hook.workflow_job.id,
			runId: hook.workflow_job.run_id,
			runAttempt: hook.workflow_job.run_attempt ?? 1,
			name: hook.workflow_job.name,
			labels: hook.workflow_job.labels,
			queuedAtMs: timeOf(hook.workflow_job.created_at, this.now()),
		};
		const defer = this.options.defer;
		if (defer) {
			defer(async () => {
				await this.answer(job);
			});
			return Response.json({ accepted: job.jobId }, { status: 202 });
		}
		const outcome = await this.answer(job);
		return Response.json(
			{
				outcome: outcome.kind,
				reason: outcome.kind === "skipped" ? outcome.reason : "",
				message: outcome.kind === "failed" ? outcome.message : "",
			},
			{ status: 200 },
		);
	}

	private async readJson<T>(
		installationId: number,
		path: string,
		schema: z.ZodType<T>,
	): Promise<T | undefined> {
		try {
			const response = await this.options.github.request(installationId, path);
			if (!response.ok) {
				await response.body?.cancel();
				return undefined;
			}
			const parsed = schema.safeParse(await response.json());
			return parsed.success ? parsed.data : undefined;
		} catch {
			return undefined;
		}
	}

	async rescue(
		connections: readonly RelayConnection[],
	): Promise<RelayRescueSummary> {
		const outcomes: RelayAnswerOutcome[] = [];
		let queued = 0;
		let failedReads = 0;
		if (!this.on) return { queued, outcomes, failedReads };
		const found: QueuedRelayJob[] = [];
		for (const connection of connections) {
			const runIds = new Set<number>();
			for (const status of ["queued", "in_progress"]) {
				const runs = await this.readJson(
					connection.installationId,
					`/repos/${connection.repository}/actions/runs?status=${status}&per_page=100`,
					Runs,
				);
				if (!runs) failedReads += 1;
				for (const run of runs?.workflow_runs ?? []) runIds.add(run.id);
			}
			for (const runId of [...runIds].sort((left, right) => left - right)) {
				const jobs = await this.readJson(
					connection.installationId,
					`/repos/${connection.repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
					Jobs,
				);
				if (!jobs) failedReads += 1;
				for (const job of jobs?.jobs ?? []) {
					if (job.status !== "queued" || !this.isRelayLabel(job.labels))
						continue;
					queued += 1;
					found.push({
						installationId: connection.installationId,
						repository: connection.repository,
						jobId: job.id,
						runId: job.run_id,
						runAttempt: job.run_attempt ?? 1,
						name: job.name,
						labels: job.labels,
						queuedAtMs: timeOf(job.created_at, this.now()),
					});
				}
			}
		}
		const results: Array<RelayAnswerOutcome | undefined> = Array.from({
			length: found.length,
		});
		let next = 0;
		const worker = async (): Promise<void> => {
			for (let index = next++; index < found.length; index = next++) {
				const queuedJob = found[index];
				if (queuedJob) results[index] = await this.answer(queuedJob);
			}
		};
		await Promise.all(
			Array.from(
				{ length: Math.min(RELAY_RESCUE_CONCURRENCY, found.length) },
				worker,
			),
		);
		for (const result of results) if (result) outcomes.push(result);
		return { queued, outcomes, failedReads };
	}

	async sweep(
		connections: readonly RelayConnection[],
	): Promise<RelaySweepSummary> {
		const deleted: string[] = [];
		let failedReads = 0;
		if (!this.on) return { deleted, failedReads };
		const scopes = new Map<string, RelayConnection[]>();
		for (const connection of connections)
			for (const scope of [
				`/repos/${connection.repository}`,
				`/orgs/${owner(connection.repository)}`,
			])
				scopes.set(scope, [...(scopes.get(scope) ?? []), connection]);
		for (const [scope, served] of scopes) {
			const first = served[0];
			if (!first) continue;
			const runners = await this.readJson(
				first.installationId,
				`${scope}/actions/runners?per_page=100`,
				Runners,
			);
			if (!runners) {
				if (scope.startsWith("/repos/")) failedReads += 1;
				continue;
			}
			for (const runner of runners.runners) {
				const runId = relayRunnerRun(runner.name);
				if (runId === undefined) continue;
				const key = `${scope}#${runner.id}`;
				if (runner.busy || runner.status !== "offline")
					this.offlineSince.delete(key);
				if (runner.busy) continue;
				if (
					!(await this.runEnded(served, runId, scope.startsWith("/repos/"))) &&
					!this.staleOffline(key, runner)
				)
					continue;
				this.offlineSince.delete(key);
				if (
					await this.deleteRunner(first.installationId, {
						id: runner.id,
						scope,
					}).catch(() => false)
				)
					deleted.push(runner.name);
			}
		}
		if (this.offlineSince.size > REMEMBERED_JOBS) this.offlineSince.clear();
		return { deleted, failedReads };
	}

	private staleOffline(
		key: string,
		runner: Readonly<{ name: string; status: string; busy: boolean }>,
	): boolean {
		if (runner.busy || runner.status !== "offline") return false;
		if (this.holding.has(runner.name)) return false;
		const now = this.now();
		const since = this.offlineSince.get(key);
		if (since === undefined) {
			this.offlineSince.set(key, now);
			return false;
		}
		return now - since >= RELAY_STALE_RUNNER_MS;
	}

	private async runEnded(
		served: readonly RelayConnection[],
		runId: number,
		repositoryScope: boolean,
	): Promise<boolean> {
		for (const connection of served) {
			const response = await this.options.github.request(
				connection.installationId,
				`/repos/${connection.repository}/actions/runs/${runId}`,
			);
			if (response.status === 404) {
				await response.body?.cancel();
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				return false;
			}
			const run = RunStatus.safeParse(await response.json());
			return run.success && run.data.status === "completed";
		}
		return repositoryScope;
	}
}

function skipped(reason: RelaySkipReason): RelayAnswerOutcome {
	return { kind: "skipped", reason, answered: [] };
}

export function createRelayAnswerer(
	options: RelayAnswererOptions,
): RelayAnswerer {
	const answerer = new Answerer(options);
	return {
		answer: (job) => answerer.answer(job),
		webhook: (request) => answerer.webhook(request),
		rescue: (connections) => answerer.rescue(connections),
		sweep: (connections) => answerer.sweep(connections),
	};
}
