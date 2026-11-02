import { createHmac, timingSafeEqual } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	type Configuration,
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
import { verifyIngressForward } from "./ingress-forward.js";
import type { LeaseStore } from "./store.js";

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

export class Relay {
	readonly now: () => string;
	constructor(
		readonly options: {
			config: Configuration;
			store: LeaseStore;
			github: GithubTransport;
			identity: IdentityVerifier;
			webhookSecret: string;
			ingressForwardSecret?: string;
			now?: () => string;
		},
	) {
		if (options.webhookSecret.length < 32)
			throw new Error("webhook secret must have at least 32 characters");
		this.now = options.now ?? (() => new Date().toISOString());
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
		const config =
			this.options.store.configuration()?.configuration ?? this.options.config;
		const account = config.accounts.find(
			(account) => account.id === lease.accountId,
		);
		if (!account) throw new Error("account revoked");
		const desired = this.options.store.controlRecord(`ci-policy:${account.id}`);
		return desired
			? effectiveCiAccount(account, parseCiPolicy(desired.bodyJson))
			: account;
	}
	private trustedOriginal(run: GithubRun, connection: Connection): boolean {
		return (
			run.repository.id === connection.repositoryId &&
			// A shared label can be claimed by any queued job, including a fork PR.
			// The workflow bridge does not isolate the nested runner from host credentials.
			run.repository.private &&
			run.head_repository?.id === connection.repositoryId &&
			connection.allowedEvents.includes(run.event) &&
			connection.allowedRefs.includes(`refs/heads/${run.head_branch}`)
		);
	}
	private trustedHost(
		run: GithubRun,
		connection: Connection,
		lease: Lease,
	): boolean {
		return (
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
		) {
			return this.processWebhook(raw, event);
		}
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
	async processWebhook(raw: Buffer, event: string): Promise<string> {
		if (event === "workflow_run") {
			const parsed = RunWebhook.safeParse(JSON.parse(raw.toString()));
			if (!parsed.success) return "ignored";
			const payload = parsed.data;
			const match = /^HoBo lease ([a-f0-9-]{36})$/.exec(
				payload.workflow_run.display_title,
			);
			if (!match?.[1]) return "ignored";
			const lease = this.options.store.get(match[1]);
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
		const payload = JobWebhook.parse(JSON.parse(raw.toString()));
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
		this.options.store.observe(job, this.now());
		if (
			job.action !== "queued" ||
			job.labels.length !== 1 ||
			job.labels[0]?.toLowerCase() !== "hobo"
		)
			return "ignored";
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
		const admitted = this.connection(
			job.repositoryId,
			job.installationId,
			job.repository,
		);
		if (
			!admitted ||
			!this.trustedOriginal(run, admitted) ||
			(payload.workflow_job.run_attempt !== undefined &&
				run.run_attempt !== payload.workflow_job.run_attempt) ||
			currentJob.status !== "queued" ||
			currentJob.run_id !== job.runId ||
			currentJob.labels.length !== 1 ||
			currentJob.labels[0]?.toLowerCase() !== "hobo"
		)
			return "ignored";
		job.runAttempt = run.run_attempt;
		const account = this.options.config.accounts.find(
			(account) => account.id === admitted.accountId,
		);
		if (!account) throw new Error("account missing");
		this.options.store.queue(job, this.now());
		const lease = this.options.store.reserve(account, job, this.now());
		return lease ? `reserved:${lease.id}` : "waiting-for-budget-or-capacity";
	}
	private queuedDemand(lease: Lease): Job {
		return create(JobSchema, {
			id: lease.jobId,
			runId: lease.originalRunId,
			runAttempt: lease.runAttempt,
			repositoryId: lease.repositoryId,
			repository: lease.repository,
			installationId: lease.installationId,
			labels: ["hobo"],
			action: "queued",
		});
	}
	private launchEligible(lease: Lease): boolean {
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
			this.options.store.all().filter((entry) => entry.id !== lease.id),
			now,
		);
		return (
			repriced !== undefined &&
			repriced.freeMinutes >= lease.reservedFreeMinutes &&
			repriced.paidMicros <= lease.reservedPaidMicros
		);
	}
	/** A reserved host has no external side effect yet, so a cheaper host can
	 * replace it. Already dispatched and uncertain hosts must never be moved. */
	private hasCheaperHost(lease: Lease): boolean {
		const account = this.account(lease);
		const offer = providerOffer(account, lease);
		const others = this.options.store
			.all()
			.filter((entry) => entry.id !== lease.id);
		const now = this.now();
		const current = route({ ...account, offers: [offer] }, others, now);
		const cheapest = route(
			{
				...account,
				offers: account.offers.filter(
					(entry) => !entry.backend || entry.backend === "gh-actions",
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
		for (const job of this.options.store.pendingJobs()) {
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
			this.options.store.reserve(account, job, this.now());
		}
		for (const candidate of this.options.store
			.all()
			.filter((lease) => lease.state === "reserved")) {
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
				const connection = this.binding(candidate);
				const offer = providerOffer(this.account(candidate), candidate);
				if (
					currentJob.status !== "queued" ||
					!this.trustedOriginal(originalRun, connection) ||
					currentJob.labels.length !== 1 ||
					currentJob.labels[0]?.toLowerCase() !== "hobo"
				) {
					this.options.store.transition(
						candidate.id,
						["reserved"],
						(lease) => {
							lease.state = "cancelled";
						},
						"ci.LeaseCancelled",
						this.now(),
					);
					continue;
				}
				if (!this.launchEligible(candidate) || this.hasCheaperHost(candidate)) {
					this.options.store.cancelAndRequeue(
						candidate.id,
						this.queuedDemand(candidate),
						this.now(),
					);
					continue;
				}
				const lease = this.options.store.transition(
					candidate.id,
					["reserved"],
					(lease) => {
						lease.state = "dispatching";
					},
					"ci.DispatchRequested",
					this.now(),
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
					this.options.store.transition(
						lease.id,
						["dispatching"],
						(entry) => {
							entry.state = "dispatched";
						},
						"ci.HostDispatched",
						this.now(),
					);
				} catch {
					this.options.store.transition(
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
		const lease = this.options.store.get(id);
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
		const connection = this.binding(lease);
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
		if (!this.launchEligible(lease) || lease.hostRunId !== 0)
			throw new Error("lease unavailable");
		const claimed = this.options.store.transition(
			id,
			["dispatching", "dispatched", "uncertain"],
			(entry) => {
				if (entry.hostRunId !== 0) throw new Error("lease already claimed");
				entry.hostRunId = runId;
				entry.state = "claiming";
			},
			"ci.RunnerClaimed",
			this.now(),
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
			const committed = this.options.store.transition(
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
			this.options.store.transition(
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
		const lease = this.options.store.get(id);
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
		const lease = this.options.store.get(id);
		if (!lease || lease.state === "completed" || lease.state === "cancelled")
			return;
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
		this.options.store.settle(
			id,
			hostRunId,
			minutes,
			this.now(),
			unmet,
			host.completed_at,
		);
	}
}
