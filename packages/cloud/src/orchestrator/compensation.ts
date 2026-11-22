import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import type { ActorHost } from "@hobo/data";
import { emit } from "@hobo/events";

import {
	CLOUD_EVENTS,
	type DeploymentTransitionData,
	deploymentRolledBack,
	deploymentTransitionCompleted,
	deploymentTransitionStarted,
	incidentEscalationRequested,
	resourceCompensationFailed,
} from "../events.js";
import type { CredentialBroker, Executor } from "../executor/executor.js";
import { isJsonObject } from "../json.js";
import type { DeploymentPlan } from "../plan-types.js";
import { currentFenceToken } from "../store/index.js";
import {
	DeploymentTransitionError,
	deploymentPlanHash,
	foldDeploymentTransition,
	newTransitionId,
	transitionResourceNames,
} from "./deployment-transition.js";
import { hasDestroyProvenance, recordedResources } from "./desired-state.js";
import { readDeploymentHistory } from "./history-scope.js";
import {
	type PendingResourceOperation,
	pendingCompensationBarriers,
} from "./pending-operations.js";
import {
	destroyResource,
	foldResourceActor,
	hasUnresolvedReconciliation,
	type ResourceActorDeps,
	type ResourceActorSnapshot,
	type ResourceActorState,
} from "./resource-actor.js";

export interface CompensationDeps {
	store: EventStore;
	actorHost: ActorHost;
	executor: Executor;
	broker: CredentialBroker;
	verifyResume?: ResourceActorDeps["verifyResume"];
}

export interface CompensationContext {
	tenant: string;
	actor: PrincipalRef;
	correlationId?: string;
}

export interface CompensationResult {
	status: "rolled-back" | "needs-human";
	destroyedOrder: string[];
	blocked: CompensationBlockedResource[];
	events: EventEnvelope[];
	pendingOperations?: readonly PendingResourceOperation[];
	provenanceMismatches?: readonly string[];
}

export interface CompensationBlockedResource {
	resourceId: string;
	reason:
		| "waiting-for-dependent-destroyed"
		| "destroy-outcome-unknown"
		| "destroy-failed";
	dependents: string[];
}

function streamId(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

function reverseDependencyOrder(
	plan: DeploymentPlan,
	states: Map<string, ResourceActorState>,
): string[] {
	const inScope = (id: string): boolean => {
		const s = states.get(id);
		return (
			s === "Provisioned" ||
			s === "Updating" ||
			s === "Failed" ||
			s === "Destroying" ||
			s === "Destroyed"
		);
	};
	const byName = new Map(plan.resources.map((r) => [r.name, r]));
	const sorted: string[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (id: string): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) throw new Error(`dependency cycle at ${id}`);
		visiting.add(id);
		for (const dep of byName.get(id)?.deps ?? []) {
			if (inScope(dep)) visit(dep);
		}
		visiting.delete(id);
		visited.add(id);
		sorted.push(id);
	};

	for (const resource of plan.resources) {
		if (inScope(resource.name)) visit(resource.name);
	}
	return sorted.reverse();
}

function dependentsOf(plan: DeploymentPlan, resourceId: string): string[] {
	return plan.resources
		.filter((r) => r.deps.includes(resourceId))
		.map((r) => r.name);
}

function hasLiveResource(
	snapshot: ResourceActorSnapshot | undefined,
	recorded: ReturnType<typeof recordedResources>,
): boolean {
	return (
		snapshot !== undefined &&
		(snapshot.state === "Provisioning" ||
			snapshot.state === "Provisioned" ||
			snapshot.state === "Updating" ||
			snapshot.state === "Destroying" ||
			snapshot.state === "ReconciliationRequired" ||
			(snapshot.state === "Failed" &&
				(snapshot.specHash !== undefined ||
					recorded.get(snapshot.resourceId)?.hasProvisionedBaseline === true ||
					recorded.get(snapshot.resourceId)?.specHash !== undefined)))
	);
}

function compensationBlockers(
	plan: DeploymentPlan,
	events: EventEnvelope[],
	deploymentId: string,
): CompensationBlockedResource[] {
	const recorded = recordedResources(events);
	const snapshots = new Map(
		plan.resources.map((resource) => [
			resource.name,
			foldResourceActor(events, { ...resource, deploymentId }),
		]),
	);
	const unresolved = new Map<string, CompensationBlockedResource["reason"]>();
	for (const resource of plan.resources) {
		const snapshot = snapshots.get(resource.name);
		if (snapshot === undefined || !hasLiveResource(snapshot, recorded))
			continue;
		const destroyingSeq =
			events
				.filter(
					(event) =>
						event.type === CLOUD_EVENTS.ResourceDestroying &&
						isJsonObject(event.data) &&
						event.data.resourceId === resource.name,
				)
				.at(-1)?.seq ?? 0;
		const failure = events
			.filter(
				(event) =>
					event.type === CLOUD_EVENTS.ResourceCompensationFailed &&
					event.seq > destroyingSeq &&
					isJsonObject(event.data) &&
					event.data.resourceId === resource.name,
			)
			.at(-1);
		if (failure === undefined && snapshot.state !== "Destroying") continue;
		unresolved.set(
			resource.name,
			failure !== undefined &&
				isJsonObject(failure.data) &&
				failure.data.outcome === "destroy-failed"
				? "destroy-failed"
				: "destroy-outcome-unknown",
		);
	}
	const blocked: CompensationBlockedResource[] = [];
	for (const resource of plan.resources) {
		const reason = unresolved.get(resource.name);
		if (reason !== undefined) {
			blocked.push({ resourceId: resource.name, reason, dependents: [] });
			continue;
		}
		const snapshot = snapshots.get(resource.name);
		if (snapshot === undefined || !hasLiveResource(snapshot, recorded))
			continue;
		const dependents = dependentsOf(plan, resource.name).filter((id) =>
			unresolved.has(id),
		);
		if (dependents.length > 0)
			blocked.push({
				resourceId: resource.name,
				reason: "waiting-for-dependent-destroyed",
				dependents,
			});
	}
	return blocked;
}

export async function runCompensation(
	deps: CompensationDeps,
	plan: DeploymentPlan,
	deploymentId: string,
	triggeringFailure: { resourceId: string; reason: string },
	ctx: CompensationContext,
): Promise<CompensationResult> {
	if (!triggeringFailure.resourceId.trim() || !triggeringFailure.reason.trim())
		throw new TypeError("rollback requires a resource and reason");
	const result = await compensate(
		deps,
		plan,
		deploymentId,
		triggeringFailure,
		ctx,
	);
	return {
		...result,
		blocked:
			result.status === "needs-human"
				? compensationBlockers(plan, result.events, deploymentId)
				: [],
	};
}

async function compensate(
	deps: CompensationDeps,
	plan: DeploymentPlan,
	deploymentId: string,
	triggeringFailure: { resourceId: string; reason: string },
	ctx: CompensationContext,
): Promise<Omit<CompensationResult, "blocked">> {
	plan = structuredClone(plan);
	triggeringFailure = { ...triggeringFailure };
	const resourceIds = transitionResourceNames(plan);
	if (
		triggeringFailure.resourceId.length === 0 ||
		triggeringFailure.resourceId.length > 200 ||
		triggeringFailure.reason.length === 0 ||
		triggeringFailure.reason.length > 4096
	)
		throw new DeploymentTransitionError("rollback cause is invalid");
	const stream = streamId(deploymentId);
	const appendOpts = {
		actor: ctx.actor,
		tenant: ctx.tenant,
		...(ctx.correlationId !== undefined
			? { correlationId: ctx.correlationId }
			: undefined),
	};

	const readHistory = () =>
		readDeploymentHistory(deps.store, deploymentId, ctx.tenant);
	const unsafeTargets = (history: EventEnvelope[]): string[] => {
		const recorded = recordedResources(history);
		return plan.resources
			.filter((resource) => {
				const previous = recorded.get(resource.name);
				return (
					previous !== undefined &&
					(previous.state === "Provisioned" ||
						previous.state === "Destroying" ||
						(previous.state === "Failed" &&
							(previous.hasProvisionedBaseline === true ||
								previous.specHash !== undefined))) &&
					!hasDestroyProvenance(previous, resource)
				);
			})
			.map((resource) => resource.name)
			.sort();
	};
	let events = await readHistory();
	let provenanceMismatches = unsafeTargets(events);
	if (provenanceMismatches.length > 0)
		return {
			status: "needs-human",
			destroyedOrder: [],
			events,
			provenanceMismatches,
		};
	let pendingOperations = pendingCompensationBarriers(events, plan);
	if (pendingOperations.length > 0)
		return {
			status: "needs-human",
			destroyedOrder: [],
			events,
			pendingOperations,
		};
	if (hasUnresolvedReconciliation(events)) {
		return { status: "needs-human", destroyedOrder: [], events };
	}

	const planHash = deploymentPlanHash(plan);
	const state = foldDeploymentTransition(events);
	if (state.status === "closed") {
		const unsettled = [...recordedResources(events).values()].some(
			(resource) =>
				resource.state === "Provisioned" ||
				resource.state === "Provisioning" ||
				resource.state === "Destroying" ||
				(resource.state === "Failed" &&
					(resource.hasProvisionedBaseline === true ||
						resource.specHash !== undefined)),
		);
		return {
			status: unsettled ? "needs-human" : "rolled-back",
			destroyedOrder: [],
			events,
		};
	}
	let transition: DeploymentTransitionData;
	if (state.status === "active") {
		if (
			state.transition.kind !== "rollback" ||
			state.transition.planHash !== planHash
		)
			return { status: "needs-human", destroyedOrder: [], events };
		transition = state.transition;
	} else {
		transition = {
			deploymentId,
			transitionId: newTransitionId(events),
			kind: "rollback",
			planHash,
			resourceIds,
			triggerResource: triggeringFailure.resourceId,
			reason: triggeringFailure.reason,
		};
		const lastSeq =
			// SAFETY: `events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;` is required at this I/O or test boundary.
			events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;
		const fenceToken = currentFenceToken(deps.store, stream);
		await emit(deps.store, stream, [deploymentTransitionStarted(transition)], {
			expectedSeq: lastSeq,
			...(fenceToken !== undefined ? { fenceToken } : undefined),
			...appendOpts,
		});
		events = await readHistory();
		const confirmed = foldDeploymentTransition(events);
		if (
			confirmed.status !== "active" ||
			JSON.stringify(confirmed.transition) !== JSON.stringify(transition)
		)
			throw new Error("rollback transition start could not be confirmed");
	}

	const actorDeps: ResourceActorDeps = {
		store: deps.store,
		actorHost: deps.actorHost,
		executor: deps.executor,
		broker: deps.broker,
	};
	if (deps.verifyResume !== undefined)
		actorDeps.verifyResume = deps.verifyResume;
	const byName = new Map(plan.resources.map((r) => [r.name, r]));
	const destroyedOrder: string[] = [];

	let progressed = true;
	while (progressed) {
		progressed = false;
		events = await readHistory();
		provenanceMismatches = unsafeTargets(events);
		if (provenanceMismatches.length > 0)
			return {
				status: "needs-human",
				destroyedOrder,
				events,
				provenanceMismatches,
			};
		pendingOperations = pendingCompensationBarriers(events, plan);
		if (pendingOperations.length > 0)
			return {
				status: "needs-human",
				destroyedOrder,
				events,
				pendingOperations,
			};
		const states = new Map<string, ResourceActorState>(
			plan.resources.map((r) => [
				r.name,
				foldResourceActor(events, { ...r, deploymentId }).state,
			]),
		);
		const recorded = recordedResources(events);
		if (hasUnresolvedReconciliation(events))
			return { status: "needs-human", destroyedOrder, events };

		for (const resourceId of reverseDependencyOrder(plan, states)) {
			const state = states.get(resourceId);
			if (state === "Destroyed") continue;
			if (
				state !== "Provisioned" &&
				state !== "Updating" &&
				state !== "Destroying" &&
				!(
					state === "Failed" &&
					(recorded.get(resourceId)?.hasProvisionedBaseline === true ||
						recorded.get(resourceId)?.specHash !== undefined)
				)
			)
				continue;

			const liveDependents = dependentsOf(plan, resourceId).filter((depId) => {
				const s = states.get(depId);
				return (
					s === "Provisioned" ||
					s === "Updating" ||
					s === "Destroying" ||
					(s === "Failed" &&
						(recorded.get(depId)?.hasProvisionedBaseline === true ||
							recorded.get(depId)?.specHash !== undefined))
				);
			});
			if (liveDependents.length > 0) continue;

			const resource = byName.get(resourceId);
			if (!resource) continue;
			events = await readHistory();
			pendingOperations = pendingCompensationBarriers(events, plan);
			if (pendingOperations.length > 0 || hasUnresolvedReconciliation(events))
				return {
					status: "needs-human",
					destroyedOrder,
					events,
					pendingOperations,
				};

			const outcome = await destroyResource(
				actorDeps,
				{ ...resource, deploymentId },
				{
					deploymentId,
					tenant: ctx.tenant,
					actor: ctx.actor,
					destroyReason: "rollback-compensation",
					...(ctx.correlationId !== undefined
						? { correlationId: ctx.correlationId }
						: undefined),
				},
			);
			if (outcome.kind === "failed") {
				const reason = outcome.reason.trim() || "provider destroy failed";
				events = await readHistory();
				const fenceToken = currentFenceToken(deps.store, stream);
				await emit(
					deps.store,
					stream,
					[
						resourceCompensationFailed({
							deploymentId,
							resourceId,
							reason,
							outcome: outcome.outcome,
						}),
						incidentEscalationRequested({
							deploymentId,
							resourceId,
							reason: "compensation-failed",
						}),
					],
					{
						expectedSeq: events.at(-1)?.seq ?? 0,
						...(fenceToken !== undefined ? { fenceToken } : undefined),
						...appendOpts,
					},
				);
				events = await readHistory();
				return { status: "needs-human", destroyedOrder, events };
			}
			if (outcome.kind === "destroyed") destroyedOrder.push(resourceId);
			progressed = true;
			break;
		}
	}

	events = await readHistory();
	provenanceMismatches = unsafeTargets(events);
	if (provenanceMismatches.length > 0)
		return {
			status: "needs-human",
			destroyedOrder,
			events,
			provenanceMismatches,
		};
	pendingOperations = pendingCompensationBarriers(events, plan);
	if (pendingOperations.length > 0 || hasUnresolvedReconciliation(events))
		return {
			status: "needs-human",
			destroyedOrder,
			events,
			pendingOperations,
		};
	const finalRecorded = recordedResources(events);
	if (
		plan.resources.some((resource) => {
			const state = foldResourceActor(events, {
				...resource,
				deploymentId,
			}).state;
			return (
				state === "Provisioning" ||
				state === "Provisioned" ||
				state === "Updating" ||
				state === "Destroying" ||
				(state === "Failed" &&
					(finalRecorded.get(resource.name)?.hasProvisionedBaseline === true ||
						finalRecorded.get(resource.name)?.specHash !== undefined))
			);
		})
	)
		return { status: "needs-human", destroyedOrder, events };
	const lastSeq = events.at(-1)?.seq ?? 0;
	const fenceToken = currentFenceToken(deps.store, stream);
	await emit(
		deps.store,
		stream,
		[
			deploymentTransitionCompleted(transition),
			deploymentRolledBack({ deploymentId }),
		],
		{
			expectedSeq: lastSeq,
			...(fenceToken !== undefined ? { fenceToken } : undefined),
			...appendOpts,
		},
	);
	events = await readHistory();
	const finished = foldDeploymentTransition(events);
	if (finished.status !== "closed")
		throw new Error("rollback transition completion could not be confirmed");
	return { status: "rolled-back", destroyedOrder, events };
}
