import { create } from "@bufbuild/protobuf";
import { ACTIVE_STATES, JobSchema, type Lease } from "@hobo/ci";
import type { HostedRelayStore } from "../hosted-relay.js";
import { workerOfferKey, workerOfferKeys } from "./daemon-shutdown.js";
import type { DockerContainer, DockerDriver } from "./docker-driver.js";
import {
	type OrphanJobCandidate,
	orphanJobCandidateForLease,
} from "./orphan-jobs.js";

export type WorkerLeaseReconciliationStore = Pick<
	HostedRelayStore,
	"activeLeases" | "configuration" | "get" | "abortIsolatedAndRequeue"
>;

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

function requeueJob(lease: Lease) {
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
	onOrphanJob?: (candidate: OrphanJobCandidate) => void;
	protectedContainerNames?: () => ReadonlySet<string>;
	protectedLeaseIds?: () => ReadonlySet<string>;
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
		const containerFor = (lease: Lease) => {
			const expectedName = lease.sandboxName || `hobo-${lease.id}`;
			return containers.find(
				(candidate) =>
					candidate.name === expectedName ||
					(!!lease.sandboxSessionId &&
						candidate.containerId === lease.sandboxSessionId),
			);
		};
		const detectedAtMs = now();
		const sweptLeaseIds = new Set<string>();
		for (const lease of owned) {
			if (lease.actualJobId === 0 || lease.runnerName !== `hobo-${lease.id}`)
				continue;
			const container = containerFor(lease);
			if (container && container.state !== "dead") continue;
			const orphan = orphanJobCandidateForLease(lease, detectedAtMs);
			if (orphan) {
				sweptLeaseIds.add(lease.id);
				options.onOrphanJob?.(orphan);
			}
		}
		const launching = owned.filter(
			(lease) => lease.state !== "reserved" || lease.sandboxName !== "",
		);
		const journalInUseMb = launching.reduce(
			(total, lease) =>
				total +
				(lease.memoryMb >= 512 ? lease.memoryMb : options.workerMemoryMb),
			0,
		);
		if (containers.length === 0 && journalInUseMb > 0)
			options.log?.("hobo_ci_memory_without_containers", {
				inUseMb: journalInUseMb,
				activeLeaseCount: launching.length,
			});
		const liveLeaseIds = new Set<string>();
		const protectedLeaseIds =
			options.protectedLeaseIds?.() ?? new Set<string>();
		for (const lease of owned) {
			if (lease.state === "reserved" || protectedLeaseIds.has(lease.id)) {
				liveLeaseIds.add(lease.id);
				continue;
			}
			const container = containerFor(lease);
			const createdMs = Date.parse(lease.createdAt);
			const dispatchingMs = Date.parse(lease.dispatchingAt);
			const ageBaseMs =
				["dispatching", "dispatched", "claiming"].includes(lease.state) &&
				Number.isFinite(dispatchingMs)
					? dispatchingMs
					: createdMs;
			const ageMs = Number.isFinite(ageBaseMs)
				? Math.max(0, now() - ageBaseMs)
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
					requeueJob(lease),
					new Date(now()).toISOString(),
				);
			}
			const current = await options.store.get(lease.id);
			if (current && ACTIVE_STATES.has(current.state)) continue;
			if (reason === "container-missing") await options.afterRelease?.(lease);
			const orphan =
				reason !== "container-exited" && lease.runnerName === `hobo-${lease.id}`
					? orphanJobCandidateForLease(lease, now())
					: undefined;
			if (orphan && !sweptLeaseIds.has(lease.id)) options.onOrphanJob?.(orphan);
			options.log?.("hobo_ci_lease_orphan_released", {
				leaseId: lease.id,
				jobId: lease.jobId,
				runId: lease.originalRunId,
				state: lease.state,
				reason,
				ageMs,
				memoryMb:
					lease.memoryMb >= 512 ? lease.memoryMb : options.workerMemoryMb,
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
		for (const container of containers) {
			if (
				leasedNames.has(container.name) ||
				leasedContainerIds.has(container.containerId) ||
				protectedNames.has(container.name)
			)
				continue;
			try {
				if (container.state === "running")
					await options.docker.stop(container.name, container.containerId);
				await options.docker.remove(container.name, container.containerId);
				options.log?.("hobo_ci_container_orphan_removed", {
					name: container.name,
					containerId: container.containerId,
					state: container.state,
				});
			} catch (error) {
				options.log?.("hobo_ci_container_orphan_remove_failed", {
					name: container.name,
					containerId: container.containerId,
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
