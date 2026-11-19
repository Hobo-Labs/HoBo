import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
	ACTIVE_STATES,
	type Account,
	effectiveCiAccount,
	type Job,
	JobSchema,
	type Lease,
	LeaseSchema,
	type Offer,
	parseCiPolicy,
	SandboxPricingSchema,
} from "@hobo/ci";
import { pinCiQueueDeadline } from "@hobo/ci/store";
import { z } from "zod";
import { RelayCacheJobSchema } from "../_generated/relay_cache_pb.js";
import {
	type GithubTransport,
	getJob,
	listRunWorkflowJobs,
} from "../github.js";
import { leaseIdFromBoxRunnerName } from "../job-runner-custody.js";
import { servedRunnerLabel } from "../runner-labels.js";
import {
	RELAY_MAX_GENERATION,
	relayJobKey,
	relayLeaseCandidates,
	relayLeaseNames,
} from "./lease-id.js";
import type { RelayCacheStore } from "./store.js";

export type RelayGithubJobView = Readonly<{
	status: string;
	runnerName?: string | null | undefined;
	runnerId?: number | null | undefined;
	createdAt?: string | undefined;
}>;

export interface RelayDiscoveryPort {
	job(job: Job): Promise<RelayGithubJobView | undefined>;
	runner(job: Job, name: string): Promise<{ id: number } | undefined>;
	bridgeRun(job: Job, title: string): Promise<{ id: number } | undefined>;
	sandbox(name: string): Promise<{ sessionId: string } | undefined>;
}

export type RelayEvidence = Readonly<{
	generation: number;
	leaseId: string;
	from: "runner" | "bridge-run" | "sandbox";
	runnerAssigned: boolean;
	runnerId: number;
	hostRunId: number;
	sandboxSessionId: string;
}>;

export type RelayRebuildOutcome =
	| { kind: "present"; leaseId: string }
	| { kind: "adopted"; leaseId: string }
	| { kind: "rebuilt"; leaseId: string; from: RelayEvidence["from"] }
	| { kind: "terminal" }
	| { kind: "pending" }
	| { kind: "foreign" }
	| { kind: "unknown" };

export type RelayResolveOutcome =
	| { kind: "not-uncertain" }
	| { kind: "evidence"; evidence: RelayEvidence[] }
	| { kind: "requeued"; nextGeneration: number }
	| { kind: "unresolved" };

export type RelayRebuildOptions = Readonly<{
	maxGeneration?: number;
}>;

function jobIdentity(job: Job) {
	return {
		repositoryId: job.repositoryId,
		jobId: job.id,
		runAttempt: job.runAttempt,
	};
}

async function gatherEvidence(
	discovery: RelayDiscoveryPort,
	job: Job,
	github: RelayGithubJobView,
	candidates: readonly { generation: number; leaseId: string }[],
): Promise<RelayEvidence[]> {
	const assignedLease = github.runnerName
		? leaseIdFromBoxRunnerName(github.runnerName)
		: undefined;
	const found: RelayEvidence[] = [];
	for (const { generation, leaseId } of candidates) {
		const names = relayLeaseNames(leaseId);
		const runnerAssigned = assignedLease === leaseId;
		const [runner, bridge, sandbox] = await Promise.all([
			runnerAssigned
				? Promise.resolve({ id: github.runnerId ?? 0 })
				: discovery.runner(job, names.runner),
			discovery.bridgeRun(job, names.bridgeRunTitle),
			discovery.sandbox(names.sandbox),
		]);
		if (!runner && !bridge && !sandbox) continue;
		found.push({
			generation,
			leaseId,
			from: sandbox ? "sandbox" : bridge ? "bridge-run" : "runner",
			runnerAssigned,
			runnerId: runner?.id ?? 0,
			hostRunId: bridge?.id ?? 0,
			sandboxSessionId: sandbox?.sessionId ?? "",
		});
	}
	return found.sort(
		(a, b) =>
			Number(b.runnerAssigned) - Number(a.runnerAssigned) ||
			b.generation - a.generation,
	);
}

function conservativeOffer(
	account: Account,
	evidence: RelayEvidence,
	job: Job,
): Offer | undefined {
	const kind = (offer: Offer) =>
		evidence.from === "sandbox"
			? offer.backend === "sandbox"
			: evidence.from === "bridge-run"
				? !offer.backend || offer.backend === "gh-actions"
				: job.isolatedRequired
					? offer.backend === "isolated-container" ||
						offer.backend === "sandbox"
					: true;
	return account.offers
		.filter(kind)
		.sort((a, b) => b.priceMicrosPerMinute - a.priceMicrosPerMinute)[0];
}

export async function rebuildLease(
	store: RelayCacheStore,
	discovery: RelayDiscoveryPort,
	job: Job,
	at: string,
	options: RelayRebuildOptions = {},
): Promise<RelayRebuildOutcome> {
	const access = store.rebuildAccess();
	const identity = jobIdentity(job);
	const key = relayJobKey(identity);
	const record = (await access.readJob(key))?.record;
	if (record?.leaseId && (await store.get(record.leaseId)))
		return { kind: "present", leaseId: record.leaseId };
	const bound = Math.min(
		RELAY_MAX_GENERATION,
		Math.max(options.maxGeneration ?? 3, record?.generation ?? 0),
	);
	const candidates = relayLeaseCandidates(identity, bound);
	const cached = (
		await access.readLeases(candidates.map((entry) => entry.leaseId))
	)
		.filter((slot) => slot !== undefined)
		.sort((a, b) => b.record.generation - a.record.generation);
	const live =
		cached.find((slot) => ACTIVE_STATES.has(slot.lease.state)) ?? cached[0];
	if (live) {
		await access.restoreJob(key, (current) =>
			current?.leaseId === live.lease.id
				? undefined
				: create(RelayCacheJobSchema, {
						jobKey: key,
						state: ACTIVE_STATES.has(live.lease.state) ? "taken" : "idle",
						generation: live.record.generation,
						leaseId: live.lease.id,
						firstSeenAt: current?.firstSeenAt || live.lease.createdAt,
						queueDeadlineAt: live.lease.queueDeadlineAt,
						assigned: current?.assigned,
					}),
		);
		await store.holdInIndex(live.lease);
		return { kind: "adopted", leaseId: live.lease.id };
	}
	const github = await discovery.job(job);
	if (!github) return { kind: "unknown" };
	if (github.status === "completed") {
		await access.restoreJob(key, (current) =>
			current?.state === "terminal"
				? undefined
				: create(RelayCacheJobSchema, {
						jobKey: key,
						state: "terminal",
						generation: current?.generation ?? 0,
						leaseId: current?.leaseId ?? "",
						firstSeenAt: current?.firstSeenAt || github.createdAt || at,
						terminalReason: "completed",
					}),
		);
		return { kind: "terminal" };
	}
	const evidence = await gatherEvidence(discovery, job, github, candidates);
	const chosen = evidence[0];
	if (!chosen) {
		if (github.status === "queued") {
			await access.queue(job, at, github.createdAt);
			return { kind: "pending" };
		}
		return { kind: "foreign" };
	}
	const snapshot = await access.snapshot();
	const config = snapshot.state.configuration;
	const binding = config?.connections.find(
		(entry) =>
			entry.repositoryId === job.repositoryId &&
			entry.installationId === job.installationId &&
			entry.repository.toLowerCase() === job.repository.toLowerCase(),
	);
	const original = config?.accounts.find(
		(entry) => entry.id === binding?.accountId,
	);
	if (!original) return { kind: "foreign" };
	const policy = snapshot.policies.find(
		(entry) => entry.accountId === original.id,
	);
	const account = policy
		? effectiveCiAccount(original, parseCiPolicy(policy.bodyJson))
		: original;
	const offer = conservativeOffer(account, chosen, job);
	const minutes = account.maxRuntimeMinutes + account.startupMinutes;
	const firstSeenAt = github.createdAt ?? at;
	const pinned = pinCiQueueDeadline(job, firstSeenAt, account);
	const names = relayLeaseNames(chosen.leaseId);
	const lease = create(LeaseSchema, {
		id: chosen.leaseId,
		budgetAdmissionAttempt: chosen.generation + 1,
		accountId: account.id,
		offerId: offer?.id ?? "",
		provider: offer?.provider ?? "",
		providerAccountId: offer?.providerAccountId ?? "",
		queueDeadlineAt: pinned.queueDeadlineAt,
		jobId: job.id,
		originalRunId: job.runId,
		runAttempt: job.runAttempt,
		repositoryId: job.repositoryId,
		repository: job.repository,
		installationId: job.installationId,
		jobName: job.name,
		state: "uncertain",
		priceMicrosPerMinute: offer?.priceMicrosPerMinute ?? 0,
		freeValidUntil: offer?.validUntil ?? "",
		sandboxPricing: offer?.sandboxPricing
			? create(SandboxPricingSchema, offer.sandboxPricing)
			: undefined,
		reservedMinutes: minutes,
		reservedPaidMicros: (offer?.priceMicrosPerMinute ?? 0) * minutes,
		runnerName: names.runner,
		hostRunId: chosen.hostRunId,
		actualJobId: chosen.runnerAssigned ? job.id : 0,
		sandboxName: chosen.from === "sandbox" ? names.sandbox : "",
		sandboxSessionId: chosen.sandboxSessionId,
		runnerId: chosen.from === "sandbox" ? chosen.runnerId : 0,
		createdAt: at,
	});
	if (chosen.from === "sandbox" && offer?.sandboxPricing?.proxyVmRequired) {
		lease.proxySandboxName = names.proxySandbox;
		lease.proxySandboxStage = "creating";
	}
	const created = await access.createLease(
		lease,
		chosen.generation,
		chosen.from,
	);
	await access.restoreJob(key, (current) =>
		create(RelayCacheJobSchema, {
			jobKey: key,
			state: "taken",
			generation: chosen.generation,
			leaseId: chosen.leaseId,
			firstSeenAt: current?.firstSeenAt || firstSeenAt,
			queueDeadlineAt: pinned.queueDeadlineAt,
			assigned:
				current?.assigned ??
				(chosen.runnerAssigned && github.status === "in_progress"
					? { leaseId: chosen.leaseId, version: randomUUID() }
					: undefined),
		}),
	);
	return created
		? { kind: "rebuilt", leaseId: chosen.leaseId, from: chosen.from }
		: { kind: "adopted", leaseId: chosen.leaseId };
}

export async function resolveUncertainLease(
	store: RelayCacheStore,
	discovery: RelayDiscoveryPort,
	leaseId: string,
	at: string,
): Promise<RelayResolveOutcome> {
	const lease: Lease | undefined = await store.get(leaseId);
	if (lease?.state !== "uncertain") return { kind: "not-uncertain" };
	const job = create(JobSchema, {
		id: lease.jobId,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		repositoryId: lease.repositoryId,
		installationId: lease.installationId,
		repository: lease.repository,
		action: "queued",
	});
	const github = await discovery.job(job);
	if (!github) return { kind: "unresolved" };
	const record = (
		await store.rebuildAccess().readJob(relayJobKey(jobIdentity(job)))
	)?.record;
	const generation = record?.leaseId === leaseId ? record.generation : 0;
	const evidence = await gatherEvidence(discovery, job, github, [
		{ generation, leaseId },
	]);
	if (evidence.length > 0) return { kind: "evidence", evidence };
	if (github.status !== "queued") return { kind: "unresolved" };
	const access = store.rebuildAccess();
	if (!(await access.cancel(leaseId, ["uncertain"], at)))
		return { kind: "unresolved" };
	await access.queue(job, at, github.createdAt);
	return { kind: "requeued", nextGeneration: generation + 1 };
}

const StatusRunList = z.object({
	workflow_runs: z
		.array(z.object({ id: z.number().int().positive() }))
		.max(100),
});

export type RelayRebuildPassResult = Readonly<{
	accounts: readonly string[];
	marked: readonly string[];
	outcomes: Readonly<Record<string, number>>;
}>;

export async function rebuildInflight(
	store: RelayCacheStore,
	discovery: RelayDiscoveryPort,
	github: GithubTransport,
	at: string,
	options: RelayRebuildOptions = {},
): Promise<RelayRebuildPassResult> {
	const accounts = await store.accountsAwaitingRebuild();
	const outcomes: Record<string, number> = {};
	const marked: string[] = [];
	if (accounts.length === 0) return { accounts, marked, outcomes };
	const config = (await store.rebuildAccess().snapshot()).state.configuration;
	for (const accountId of accounts) {
		let complete = true;
		for (const connection of config?.connections ?? []) {
			if (connection.accountId !== accountId) continue;
			for (const status of ["queued", "in_progress"] as const) {
				let runs: { id: number }[];
				try {
					const response = await github.request(
						connection.installationId,
						`/repos/${connection.repository}/actions/runs?status=${status}&per_page=100`,
					);
					if (!response.ok) {
						complete = false;
						continue;
					}
					runs = StatusRunList.parse(await response.json()).workflow_runs;
				} catch {
					complete = false;
					continue;
				}
				if (runs.length === 100) complete = false;
				for (const run of runs) {
					try {
						for (const found of await listRunWorkflowJobs(
							github,
							connection.installationId,
							connection.repository,
							run.id,
						)) {
							if (found.status !== "queued" && found.status !== "in_progress")
								continue;
							const runner = found.runner_name ?? "";
							if (runner && !leaseIdFromBoxRunnerName(runner)) continue;
							if (!runner && !servedRunnerLabel(found.labels ?? [])) continue;
							const job = create(JobSchema, {
								id: found.id,
								runId: found.run_id,
								runAttempt: found.run_attempt ?? 1,
								repositoryId: connection.repositoryId,
								installationId: connection.installationId,
								repository: connection.repository,
								labels: found.labels ?? [],
								action: found.status,
								runnerName: runner,
								isolatedRequired: connection.isolatedOnly,
							});
							const outcome = await rebuildLease(
								store,
								discovery,
								job,
								at,
								options,
							);
							outcomes[outcome.kind] = (outcomes[outcome.kind] ?? 0) + 1;
						}
					} catch {
						complete = false;
					}
				}
			}
		}
		if (!complete) continue;
		await store.markHoldsKnown(accountId, at);
		marked.push(accountId);
	}
	return { accounts, marked, outcomes };
}

const RunnerList = z.object({
	runners: z.array(
		z.object({ id: z.number().int().positive(), name: z.string() }),
	),
});
const RunList = z.object({
	workflow_runs: z.array(
		z.object({ id: z.number().int().positive(), display_title: z.string() }),
	),
});

export function githubRelayDiscovery(
	github: GithubTransport,
	options: Readonly<{
		bridgeWorkflow: (job: Job) => string | undefined;
		sandbox: (name: string) => Promise<{ sessionId: string } | undefined>;
		maxBridgePages?: number;
	}>,
): RelayDiscoveryPort {
	return {
		async job(job) {
			const view = await getJob(
				github,
				job.installationId,
				job.repository,
				job.id,
			);
			if (
				job.runAttempt &&
				view.run_attempt &&
				view.run_attempt !== job.runAttempt
			)
				return { status: "completed", createdAt: view.created_at };
			return {
				status: view.status,
				runnerName: view.runner_name,
				runnerId: view.runner_id,
				createdAt: view.created_at,
			};
		},
		async runner(job, name) {
			const response = await github.request(
				job.installationId,
				`/repos/${job.repository}/actions/runners?name=${encodeURIComponent(name)}`,
			);
			if (!response.ok)
				throw new Error(`GitHub runner lookup failed (${response.status})`);
			const found = RunnerList.parse(await response.json()).runners.find(
				(runner) => runner.name === name,
			);
			return found ? { id: found.id } : undefined;
		},
		async bridgeRun(job, title) {
			const workflow = options.bridgeWorkflow(job);
			if (!workflow) return undefined;
			for (let page = 1; page <= (options.maxBridgePages ?? 10); page++) {
				const response = await github.request(
					job.installationId,
					`/repos/${job.repository}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100${page === 1 ? "" : `&page=${page}`}`,
				);
				if (!response.ok) throw new Error("host discovery unavailable");
				const runs = RunList.parse(await response.json()).workflow_runs;
				const match = runs.find((run) => run.display_title === title);
				if (match) return { id: match.id };
				if (runs.length < 100) return undefined;
			}
			throw new Error(
				"host discovery window exhausted; operator reconciliation required",
			);
		},
		sandbox: options.sandbox,
	};
}
