import { create } from "@bufbuild/protobuf";
import { ACTIVE_STATES, JobSchema, type Lease } from "@hobo/ci";
import type { HostedRelayStore } from "../hosted-relay.js";
import { workerOfferKey, workerOfferKeys } from "./daemon-shutdown.js";
import type { DockerContainer, DockerDriver } from "./docker-driver.js";

export type WorkerLeaseReconciliationStore = Pick<
	HostedRelayStore,
	"activeLeases" | "all" | "configuration" | "get" | "abortIsolatedAndRequeue"
>;

export function leaseJobLogFields(
	lease: Pick<Lease, "jobId" | "actualJobId">,
): Readonly<{ jobId: number; requestedJobId?: number }> {
	const jobId = lease.actualJobId > 0 ? lease.actualJobId : lease.jobId;
	return jobId === lease.jobId
		? { jobId }
		: { jobId, requestedJobId: lease.jobId };
}

export type WorkerLeaseReconciliationEvent =
	| "hobo_ci_container_orphan_removed"
	| "hobo_ci_container_orphan_remove_failed"
	| "hobo_ci_lease_orphan_released"
	| "hobo_ci_lease_reconciliation_failed"
	| "hobo_ci_memory_without_containers";

export type WorkerLeaseReconciliationLog = (
	event: WorkerLeaseReconciliationEvent,
	fields: Readonly<Record<string, string | number | boolean>>,
) => void;

export type WorkerLeaseReconciliationResult = Readonly<{
	inventoryKnown: boolean;
	liveLeaseIds: ReadonlySet<string>;
}>;

function requeueJob(lease: Lease, requeueAfter: string) {
	return create(JobSchema, {
		id: lease.jobId,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		repositoryId: lease.repositoryId,
		installationId: lease.installationId,
		repository: lease.repository,
		memoryClass: lease.memoryClass,
		memoryMb: lease.memoryMb,
		labels: ["hobo"],
		action: "queued",
		isolatedRequired: true,
		requeueAfter,
	});
}

export function createWorkerLeaseReconciler(options: {
	store: WorkerLeaseReconciliationStore;
	docker: Pick<DockerDriver, "list" | "stop" | "remove">;
	workerAccountId: string;
	workerMemoryMb: number;
	orphanGraceMs?: number;
	now?: () => number;
	log?: WorkerLeaseReconciliationLog;
	settleExited?: (lease: Lease) => Promise<void>;
	afterRelease?: (lease: Lease) => Promise<void>;
	protectedContainerNames?: () => ReadonlySet<string>;
}) {
	const now = options.now ?? Date.now;
	const orphanGraceMs = options.orphanGraceMs ?? 2 * 60_000;
	if (!Number.isInteger(orphanGraceMs) || orphanGraceMs < 0)
		throw new Error("invalid orphan grace");

	async function reconcile(
		reconcileOptions: { draining?: boolean } = {},
	): Promise<WorkerLeaseReconciliationResult> {
		const leases = await options.store.activeLeases();
		const configuration = (await options.store.configuration())?.configuration;
		const workerOffers = workerOfferKeys(
			configuration,
			options.workerAccountId,
		);
		const owned = leases.filter(
			(lease) =>
				(lease.provider === "kubernetes" ||
					lease.provider === "hobo-box-worker") &&
				workerOffers.has(workerOfferKey(lease.accountId, lease.offerId)),
		);
		let containers: readonly DockerContainer[];
		try {
			if (!options.docker.list)
				throw new Error("docker container listing unavailable");
			containers = await options.docker.list("hobo.ci/isolated=1");
		} catch (error) {
			options.log?.("hobo_ci_lease_reconciliation_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
			return {
				inventoryKnown: false,
				liveLeaseIds: new Set(owned.map((lease) => lease.id)),
			};
		}
		const journalInUseMb = owned.reduce(
			(total, lease) =>
				total +
				(lease.memoryMb >= 512 ? lease.memoryMb : options.workerMemoryMb),
			0,
		);
		if (containers.length === 0 && journalInUseMb > 0)
			options.log?.("hobo_ci_memory_without_containers", {
				inUseMb: journalInUseMb,
				activeLeaseCount: owned.length,
			});
		const liveLeaseIds = new Set<string>();
		for (const lease of owned) {
			const expectedName = lease.sandboxName || `hobo-${lease.id}`;
			const container = containers.find(
				(candidate) =>
					candidate.name === expectedName ||
					(!!lease.sandboxSessionId &&
						candidate.containerId === lease.sandboxSessionId),
			);
			const createdMs = Date.parse(lease.createdAt);
			const ageMs = Number.isFinite(createdMs)
				? Math.max(0, now() - createdMs)
				: 0;
			let reason: string;
			if (container?.state === "exited" || container?.state === "dead") {
				reason = `container-${container.state}`;
				try {
					await options.settleExited?.(lease);
				} catch (error) {
					options.log?.("hobo_ci_lease_reconciliation_failed", {
						leaseId: lease.id,
						message: error instanceof Error ? error.message : "unknown",
					});
					continue;
				}
			} else if (container) {
				liveLeaseIds.add(lease.id);
				continue;
			} else {
				reason = "container-missing";
				if (!reconcileOptions.draining && ageMs < orphanGraceMs) continue;
				await options.store.abortIsolatedAndRequeue(
					lease.id,
					requeueJob(lease, new Date(now() + orphanGraceMs).toISOString()),
					new Date(now()).toISOString(),
				);
			}
			const current = await options.store.get(lease.id);
			if (current && ACTIVE_STATES.has(current.state)) continue;
			const released = current ?? lease;
			if (reason === "container-missing")
				await options.afterRelease?.(released);
			options.log?.("hobo_ci_lease_orphan_released", {
				leaseId: released.id,
				...leaseJobLogFields(released),
				runId: released.originalRunId,
				state: released.state,
				reason,
				ageMs,
				memoryMb:
					released.memoryMb >= 512 ? released.memoryMb : options.workerMemoryMb,
			});
		}
		const leasedNames = new Set(
			leases.map((lease) => lease.sandboxName || `hobo-${lease.id}`),
		);
		const leasedContainerIds = new Set(
			leases
				.map((lease) => lease.sandboxSessionId)
				.filter((containerId) => containerId !== ""),
		);
		const protectedNames =
			options.protectedContainerNames?.() ?? new Set<string>();
		let historicalLeases: readonly Lease[] | undefined;
		for (const container of containers) {
			if (
				leasedNames.has(container.name) ||
				leasedContainerIds.has(container.containerId) ||
				protectedNames.has(container.name)
			)
				continue;
			if (historicalLeases === undefined) {
				try {
					historicalLeases = await options.store.all();
				} catch {
					historicalLeases = [];
				}
			}
			const orphanLease = historicalLeases.find(
				(lease) =>
					lease.sandboxName === container.name ||
					(lease.sandboxSessionId !== "" &&
						lease.sandboxSessionId === container.containerId),
			);
			const identity = orphanLease ? leaseJobLogFields(orphanLease) : {};
			try {
				if (container.state === "running")
					await options.docker.stop(container.name, container.containerId);
				await options.docker.remove(container.name, container.containerId);
				options.log?.("hobo_ci_container_orphan_removed", {
					name: container.name,
					containerId: container.containerId,
					state: container.state,
					...identity,
				});
			} catch (error) {
				options.log?.("hobo_ci_container_orphan_remove_failed", {
					name: container.name,
					containerId: container.containerId,
					...identity,
					message: error instanceof Error ? error.message : "unknown",
				});
			}
		}
		return { inventoryKnown: true, liveLeaseIds };
	}

	return { reconcile };
}

export type WorkerLeaseReconciler = ReturnType<
	typeof createWorkerLeaseReconciler
>;
