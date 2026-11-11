import { create } from "@bufbuild/protobuf";
import { ACTIVE_STATES, JobSchema, type Lease } from "@hobo/ci";
import type { HostedRelayStore } from "../hosted-relay.js";
import { leaseIdFromBoxRunnerName } from "../job-runner-custody.js";
import { containerPastHardTimeout } from "./container-timeout.js";
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
	| "hobo_ci_container_timeout_enforced"
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
	/** Memory reserved by the leases that are launching or running. */
	inUseMemoryMb: number;
}>;

function requeueJob(lease: Lease) {
	return create(JobSchema, {
		id: lease.jobId,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		repositoryId: lease.repositoryId,
		installationId: lease.installationId,
		repository: lease.repository,
		name: lease.jobName,
		memoryClass: lease.memoryClass,
		memoryMb: lease.memoryMb,
		labels: ["hobo"],
		action: "queued",
		isolatedRequired: true,
	});
}

function hasUnregisteredCreateIdentity(lease: Lease): boolean {
	return (
		(lease.provider === "kubernetes" || lease.provider === "hobo-box-worker") &&
		!lease.pipelineId &&
		!!lease.sandboxName &&
		lease.sandboxName === `hobo-${lease.id}` &&
		lease.runnerName === `hobo-${lease.id}` &&
		lease.hostRunId === 0 &&
		lease.runnerId === 0 &&
		lease.actualJobId === 0 &&
		!lease.usageCompletedAt
	);
}

/** Registration cannot have started while a create is still the durable stage. */
export function isUnregisteredUncertainCreate(lease: Lease): boolean {
	return (
		lease.state === "uncertain" &&
		(lease.sandboxStage === "creating" || lease.sandboxStage === "created") &&
		hasUnregisteredCreateIdentity(lease)
	);
}

/** A dispatch interrupted before its create result must retain the same fence. */
export function isUnregisteredDispatchingCreate(lease: Lease): boolean {
	return (
		lease.state === "dispatching" &&
		lease.sandboxStage === "creating" &&
		!lease.sandboxSessionId &&
		hasUnregisteredCreateIdentity(lease)
	);
}

/** A durable stop intent is bound to the same isolated host session. */
export function hasIsolatedStopIntent(lease: Lease): boolean {
	return (
		(lease.provider === "kubernetes" || lease.provider === "hobo-box-worker") &&
		!lease.pipelineId &&
		(lease.sandboxStage === "stopping" || lease.sandboxStage === "stopped") &&
		!!lease.sandboxName &&
		!!lease.sandboxSessionId
	);
}

/** A lease that may still be executing a GitHub job; drain must not drop it. */
export function leaseHoldDuringWorkerDrain(lease: Lease): boolean {
	if (["running", "dispatched", "claiming"].includes(lease.state)) return true;
	if (
		lease.state === "reserved" &&
		(lease.sandboxSessionId !== "" ||
			lease.actualJobId > 0 ||
			lease.runnerId > 0)
	)
		return true;
	return false;
}

export function createWorkerLeaseReconciler(options: {
	store: WorkerLeaseReconciliationStore;
	docker: Pick<
		DockerDriver,
		"list" | "listWorkerContainers" | "stop" | "remove"
	>;
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
	/**
	 * When this returns true, a running container must not be stopped even if it
	 * is not on the active lease name/id sets (custody record or GitHub job).
	 */
	containerCustody?: (input: {
		container: DockerContainer;
		leaseId?: string;
	}) => Promise<boolean>;
}) {
	const now = options.now ?? Date.now;
	const orphanGraceMs = options.orphanGraceMs ?? 2 * 60_000;
	if (!Number.isInteger(orphanGraceMs) || orphanGraceMs < 0)
		throw new Error("invalid orphan grace");

	const orphanRemovalsInFlight = new Set<string>();

	function orphanContainerKey(container: DockerContainer): string {
		return container.containerId || container.name;
	}

	/** Memory reserved by leases that are launching or running. */
	function reservedMemoryMb(owned: readonly Lease[]): number {
		return owned
			.filter((lease) => lease.state !== "reserved" || lease.sandboxName !== "")
			.reduce(
				(total, lease) =>
					total +
					(lease.memoryMb >= 512 ? lease.memoryMb : options.workerMemoryMb),
				0,
			);
	}

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
			if (options.docker.listWorkerContainers)
				containers = await options.docker.listWorkerContainers();
			else if (options.docker.list)
				containers = await options.docker.list("hobo.ci/isolated=1");
			else throw new Error("docker container listing unavailable");
		} catch (error) {
			options.log?.("hobo_ci_lease_reconciliation_failed", {
				message: error instanceof Error ? error.message : "unknown",
			});
			return {
				inventoryKnown: false,
				liveLeaseIds: new Set(owned.map((lease) => lease.id)),
				inUseMemoryMb: reservedMemoryMb(owned),
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
		const journalInUseMb = reservedMemoryMb(owned);
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
			// A durable stop intent must be reconciled before releasing its hold.
			// Retry final job observation and settlement after confirmed removal.
			if (hasIsolatedStopIntent(lease)) {
				if (!options.settleExited) {
					liveLeaseIds.add(lease.id);
					continue;
				}
				const matches = containers.filter(
					(candidate) =>
						candidate.name === lease.sandboxName ||
						candidate.containerId === lease.sandboxSessionId,
				);
				if (
					matches.length > 1 ||
					(matches.length === 1 &&
						(matches[0]?.name !== lease.sandboxName ||
							matches[0]?.containerId !== lease.sandboxSessionId))
				) {
					liveLeaseIds.add(lease.id);
					continue;
				}
				try {
					await options.settleExited(lease);
				} catch (error) {
					options.log?.("hobo_ci_lease_reconciliation_failed", {
						leaseId: lease.id,
						message: error instanceof Error ? error.message : "unknown",
					});
				}
				const current = await options.store.get(lease.id);
				if (current && ACTIVE_STATES.has(current.state))
					liveLeaseIds.add(lease.id);
				continue;
			}
			// A create can succeed after its reply is lost. A uniquely named,
			// unregistered container may be bound and stopped by the owning host;
			// never free its reservation merely because the reply was ambiguous.
			if (
				isUnregisteredUncertainCreate(lease) ||
				isUnregisteredDispatchingCreate(lease)
			) {
				// Another process may still be completing a slow create. Preserve
				// both the orphan grace and the account's configured startup window.
				const startupMinutes =
					configuration?.accounts.find(
						(account) => account.id === lease.accountId,
					)?.startupMinutes ?? 0;
				const createGraceMs = Math.max(orphanGraceMs, startupMinutes * 60_000);
				if (lease.state === "dispatching" && ageMs < createGraceMs) {
					liveLeaseIds.add(lease.id);
					continue;
				}
				const matches = containers.filter(
					(candidate) => candidate.name === lease.sandboxName,
				);
				// An absent name does not fence a create whose reply was lost: the
				// provider may still complete it after this inventory snapshot.
				if (matches.length === 0 && !lease.sandboxSessionId) {
					liveLeaseIds.add(lease.id);
					continue;
				}
				if (matches.length > 0) {
					const match = matches[0];
					if (
						matches.length !== 1 ||
						!match?.containerId ||
						(lease.sandboxSessionId &&
							lease.sandboxSessionId !== match.containerId)
					) {
						liveLeaseIds.add(lease.id);
						continue;
					}
					if (!options.settleExited) {
						liveLeaseIds.add(lease.id);
						continue;
					}
					try {
						await options.settleExited(lease);
					} catch (error) {
						options.log?.("hobo_ci_lease_reconciliation_failed", {
							leaseId: lease.id,
							message: error instanceof Error ? error.message : "unknown",
						});
					}
					const current = await options.store.get(lease.id);
					if (current && ACTIVE_STATES.has(current.state))
						liveLeaseIds.add(lease.id);
					continue;
				}
			}
			// An inconsistent create record is not proof that its provider effect
			// was absent. Keep its hold rather than requeueing on missing inventory.
			if (
				["dispatching", "uncertain"].includes(lease.state) &&
				["creating", "created"].includes(lease.sandboxStage)
			) {
				liveLeaseIds.add(lease.id);
				continue;
			}
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
				if (
					container.state === "running" &&
					container.timeoutMs !== undefined &&
					container.createdAtMs !== undefined &&
					containerPastHardTimeout(
						container.createdAtMs,
						container.timeoutMs,
						now(),
					)
				) {
					try {
						await options.docker.stop(container.name, container.containerId);
						await options.docker.remove(container.name, container.containerId);
						options.log?.("hobo_ci_container_timeout_enforced", {
							leaseId: lease.id,
							jobId: lease.jobId,
							name: container.name,
							timeoutMs: container.timeoutMs,
						});
					} catch (error) {
						options.log?.("hobo_ci_lease_reconciliation_failed", {
							leaseId: lease.id,
							message: error instanceof Error ? error.message : "unknown",
						});
						liveLeaseIds.add(lease.id);
						continue;
					}
					try {
						await options.settleExited?.(lease);
					} catch (error) {
						options.log?.("hobo_ci_lease_reconciliation_failed", {
							leaseId: lease.id,
							message: error instanceof Error ? error.message : "unknown",
						});
					}
					const current = await options.store.get(lease.id);
					if (current && ACTIVE_STATES.has(current.state))
						liveLeaseIds.add(lease.id);
					continue;
				}
				liveLeaseIds.add(lease.id);
				continue;
			} else {
				reason = "container-missing";
				if (reconcileOptions.draining && leaseHoldDuringWorkerDrain(lease)) {
					liveLeaseIds.add(lease.id);
					continue;
				}
				if (!reconcileOptions.draining && ageMs < orphanGraceMs) continue;
				await options.store.abortIsolatedAndRequeue(
					lease.id,
					requeueJob(lease),
					new Date(now()).toISOString(),
				);
			}
			const current = await options.store.get(lease.id);
			if (current && ACTIVE_STATES.has(current.state)) continue;
			if (reason === "container-missing" && !reconcileOptions.draining)
				await options.afterRelease?.(lease);
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
		const leasedNames = new Set<string>();
		for (const lease of leases) {
			if (lease.sandboxName) leasedNames.add(lease.sandboxName);
			if (lease.runnerName) leasedNames.add(lease.runnerName);
			leasedNames.add(lease.sandboxName || `hobo-${lease.id}`);
		}
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
			if (container.state === "running" || container.state === "removing") {
				if (container.state === "removing") continue;
				if (reconcileOptions.draining) continue;
				if (container.createdAtMs === undefined) continue;
				const removalKey = orphanContainerKey(container);
				if (orphanRemovalsInFlight.has(removalKey)) continue;
				const leaseId = leaseIdFromBoxRunnerName(container.name);
				if (options.containerCustody) {
					const custodyInput =
						leaseId === undefined ? { container } : { container, leaseId };
					if (await options.containerCustody(custodyInput)) continue;
				} else if (!leaseId) {
					continue;
				}
				const ageMs = Math.max(0, now() - container.createdAtMs);
				if (ageMs < orphanGraceMs) continue;
				orphanRemovalsInFlight.add(removalKey);
				try {
					if (options.docker.stop)
						await options.docker.stop(container.name, container.containerId);
					await options.docker.remove(container.name, container.containerId);
					orphanRemovalsInFlight.delete(removalKey);
					options.log?.("hobo_ci_container_orphan_removed", {
						name: container.name,
						containerId: container.containerId,
						state: container.state,
						running: true,
						ageMs,
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (!/already in progress/i.test(message))
						orphanRemovalsInFlight.delete(removalKey);
					options.log?.("hobo_ci_container_orphan_remove_failed", {
						name: container.name,
						containerId: container.containerId,
						message,
					});
				}
				continue;
			}
			const staleKey = orphanContainerKey(container);
			if (orphanRemovalsInFlight.has(staleKey)) continue;
			orphanRemovalsInFlight.add(staleKey);
			try {
				await options.docker.remove(container.name, container.containerId);
				orphanRemovalsInFlight.delete(staleKey);
				const event = "hobo_ci_container_orphan_removed";
				if (container.timeoutMs !== undefined) {
					options.log?.(event, {
						name: container.name,
						containerId: container.containerId,
						state: container.state,
						timeoutMs: container.timeoutMs,
					});
				} else {
					options.log?.(event, {
						name: container.name,
						containerId: container.containerId,
						state: container.state,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!/already in progress/i.test(message))
					orphanRemovalsInFlight.delete(staleKey);
				options.log?.("hobo_ci_container_orphan_remove_failed", {
					name: container.name,
					containerId: container.containerId,
					message,
				});
			}
		}
		return {
			inventoryKnown: true,
			liveLeaseIds,
			inUseMemoryMb: journalInUseMb,
		};
	}

	return { reconcile };
}

export type WorkerLeaseReconciler = ReturnType<
	typeof createWorkerLeaseReconciler
>;
