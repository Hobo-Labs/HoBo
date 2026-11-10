import { toJsonString } from "@bufbuild/protobuf";
import type { CiEvent } from "@hobo/ci";
import { z } from "zod";
import { JitBootstrapResponseSchema } from "./_generated/jit_bootstrap_response_pb.js";
import { createAdmissionOrder } from "./admission-order.js";
import type { FleetRoutePublisher } from "./fleet-routes.js";
import { type GithubTransport, getJob } from "./github.js";
import {
	HostedRelay,
	type HostedRelayStore,
	type IsolatedRunnerHost,
	type ServedRunnerLabelCache,
	type TrunkWaitCache,
} from "./hosted-relay.js";
import type { WorkerMemoryAdmission } from "./isolated-worker/memory-admission.js";
import type { WorkerStorageAdmission } from "./isolated-worker/storage-admission.js";
import type { JobDurations } from "./job-durations.js";
import type { JobPickupMetadataCache } from "./job-pickup.js";
import type { IdentityVerifier } from "./oidc.js";
import { TRUNK_RUNNER_LABEL } from "./runner-labels.js";

/** The inbox stores only signature-verified GitHub delivery bytes. */
export interface HostedInboxStore extends HostedRelayStore {
	ready(): Promise<boolean>;
	latestLeaseIntents(ids: readonly string[]): Promise<CiEvent[]>;
	acceptWebhook(input: {
		deliveryId: string;
		event: string;
		installationId: number;
		repositoryId: number;
		rawBody: Uint8Array;
		receivedAt: string;
	}): Promise<{ duplicate: boolean }>;
	acceptIgnoredWebhook(input: {
		deliveryId: string;
		event: string;
		installationId: number;
		repositoryId: number;
		rawBody: Uint8Array;
		receivedAt: string;
	}): Promise<{ duplicate: boolean }>;
	claimWebhook(
		now: string,
		leaseMs: number,
	): Promise<
		| undefined
		| {
				deliveryId: string;
				event: string;
				rawBody: Uint8Array;
				token: string;
		  }
	>;
	ackWebhook(deliveryId: string, token: string): Promise<boolean>;
	failWebhook(
		deliveryId: string,
		token: string,
		now: string,
	): Promise<"retry" | "quarantined" | "stale">;
}
const DeliveryIdentity = z.object({
	installation: z.object({
		id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	}),
	repository: z.object({
		id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		full_name: z.string().min(3),
	}),
});
const QueuedJobDelivery = z.object({
	action: z.literal("queued"),
	workflow_job: z.object({
		id: z.number().int().positive(),
		run_attempt: z.number().int().positive().optional(),
	}),
});

export type HostedRelayTickTiming = Readonly<{
	totalMs: number;
	deliveriesMs: number;
	leaseReconcileMs: number;
	dispatchMs: number;
	leaseCount: number;
	pendingCount: number;
}>;

/** Public API and bounded worker share the durable inbox and lease authority. */
export function createHostedRelayRuntime(options: {
	store: HostedInboxStore;
	github: GithubTransport;
	identity: IdentityVerifier;
	webhookSecret: string;
	isolatedHost?: IsolatedRunnerHost;
	denyUnisolated?: boolean;
	/** Shared across ticks; a relay is rebuilt per tick and would forget it. */
	jobDurations?: JobDurations;
	/** See `HostedRelay`: maximum active leases for shared-label runners. */
	generalLeaseLimit?: number;
	/** See `HostedRelay`: maximum distinct merge groups with active leases. */
	mergeGroupLeaseLimit?: number;
	jobPickupMetadata?: JobPickupMetadataCache;
	/** See `HostedRelay`: whether shared-label runs may borrow trunk slots. */
	lendTrunkSlots?: boolean;
	memoryAdmission?: WorkerMemoryAdmission;
	storageAdmission?: WorkerStorageAdmission;
	/** See `HostedRelay`: publishes the fleet route table after each pass. */
	fleetRoutes?: Pick<FleetRoutePublisher, "publish"> | undefined;
	/** Recovery-only access never admits work or starts a runner. */
	isolatedRecoveryHost?: Pick<IsolatedRunnerHost, "reconcile">;
	control: (request: Request) => Promise<Response | undefined>;
	onTickTiming?: (timing: HostedRelayTickTiming) => void;
	/** A lease whose reconciliation threw this tick; the lease is retained and retried. */
	onLeaseFailure?: (leaseId: string) => void;
	now?: () => string;
}) {
	const now = options.now ?? (() => new Date().toISOString());
	const lastDuplicateRecheck = new Map<string, number>();
	const sharedLabelTrunkJobs = new Set<string>();
	const mergeGroupCapWaitJobs = new Set<string>();
	const servedRunnerLabels: ServedRunnerLabelCache = new Map();
	const trunkWaits: TrunkWaitCache = new Map();
	const jobPickupMetadata: JobPickupMetadataCache =
		options.jobPickupMetadata ?? new Map();
	const admissionOrder = createAdmissionOrder(
		options.github,
		options.jobDurations,
	);
	async function relay() {
		const state = await options.store.configuration();
		if (!state?.configuration) throw new Error("configuration unavailable");
		const relayOptions: ConstructorParameters<typeof HostedRelay>[0] = {
			config: state.configuration,
			store: options.store,
			github: options.github,
			identity: options.identity,
			webhookSecret: options.webhookSecret,
			// Every tick ends in `dispatchPending`, which reserves in admission order.
			deferReservation: true,
			admissionOrder,
			sharedLabelTrunkJobs,
			mergeGroupCapWaitJobs,
			servedRunnerLabels,
			trunkWaits,
			jobPickupMetadata,
			now,
		};
		if (options.denyUnisolated) relayOptions.denyUnisolated = true;
		if (options.isolatedHost) relayOptions.isolatedHost = options.isolatedHost;
		if (options.jobDurations) relayOptions.jobDurations = options.jobDurations;
		if (options.generalLeaseLimit !== undefined)
			relayOptions.generalLeaseLimit = options.generalLeaseLimit;
		if (options.mergeGroupLeaseLimit !== undefined)
			relayOptions.mergeGroupLeaseLimit = options.mergeGroupLeaseLimit;
		if (options.lendTrunkSlots !== undefined)
			relayOptions.lendTrunkSlots = options.lendTrunkSlots;
		if (options.memoryAdmission)
			relayOptions.memoryAdmission = options.memoryAdmission;
		if (options.storageAdmission)
			relayOptions.storageAdmission = options.storageAdmission;
		if (options.fleetRoutes) relayOptions.fleetRoutes = options.fleetRoutes;
		return new HostedRelay(relayOptions);
	}
	return {
		admissionOrder,
		async ingestWebhook(input: {
			deliveryId: string;
			event: "workflow_job" | "workflow_run";
			rawBody: Uint8Array;
			receivedAt: string;
		}) {
			const body = JSON.parse(Buffer.from(input.rawBody).toString("utf8"));
			const identity = DeliveryIdentity.parse(body);
			const state = await options.store.configuration();
			if (!state?.configuration) throw new Error("configuration unavailable");
			if (
				!state.configuration.connections.some(
					(connection) =>
						connection.installationId === identity.installation.id &&
						connection.repositoryId === identity.repository.id &&
						connection.repository.toLowerCase() ===
							identity.repository.full_name.toLowerCase(),
				)
			) {
				await options.store.acceptIgnoredWebhook({
					...input,
					installationId: identity.installation.id,
					repositoryId: identity.repository.id,
				});
				return "ignored" as const;
			}
			const result = await options.store.acceptWebhook({
				...input,
				installationId: identity.installation.id,
				repositoryId: identity.repository.id,
			});
			if (!result.duplicate) return "accepted" as const;
			if (input.event !== "workflow_job") return "duplicate" as const;
			const queued = QueuedJobDelivery.safeParse(body);
			if (!queued.success) return "duplicate" as const;
			const jobId = queued.data.workflow_job.id;
			const runAttempt = queued.data.workflow_job.run_attempt;
			const matchesAttempt = (attempt: number) =>
				runAttempt === undefined || attempt === runAttempt;
			const [pending, leases] = await Promise.all([
				options.store.pendingJobs(),
				options.store.activeLeases(),
			]);
			const covered =
				pending.some(
					(job) =>
						job.repositoryId === identity.repository.id &&
						job.id === jobId &&
						matchesAttempt(job.runAttempt),
				) ||
				leases.some(
					(lease) =>
						lease.repositoryId === identity.repository.id &&
						matchesAttempt(lease.runAttempt) &&
						((lease.jobId === jobId &&
							(lease.actualJobId === 0 || lease.actualJobId === jobId)) ||
							lease.actualJobId === jobId),
				);
			if (covered) return "duplicate" as const;
			const nowMs = Date.parse(now());
			const registrationPending = leases.some(
				(lease) =>
					lease.repositoryId === identity.repository.id &&
					matchesAttempt(lease.runAttempt) &&
					(lease.jobId === jobId || lease.actualJobId === jobId) &&
					lease.runnerId > 0 &&
					(lease.state === "claiming" ||
						lease.state === "running" ||
						lease.state === "uncertain" ||
						lease.state === "dispatched"),
			);
			const recheckMs = registrationPending ? 300_000 : 60_000;
			const recheckKey = `${identity.repository.id}:${jobId}:${runAttempt ?? 0}`;
			for (const [key, lastMs] of lastDuplicateRecheck) {
				if (nowMs - lastMs >= recheckMs) lastDuplicateRecheck.delete(key);
			}
			const lastRecheckMs = lastDuplicateRecheck.get(recheckKey);
			if (lastRecheckMs !== undefined && nowMs - lastRecheckMs < recheckMs)
				return "duplicate" as const;
			lastDuplicateRecheck.set(recheckKey, nowMs);
			try {
				const recheck = await (await relay()).processWebhook(
					Buffer.from(input.rawBody),
					input.event,
				);
				return recheck === "queued"
					? ("requeued" as const)
					: ("duplicate" as const);
			} catch {
				return "duplicate" as const;
			}
		},
		async claim(id: string, token: string): Promise<Response> {
			const result = await (await relay()).claim(id, token);
			return new Response(toJsonString(JitBootstrapResponseSchema, result), {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "no-store",
				},
			});
		},
		control: options.control,
		async ready() {
			return (
				(await options.store.ready()) &&
				(await options.store.configuration())?.configuration !== undefined
			);
		},
		/**
		 * Process a bounded inbox batch, then drain and inspect known leases.
		 * With `admit: false` (a draining worker) it only inspects leases: no
		 * delivery is taken and no pending job is reserved or launched.
		 */
		async tick(tickOptions: { maxDeliveries?: number; admit?: boolean } = {}) {
			const tickStartedAt = Date.now();
			const admit = tickOptions.admit ?? true;
			const limit = admit ? (tickOptions.maxDeliveries ?? 10) : 0;
			if (!Number.isInteger(limit) || limit < 0 || limit > 50)
				throw new Error("invalid delivery batch size");
			// A function can die after committing intent and before recording the
			// external response. Old in-flight intent becomes uncertain, never retried.
			const leases = await options.store.activeLeases();
			const events = await options.store.latestLeaseIntents(
				leases
					.filter(
						(lease) =>
							lease.state === "dispatching" ||
							lease.state === "claiming" ||
							(lease.state === "dispatched" &&
								lease.provider === "vercel" &&
								lease.sandboxName),
					)
					.map((lease) => lease.id),
			);
			for (const lease of leases) {
				const sandbox =
					(lease.provider === "vercel" ||
						lease.provider === "kubernetes" ||
						lease.provider === "hobo-box-worker") &&
					!!lease.sandboxName;
				if (
					lease.state !== "dispatching" &&
					lease.state !== "claiming" &&
					!(sandbox && lease.state === "dispatched")
				)
					continue;
				const kind =
					lease.state === "dispatching"
						? "ci.DispatchRequested"
						: lease.state === "claiming"
							? "ci.RunnerClaimed"
							: "ci.SandboxCreated";
				// A Vercel Function can run for up to 800 seconds. Wait longer
				// before treating its in-flight Sandbox operation as abandoned.
				const cutoff = Date.parse(now()) - (sandbox ? 1_020_000 : 120_000);
				const intent = [...events]
					.reverse()
					.find((event) => event.leaseId === lease.id && event.type === kind);
				if (
					!intent ||
					!Number.isFinite(Date.parse(intent.at)) ||
					Date.parse(intent.at) > cutoff
				)
					continue;
				await options.store.transition(
					lease.id,
					[lease.state],
					(entry) => {
						entry.state = "uncertain";
					},
					"ci.LeaseUncertain",
					now(),
				);
			}
			let deliveryFailed = false;
			for (let processed = 0; processed < limit; processed++) {
				const claim = await options.store.claimWebhook(now(), 120_000);
				if (!claim) break;
				try {
					await (await relay()).processWebhook(
						Buffer.from(claim.rawBody),
						claim.event,
					);
					if (!(await options.store.ackWebhook(claim.deliveryId, claim.token)))
						throw new Error("inbox claim lost");
				} catch {
					// Retain failed evidence with a backoff (and eventual quarantine), so
					// a poison delivery cannot block other accounts in the shared inbox.
					if (
						(await options.store.failWebhook(
							claim.deliveryId,
							claim.token,
							now(),
						)) === "stale"
					)
						throw new Error("inbox claim lost");
					deliveryFailed = true;
				}
			}
			const deliveriesMs = Date.now() - tickStartedAt;
			const controller = await relay();
			const leaseReconcileStartedAt = Date.now();
			const activeLeases = await options.store.activeLeases();
			for (const lease of activeLeases) {
				if (
					!["running", "dispatched", "uncertain"].includes(lease.state) &&
					!(
						!options.isolatedHost &&
						options.isolatedRecoveryHost &&
						lease.provider === "vercel" &&
						!!lease.sandboxName &&
						["dispatching", "claiming"].includes(lease.state)
					)
				)
					continue;
				try {
					if (
						(lease.provider === "vercel" ||
							lease.provider === "kubernetes" ||
							lease.provider === "hobo-box-worker") &&
						lease.sandboxName
					) {
						const host = options.isolatedHost ?? options.isolatedRecoveryHost;
						if (host) {
							let assignedJobCompleted = false;
							if (
								options.isolatedHost &&
								lease.state !== "uncertain" &&
								lease.runnerName &&
								(lease.actualJobId > 0 ||
									servedRunnerLabels.get(
										`${lease.repository}:${lease.jobId}`,
									) === TRUNK_RUNNER_LABEL)
							) {
								const jobId =
									lease.actualJobId > 0 ? lease.actualJobId : lease.jobId;
								try {
									const job = await getJob(
										options.github,
										lease.installationId,
										lease.repository,
										jobId,
									);
									assignedJobCompleted =
										job.id === jobId &&
										job.status === "completed" &&
										job.runner_name === lease.runnerName;
								} catch {
									// Failed or ambiguous GitHub reads cannot authorize a stop.
								}
							}
							await host.reconcile(
								lease.id,
								!options.isolatedHost ||
									lease.state === "uncertain" ||
									assignedJobCompleted,
							);
						}
						continue;
					}
					if (lease.hostRunId > 0)
						await controller.reconcile(lease.id, lease.hostRunId);
					else await controller.discover(lease.id);
				} catch {
					/* Retain ambiguous reservations until a later verified reconciliation. */
					options.onLeaseFailure?.(lease.id);
				}
			}
			const leaseReconcileMs = Date.now() - leaseReconcileStartedAt;
			const dispatchStartedAt = Date.now();
			const pendingCount = admit ? await controller.dispatchPending() : 0;
			const dispatchMs = Date.now() - dispatchStartedAt;
			const totalMs = Date.now() - tickStartedAt;
			if (totalMs > 5_000)
				options.onTickTiming?.({
					totalMs,
					deliveriesMs,
					leaseReconcileMs,
					dispatchMs,
					leaseCount: activeLeases.length,
					pendingCount,
				});
			if (deliveryFailed)
				throw new Error("one or more inbox deliveries failed");
		},
	};
}
