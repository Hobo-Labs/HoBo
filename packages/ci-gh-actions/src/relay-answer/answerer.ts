/**
 * `createRelayAnswerer`: relay mode (ADR-0183). A HoBo node answers a relay
 * job itself, over the runner protocol, so the job runs on no runner, bills
 * no minute and runs no job code.
 *
 * For a queued job whose only label is the relay label, when `relayJobs`
 * answering is on for the node and for the repository:
 *
 * 1. Take the mesh turn for the job id, so one node answers it.
 * 2. Check GitHub still has the job queued.
 * 3. Create a one-job runner on the job's repository (the organization when
 *    the repository refuses), open a session, wait up to four minutes and
 *    take the job GitHub offers.
 * 4. Answer it with `answerRelayJob` and the relay's own facts, complete it,
 *    close the session and delete the runner.
 *
 * GitHub offers a runner any waiting job with its label, not the one that
 * woke the answerer. A job that is not the original is answered all the same
 * (it is a relay job too), and the answerer starts again for the original,
 * four times at most.
 *
 * Two more ways in keep a relay job from waiting forever. `rescue` reads the
 * queue of each connected repository, as the job poller does, and answers
 * queued relay jobs whose webhook never arrived. `sweep` deletes leftover
 * `hobo-relay-*` runners whose run has ended.
 *
 * What it reads of a repository is `.hobo/ci.json` and nothing else. It asks
 * for no log, secret or other content, and it starts no process: the job's
 * steps are read as data and never run. With answering off for the node it
 * makes no request and registers nothing.
 *
 * This channel is built, not proven: it is tested against the GitHub
 * simulator, and no run against GitHub's runner service is linked yet.
 */
import { create } from "@bufbuild/protobuf";
import {
	answerRelayJob,
	type ParsedRelayRecord,
	type RelayChecks,
	type RelayJobAnswer,
	RelayJobAnswerSchema,
	type RelayJobMessage,
	type RelayJobsConfig,
	type RouteFactsSource,
	type RouteJournal,
} from "@hobo/ci";
import { z } from "zod";
import type { GithubTransport } from "../github.js";
import { parseJitConfig } from "../runner-protocol/jit-config.js";
import type {
	ParsedJitConfig,
	RunnerServiceClient,
	RunnerSession,
} from "../runner-protocol/port.js";
import { isRelayJob } from "../runner-protocol/wire.js";
import { verifyWebhookSignature } from "../webhook-signature.js";
import {
	GithubCiFile,
	GithubCiOrderSource,
	parseRelayJobs,
} from "./ci-file.js";

/** How long a session waits for GitHub to offer the job: four minutes. */
export const RELAY_OFFER_WAIT_MS = 4 * 60_000;
/** How many runners one relay job may take before the answerer gives up on it. */
export const RELAY_MAX_ATTEMPTS = 4;
// public-contract: the prefix of every one-job runner relay mode creates; the sweep deletes by it.
export const RELAY_RUNNER_PREFIX = "hobo-relay-";
const RELAY_RUNNER_NAME = /^hobo-relay-(\d+)-(\d+)-(\d+)$/u;
/** Jobs remembered as answered, so a redelivery costs no GitHub call. */
const REMEMBERED_JOBS = 5_000;

/** A queued job as the webhook or the queue read shows it. */
export type QueuedRelayJob = Readonly<{
	installationId: number;
	repository: string;
	/** GitHub's job id. */
	jobId: number;
	runId: number;
	runAttempt: number;
	/** The job's name in GitHub's lists: its id in the workflow file. */
	name: string;
	labels: readonly string[];
	/** When GitHub queued it, epoch ms: the clock every mesh node shares. */
	queuedAtMs: number;
}>;

/** A repository the node watches, as the job poller's connections name it. */
export type RelayConnection = Readonly<{
	installationId: number;
	repository: string;
}>;

/** The mesh's say on whether this node answers a job now; `MeshCoordinator` has it. */
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

/** One relay job the answerer completed. */
export type AnsweredRelayJob = Readonly<{
	repository: string;
	runId: number;
	job: string;
	conclusion: string;
	runner: string;
	outcome: string;
	reason: string;
}>;

export const RELAY_SKIP_REASONS = [
	/** Answering is off for this node. */
	"relay-mode-off",
	/** The job asked for more than the relay label, or another label. */
	"not-relay-label",
	/** The node serves no account for this repository. */
	"no-account",
	/** `.hobo/ci.json` does not turn answering on for this label. */
	"repository-off",
	/** This node is already answering it, or already did. */
	"in-flight",
	/** Another mesh node's turn comes first. */
	"waiting-turn",
	/** Another mesh node holds the job. */
	"claimed-elsewhere",
	/** GitHub no longer has it queued. */
	"not-queued",
	/** A runner for this job and attempt exists: another node is answering it. */
	"runner-exists",
	/** GitHub offered the runner nothing in the wait. */
	"no-job-offered",
] as const;
export type RelaySkipReason = (typeof RELAY_SKIP_REASONS)[number];

export type RelayAnswerOutcome =
	| Readonly<{
			kind: "answered";
			/** Every relay job completed for this one, the original last. */
			answered: readonly AnsweredRelayJob[];
	  }>
	| Readonly<{
			kind: "skipped";
			reason: RelaySkipReason;
			/** Relay jobs completed before the skip, when it came after one. */
			answered: readonly AnsweredRelayJob[];
	  }>
	| Readonly<{
			kind: "failed";
			message: string;
			answered: readonly AnsweredRelayJob[];
	  }>;

export type RelayAnswererOptions = Readonly<{
	/** The node's `relayJobs`. Off, the answerer makes no request at all. */
	relayJobs: RelayJobsConfig;
	github: GithubTransport;
	/** The runner service: `GithubRunnerServiceClient` in production. */
	runnerService: RunnerServiceClient;
	/** Decode a one-job runner's configuration; `parseJitConfig` when absent. */
	readJitConfig?: (encoded: string, runnerName: string) => ParsedJitConfig;
	/** The HoBo account a repository's jobs belong to, or undefined when this node serves none. */
	account: (job: QueuedRelayJob) => Promise<string | undefined>;
	/** The relay's facts for one account (`StoreRouteFacts`). */
	facts: (accountId: string) => RouteFactsSource;
	journal: RouteJournal;
	/** This node's name in the journal. */
	node: string;
	/** The mesh turn; every job is this node's when absent. */
	turn?: RelayTurn | undefined;
	checks?: RelayChecks | undefined;
	/** Webhook deliveries are checked against it. */
	webhookSecret?: string | undefined;
	/**
	 * Runs an answer after the webhook has been acknowledged, for a host that
	 * must reply to GitHub within its ten seconds. Absent, the webhook replies
	 * once the job is answered.
	 */
	defer?: ((task: () => Promise<void>) => void) | undefined;
	/** `RELAY_OFFER_WAIT_MS` when absent. */
	offerWaitMs?: number | undefined;
	nowMs?: (() => number) | undefined;
}>;

export type RelayRescueSummary = Readonly<{
	/** Queued relay jobs the read found. */
	queued: number;
	outcomes: readonly RelayAnswerOutcome[];
	/** Reads GitHub refused; the rescue carried on without them. */
	failedReads: number;
}>;

export type RelaySweepSummary = Readonly<{
	deleted: readonly string[];
	failedReads: number;
}>;

export type RelayAnswerer = Readonly<{
	/** Answer one queued job, or say why not. Never throws. */
	answer(job: QueuedRelayJob): Promise<RelayAnswerOutcome>;
	/** A signed `workflow_job` webhook: a queued relay job is answered. */
	webhook(request: Request): Promise<Response>;
	/** Answer queued relay jobs the webhooks missed. */
	rescue(connections: readonly RelayConnection[]): Promise<RelayRescueSummary>;
	/** Delete leftover relay runners whose run has ended. */
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
	/** `/repos/{repo}` or `/orgs/{org}`: where it was registered, and is deleted. */
	scope: string;
	encoded: string;
}>;

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

function outputOf(answer: RelayJobAnswer, name: string): string {
	return answer.outputs.find((output) => output.name === name)?.value ?? "";
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
		runner: outputOf(answer, "runner"),
		outcome: outputOf(answer, "outcome"),
		reason: outputOf(answer, "reason"),
	});
}

/** Whether the message is the job that woke the answerer. */
function isOriginal(message: RelayJobMessage, job: QueuedRelayJob): boolean {
	return (
		message.repository.toLowerCase() === job.repository.toLowerCase() &&
		message.runId === job.runId &&
		(message.runAttempt === 0 || message.runAttempt === job.runAttempt) &&
		message.job === job.name
	);
}

/**
 * A job that asked for the relay label but is no relay job: it names no
 * relay input and is not made of check steps. A relay runs no job code, so
 * the job fails with the reason instead of waiting for a runner.
 */
function notRelayAnswer(message: RelayJobMessage): RelayJobAnswer {
	return create(RelayJobAnswerSchema, {
		jobId: message.jobId,
		planId: message.planId,
		conclusion: "failed",
		outputs: [],
		annotations: [
			{
				level: "error",
				message: `Job ${message.job} asked for the relay label but names no relay input; a relay answers relay jobs and never runs a job's steps. Give it a runs-on label of a runner instead.`,
			},
		],
	});
}

/** The runner name for one try at one job; the same name on two nodes fences the job. */
export function relayRunnerName(job: QueuedRelayJob, attempt: number): string {
	return `${RELAY_RUNNER_PREFIX}${job.runId}-${job.jobId}-${attempt}`;
}

/** The run a relay runner was created for, read from its name. */
export function relayRunnerRun(name: string): number | undefined {
	const match = RELAY_RUNNER_NAME.exec(name);
	const runId = Number(match?.[1]);
	return Number.isSafeInteger(runId) && runId > 0 ? runId : undefined;
}

class Answerer {
	private readonly inFlight = new Set<number>();
	private readonly done = new Set<number>();
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
			if (!(await this.stillQueued(job)))
				return done.length === 0
					? skipped("not-queued")
					: { kind: "skipped", reason: "not-queued", answered: done };
			const registration = await this.register(job, attempt, label);
			if (registration.kind === "exists")
				return { kind: "skipped", reason: "runner-exists", answered: done };
			if (registration.kind === "refused")
				return {
					kind: "failed",
					message: registration.message,
					answered: done,
				};
			const taken = await this.take(
				job,
				registration.runner,
				new GithubCiOrderSource(file),
				accountId,
			);
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

	private async stillQueued(job: QueuedRelayJob): Promise<boolean> {
		const response = await this.options.github.request(
			job.installationId,
			`/repos/${job.repository}/actions/jobs/${job.jobId}`,
		);
		if (!response.ok) {
			await response.body?.cancel();
			return false;
		}
		const read = JobStatus.safeParse(await response.json());
		return read.success && read.data.status === "queued";
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
			// A repository GitHub refuses outright is not tried at the organization.
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
		order: GithubCiOrderSource,
		accountId: string,
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
			const answer: ParsedRelayRecord<RelayJobAnswer> | RelayJobAnswer =
				isRelayJob(message)
					? await answerRelayJob(message, {
							order,
							facts: this.options.facts(accountId),
							journal: this.options.journal,
							nowMs: this.now(),
							mode: "relay",
							node: this.options.node,
							accountId,
							checks: this.options.checks,
						})
					: notRelayAnswer(message);
			await session.complete(answer);
			return {
				answered: answered(message, answer),
				original: isOriginal(message, job),
			};
		} finally {
			await session?.close().catch(() => undefined);
			await this.deleteRunner(job.installationId, runner).catch(
				() => undefined,
			);
		}
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
		// GitHub removes a one-job runner after its job; gone is deleted.
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
					outcomes.push(
						await this.answer({
							installationId: connection.installationId,
							repository: connection.repository,
							jobId: job.id,
							runId: job.run_id,
							runAttempt: job.run_attempt ?? 1,
							name: job.name,
							labels: job.labels,
							queuedAtMs: timeOf(job.created_at, this.now()),
						}),
					);
				}
			}
		}
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
			// An account that is not an organization has no organization runners.
			if (!runners) {
				if (scope.startsWith("/repos/")) failedReads += 1;
				continue;
			}
			for (const runner of runners.runners) {
				const runId = relayRunnerRun(runner.name);
				if (runId === undefined || runner.busy) continue;
				if (!(await this.runEnded(served, runId))) continue;
				if (
					await this.deleteRunner(first.installationId, {
						id: runner.id,
						scope,
					}).catch(() => false)
				)
					deleted.push(runner.name);
			}
		}
		return { deleted, failedReads };
	}

	/** Whether the run has ended in every repository it could belong to. */
	private async runEnded(
		served: readonly RelayConnection[],
		runId: number,
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
		return true;
	}
}

function skipped(reason: RelaySkipReason): RelayAnswerOutcome {
	return { kind: "skipped", reason, answered: [] };
}

/** The relay-mode answerer. It holds no state beyond the jobs it is answering. */
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
