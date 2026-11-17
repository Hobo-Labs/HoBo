import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import type { ActorHost } from "@hobo/data";
import { emit } from "@hobo/events";

import { CLOUD_EVENTS, deploymentDeployed } from "../events.js";
import type { CredentialBroker, Executor } from "../executor/executor.js";
import type { DeploymentPlan, ResourcePlan } from "../plan-types.js";
import { currentFenceToken } from "../store/index.js";
import { type CompensationResult, runCompensation } from "./compensation.js";
import {
	type BlockedProviderMove,
	blockedProviderMove,
	changedSinceLastDeployed,
	currentEpochStart,
	type DeploymentChangeSet,
	type DeploymentMode,
	orphansToPrune,
	planDeploymentChanges,
	recordedResources,
} from "./desired-state.js";
import { readDeploymentHistory } from "./history-scope.js";
import {
	type PendingResourceOperation,
	pendingOrchestrationBarriers,
} from "./pending-operations.js";
import {
	destroyResource,
	foldResourceActor,
	hasUnresolvedReconciliation,
	isConverged,
	type ReconcileContext,
	type ResourceActorDeps,
	type ResourceActorSnapshot,
	type ResourceActorState,
	reconcileResource,
} from "./resource-actor.js";

// The Orchestrator (control-plane.md "Choreography over orchestration"): given a
// DeploymentPlan DAG it activates ResourceActors; each self-activates when all its
// dependencies' `resource.Provisioned` facts are present (edge-triggered by
// events, level-triggered by this resync loop). When every actor reaches
// Provisioned it drives `deployment.Deployed`. There is no central step-by-step
// coordinator — ordering is the dependency DAG, realized by choreography. A
// no-go failure hands off to choreographed compensation (compensation.ts).

export interface OrchestratorDeps {
	store: EventStore;
	actorHost: ActorHost;
	executor: Executor;
	broker: CredentialBroker;
	verifyResume?: ResourceActorDeps["verifyResume"];
}

export interface OrchestratorContext {
	tenant: string;
	actor: PrincipalRef;
	correlationId?: string;
	// Resources whose apply-failure crosses the no-go threshold (seeded in tests).
	noGoThresholdResources?: ReadonlySet<string>;
	/**
	 * `incremental` (default) keeps resources the log provisioned but the plan
	 * no longer declares; `complete` destroys them after the declared ones
	 * converge (Bicep's deployment modes).
	 */
	mode?: DeploymentMode;
}

export type OrchestratorStatus =
	| "deployed"
	| "rolled-back"
	| "needs-human"
	| "waiting";

export interface OrchestratorResult {
	status: OrchestratorStatus;
	deploymentId: string;
	provisioned: string[];
	destroyed: string[];
	events: EventEnvelope[];
	compensation?: CompensationResult;
	/** The what-if this run started from: what it set out to change. */
	changes: DeploymentChangeSet;
	/** Undeclared resources `complete` mode destroyed, dependents first. */
	pruned: string[];
	/** Undeclared resources `complete` mode could not destroy (no recorded plan). */
	unprunable: string[];
	/** Provider changes refused until the prior resource's effects are reconciled. */
	blockedProviderMoves?: readonly BlockedProviderMove[];
	/** In-flight effects that must be reconciled before changing this plan. */
	pendingOperations?: readonly PendingResourceOperation[];
}

function streamId(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

function resourceSnapshots(
	events: EventEnvelope[],
	plan: DeploymentPlan,
	deploymentId: string,
): Map<string, ResourceActorSnapshot> {
	const snapshots = new Map<string, ResourceActorSnapshot>();
	for (const resource of plan.resources)
		snapshots.set(
			resource.name,
			foldResourceActor(events, { ...resource, deploymentId }),
		);
	return snapshots;
}

function resourceStates(
	events: EventEnvelope[],
	plan: DeploymentPlan,
	deploymentId: string,
): Map<string, ResourceActorState> {
	const states = new Map<string, ResourceActorState>();
	for (const [name, snapshot] of resourceSnapshots(events, plan, deploymentId))
		states.set(name, snapshot.state);
	return states;
}

function depsProvisioned(
	resource: ResourcePlan,
	snapshots: Map<string, ResourceActorSnapshot>,
	resources: Map<string, ResourcePlan>,
): boolean {
	return resource.deps.every((dep) => {
		const snapshot = snapshots.get(dep);
		const desired = resources.get(dep);
		return (
			snapshot !== undefined &&
			desired !== undefined &&
			isConverged(snapshot, desired)
		);
	});
}

// Run the choreography to convergence: reconcile any resource whose deps are all
// Provisioned, re-folding the durable log each pass (level-triggered). Safe to
// re-invoke against a partially-written stream — that is the crash-resume path.
export async function runOrchestrator(
	deps: OrchestratorDeps,
	plan: DeploymentPlan,
	deploymentId: string,
	ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
	const stream = streamId(deploymentId);
	const actorDeps: ResourceActorDeps = {
		store: deps.store,
		actorHost: deps.actorHost,
		executor: deps.executor,
		broker: deps.broker,
	};
	if (deps.verifyResume !== undefined)
		actorDeps.verifyResume = deps.verifyResume;
	const reconcileCtx: ReconcileContext = {
		deploymentId,
		tenant: ctx.tenant,
		actor: ctx.actor,
		...(ctx.correlationId !== undefined
			? { correlationId: ctx.correlationId }
			: undefined),
		...(ctx.noGoThresholdResources !== undefined
			? { noGoThresholdResources: ctx.noGoThresholdResources }
			: undefined),
	};

	let progressed = true;
	let triggeringFailure: { resourceId: string; reason: string } | null = null;
	const mode = ctx.mode ?? "incremental";
	const readHistory = () =>
		readDeploymentHistory(deps.store, deploymentId, ctx.tenant);
	let initialEvents = await readHistory();
	// This run's epoch: facts after the last Deployed/RolledBack. Earlier
	// failures belong to an `up` that already ended.
	const epochStart = currentEpochStart(initialEvents);
	const changes = planDeploymentChanges(plan, initialEvents, mode);
	const pendingResult = async (
		history: EventEnvelope[],
		pruned: string[] = [],
		unprunable: string[] = [],
	): Promise<OrchestratorResult | undefined> => {
		const pendingOperations = await pendingOrchestrationBarriers(
			history,
			plan,
			{
				deploymentId,
				tenant: ctx.tenant,
				verifyResume: deps.verifyResume,
			},
		);
		if (pendingOperations.length === 0) return undefined;
		const states = resourceStates(history, plan, deploymentId);
		return {
			status: "needs-human",
			deploymentId,
			provisioned: provisionedList(states),
			destroyed: destroyedList(states),
			events: history,
			changes,
			pruned,
			unprunable,
			pendingOperations,
		};
	};
	let initialPending = await pendingResult(initialEvents);
	const recoveredPruned: string[] = [];
	if (initialPending !== undefined) {
		const [only] = initialPending.pendingOperations ?? [];
		const previous =
			only === undefined
				? undefined
				: recordedResources(initialEvents).get(only.resourceId);
		const known = [...recordedResources(initialEvents).values()];
		const liveDependentsAbsent =
			only !== undefined &&
			known.every(
				(item) =>
					item.resourceId === only.resourceId ||
					item.state === "Destroyed" ||
					(item.plan !== undefined &&
						!item.plan.deps.includes(only.resourceId)),
			);
		if (
			mode === "complete" &&
			!hasUnresolvedReconciliation(initialEvents) &&
			initialPending.pendingOperations?.length === 1 &&
			only?.operation === "destroy" &&
			only.reason === "removed-from-plan" &&
			previous?.plan !== undefined &&
			deps.verifyResume !== undefined &&
			liveDependentsAbsent &&
			!plan.resources.some((resource) =>
				resource.deps.includes(only.resourceId),
			)
		) {
			const resumed = await destroyResource(
				actorDeps,
				{ ...previous.plan, deploymentId },
				reconcileCtx,
			);
			initialEvents = await readHistory();
			if (resumed.kind === "failed") {
				const state = resourceStates(initialEvents, plan, deploymentId);
				return {
					status: "needs-human",
					deploymentId,
					provisioned: provisionedList(state),
					destroyed: destroyedList(state),
					events: initialEvents,
					changes,
					pruned: [],
					unprunable: [only.resourceId],
					pendingOperations: initialPending.pendingOperations,
				};
			}
			if (resumed.kind === "destroyed") recoveredPruned.push(only.resourceId);
			initialPending = await pendingResult(initialEvents, recoveredPruned);
		}
		if (initialPending !== undefined) return initialPending;
	}
	// Provisioning is recorded before dispatch, so even a failed or interrupted
	// call may have created state. A new provider cannot take over that resource
	// without a fenced handover. Unknown ownership must fail closed too.
	const recorded = recordedResources(initialEvents);
	const blockedProviderMoves = plan.resources.flatMap((resource) => {
		const blocked = blockedProviderMove(recorded.get(resource.name), resource);
		return blocked === undefined ? [] : [blocked];
	});
	if (blockedProviderMoves.length > 0) {
		const states = resourceStates(initialEvents, plan, deploymentId);
		return {
			status: "needs-human",
			deploymentId,
			provisioned: provisionedList(states),
			destroyed: destroyedList(states),
			events: initialEvents,
			changes,
			pruned: [],
			unprunable: [],
			blockedProviderMoves,
		};
	}
	const resources = new Map(
		plan.resources.map((resource) => [resource.name, resource]),
	);
	// Each resource is applied at most once per run: a retryable failure is
	// reported as `waiting`, not retried in a hot loop.
	const attempted = new Set<string>();
	let lateBlocked: BlockedProviderMove | undefined;

	while (progressed) {
		progressed = false;
		const events = await readHistory();
		const pending = await pendingResult(events);
		if (pending !== undefined) return pending;
		const snapshots = resourceSnapshots(events, plan, deploymentId);
		const states = resourceStates(events, plan, deploymentId);
		// A possibly-applied resource must be reconciled before any retry or rollback.
		if (hasUnresolvedReconciliation(events)) {
			return {
				status: "needs-human",
				deploymentId,
				provisioned: provisionedList(states),
				destroyed: destroyedList(states),
				events,
				changes,
				pruned: [],
				unprunable: [],
			};
		}

		// A no-go failure in this epoch short-circuits to compensation.
		const failed = events.find(
			(e) =>
				e.seq > epochStart &&
				e.type === CLOUD_EVENTS.ResourceFailed &&
				// SAFETY: `(e.data as { crossedNoGoThreshold?: boolean }).crossedNoGoThreshold,` is required at this I/O or test boundary.
				(e.data as { crossedNoGoThreshold?: boolean }).crossedNoGoThreshold,
		);
		if (failed) {
			// SAFETY: `const data = failed.data as { resourceId: string; reason: string };` is required at this I/O or test boundary.
			const data = failed.data as { resourceId: string; reason: string };
			triggeringFailure = { resourceId: data.resourceId, reason: data.reason };
			break;
		}

		for (const resource of plan.resources) {
			const snapshot = snapshots.get(resource.name);
			// Desired state reached (same spec hash): the controller no-op.
			if (snapshot && isConverged(snapshot, resource)) continue;
			if (snapshot?.state === "Destroying") continue;
			if (attempted.has(resource.name)) continue;
			if (!depsProvisioned(resource, snapshots, resources)) continue;
			attempted.add(resource.name);

			const outcome = await reconcileResource(
				actorDeps,
				{ ...resource, deploymentId },
				reconcileCtx,
			);
			progressed = true;
			if (outcome.kind === "blocked") {
				lateBlocked = outcome.move;
				break;
			}
			if (outcome.kind === "failed" && outcome.crossedNoGoThreshold) {
				triggeringFailure = {
					resourceId: resource.name,
					reason: outcome.reason,
				};
			}
			// Re-fold from the log on the next while-iteration (level-triggered).
			break;
		}

		if (triggeringFailure || lateBlocked) break;
	}

	let events = await readHistory();
	const pending = await pendingResult(events);
	if (pending !== undefined) return pending;
	let states = resourceStates(events, plan, deploymentId);
	if (lateBlocked)
		return {
			status: "needs-human",
			deploymentId,
			provisioned: provisionedList(states),
			destroyed: destroyedList(states),
			events,
			changes,
			pruned: [],
			unprunable: [],
			blockedProviderMoves: [lateBlocked],
		};

	// Compensation path: a no-go failure triggers deployment.RolledBack + reverse
	// dependency-order destroys.
	if (triggeringFailure) {
		// Compensation deletes resources. An update to an already deployed estate
		// cannot safely use that create-time rollback: it would destroy resources
		// that existed before this epoch. Leave the failure durable for an operator
		// rather than claiming the previous state was restored.
		const beforeEpoch = initialEvents.filter(
			(event) => event.seq <= epochStart,
		);
		const previousStates = resourceStates(beforeEpoch, plan, deploymentId);
		if (
			[...previousStates.values()].some(
				(state) =>
					state === "Provisioned" ||
					state === "Updating" ||
					state === "Destroying" ||
					state === "Failed",
			)
		) {
			return {
				status: "needs-human",
				deploymentId,
				provisioned: provisionedList(states),
				destroyed: destroyedList(states),
				events,
				changes,
				pruned: [],
				unprunable: [],
			};
		}
		const compensation = await runCompensation(
			actorDeps,
			plan,
			deploymentId,
			triggeringFailure,
			{
				tenant: ctx.tenant,
				actor: ctx.actor,
				...(ctx.correlationId !== undefined
					? { correlationId: ctx.correlationId }
					: undefined),
			},
		);
		events = await readHistory();
		states = resourceStates(events, plan, deploymentId);
		return {
			status:
				compensation.status === "needs-human" ? "needs-human" : "rolled-back",
			deploymentId,
			provisioned: provisionedList(states),
			destroyed: destroyedList(states),
			events,
			compensation,
			changes,
			pruned: [],
			unprunable: [],
		};
	}

	// Complete mode: once every declared resource converged, destroy what the
	// log provisioned but the plan no longer declares, dependents first.
	const pruned: string[] = [...recoveredPruned];
	let unprunable: string[] = [];
	const declaredConverged = () => {
		const snapshots = resourceSnapshots(events, plan, deploymentId);
		return plan.resources.every((resource) => {
			const snapshot = snapshots.get(resource.name);
			return snapshot !== undefined && isConverged(snapshot, resource);
		});
	};
	if (mode === "complete" && declaredConverged()) {
		const orphans = orphansToPrune(plan, events);
		unprunable = [...orphans.unknown];
		// A live declared resource may still reference an undeclared one. An
		// orphan without a recorded plan may depend on any other orphan, so
		// preserve all known orphans until its dependencies can be recovered.
		const blocked = new Set(
			plan.resources.flatMap((resource) => resource.deps),
		);
		const remaining = new Set(orphans.ordered.map((orphan) => orphan.name));
		if (orphans.unknown.length > 0)
			for (const orphan of orphans.ordered) blocked.add(orphan.name);
		for (const orphan of orphans.ordered) {
			events = await readHistory();
			const blockedByPending = await pendingResult(
				events,
				pruned,
				[...new Set([...unprunable, ...remaining])].sort(),
			);
			if (blockedByPending !== undefined) return blockedByPending;
			if (!declaredConverged()) {
				states = resourceStates(events, plan, deploymentId);
				return {
					status: "waiting",
					deploymentId,
					provisioned: provisionedList(states),
					destroyed: destroyedList(states),
					events,
					changes,
					pruned,
					unprunable,
				};
			}
			const hasLiveDependent = orphans.ordered.some(
				(other) =>
					remaining.has(other.name) && other.deps.includes(orphan.name),
			);
			if (blocked.has(orphan.name) || hasLiveDependent) {
				unprunable.push(orphan.name);
				for (const dependency of orphan.deps) blocked.add(dependency);
				continue;
			}
			const outcome = await destroyResource(
				actorDeps,
				{ ...orphan, deploymentId },
				reconcileCtx,
			);
			if (outcome.kind === "failed") {
				unprunable.push(orphan.name);
				if (outcome.snapshot.state === "ReconciliationRequired") {
					events = await readHistory();
					states = resourceStates(events, plan, deploymentId);
					return {
						status: "needs-human",
						deploymentId,
						provisioned: provisionedList(states),
						destroyed: destroyedList(states),
						events,
						changes,
						pruned,
						unprunable: [...unprunable].sort(),
					};
				}
				for (const dependency of orphan.deps) blocked.add(dependency);
				continue;
			}
			if (outcome.kind === "destroyed") pruned.push(orphan.name);
			remaining.delete(orphan.name);
		}
		if (pruned.length > 0) {
			events = await readHistory();
			states = resourceStates(events, plan, deploymentId);
		}
	}

	events = await readHistory();
	states = resourceStates(events, plan, deploymentId);
	const finalPending = await pendingResult(events, pruned, unprunable);
	if (finalPending !== undefined) return finalPending;
	// All actors Provisioned → drive deployment.Deployed (choreography terminal).
	const allProvisioned = declaredConverged() && unprunable.length === 0;
	// Deployed is recorded once per change: an idempotent re-run that changed
	// nothing appends nothing.
	if (allProvisioned && changedSinceLastDeployed(events)) {
		const lastSeq =
			// SAFETY: `events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;` is required at this I/O or test boundary.
			events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;
		// The deployment stream is fenced (owner_epoch set by the first leased
		// write); the terminal fact continues under the current owner epoch.
		const fenceToken = currentFenceToken(deps.store, stream);
		await emit(
			deps.store,
			stream,
			[
				deploymentDeployed({
					deploymentId,
					setId: `${deploymentId}-set`,
					resourceIds: plan.resources.map((r) => r.name).sort(),
				}),
			],
			{
				expectedSeq: lastSeq,
				actor: ctx.actor,
				tenant: ctx.tenant,
				...(fenceToken !== undefined ? { fenceToken } : undefined),
				...(ctx.correlationId !== undefined
					? { correlationId: ctx.correlationId }
					: undefined),
			},
		);
		events = await readHistory();
	}

	return {
		status: allProvisioned ? "deployed" : "waiting",
		deploymentId,
		provisioned: provisionedList(states),
		destroyed: destroyedList(states),
		events,
		changes,
		pruned,
		unprunable: [...unprunable].sort(),
	};
}

function provisionedList(states: Map<string, ResourceActorState>): string[] {
	return [...states.entries()]
		.filter(([, s]) => s === "Provisioned")
		.map(([id]) => id)
		.sort();
}

function destroyedList(states: Map<string, ResourceActorState>): string[] {
	return [...states.entries()]
		.filter(([, s]) => s === "Destroyed")
		.map(([id]) => id)
		.sort();
}
