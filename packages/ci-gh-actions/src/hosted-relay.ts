import { createHmac, timingSafeEqual } from "node:crypto";
import { clone, create } from "@bufbuild/protobuf";
import type { Account, ConfigurationState } from "@hobo/ci";
import {
	type Configuration,
	ConfigurationSchema,
	type Connection,
	effectiveCiAccount,
	type Job,
	JobSchema,
	type Lease,
	parseCiPolicy,
	providerOffer,
	route,
} from "@hobo/ci";
import { z } from "zod";
import {
	type JitBootstrapResponse,
	JitBootstrapResponseSchema,
} from "./_generated/jit_bootstrap_response_pb.js";
import {
	type GithubRun,
	type GithubTransport,
	getHostJob,
	getJob,
	getRun,
} from "./github.js";
import type { IdentityVerifier } from "./oidc.js";
import {
	isIsolatedHostOffer,
} from "./isolated-backend.js";
import { verifyIngressForward } from "./ingress-forward.js";

/** Isolated executions are supplied by the hosting runtime and must fail closed. */
export interface IsolatedRunnerHost {
	launch(id: string): Promise<void>;
	reconcile(id: string, forceStop?: boolean): Promise<void>;
}

/** Transactional asynchronous operations needed by the hosted relay. */
export interface HostedRelayStore {
	configuration(): Promise<ConfigurationState | undefined>;
	policySnapshot(): Promise<{
		state: ConfigurationState | undefined;
		policies: { accountId: string; bodyJson: string }[];
	}>;
	get(id: string): Promise<Lease | undefined>;
	all(): Promise<Lease[]>;
	activeLeases(): Promise<Lease[]>;
	accountLeases(accountId: string): Promise<Lease[]>;
	pendingJobs(): Promise<Job[]>;
	assignedJob?(
		job: Job,
	): Promise<{ leaseId: string; version: string } | undefined>;
	clearAssignedJob?(
		job: Job,
		leaseId: string,
		version: string,
		at: string,
		expectedRevision: number,
	): Promise<boolean>;
	observe(job: Job, at: string, expectedRevision?: number): Promise<void>;
	queue(job: Job, at: string, expectedRevision?: number): Promise<void>;
	reserve(
		account: Account,
		job: Job,
		at: string,
		expectedRevision?: number,
	): Promise<Lease | undefined>;
	transition(
		id: string,
		expected: readonly string[],
		update: (lease: Lease) => void,
		event: string,
		at: string,
		expectedRevision?: number,
	): Promise<Lease | undefined>;
	cancelAndRequeue(id: string, job: Job, at: string): Promise<void>;
	abortIsolatedAndRequeue(id: string, job: Job, at: string): Promise<void>;
	settleObserved(
		id: string,
		hostRunId: number,
		billedMinutes: number,
		at: string,
		unmet: Job | undefined,
		completedAt: string,
		observed: { state: string; hostRunId: number; runnerId: number },
	): Promise<Lease | undefined>;
}

const JobWebhook = z.object({
	action: z.enum(["queued", "in_progress", "completed"]),
	installation: z.object({ id: z.number().int().positive() }),
	repository: z.object({
		id: z.number().int().positive(),
		full_name: z.string(),
	}),
	workflow_job: z.object({
		id: z.number().int().positive(),
		run_id: z.number().int().positive(),
		run_attempt: z.number().int().positive().optional(),
		labels: z.array(z.string()),
		runner_name: z.string().nullable().optional(),
	}),
});
const RunWebhook = z.object({
	action: z.literal("completed"),
	installation: z.object({ id: z.number().int().positive() }),
	repository: z.object({
		id: z.number().int().positive(),
		full_name: z.string(),
	}),
	workflow_run: z.object({
		id: z.number().int().positive(),
		display_title: z.string(),
	}),
});

export class HostedRelay {
	readonly now: () => string;
	constructor(
		readonly options: {
			config: Configuration;
			store: HostedRelayStore;
			github: GithubTransport;
			identity: IdentityVerifier;
			webhookSecret: string;
			ingressForwardSecret?: string;
			isolatedHost?: IsolatedRunnerHost;
			/** Deny workflow bridge use when repository-wide runner trust is not fenced. */
			denyUnisolated?: boolean;
			now?: () => string;
		},
	) {
		if (options.webhookSecret.length < 32)
			throw new Error("webhook secret must have at least 32 characters");
		this.now = options.now ?? (() => new Date().toISOString());
	}
	private async refreshConfig(): Promise<number> {
		const { state, policies } = await this.options.store.policySnapshot();
		if (!state?.configuration) throw new Error("configuration unavailable");
		const configuration = clone(ConfigurationSchema, state.configuration);
		const byAccount = new Map(
			policies.map((policy) => [policy.accountId, policy.bodyJson]),
		);
		configuration.accounts = configuration.accounts.map((account) => {
			const json = byAccount.get(account.id);
			return json === undefined
				? account
				: effectiveCiAccount(account, parseCiPolicy(json));
		});
		this.options.config = configuration;
		return state.revision;
	}
	private connection(
		repositoryId: number,
		installationId: number,
		repository: string,
	): Connection | undefined {
		return this.options.config.connections.find(
			(connection) =>
				connection.repositoryId === repositoryId &&
				connection.installationId === installationId &&
				connection.repository.toLowerCase() === repository.toLowerCase(),
		);
	}
	private binding(lease: Lease): Connection {
		const connection = this.connection(
			lease.repositoryId,
			lease.installationId,
			lease.repository,
		);
		if (!connection || connection.accountId !== lease.accountId)
			throw new Error("connection revoked");
		return connection;
	}
	private account(lease: Lease) {
		const account = this.options.config.accounts.find(
			(account) => account.id === lease.accountId,
		);
		if (!account) throw new Error("account revoked");
		return account;
	}
	private trustedOriginal(run: GithubRun, connection: Connection): boolean {
		return (
			!connection.isolatedOnly &&
			!this.options.denyUnisolated &&
			run.repository.id === connection.repositoryId &&
			// A shared label can be claimed by any queued job, including a fork PR.
			// The workflow bridge does not isolate the nested runner from host credentials.
			run.repository.private &&
			run.head_repository?.id === connection.repositoryId &&
			connection.allowedEvents.includes(run.event) &&
			connection.allowedRefs.includes(`refs/heads/${run.head_branch}`)
		);
	}
	private trustedSandboxOriginal(
		run: GithubRun,
		connection: Connection,
	): boolean {
		return (
			!!this.options.isolatedHost &&
			connection.isolatedOnly &&
			connection.acceptAllMatchingRepositoryJobs &&
			connection.publicRepositoryAcknowledged &&
			!connection.allowAllPullRequests &&
			connection.allowedEvents.length === 0 &&
			connection.allowedRefs.length === 0 &&
			run.repository.id === connection.repositoryId
		);
	}
	private trustedHost(
		run: GithubRun,
		connection: Connection,
		lease: Lease,
	): boolean {
		return (
			!connection.isolatedOnly &&
			run.actor.id === connection.dispatcherActorId &&
			run.repository.id === lease.repositoryId &&
			(run.repository.private || connection.publicRepositoryAcknowledged) &&
			run.head_repository?.id === lease.repositoryId &&
			run.event === "workflow_dispatch" &&
			run.run_attempt === 1 &&
			run.head_sha === connection.bridgeSha &&
			run.path.split("@")[0] ===
				`.github/workflows/${connection.bridgeWorkflow}` &&
			run.display_title === `HoBo lease ${lease.id}`
		);
	}
	async webhook(
		raw: Buffer,
		signature: string,
		event: string,
		ingressForward?: string,
	): Promise<string> {
		if (
			this.options.ingressForwardSecret &&
			verifyIngressForward(
				this.options.ingressForwardSecret,
				raw,
				ingressForward,
			)
		)
			return this.processWebhook(raw, event);
		const expected = createHmac("sha256", this.options.webhookSecret)
			.update(raw)
			.digest();
		if (
			!/^sha256=[a-f0-9]{64}$/.test(signature) ||
			!timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"))
		)
			throw new Error("invalid webhook signature");
		return this.processWebhook(raw, event);
	}
	/** Called only after ingress authenticated and durably recorded the exact body. */
	async processWebhook(raw: Buffer, event: string): Promise<string> {
		await this.refreshConfig();
		if (event === "workflow_run") {
			const parsed = RunWebhook.safeParse(JSON.parse(raw.toString()));
			if (!parsed.success) return "ignored";
			const payload = parsed.data;
			const match = /^HoBo lease ([a-f0-9-]{36})$/.exec(
				payload.workflow_run.display_title,
			);
			if (!match?.[1]) return "ignored";
			const lease = await this.options.store.get(match[1]);
			if (
				!lease ||
				lease.repositoryId !== payload.repository.id ||
				lease.installationId !== payload.installation.id ||
				lease.repository.toLowerCase() !==
					payload.repository.full_name.toLowerCase()
			)
				return "ignored";
			await this.reconcile(lease.id, payload.workflow_run.id);
			return "settled";
		}
		if (event !== "workflow_job") return "ignored";
		const parsed = JobWebhook.safeParse(JSON.parse(raw.toString()));
		if (!parsed.success) return "ignored";
		const payload = parsed.data;
		const connection = this.connection(
			payload.repository.id,
			payload.installation.id,
			payload.repository.full_name,
		);
		if (!connection) return "ignored";
		const job: Job = create(JobSchema, {
			id: payload.workflow_job.id,
			runId: payload.workflow_job.run_id,
			runAttempt: payload.workflow_job.run_attempt ?? 1,
			repositoryId: payload.repository.id,
			repository: connection.repository,
			installationId: payload.installation.id,
			labels: payload.workflow_job.labels,
			action: payload.action,
			runnerName: payload.workflow_job.runner_name ?? "",
		});
		const [run, currentJob] = await Promise.all([
			getRun(
				this.options.github,
				job.installationId,
				job.repository,
				job.runId,
			),
			getJob(this.options.github, job.installationId, job.repository, job.id),
		]);
		// The platform may rotate/revoke a connection while the REST checks await.
		// Resolve authority again before committing demand under that connection.
		const admittedRevision = await this.refreshConfig();
		const admitted = this.connection(
			job.repositoryId,
			job.installationId,
			job.repository,
		);
		if (currentJob.run_attempt === undefined)
			throw new Error("GitHub job attempt unavailable");
		if (
			!admitted ||
			run.id !== job.runId ||
			run.repository.id !== job.repositoryId ||
			(payload.workflow_job.run_attempt !== undefined &&
				currentJob.run_attempt !== payload.workflow_job.run_attempt) ||
			currentJob.id !== job.id ||
			currentJob.run_id !== job.runId
		)
			return "ignored";
		// GitHub's REST job, rather than an optional webhook field, owns the runner
		// identity; attempt is always read from the authoritative workflow run.
		job.runAttempt = currentJob.run_attempt;
		job.runnerName = currentJob.runner_name ?? "";
		// Webhook delivery can be delayed or reordered. Assignment and terminal
		// fences must reflect the fresh GitHub job state, not an older event action.
		if (
			currentJob.status === "queued" ||
			currentJob.status === "in_progress" ||
			currentJob.status === "completed"
		) {
			const observation = clone(JobSchema, job);
			observation.action = currentJob.status;
			await this.options.store.observe(
				observation,
				this.now(),
				admittedRevision,
			);
		}
		const isolatedRequired =
			admitted.isolatedOnly ||
			!run.repository.private ||
			run.event === "pull_request";
		job.isolatedRequired = isolatedRequired;
		const trusted = isolatedRequired
			? this.trustedSandboxOriginal(run, admitted)
			: this.trustedOriginal(run, admitted);
		if (
			job.action !== "queued" ||
			currentJob.run_attempt !== run.run_attempt ||
			!trusted ||
			currentJob.status !== "queued" ||
			currentJob.labels.length !== 1 ||
			currentJob.labels[0]?.toLowerCase() !== "hobo"
		)
			return "ignored";
		// Clear a stale assignment only after GitHub verifies the job is queued,
		// with an exact owner/version fence and a terminal prior host.
		const assignment = await this.options.store.assignedJob?.(job);
		if (assignment) {
			const latest = await getJob(
				this.options.github,
				job.installationId,
				job.repository,
				job.id,
			);
			if (
				latest.status !== "queued" ||
				latest.run_id !== job.runId ||
				latest.run_attempt !== job.runAttempt
			)
				return "waiting-for-assignment-recovery";
			if (
				!this.options.store.clearAssignedJob ||
				!(await this.options.store.clearAssignedJob(
					job,
					assignment.leaseId,
					assignment.version,
					this.now(),
					admittedRevision,
				))
			)
				return "waiting-for-assignment-recovery";
		}
		const account = this.options.config.accounts.find(
			(account) => account.id === admitted.accountId,
		);
		if (!account) throw new Error("account missing");
		await this.options.store.queue(job, this.now(), admittedRevision);
		const lease = await this.options.store.reserve(
			account,
			job,
			this.now(),
			admittedRevision,
		);
		return lease ? `reserved:${lease.id}` : "waiting-for-budget-or-capacity";
	}
	private queuedDemand(lease: Lease): Job {
		const offer = providerOffer(this.account(lease), lease);
		return create(JobSchema, {
			id: lease.jobId,
			runId: lease.originalRunId,
			runAttempt: lease.runAttempt,
			repositoryId: lease.repositoryId,
			repository: lease.repository,
			installationId: lease.installationId,
			labels: ["hobo"],
			action: "queued",
			isolatedRequired: isIsolatedHostOffer(offer),
		});
	}
	private async launchEligible(lease: Lease): Promise<boolean> {
		const account = this.account(lease);
		const offer = providerOffer(account, lease);
		const now = this.now();
		const bound = Date.parse(now) + lease.reservedMinutes * 60000;
		if (
			!offer.enabled ||
			(offer.backend !== "" && offer.backend !== "gh-actions") ||
			!offer.bridgeAcknowledged ||
			offer.provider !== lease.provider ||
			offer.priceMicrosPerMinute !== lease.priceMicrosPerMinute ||
			account.maxRuntimeMinutes + account.startupMinutes !==
				lease.reservedMinutes ||
			(lease.reservedFreeMinutes > 0 &&
				(!Number.isFinite(Date.parse(lease.freeValidUntil)) ||
					Date.parse(lease.freeValidUntil) < bound))
		)
			return false;
		// Reprice this exact host against fresh evidence, excluding its own reservation.
		const repriced = route(
			{ ...account, offers: [offer] },
			(await this.options.store.accountLeases(account.id)).filter(
				(entry) => entry.id !== lease.id,
			),
			now,
		);
		return (
			repriced !== undefined &&
			repriced.freeMinutes >= lease.reservedFreeMinutes &&
			repriced.paidMicros <= lease.reservedPaidMicros
		);
	}
	/** A reserved host has no external side effect yet, so a preferred host can
	 * replace it. Already dispatched and uncertain hosts must never be moved. */
	private async hasCheaperHost(lease: Lease): Promise<boolean> {
		const account = this.account(lease);
		const offer = providerOffer(account, lease);
		const others = (await this.options.store.accountLeases(account.id)).filter(
			(entry) => entry.id !== lease.id,
		);
		const now = this.now();
		const current = route({ ...account, offers: [offer] }, others, now);
		const cheapest = route(
			{
				...account,
				offers: account.offers.filter((entry) =>
					isIsolatedHostOffer(offer)
						? isIsolatedHostOffer(entry)
						: !entry.backend || entry.backend === "gh-actions",
				),
			},
			others,
			now,
		);
		if (!current || !cheapest) return false;
		// A refreshed allocation for the same offer is not reflected in the
		// existing reservation. Requeue it so the new free balance is reserved.
		if (current.freeMinutes > lease.reservedFreeMinutes) return true;
		const currentFree = current.freeMinutes > 0;
		const preferredFree = cheapest.freeMinutes > 0;
		return (
			(preferredFree && !currentFree) ||
			(preferredFree === currentFree &&
				cheapest.paidMicros < current.paidMicros)
		);
	}
	/** Durable outbox drain. A launch intent is committed before network I/O. */
	async dispatchPending(): Promise<void> {
		const reservationRevision = await this.refreshConfig();
		for (const job of await this.options.store.pendingJobs()) {
			const connection = this.connection(
				job.repositoryId,
				job.installationId,
				job.repository,
			);
			if (!connection) continue;
			const account = this.options.config.accounts.find(
				(account) => account.id === connection.accountId,
			);
			if (!account) continue;
			// A policy can become stricter while demand is queued. Never reserve a
			// bridge from a pending job admitted under the previous connection.
			if (connection.isolatedOnly) job.isolatedRequired = true;
			await this.options.store.reserve(
				account,
				job,
				this.now(),
				reservationRevision,
			);
		}
		for (const candidate of (await this.options.store.activeLeases()).filter(
			(lease) => lease.state === "reserved",
		)) {
			try {
				this.binding(candidate);
				const [currentJob, originalRun] = await Promise.all([
					getJob(
						this.options.github,
						candidate.installationId,
						candidate.repository,
						candidate.jobId,
					),
					getRun(
						this.options.github,
						candidate.installationId,
						candidate.repository,
						candidate.originalRunId,
					),
				]);
				// Authority may narrow while the GitHub reads are in flight.
				const preflightRevision = await this.refreshConfig();
				const connection = this.binding(candidate);
				const offer = providerOffer(this.account(candidate), candidate);
				const isolatedHost = isIsolatedHostOffer(offer);
				if (connection.isolatedOnly && !isolatedHost) {
					const demand = this.queuedDemand(candidate);
					demand.isolatedRequired = true;
					await this.options.store.cancelAndRequeue(
						candidate.id,
						demand,
						this.now(),
					);
					continue;
				}
				if (
					currentJob.status !== "queued" ||
					currentJob.run_attempt !== candidate.runAttempt ||
					originalRun.run_attempt !== candidate.runAttempt ||
					!(isolatedHost
						? this.trustedSandboxOriginal(originalRun, connection)
						: this.trustedOriginal(originalRun, connection)) ||
					currentJob.labels.length !== 1 ||
					currentJob.labels[0]?.toLowerCase() !== "hobo"
				) {
					await this.options.store.transition(
						candidate.id,
						["reserved"],
						(lease) => {
							lease.state = "cancelled";
						},
						"ci.LeaseCancelled",
						this.now(),
						preflightRevision,
					);
					continue;
				}
				if (isolatedHost) {
					if (!this.options.isolatedHost)
						throw new Error("isolated runner unavailable");
					await this.options.isolatedHost.launch(candidate.id);
					continue;
				}
				if (
					!(await this.launchEligible(candidate)) ||
					(await this.hasCheaperHost(candidate))
				) {
					await this.options.store.cancelAndRequeue(
						candidate.id,
						this.queuedDemand(candidate),
						this.now(),
					);
					continue;
				}
				const lease = await this.options.store.transition(
					candidate.id,
					["reserved"],
					(lease) => {
						lease.state = "dispatching";
					},
					"ci.DispatchRequested",
					this.now(),
					preflightRevision,
				);
				if (!lease) continue;
				try {
					const response = await this.options.github.request(
						lease.installationId,
						`/repos/${lease.repository}/actions/workflows/${connection.bridgeWorkflow}/dispatches`,
						"POST",
						JSON.stringify({
							ref: connection.bridgeRef,
							inputs: {
								lease_id: lease.id,
								runs_on: offer.runsOn,
								timeout_minutes: String(lease.reservedMinutes),
							},
						}),
					);
					if (response.status !== 204)
						throw new Error(`dispatch failed (${response.status})`);
					await this.options.store.transition(
						lease.id,
						["dispatching"],
						(entry) => {
							entry.state = "dispatched";
						},
						"ci.HostDispatched",
						this.now(),
					);
				} catch {
					await this.options.store.transition(
						lease.id,
						["dispatching"],
						(entry) => {
							entry.state = "uncertain";
						},
						"ci.LeaseUncertain",
						this.now(),
					);
				}
			} catch {
				/* Isolate this account: retain reservation and process other candidates. */
			}
		}
	}
	async claim(id: string, token: string): Promise<JitBootstrapResponse> {
		const lease = await this.options.store.get(id);
		if (!lease) throw new Error("unknown lease");
		const claims = await this.options.identity.verify(token);
		if (
			claims.repository_id !== String(lease.repositoryId) ||
			claims.repository.toLowerCase() !== lease.repository.toLowerCase() ||
			claims.run_attempt !== "1"
		)
			throw new Error("identity does not own lease");
		const runId = Number(claims.run_id);
		const [run, originalRun] = await Promise.all([
			getRun(
				this.options.github,
				lease.installationId,
				lease.repository,
				runId,
			),
			getRun(
				this.options.github,
				lease.installationId,
				lease.repository,
				lease.originalRunId,
			),
		]);
		const host = await getHostJob(
			this.options.github,
			lease.installationId,
			lease.repository,
			runId,
		);
		// Recheck current branch/event authority after every external read and before JIT.
		const claimRevision = await this.refreshConfig();
		const connection = this.binding(lease);
		if (connection.isolatedOnly)
			throw new Error("workflow bridge disabled for isolated connection");
		if (
			claims.workflow_sha !== connection.bridgeSha ||
			claims.workflow_ref.split("@")[0] !==
				`${lease.repository}/.github/workflows/${connection.bridgeWorkflow}`
		)
			throw new Error("identity does not own lease");
		if (!this.trustedHost(run, connection, lease) || run.status === "completed")
			throw new Error("untrusted host workflow");
		if (
			!this.trustedOriginal(originalRun, connection) ||
			originalRun.run_attempt !== lease.runAttempt
		)
			throw new Error("original workflow authority revoked");
		if (
			host.status !== "in_progress" ||
			host.labels.length !== 1 ||
			host.labels[0]?.toLowerCase() !==
				providerOffer(this.account(lease), lease).runsOn.toLowerCase()
		)
			throw new Error("unexpected provider host");
		if (!(await this.launchEligible(lease)) || lease.hostRunId !== 0)
			throw new Error("lease unavailable");
		const claimed = await this.options.store.transition(
			id,
			["dispatching", "dispatched", "uncertain"],
			(entry) => {
				if (entry.hostRunId !== 0) throw new Error("lease already claimed");
				entry.hostRunId = runId;
				entry.state = "claiming";
			},
			"ci.RunnerClaimed",
			this.now(),
			claimRevision,
		);
		if (!claimed) throw new Error("lease already claimed");
		try {
			const response = await this.options.github.request(
				lease.installationId,
				`/repos/${lease.repository}/actions/runners/generate-jitconfig`,
				"POST",
				JSON.stringify({
					name: lease.runnerName,
					runner_group_id: connection.runnerGroupId,
					labels: ["hobo"],
					work_folder: "_hobo_work",
				}),
			);
			if (response.status !== 201)
				throw new Error("runner registration failed");
			const result = z
				.object({
					encoded_jit_config: z.string().min(1),
					runner: z.object({
						id: z.number().int().positive(),
						name: z.literal(lease.runnerName),
					}),
				})
				.parse(await response.json());
			const committed = await this.options.store.transition(
				id,
				["claiming"],
				(entry) => {
					entry.state = "running";
					entry.runnerId = result.runner.id;
				},
				"ci.RunnerRegistered",
				this.now(),
			);
			if (!committed) throw new Error("lease changed while registering");
			return create(JitBootstrapResponseSchema, {
				encodedJitConfig: result.encoded_jit_config,
			});
		} catch (error) {
			await this.options.store.transition(
				id,
				["claiming"],
				(entry) => {
					entry.state = "uncertain";
				},
				"ci.LeaseUncertain",
				this.now(),
			);
			throw error;
		}
	}
	/** Only a verified completed host can release an ambiguous or active reservation. */
	async discover(id: string): Promise<void> {
		await this.refreshConfig();
		const lease = await this.options.store.get(id);
		if (
			!lease ||
			!["uncertain", "dispatched"].includes(lease.state) ||
			lease.hostRunId !== 0
		)
			return;
		const connection = this.binding(lease);
		const matches: { id: number; display_title: string }[] = [];
		for (let page = 1; page <= 10; page++) {
			const response = await this.options.github.request(
				lease.installationId,
				`/repos/${lease.repository}/actions/workflows/${connection.bridgeWorkflow}/runs?event=workflow_dispatch&per_page=100${page === 1 ? "" : `&page=${page}`}`,
			);
			if (!response.ok) throw new Error("host discovery unavailable");
			const result = z
				.object({
					workflow_runs: z.array(
						z.object({
							id: z.number().int().positive(),
							display_title: z.string(),
						}),
					),
				})
				.parse(await response.json());
			matches.push(
				...result.workflow_runs.filter(
					(run) => run.display_title === `HoBo lease ${lease.id}`,
				),
			);
			if (matches.length > 1)
				throw new Error(
					"host discovery is ambiguous; operator reconciliation required",
				);
			if (result.workflow_runs.length < 100) {
				if (matches[0]) await this.reconcile(id, matches[0].id);
				return;
			}
		}
		throw new Error(
			"host discovery window exhausted; operator reconciliation required",
		);
	}
	async reconcile(id: string, hostRunId: number): Promise<void> {
		await this.refreshConfig();
		const lease = await this.options.store.get(id);
		if (!lease || lease.state === "completed" || lease.state === "cancelled")
			return;
		// A JIT request may still create a runner even after its response is lost.
		// Do not free the reservation until that ambiguity is resolved.
		if (
			lease.state === "claiming" ||
			(lease.state === "uncertain" &&
				lease.hostRunId !== 0 &&
				lease.runnerId === 0)
		)
			throw new Error("runner registration outcome is unresolved");
		const connection = this.binding(lease);
		const run = await getRun(
			this.options.github,
			lease.installationId,
			lease.repository,
			hostRunId,
		);
		if (
			!this.trustedHost(run, connection, lease) ||
			run.status !== "completed" ||
			!run.run_started_at
		)
			throw new Error("host completion not established");
		if (lease.hostRunId !== 0 && lease.hostRunId !== hostRunId)
			throw new Error("host mismatch");
		const host = await getHostJob(
			this.options.github,
			lease.installationId,
			lease.repository,
			hostRunId,
		);
		const offer = providerOffer(this.account(lease), lease);
		if (
			host.status !== "completed" ||
			!host.started_at ||
			!host.completed_at ||
			host.labels.length !== 1 ||
			host.labels[0]?.toLowerCase() !== offer.runsOn.toLowerCase()
		)
			throw new Error("host shutdown not established");
		if (lease.runnerId !== 0) {
			const deleted = await this.options.github.request(
				lease.installationId,
				`/repos/${lease.repository}/actions/runners/${lease.runnerId}`,
				"DELETE",
			);
			if (deleted.status !== 204 && deleted.status !== 404)
				throw new Error("runner cleanup not established");
		}
		// Wall-clock host duration conservatively includes boot/idle/cleanup, rounded up.
		const minutes = Math.ceil(
			(Date.parse(host.completed_at) - Date.parse(host.started_at)) / 60000,
		);
		if (!Number.isFinite(minutes) || minutes < 0)
			throw new Error("invalid host duration");
		const original = await getJob(
			this.options.github,
			lease.installationId,
			lease.repository,
			lease.jobId,
		);
		const unmet =
			original.status === "queued" ? this.queuedDemand(lease) : undefined;
		await this.options.store.settleObserved(
			id,
			hostRunId,
			minutes,
			this.now(),
			unmet,
			host.completed_at,
			{
				state: lease.state,
				hostRunId: lease.hostRunId,
				runnerId: lease.runnerId,
			},
		);
	}
}
