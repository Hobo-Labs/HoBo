import { clone, create } from "@bufbuild/protobuf";
import type { Account, ConfigurationState } from "@hobo/ci";
import {
	type Configuration,
	ConfigurationSchema,
	type Connection,
	compareCiRoutingCandidates,
	effectiveCiAccount,
	type Job,
	JobSchema,
	type Lease,
	parseCiPolicy,
	providerOffer,
	queuedDemandLabels,
	route,
} from "@hobo/ci";
import { z } from "zod";
import {
	type JitBootstrapResponse,
	JitBootstrapResponseSchema,
} from "./_generated/jit_bootstrap_response_pb.js";
import {
	type AdmissionOrder,
	createAdmissionOrder,
	isMainTrunkFleetDeferJob,
	isMainWorkspaceShardJob,
	TRUNK_RANK,
} from "./admission-order.js";
import type { FleetCapacityWitness } from "./fleet-absorb.js";
import { fleetPeerAbsorbSlots, fleetWitnessFields } from "./fleet-absorb.js";
import type {
	FleetCapacityPublisher,
	FleetCapacityPublishInput,
} from "./fleet-capacity.js";
import type { FleetRoutePublisher } from "./fleet-routes.js";
import {
	type GithubRun,
	type GithubTransport,
	getHostJob,
	getJob,
	getRun,
} from "./github.js";
import { heldRoutingOptions } from "./held-routing.js";
import { verifyIngressForward } from "./ingress-forward.js";
import { isIsolatedHostOffer } from "./isolated-backend.js";
import type { createHeadroomTrunkOverflow } from "./isolated-worker/headroom-trunk-overflow.js";
import type { WorkerMemoryAdmission } from "./isolated-worker/memory-admission.js";
import { memoryRequestForStoredJob } from "./isolated-worker/memory-classes.js";
import type { WorkerStorageAdmission } from "./isolated-worker/storage-admission.js";
import type { WorkerStorageReserve } from "./isolated-worker/storage-job-classes.js";
import { deregisterGithubRunner } from "./jit-runner-deregister.js";
import { decideFleetGhostRecovery } from "./jit-runner-fleet-recovery.js";
import { fetchGithubRunnerPresence } from "./jit-runner-presence.js";
import type { JobDurations } from "./job-durations.js";
import {
	type JobPickupMetadataCache,
	jobPickupMetadataKey,
	observeJobPickupMetadata,
} from "./job-pickup.js";
import {
	activeLeaseCoversJob,
	hasOutstandingBoxCustody,
	leaseIdFromBoxRunnerName,
	runnerCustody,
} from "./job-runner-custody.js";
import {
	leaseOccupiesMergeGroupCap,
	leaseOccupiesWorkerMemory,
} from "./lease-resource-occupancy.js";
import { countLiveBoxContainers } from "./live-container-count.js";
import {
	effectiveParallelLaunchSlots,
	logMainShardAdmissionHold,
	type MainShardAdmissionHoldFields,
} from "./main-shard-parallel-admission.js";
import type { OfflineJitJobRecovery } from "./offline-jit-job-recovery.js";
import type { IdentityVerifier } from "./oidc.js";
import {
	type RunnerLabel,
	servedRunnerLabel,
	TRUNK_RUNNER_LABEL,
} from "./runner-labels.js";
import { adoptRunnerAssignment } from "./runner-lease-adoption.js";
import {
	DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS,
	effectiveTrunkFleetDeferMs,
	evaluateMainTrunkFleetDefer,
	type TrunkWaitCache,
	type TrunkWaitReason,
	trunkWaitKey,
} from "./trunk-wait.js";
import {
	DEFAULT_UNLAUNCHED_BACKLOG_MIN_AGE_MS,
	DEFAULT_UNLAUNCHED_RE_RESERVE_COOLDOWN_MS,
	DEFAULT_UNLAUNCHED_RESERVE_MS,
	pickTrunkHeadroomFleetReleases,
	pickUnlaunchedReservationsToRelease,
	rememberTrunkWait,
	unlaunchedJobCoopKey,
	unlaunchedJobCoopKeyFromPending,
} from "./unlaunched-reservation-release.js";
import { verifyWebhookSignature } from "./webhook-signature.js";

/** Isolated executions are supplied by the hosting runtime and must fail closed. */
export interface IsolatedRunnerHost {
	/** `label` is the one runner label the lease's job asked for; the runner registers with it. */
	launch(id: string, label?: RunnerLabel, rank?: number): Promise<void>;
	isLaunchParked?(job: Job): Promise<boolean>;
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
	/**
	 * `githubCreatedAt` is GitHub's `created_at` for the job, when the caller
	 * has it: a store that pins the queue deadline pins it from when GitHub
	 * queued the job, not from when the relay first saw it.
	 */
	queue(
		job: Job,
		at: string,
		expectedRevision?: number,
		githubCreatedAt?: string,
	): Promise<void>;
	expireQueued?(
		job: Job,
		at: string,
		expectedRevision?: number,
	): Promise<boolean>;
	reserve(
		account: Account,
		job: Job,
		at: string,
		expectedRevision?: number,
		githubCreatedAt?: string,
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
	withdrawQueuedJob?(
		job: Job,
		at: string,
		expectedRevision?: number,
		exceptLeaseId?: string,
	): Promise<boolean>;
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
		name: z.string().optional(),
		created_at: z.string().optional(),
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

export type ServedRunnerLabelCache = Map<string, RunnerLabel | undefined>;
export type { TrunkWaitCache } from "./trunk-wait.js";

/** Active leases whose runners GitHub can assign to shared-label jobs. */
export async function generalLeaseIdsFor(
	activeLeases: readonly Lease[],
	github: GithubTransport,
	servedRunnerLabels: ServedRunnerLabelCache,
): Promise<Set<string>> {
	const ids = new Set<string>();
	const activeKeys = new Set(
		activeLeases.map((lease) => `${lease.repository}:${lease.jobId}`),
	);
	for (const key of servedRunnerLabels.keys())
		if (!activeKeys.has(key)) servedRunnerLabels.delete(key);
	for (const lease of activeLeases) {
		const key = `${lease.repository}:${lease.jobId}`;
		let label = servedRunnerLabels.get(key);
		if (!servedRunnerLabels.has(key)) {
			try {
				const currentJob = await getJob(
					github,
					lease.installationId,
					lease.repository,
					lease.jobId,
				);
				label = servedRunnerLabel(currentJob.labels);
				servedRunnerLabels.set(key, label);
			} catch {
				// Unknown labels consume shared capacity; retry the lookup next tick.
				ids.add(lease.id);
				continue;
			}
		}
		if (label !== TRUNK_RUNNER_LABEL) ids.add(lease.id);
	}
	return ids;
}

export class HostedRelay {
	readonly now: () => string;
	private readonly admissionOrder: AdmissionOrder;
	private readonly sharedLabelTrunkJobs: Set<string>;
	private readonly mergeGroupCapWaitJobs: Set<string>;
	private readonly servedRunnerLabels: ServedRunnerLabelCache;
	private readonly trunkWaits: TrunkWaitCache;
	private readonly trunkDeferDecisionSig = new Map<string, string>();
	private shardAdmissionHoldLogged = new Set<string>();
	private readonly unlaunchedReReserveLedger = new Map<
		string,
		Readonly<{
			releasedAtMs: number;
			releaseCount: number;
			lastNonLocalFreeSlots: number;
		}>
	>();
	private dispatchGithubJobCache?: Map<
		string,
		Awaited<ReturnType<typeof getJob>>
	>;
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
			/** Recent job durations; the longest expected job of a run is admitted first. */
			jobDurations?: Pick<JobDurations, "expectedMs">;
			/** Shared across relays so each run is looked up once, not once per relay. */
			admissionOrder?: AdmissionOrder;
			/** Shared across relays so each mislabelled job is logged once. */
			sharedLabelTrunkJobs?: Set<string>;
			/** Shared across relays so each capped merge-group job is logged once. */
			mergeGroupCapWaitJobs?: Set<string>;
			/** Immutable job labels, keyed by repository and job ID, shared across relays. */
			servedRunnerLabels?: ServedRunnerLabelCache;
			/** Shared across relays so a wait survives the next dispatch tick. */
			trunkWaits?: TrunkWaitCache;
			/**
			 * Queue an admitted job without reserving it. For callers that run
			 * `dispatchPending` after a batch, so the batch is reserved in admission
			 * order rather than in the order its deliveries arrived.
			 */
			deferReservation?: boolean;
			/** Maximum active leases for shared-label runners. Unset: no cap. */
			generalLeaseLimit?: number;
			/** Maximum distinct merge groups with active leases. Unset: no cap. */
			mergeGroupLeaseLimit?: number;
			jobPickupMetadata?: JobPickupMetadataCache;
			/** Let shared-label runs exceed the limit until a trunk-label job waits. */
			lendTrunkSlots?: boolean;
			/** Local trunk reservations this box may hold; defers extra shards when mesh has room. */
			trunkSlots?: number;
			memoryAdmission?: WorkerMemoryAdmission;
			storageAdmission?: WorkerStorageAdmission;
			/** Per-job byte/inode reservation for storage admission (learned + class budget). */
			storageJobReserve?: (jobName: string) => WorkerStorageReserve;
			/**
			 * Publishes the fleet route table after each dispatch pass. Unset: the
			 * relay balances nothing ahead of the queue and every job stays on its
			 * hobo label.
			 */
			fleetRoutes?: Pick<FleetRoutePublisher, "publish">;
			headroomTrunkOverflow?: ReturnType<typeof createHeadroomTrunkOverflow>;
			/** Trunk headroom/storage waits before cooperative fleet defer (default 45s). */
			headroomFleetDeferMs?: number;
			fleetCapacity?: Readonly<{
				publish: FleetCapacityPublisher["publish"];
				snapshot: () => Promise<
					FleetCapacityWitness & { hoboFreeSlots: number }
				>;
			}>;
			/** Shared witness reruns for jobs bound to offline peer box JIT runners. */
			offlineJitRecovery?: OfflineJitJobRecovery;
			unlaunchedReservationRelease?: Readonly<{
				boundMs?: number;
				backlogMinAgeMs?: number;
				reReserveCooldownMs?: number;
				launchSlots: number;
				backlogImmediate?: boolean;
			}>;
			/** OS headroom parallel cap for launch/backlog (defaults to launchSlots). */
			parallelLaunchCapacity?: () => number;
			now?: () => string;
		},
	) {
		if (options.webhookSecret.length < 32)
			throw new Error("webhook secret must have at least 32 characters");
		this.now = options.now ?? (() => new Date().toISOString());
		this.admissionOrder =
			options.admissionOrder ??
			createAdmissionOrder(options.github, options.jobDurations);
		this.sharedLabelTrunkJobs = options.sharedLabelTrunkJobs ?? new Set();
		this.mergeGroupCapWaitJobs = options.mergeGroupCapWaitJobs ?? new Set();
		this.servedRunnerLabels = options.servedRunnerLabels ?? new Map();
		this.trunkWaits = options.trunkWaits ?? new Map();
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
		if (
			verifyWebhookSignature(this.options.webhookSecret, raw, signature) !==
			"valid"
		)
			throw new Error("invalid webhook signature");
		return this.processWebhook(raw, event);
	}
	/**
	 * Another fleet runner on the shared `hobo` label holds this job; release this
	 * worker's leases and pending demand without requeueing (mesh cooperation).
	 */
	private githubJobCacheKey(
		installationId: number,
		repository: string,
		jobId: number,
	): string {
		return `${installationId}:${repository}:${jobId}`;
	}

	private async cachedGithubJob(
		installationId: number,
		repository: string,
		jobId: number,
	): Promise<Awaited<ReturnType<typeof getJob>>> {
		const key = this.githubJobCacheKey(installationId, repository, jobId);
		let cache = this.dispatchGithubJobCache;
		if (!cache) {
			cache = new Map();
			this.dispatchGithubJobCache = cache;
		}
		const hit = cache.get(key);
		if (hit) return hit;
		const bound = await getJob(
			this.options.github,
			installationId,
			repository,
			jobId,
		);
		cache.set(key, bound);
		return bound;
	}

	private localTrunkReservationCount(
		active: readonly Lease[],
		memoryTrunk?: ReadonlySet<string>,
	): number {
		if (memoryTrunk) return memoryTrunk.size;
		let count = 0;
		for (const lease of active) {
			const label = this.servedRunnerLabels.get(
				`${lease.repository}:${lease.jobId}`,
			);
			if (label !== TRUNK_RUNNER_LABEL) continue;
			if (
				lease.state === "reserved" ||
				lease.state === "dispatching" ||
				lease.state === "running"
			)
				count += 1;
		}
		return count;
	}

	private reReserveCooldownBlocks(
		job: Pick<Job, "installationId" | "repository" | "id" | "runAttempt">,
		nonLocalFreeSlots: number | undefined,
	): boolean {
		const policy = this.options.unlaunchedReservationRelease;
		const cooldownMs =
			policy?.reReserveCooldownMs ?? DEFAULT_UNLAUNCHED_RE_RESERVE_COOLDOWN_MS;
		const key = unlaunchedJobCoopKeyFromPending(job);
		const ledger = this.unlaunchedReReserveLedger.get(key);
		if (!ledger) return false;
		const nowMs = Date.parse(this.now());
		const headroomImproved =
			nonLocalFreeSlots !== undefined &&
			nonLocalFreeSlots > ledger.lastNonLocalFreeSlots;
		if (headroomImproved) return false;
		return nowMs - ledger.releasedAtMs < cooldownMs;
	}

	private recordUnlaunchedRelease(
		lease: Pick<
			Lease,
			"installationId" | "repository" | "jobId" | "runAttempt"
		>,
		nonLocalFreeSlots: number | undefined,
	): number {
		const key = unlaunchedJobCoopKey(lease);
		const nowMs = Date.parse(this.now());
		const prior = this.unlaunchedReReserveLedger.get(key);
		const releaseCount = (prior?.releaseCount ?? 0) + 1;
		this.unlaunchedReReserveLedger.set(key, {
			releasedAtMs: nowMs,
			releaseCount,
			lastNonLocalFreeSlots: nonLocalFreeSlots ?? 0,
		});
		return releaseCount;
	}

	private headroomFleetDeferMs(): number {
		const configured = this.options.headroomFleetDeferMs;
		if (configured === undefined) return DEFAULT_TRUNK_HEADROOM_FLEET_DEFER_MS;
		if (!Number.isInteger(configured) || configured < 1_000) {
			throw new Error("invalid headroom fleet defer ms");
		}
		return configured;
	}

	private logTrunkFleetDeferDecision(
		job: Pick<Job, "repository" | "runId" | "id" | "name" | "runAttempt">,
		decision: ReturnType<typeof evaluateMainTrunkFleetDefer>,
	): void {
		const signature = [
			decision.action,
			decision.holdReason ?? "",
			decision.waitReason ?? "",
			decision.peerAbsorbSlots,
			decision.waitedMs,
			decision.deferMs ?? "",
			decision.shardIndex ?? "",
		].join(":");
		const key = trunkWaitKey(job);
		if (this.trunkDeferDecisionSig.get(key) === signature) return;
		this.trunkDeferDecisionSig.set(key, signature);
		const coreLog = {
			event: "hobo_ci_trunk_fleet_defer_decision" as const,
			repository: job.repository,
			runId: job.runId,
			jobId: job.id,
			jobName: job.name,
			action: decision.action,
			waitReason: decision.waitReason ?? "",
			waitedMs: decision.waitedMs,
			holdReason: decision.holdReason ?? "",
			deferMs: decision.deferMs,
			shardIndex: decision.shardIndex,
			arcFreeSlots: decision.arcFreeSlots,
			meshFreeSlots: decision.meshFreeSlots,
			peerAbsorbSlots: decision.peerAbsorbSlots,
		};
		if (decision.hoboFreeSlots !== undefined) {
			console.error(
				JSON.stringify({ ...coreLog, hoboFreeSlots: decision.hoboFreeSlots }),
			);
			return;
		}
		console.error(JSON.stringify(coreLog));
	}

	private fleetPeerSlots(
		fleetWitness: FleetCapacityWitness | undefined,
	): number {
		return fleetPeerAbsorbSlots(fleetWitness);
	}

	/** Drop reservations that never reached dispatch so fleet runners can absorb custody. */
	private async releaseBlockedUnlaunchedReservations(
		pendingDemand: number,
		fleetWitness: FleetCapacityWitness | undefined,
	): Promise<void> {
		const policy = this.options.unlaunchedReservationRelease;
		if (!policy || policy.launchSlots <= 0) return;
		const active = await this.options.store.activeLeases();
		const nowMs = Date.parse(this.now());
		const boundMs = policy.boundMs ?? DEFAULT_UNLAUNCHED_RESERVE_MS;
		const liveContainerCount = countLiveBoxContainers(active);
		const effectiveLaunchSlots = effectiveParallelLaunchSlots(
			policy.launchSlots,
			liveContainerCount,
			this.options.parallelLaunchCapacity?.(),
		);
		const releaseBase = {
			boundMs,
			backlogMinAgeMs:
				policy.backlogMinAgeMs ?? DEFAULT_UNLAUNCHED_BACKLOG_MIN_AGE_MS,
			pendingDemand,
			unlaunchedCount: active.filter(
				(lease) =>
					lease.state === "reserved" &&
					!lease.sandboxName &&
					lease.runnerId === 0,
			).length,
			launchSlots: effectiveLaunchSlots,
			liveContainerCount,
			backlogImmediate: policy.backlogImmediate ?? true,
		};
		const releaseContext = fleetWitness
			? { ...releaseBase, fleetWitness }
			: releaseBase;
		const releases = pickUnlaunchedReservationsToRelease(
			active,
			nowMs,
			releaseContext,
		);
		const peerSlots = this.fleetPeerSlots(fleetWitness);
		for (const release of releases) {
			const lease = active.find((entry) => entry.id === release.leaseId);
			if (!lease) continue;
			const releaseCount = this.recordUnlaunchedRelease(lease, peerSlots);
			await this.options.store.cancelAndRequeue(
				lease.id,
				this.queuedDemand(lease),
				this.now(),
			);
			console.error(
				JSON.stringify({
					event: "hobo_ci_unlaunched_reservation_released",
					repository: lease.repository,
					runId: lease.originalRunId,
					jobId: lease.jobId,
					leaseId: lease.id,
					reason: release.reason,
					ageMs: nowMs - Date.parse(lease.createdAt),
					pendingDemand,
					nonLocalFreeSlots: peerSlots,
					releaseCount,
				}),
			);
		}
	}

	private async releaseTrunkHeadroomFleetReservations(
		active: readonly Lease[],
		fleetWitness: FleetCapacityWitness | undefined,
	): Promise<void> {
		const baseDeferMs = this.headroomFleetDeferMs();
		const peerSlots = this.fleetPeerSlots(fleetWitness);
		const deferMs = effectiveTrunkFleetDeferMs(baseDeferMs, peerSlots);
		const nowMs = Date.parse(this.now());
		const releases = pickTrunkHeadroomFleetReleases(
			this.trunkWaits,
			active,
			nowMs,
			fleetWitness ? { deferMs, fleetWitness } : { deferMs },
		);
		for (const release of releases) {
			const lease = active.find((entry) => entry.id === release.leaseId);
			if (!lease) continue;
			if (
				this.reReserveCooldownBlocks(
					{
						installationId: lease.installationId,
						repository: lease.repository,
						id: lease.jobId,
						runAttempt: lease.runAttempt,
					},
					peerSlots,
				)
			)
				continue;
			const releaseCount = this.recordUnlaunchedRelease(lease, peerSlots);
			await this.options.store.cancelAndRequeue(
				lease.id,
				this.queuedDemand(lease),
				this.now(),
			);
			this.trunkWaits.delete(release.waitKey);
			console.error(
				JSON.stringify({
					event: "hobo_ci_trunk_headroom_fleet_defer",
					repository: lease.repository,
					runId: lease.originalRunId,
					jobId: lease.jobId,
					leaseId: lease.id,
					reason: release.reason,
					waitedMs: release.waitedMs,
					nonLocalFreeSlots: peerSlots,
					hoboFreeSlots: fleetWitness?.hoboFreeSlots ?? -1,
					arcFreeSlots: fleetWitness?.arcFreeSlots ?? -1,
					meshFreeSlots: fleetWitness?.meshFreeSlots ?? -1,
					releaseCount,
				}),
			);
		}
	}

	/** Peer or local ghost box JIT: deregister offline runners so GitHub can re-offer work. */
	private async releaseFleetGhostBinding(
		job: Job,
		active: readonly Lease[],
		installationId: number,
		localAccountId: string | undefined,
		mode: "reserve" | "observe",
	): Promise<boolean> {
		try {
			const bound = await this.cachedGithubJob(
				installationId,
				job.repository,
				job.id,
			);
			const runnerId = bound.runner_id ?? 0;
			const leaseId = leaseIdFromBoxRunnerName(bound.runner_name ?? "");
			const shared = leaseId
				? await this.options.store.get(leaseId)
				: undefined;
			const sharedHint = shared
				? {
						id: shared.id,
						state: shared.state,
						accountId: shared.accountId,
					}
				: undefined;
			const presence =
				Number.isInteger(runnerId) && runnerId > 0
					? await fetchGithubRunnerPresence(
							this.options.github,
							installationId,
							job.repository,
							runnerId,
						)
					: undefined;
			const decision = decideFleetGhostRecovery(
				job,
				bound,
				active,
				sharedHint,
				presence,
				localAccountId,
			);
			if (decision.kind === "none") return false;
			if (decision.kind === "covered") {
				if (mode === "reserve") {
					console.error(
						JSON.stringify({
							event: "hobo_ci_job_reserve_duplicate_skipped",
							repository: job.repository,
							runId: job.runId,
							jobId: job.id,
							leaseId: decision.leaseId,
						}),
					);
					return true;
				}
				return false;
			}
			if (decision.kind === "defer") {
				console.error(
					JSON.stringify({
						event: "hobo_ci_fleet_ghost_defer",
						repository: job.repository,
						runId: job.runId,
						jobId: job.id,
						leaseId: decision.leaseId,
						reason: decision.reason,
						runnerPresence: presence?.status ?? "unknown",
					}),
				);
				return true;
			}
			const outcome = await deregisterGithubRunner(
				this.options.github,
				installationId,
				job.repository,
				decision.runnerId,
			);
			console.error(
				JSON.stringify({
					event: "hobo_ci_jit_runner_ghost_binding_cleared",
					repository: job.repository,
					runId: job.runId,
					jobId: job.id,
					runnerName: decision.runnerName,
					runnerId: decision.runnerId,
					leaseId: decision.leaseId,
					recoveryRole: decision.role,
					runnerPresence: "offline",
					outcome,
				}),
			);
			this.options.offlineJitRecovery?.register({
				repository: job.repository,
				installationId,
				runId: bound.run_id,
				jobId: job.id,
				runnerName: decision.runnerName,
				leaseId: decision.leaseId,
				recoveryRole: decision.role,
				registeredAtMs: Date.parse(this.now()),
			});
			return true;
		} catch {
			return false;
		}
	}

	private async yieldForeignRunnerCustody(
		job: Job,
		expectedRevision: number,
	): Promise<void> {
		const at = this.now();
		const active = await this.options.store.activeLeases();
		let retainedLeaseId: string | undefined;
		for (const lease of active) {
			if (
				!activeLeaseCoversJob(lease, job.repositoryId, job.id, job.runAttempt)
			)
				continue;
			if (lease.runnerName) {
				const custody = await adoptRunnerAssignment(
					this.options.store,
					this.options.github,
					lease,
					at,
				);
				if (custody.holdsActive && custody.assignment) {
					retainedLeaseId = lease.id;
					continue;
				}
			}
			await this.options.isolatedHost?.reconcile(lease.id, true);
			await this.options.store.transition(
				lease.id,
				[
					"reserved",
					"dispatching",
					"claiming",
					"dispatched",
					"running",
					"uncertain",
				],
				(entry) => {
					entry.state = "cancelled";
				},
				"ci.LeaseCancelled",
				at,
				expectedRevision,
			);
		}
		await this.options.store.withdrawQueuedJob?.(
			job,
			at,
			expectedRevision,
			retainedLeaseId,
		);
	}

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
			name: payload.workflow_job.name ?? "",
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
		job.name = currentJob.name ?? job.name;
		const custody = runnerCustody(currentJob.runner_name);
		if (
			custody === "foreign" &&
			(currentJob.status === "queued" || currentJob.status === "in_progress")
		) {
			await this.yieldForeignRunnerCustody(job, admittedRevision);
			return "foreign-runner";
		}
		if (custody === "box" && currentJob.status === "in_progress") {
			const active = await this.options.store.activeLeases();
			if (
				await this.releaseFleetGhostBinding(
					job,
					active,
					job.installationId,
					admitted?.accountId,
					"observe",
				)
			)
				return "fleet-ghost-peer";
		}
		if (custody === "box" && job.action === "queued") {
			const expectedLeaseId = leaseIdFromBoxRunnerName(
				currentJob.runner_name?.trim() ?? "",
			);
			const leases = await this.options.store.activeLeases();
			if (
				leases.some(
					(lease) =>
						activeLeaseCoversJob(
							lease,
							job.repositoryId,
							job.id,
							job.runAttempt,
						) &&
						(!expectedLeaseId ||
							lease.id === expectedLeaseId ||
							lease.runnerName === currentJob.runner_name?.trim()),
				)
			) {
				return "duplicate";
			}
		}
		if (this.options.jobPickupMetadata)
			observeJobPickupMetadata(this.options.jobPickupMetadata, {
				repositoryId: job.repositoryId,
				id: job.id,
				runAttempt: job.runAttempt,
				event: run.event,
				jobCreatedAt: currentJob.created_at ?? payload.workflow_job.created_at,
			});
		if (this.options.memoryAdmission) {
			const memory = memoryRequestForStoredJob(
				job,
				this.options.memoryAdmission.config,
			);
			job.memoryClass = memory.memoryClass;
			job.memoryMb = memory.memoryMb;
		}
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
			!servedRunnerLabel(currentJob.labels)
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
		const githubCreatedAt =
			currentJob.created_at ?? payload.workflow_job.created_at;
		await this.options.store.queue(
			job,
			this.now(),
			admittedRevision,
			githubCreatedAt,
		);
		if (this.options.deferReservation) return "queued";
		const lease = await this.options.store.reserve(
			account,
			job,
			this.now(),
			admittedRevision,
			githubCreatedAt,
		);
		if (lease)
			this.servedRunnerLabels.set(
				`${job.repository}:${job.id}`,
				servedRunnerLabel(job.labels),
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
			name: lease.jobName,
			memoryClass: lease.memoryClass,
			memoryMb: lease.memoryMb,
			labels: queuedDemandLabels(lease.provider, offer.backend, offer.runsOn, [
				"hobo",
			]),
			action: "queued",
			isolatedRequired: isIsolatedHostOffer(offer),
			queueDeadlineAt: lease.queueDeadlineAt,
		});
	}
	private async launchEligible(lease: Lease): Promise<boolean> {
		const account = this.account(lease);
		const offer = providerOffer(account, lease);
		const now = this.now();
		const bound = Date.parse(now) + lease.reservedMinutes * 60000;
		if (
			this.queueExpired(lease.queueDeadlineAt) ||
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
			{
				...account,
				offers: account.offers.map((entry) => ({
					...entry,
					enabled: entry.enabled && entry.id === offer.id,
				})),
			},
			(await this.options.store.accountLeases(account.id)).filter(
				(entry) => entry.id !== lease.id,
			),
			now,
			heldRoutingOptions(account, lease, now),
		);
		return (
			repriced !== undefined &&
			repriced.freeMinutes >= lease.reservedFreeMinutes &&
			repriced.paidMicros <= lease.reservedPaidMicros
		);
	}
	private queueExpired(deadline: string): boolean {
		return (
			deadline !== "" &&
			(!Number.isFinite(Date.parse(deadline)) ||
				Date.parse(deadline) <= Date.parse(this.now()))
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
		const options = heldRoutingOptions(account, lease, now);
		const current = route(
			{
				...account,
				offers: account.offers.map((entry) => ({
					...entry,
					enabled: entry.enabled && entry.id === offer.id,
				})),
			},
			others,
			now,
			options,
		);
		const cheapest = route(
			{
				...account,
				offers: account.offers.map((entry) => ({
					...entry,
					enabled:
						entry.enabled &&
						(isIsolatedHostOffer(offer)
							? isIsolatedHostOffer(entry)
							: !entry.backend || entry.backend === "gh-actions"),
				})),
			},
			others,
			now,
			options,
		);
		if (!current || !cheapest) return false;
		// A refreshed allocation for the same offer is not reflected in the
		// existing reservation. Requeue it so the new free balance is reserved.
		if (current.freeMinutes > lease.reservedFreeMinutes) return true;
		return (
			compareCiRoutingCandidates(cheapest, current, account.routingStrategy) < 0
		);
	}
	private async logSharedLabelTrunkJob(job: Job): Promise<void> {
		const key = `${job.repositoryId}:${job.runId}:${job.id}:${job.runAttempt}`;
		if (this.sharedLabelTrunkJobs.has(key)) return;
		try {
			const run = await getRun(
				this.options.github,
				job.installationId,
				job.repository,
				job.runId,
			);
			this.sharedLabelTrunkJobs.add(key);
			console.error(
				JSON.stringify({
					event: "hobo_ci_trunk_job_on_shared_label",
					repository: job.repository,
					workflow: run.path,
					runId: job.runId,
					jobId: job.id,
				}),
			);
		} catch {
			/* Logging must not change admission; retry the lookup next tick. */
		}
	}
	private async generalLeaseIds(): Promise<Set<string>> {
		return generalLeaseIdsFor(
			await this.options.store.activeLeases(),
			this.options.github,
			this.servedRunnerLabels,
		);
	}
	private async trunkLeaseIds(active: readonly Lease[]): Promise<Set<string>> {
		const ids = new Set<string>();
		for (const lease of active) {
			const label = this.servedRunnerLabels.get(
				`${lease.repository}:${lease.jobId}`,
			);
			const ref = {
				installationId: lease.installationId,
				repository: lease.repository,
				runId: lease.originalRunId,
				jobId: lease.jobId,
			};
			const rank = await this.admissionOrder.rank(
				label ? { ...ref, labels: [label] } : ref,
			);
			if (rank === TRUNK_RANK) ids.add(lease.id);
		}
		return ids;
	}
	/** A runner reassigned by GitHub no longer satisfies its original queued job. */
	private async requeueSwappedJobs(
		expectedRevision: number,
		active: readonly Lease[],
		pending: Job[],
	): Promise<void> {
		const keyOf = (repositoryId: number, jobId: number, runAttempt: number) =>
			`${repositoryId}:${jobId}:${runAttempt}`;
		const pendingKeys = new Set(
			pending.map((job) => keyOf(job.repositoryId, job.id, job.runAttempt)),
		);
		const replacedKeys = new Set(
			active
				.filter(
					(lease) =>
						lease.actualJobId === 0 || lease.actualJobId === lease.jobId,
				)
				.map((lease) =>
					keyOf(lease.repositoryId, lease.jobId, lease.runAttempt),
				),
		);
		const idleRunnerExists = async (label: RunnerLabel) => {
			for (const candidate of active) {
				if (
					candidate.state !== "running" ||
					candidate.actualJobId !== 0 ||
					candidate.runnerId === 0
				)
					continue;
				try {
					const response = await this.options.github.request(
						candidate.installationId,
						`/repos/${candidate.repository}/actions/runners/${candidate.runnerId}`,
					);
					if (!response.ok) continue;
					const runner = z
						.object({
							busy: z.boolean(),
							labels: z.array(z.object({ name: z.string() })),
						})
						.parse(await response.json());
					if (
						!runner.busy &&
						runner.labels.some((runnerLabel) => runnerLabel.name === label)
					)
						return true;
				} catch {}
			}
			return false;
		};
		for (const lease of active) {
			if (lease.actualJobId === 0 || lease.actualJobId === lease.jobId)
				continue;
			const key = keyOf(lease.repositoryId, lease.jobId, lease.runAttempt);
			// Requeued or replaced demand must not cost a GitHub read on every tick.
			if (pendingKeys.has(key) || replacedKeys.has(key)) continue;
			try {
				const current = await getJob(
					this.options.github,
					lease.installationId,
					lease.repository,
					lease.jobId,
				);
				if (
					current.status !== "queued" ||
					current.run_id !== lease.originalRunId ||
					current.run_attempt !== lease.runAttempt
				)
					continue;
				const label = servedRunnerLabel(current.labels);
				if (label && (await idleRunnerExists(label))) continue;
				const demand = this.queuedDemand(lease);
				demand.labels = current.labels;
				await this.options.store.queue(demand, this.now(), expectedRevision);
				pending.push(demand);
				pendingKeys.add(key);
			} catch {
				/* An ambiguous original-job read must not block other demand. */
			}
		}
	}
	/** Reclaim one newest reservation that has no container, runner or host run. */
	private async reclaimUnlaunchedGeneralLease(): Promise<boolean> {
		const active = await this.options.store.activeLeases();
		const general = await this.generalLeaseIds();
		const lease = active
			.filter(
				(lease) =>
					lease.state === "reserved" &&
					!lease.sandboxName &&
					!lease.sandboxSessionId &&
					lease.runnerId === 0 &&
					lease.hostRunId === 0 &&
					general.has(lease.id),
			)
			.sort(
				(a, b) =>
					b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
			)[0];
		if (!lease) return false;
		await this.options.store.cancelAndRequeue(
			lease.id,
			this.queuedDemand(lease),
			this.now(),
		);
		return true;
	}
	private reportTrunkWait(
		job: Job,
		reason: TrunkWaitReason,
		fields: MainShardAdmissionHoldFields = {},
	): string {
		const key = trunkWaitKey(job);
		const nowMs = Date.parse(this.now());
		const wait = rememberTrunkWait(this.trunkWaits, job, reason, nowMs);
		const waitedMs = nowMs - wait.sinceMs;
		if (isMainWorkspaceShardJob(job.name)) {
			if (!this.shardAdmissionHoldLogged.has(key)) {
				this.shardAdmissionHoldLogged.add(key);
				logMainShardAdmissionHold(job, reason, {
					waitedMs,
					...fields,
				});
			}
		}
		if (waitedMs > 10_000 && !wait.logged) {
			this.trunkWaits.set(key, { ...wait, logged: true });
			console.error(
				JSON.stringify({
					event: "hobo_ci_trunk_wait",
					reason,
					waitedMs,
					repository: job.repository,
					runId: job.runId,
					jobId: job.id,
				}),
			);
		}
		return key;
	}
	/** Durable outbox drain. A launch intent is committed before network I/O. */
	async dispatchPending(): Promise<number> {
		this.dispatchGithubJobCache = new Map();
		this.shardAdmissionHoldLogged.clear();
		const reservationRevision = await this.refreshConfig();
		const queued = await this.options.store.pendingJobs();
		let fleetWitness: FleetCapacityWitness | undefined;
		try {
			fleetWitness = await this.options.fleetCapacity?.snapshot();
		} catch {
			fleetWitness = undefined;
		}
		const fleetPeerSlots = this.fleetPeerSlots(fleetWitness);
		// Both the reservation (offer concurrency) and the launch (host slots) hand
		// out capacity in this order, so a freed slot goes to the queue's head.
		const refOf = (job: Job) => ({
			installationId: job.installationId,
			repository: job.repository,
			runId: job.runId,
			jobId: job.id,
			labels: job.labels,
			jobName: job.name,
		});
		const active = await this.options.store.activeLeases();
		const memoryActive = active.filter((lease) =>
			leaseOccupiesWorkerMemory(lease),
		);
		const memoryGeneral = this.options.memoryAdmission
			? await this.generalLeaseIds()
			: undefined;
		const memoryTrunk = this.options.memoryAdmission
			? await this.trunkLeaseIds(active)
			: undefined;
		const memoryBlockedRanks = new Set<number>();
		await this.requeueSwappedJobs(reservationRevision, active, queued);
		const pending = await this.admissionOrder(queued, refOf);
		const limit = this.options.generalLeaseLimit;
		const mergeGroupLimit = this.options.mergeGroupLeaseLimit;
		const activeMergeGroups = new Set<string>();
		if (mergeGroupLimit !== undefined)
			for (const lease of active) {
				if (!leaseOccupiesMergeGroupCap(lease)) continue;
				const groupKey = await this.admissionOrder.mergeGroupKeyForLease(lease);
				if (groupKey !== undefined) activeMergeGroups.add(groupKey);
			}
		let general: Set<string> | undefined;
		// Strict reservation always caps shared-label leases; lending applies the cap
		// only after trunk-label demand misses a lease. Both free capacity in this pass.
		let trunkWaiting = false;
		let rankZeroWaiting = false;
		let storageRefused = false;
		const waitingTrunk = new Set<string>();
		let localTrunkReserved = this.localTrunkReservationCount(
			active,
			memoryTrunk,
		);
		for (const job of pending) {
			if (this.queueExpired(job.queueDeadlineAt)) {
				await this.options.store.expireQueued?.(
					job,
					this.now(),
					reservationRevision,
				);
				continue;
			}
			if ((await this.options.isolatedHost?.isLaunchParked?.(job)) === true)
				continue;
			if (
				active.some((lease) =>
					hasOutstandingBoxCustody(
						lease,
						job.repositoryId,
						job.id,
						job.runAttempt,
					),
				)
			)
				continue;
			if (this.reReserveCooldownBlocks(job, fleetPeerSlots)) continue;
			const rank = await this.admissionOrder.rank(refOf(job));
			const trunk = servedRunnerLabel(job.labels) === TRUNK_RUNNER_LABEL;
			if (!trunk && rank === TRUNK_RANK) await this.logSharedLabelTrunkJob(job);
			if (rank > TRUNK_RANK && rankZeroWaiting) continue;
			if (memoryBlockedRanks.has(rank)) continue;
			const mergeGroupKey =
				mergeGroupLimit === undefined
					? undefined
					: await this.admissionOrder.mergeGroupKey(refOf(job));
			if (
				mergeGroupLimit !== undefined &&
				mergeGroupKey !== undefined &&
				!activeMergeGroups.has(mergeGroupKey) &&
				activeMergeGroups.size >= mergeGroupLimit
			) {
				if (rank === TRUNK_RANK) rankZeroWaiting = true;
				const key = `${job.repositoryId}:${job.runId}:${job.id}:${job.runAttempt}`;
				if (!this.mergeGroupCapWaitJobs.has(key)) {
					this.mergeGroupCapWaitJobs.add(key);
					console.error(
						JSON.stringify({
							event: "hobo_ci_merge_group_cap_wait",
							repository: job.repository,
							runId: job.runId,
							jobId: job.id,
							groupKey: mergeGroupKey,
							limit: mergeGroupLimit,
						}),
					);
				}
				continue;
			}
			if (
				!trunk &&
				(this.options.lendTrunkSlots !== true || trunkWaiting) &&
				limit !== undefined
			) {
				general ??= await this.generalLeaseIds();
				if (general.size >= limit) continue;
			}
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
			if (
				await this.releaseFleetGhostBinding(
					job,
					active,
					connection.installationId,
					account.id,
					"reserve",
				)
			)
				continue;
			const nowMs = Date.parse(this.now());
			const priorWait = this.trunkWaits.get(trunkWaitKey(job));
			const headroomFleetDeferMs = this.headroomFleetDeferMs();
			const runEvent = await this.admissionOrder.event(refOf(job));
			const mainTrunk = isMainTrunkFleetDeferJob(job.name, runEvent);
			const fleetDeferDecision = evaluateMainTrunkFleetDefer({
				jobName: job.name,
				isMainTrunkJob: mainTrunk,
				priorWait,
				deferMs: headroomFleetDeferMs,
				nowMs,
				trunkSlots: this.options.trunkSlots,
				localTrunkReserved,
				fleetWitness,
			});
			if (mainTrunk || priorWait !== undefined) {
				this.logTrunkFleetDeferDecision(job, fleetDeferDecision);
			}
			if (fleetDeferDecision.action === "defer") {
				waitingTrunk.add(
					this.reportTrunkWait(job, "fleet-capacity", {
						action: "defer",
						holdReason: fleetDeferDecision.holdReason ?? "",
						localTrunkReserved,
						trunkSlots: this.options.trunkSlots ?? 0,
					}),
				);
				continue;
			}
			// A policy can become stricter while demand is queued. Never reserve a
			// bridge from a pending job admitted under the previous connection.
			if (connection.isolatedOnly) job.isolatedRequired = true;
			const storageAdmission = this.options.storageAdmission;
			const storageJobId = String(job.id);
			if (storageAdmission) {
				if (storageRefused) {
					if (trunk) waitingTrunk.add(this.reportTrunkWait(job, "storage"));
					continue;
				}
				const storageLeases = await this.options.store.activeLeases();
				const reserve = this.options.storageJobReserve?.(job.name) ?? undefined;
				const admitted = await storageAdmission.admit(
					storageLeases.map((lease) => ({
						id: lease.id,
						sandboxName: lease.sandboxName,
						jobId: String(lease.jobId),
					})),
					storageJobId,
					reserve,
				);
				if (!admitted) {
					storageRefused = true;
					rankZeroWaiting ||= rank === TRUNK_RANK;
					trunkWaiting ||= trunk;
					if (trunk) waitingTrunk.add(this.reportTrunkWait(job, "storage"));
					continue;
				}
			}
			let lease: Lease | undefined;
			try {
				const memoryAdmission = this.options.memoryAdmission;
				if (memoryAdmission && memoryGeneral && memoryTrunk) {
					const memory = memoryRequestForStoredJob(job, memoryAdmission.config);
					job.memoryClass = memory.memoryClass;
					job.memoryMb = memory.memoryMb;
					const decision = memoryAdmission.admit({
						jobId: job.id,
						...memory,
						rank,
						activeLeases: memoryActive,
						generalLeaseIds: memoryGeneral,
						trunkLeaseIds: memoryTrunk,
					});
					if (!decision.admitted) {
						if (decision.blockRank) {
							if (rank === TRUNK_RANK) rankZeroWaiting = true;
							else memoryBlockedRanks.add(rank);
						}
						if (trunk && decision.reason) {
							const waitReason: TrunkWaitReason =
								decision.reason === "host-pressure" ||
								decision.reason === "cpu-contention"
									? decision.reason
									: decision.reason;
							if (
								mainTrunk &&
								decision.reason === "cpu-contention" &&
								this.fleetPeerSlots(fleetWitness) > 0
							) {
								const waitedMs = priorWait
									? Math.max(0, nowMs - priorWait.sinceMs)
									: 0;
								this.logTrunkFleetDeferDecision(job, {
									action: "defer",
									waitedMs,
									waitReason: "cpu-contention",
									...fleetWitnessFields(fleetWitness),
								});
								waitingTrunk.add(
									this.reportTrunkWait(job, "fleet-capacity", {
										requestMb: memory.memoryMb,
										memoryClass: memory.memoryClass,
										waitReason: "cpu-contention",
									}),
								);
								continue;
							}
							waitingTrunk.add(
								this.reportTrunkWait(job, waitReason, {
									requestMb: memory.memoryMb,
									memoryClass: memory.memoryClass,
								}),
							);
							if (mainTrunk) {
								const afterWait = this.trunkWaits.get(trunkWaitKey(job));
								const postDecision = evaluateMainTrunkFleetDefer({
									jobName: job.name,
									isMainTrunkJob: true,
									priorWait: afterWait,
									deferMs: headroomFleetDeferMs,
									nowMs,
									trunkSlots: this.options.trunkSlots,
									localTrunkReserved,
									fleetWitness,
								});
								this.logTrunkFleetDeferDecision(job, postDecision);
								if (postDecision.action === "defer") {
									waitingTrunk.add(this.reportTrunkWait(job, "fleet-capacity"));
								}
							}
						}
						continue;
					}
				}
				if (
					active.some((lease) =>
						hasOutstandingBoxCustody(
							lease,
							job.repositoryId,
							job.id,
							job.runAttempt,
						),
					)
				)
					continue;
				// GitHub's `created_at`, as the job's webhook recorded it.
				const githubCreatedAt = this.options.jobPickupMetadata?.get(
					jobPickupMetadataKey(job),
				)?.jobCreatedAt;
				lease = await this.options.store.reserve(
					account,
					job,
					this.now(),
					reservationRevision,
					githubCreatedAt,
				);
				if (!lease && trunk && (await this.reclaimUnlaunchedGeneralLease()))
					lease = await this.options.store.reserve(
						account,
						job,
						this.now(),
						reservationRevision,
						githubCreatedAt,
					);
			} finally {
				if (!lease) storageAdmission?.release(storageJobId);
			}
			if (!lease) {
				rankZeroWaiting ||= rank === TRUNK_RANK;
				trunkWaiting ||= trunk;
				if (trunk)
					waitingTrunk.add(this.reportTrunkWait(job, "lease-capacity"));
			} else {
				this.servedRunnerLabels.set(
					`${job.repository}:${job.id}`,
					servedRunnerLabel(job.labels),
				);
				const pickupMeta = this.options.jobPickupMetadata?.get(
					jobPickupMetadataKey(job),
				);
				const jobCreatedMs = Date.parse(pickupMeta?.jobCreatedAt ?? "");
				const reservedMs = Date.parse(this.now());
				if (Number.isFinite(jobCreatedMs) && Number.isFinite(reservedMs)) {
					console.error(
						JSON.stringify({
							event: "hobo_ci_job_reserved",
							repository: job.repository,
							runId: job.runId,
							jobId: job.id,
							jobName: job.name,
							queuedToReservedMs: reservedMs - jobCreatedMs,
						}),
					);
				}
				if (!active.some((entry) => entry.id === lease.id)) {
					active.push(lease);
					if (
						!memoryActive.some((entry) => entry.id === lease.id) &&
						leaseOccupiesWorkerMemory(lease)
					)
						memoryActive.push(lease);
				}
				if (rank === TRUNK_RANK) memoryTrunk?.add(lease.id);
				if (!trunk) {
					general?.add(lease.id);
					memoryGeneral?.add(lease.id);
				}
				if (trunk) localTrunkReserved += 1;
				if (mergeGroupKey !== undefined) activeMergeGroups.add(mergeGroupKey);
			}
		}
		const unreservedPendingDemand = pending.filter(
			(job) =>
				!active.some((lease) =>
					hasOutstandingBoxCustody(
						lease,
						job.repositoryId,
						job.id,
						job.runAttempt,
					),
				),
		).length;
		await this.releaseBlockedUnlaunchedReservations(
			unreservedPendingDemand,
			fleetWitness,
		);
		const postReleaseActive = await this.options.store.activeLeases();
		await this.releaseTrunkHeadroomFleetReservations(
			postReleaseActive,
			fleetWitness,
		);
		const reserved = await this.admissionOrder(
			(await this.options.store.activeLeases()).filter(
				(lease) => lease.state === "reserved",
			),
			(lease) => {
				const label = this.servedRunnerLabels.get(
					`${lease.repository}:${lease.jobId}`,
				);
				const ref = {
					installationId: lease.installationId,
					repository: lease.repository,
					runId: lease.originalRunId,
					jobId: lease.jobId,
					jobName: lease.jobName,
				};
				if (label) return { ...ref, labels: [label] as const };
				return ref;
			},
		);
		for (const candidate of reserved) {
			try {
				if (this.queueExpired(candidate.queueDeadlineAt)) {
					await this.options.store.expireQueued?.(
						this.queuedDemand(candidate),
						this.now(),
					);
					continue;
				}
				this.binding(candidate);
				const [currentJob, originalRun] = await Promise.all([
					this.cachedGithubJob(
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
				if (this.queueExpired(candidate.queueDeadlineAt)) {
					await this.options.store.expireQueued?.(
						this.queuedDemand(candidate),
						this.now(),
						preflightRevision,
					);
					continue;
				}
				const connection = this.binding(candidate);
				const offer = providerOffer(this.account(candidate), candidate);
				const isolatedHost = isIsolatedHostOffer(offer);
				const label = servedRunnerLabel(currentJob.labels);
				this.servedRunnerLabels.set(
					`${candidate.repository}:${candidate.jobId}`,
					label,
				);
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
					currentJob.id !== candidate.jobId ||
					currentJob.run_id !== candidate.originalRunId ||
					currentJob.run_attempt !== candidate.runAttempt ||
					originalRun.id !== candidate.originalRunId ||
					originalRun.run_attempt !== candidate.runAttempt ||
					!(isolatedHost
						? this.trustedSandboxOriginal(originalRun, connection)
						: this.trustedOriginal(originalRun, connection)) ||
					!label
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
					if (
						(await this.options.isolatedHost.isLaunchParked?.(
							this.queuedDemand(candidate),
						)) === true
					)
						continue;
					const rank = await this.admissionOrder.rank({
						installationId: candidate.installationId,
						repository: candidate.repository,
						runId: candidate.originalRunId,
						jobId: candidate.jobId,
						labels: currentJob.labels,
					});
					await this.options.isolatedHost.launch(candidate.id, label, rank);
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
				if (this.queueExpired(lease.queueDeadlineAt)) {
					await this.options.store.transition(
						lease.id,
						["dispatching"],
						(entry) => {
							entry.state = "uncertain";
						},
						"ci.LeaseUncertain",
						this.now(),
					);
					continue;
				}
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
		for (const key of this.trunkWaits.keys())
			if (!waitingTrunk.has(key)) this.trunkWaits.delete(key);
		await this.publishFleetRoutes();
		await this.publishFleetCapacity();
		return pending.length;
	}
	/** One table per connected repository, from the state this pass just left. */
	private async publishFleetRoutes(): Promise<void> {
		const publisher = this.options.fleetRoutes;
		if (!publisher) return;
		for (const connection of this.options.config.connections) {
			const account = this.options.config.accounts.find(
				(entry) => entry.id === connection.accountId,
			);
			if (!account) continue;
			try {
				await publisher.publish({
					installationId: connection.installationId,
					repository: connection.repository,
					account,
					leases: () => this.options.store.accountLeases(account.id),
					isolatedOnly: connection.isolatedOnly,
					at: this.now(),
				});
			} catch {
				/* Routing ahead of the queue is advisory; admission already ran. */
			}
		}
	}
	private async publishFleetCapacity(): Promise<void> {
		const publisher = this.options.fleetCapacity;
		if (!publisher) return;
		let snapshot: Readonly<{
			hoboFreeSlots: number;
			arcFreeSlots?: number;
			trunkMemoryAdmit?: boolean;
		}>;
		try {
			snapshot = await publisher.snapshot();
		} catch {
			return;
		}
		const at = this.now();
		for (const connection of this.options.config.connections) {
			try {
				const base = {
					installationId: connection.installationId,
					repository: connection.repository,
					hoboFreeSlots: snapshot.hoboFreeSlots,
					at,
				} satisfies FleetCapacityPublishInput;
				const withTrunk =
					snapshot.trunkMemoryAdmit === undefined
						? base
						: { ...base, trunkMemoryAdmit: snapshot.trunkMemoryAdmit };
				if (snapshot.arcFreeSlots === undefined) {
					await publisher.publish(withTrunk);
					continue;
				}
				await publisher.publish({
					...withTrunk,
					arcFreeSlots: snapshot.arcFreeSlots,
				});
			} catch {
				/* Advisory only. */
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
		const [run, originalRun, originalJob] = await Promise.all([
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
			getJob(
				this.options.github,
				lease.installationId,
				lease.repository,
				lease.jobId,
			),
		]);
		const label = servedRunnerLabel(originalJob.labels);
		if (!label)
			throw new Error("original job no longer asks for a hobo runner");
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
		if (
			run.id !== runId ||
			!this.trustedHost(run, connection, lease) ||
			run.status === "completed"
		)
			throw new Error("untrusted host workflow");
		if (
			originalRun.id !== lease.originalRunId ||
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
			if (this.queueExpired(claimed.queueDeadlineAt))
				throw new Error("CI queue deadline expired before runner registration");
			const response = await this.options.github.request(
				lease.installationId,
				`/repos/${lease.repository}/actions/runners/generate-jitconfig`,
				"POST",
				JSON.stringify({
					name: lease.runnerName,
					runner_group_id: connection.runnerGroupId,
					labels: [label],
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
			run.id !== hostRunId ||
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
