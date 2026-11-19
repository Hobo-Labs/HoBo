import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import { type ActorHost, isOptimisticConflict } from "@hobo/data";
import { emit } from "@hobo/events";

import {
	CLOUD_EVENTS,
	deploymentRollbackStarted,
	deploymentRolledBack,
	incidentEscalationRequested,
	resourceCompensationFailed,
	resourceDestroying,
} from "../events.js";
import type { CredentialBroker, Executor } from "../executor/executor.js";
import type { DeploymentPlan } from "../plan-types.js";
import { isJsonObject } from "../json.js";
import { collectStream, currentFenceToken } from "../store/index.js";
import {
	destroyResource,
	foldResourceActor,
	type ResourceActorDeps,
	type ResourceActorSnapshot,
	type ResourceActorState,
} from "./resource-actor.js";

export interface CompensationDeps {
	store: EventStore;
	actorHost: ActorHost;
	executor: Executor;
	broker: CredentialBroker;
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
}

export interface CompensationBlockedResource {
	resourceId: string;
	reason:
		| "waiting-for-dependent-destroyed"
		| "destroy-outcome-unknown"
		| "destroy-failed"
		| "failed-after-provisioning";
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

function hasLiveResource(snapshot: ResourceActorSnapshot | undefined): boolean {
	return (
		snapshot !== undefined &&
		(snapshot.state === "Provisioned" ||
			snapshot.state === "Updating" ||
			snapshot.state === "Destroying" ||
			(snapshot.state === "Failed" && snapshot.specHash !== undefined))
	);
}

function compensationBlockers(
	plan: DeploymentPlan,
	events: EventEnvelope[],
	deploymentId: string,
): CompensationBlockedResource[] {
	const snapshots = new Map(
		plan.resources.map((resource) => [
			resource.name,
			foldResourceActor(events, { ...resource, deploymentId }),
		]),
	);
	const blocked: CompensationBlockedResource[] = [];
	for (const resource of plan.resources) {
		const snapshot = snapshots.get(resource.name);
		if (!hasLiveResource(snapshot)) continue;
		const dependents = dependentsOf(plan, resource.name).filter((id) =>
			hasLiveResource(snapshots.get(id)),
		);
		if (dependents.length) {
			blocked.push({
				resourceId: resource.name,
				reason: "waiting-for-dependent-destroyed",
				dependents,
			});
		} else if (snapshot?.state === "Destroying") {
			const facts = events.filter(
				(event) =>
					isJsonObject(event.data) && event.data.resourceId === resource.name,
			);
			const destroyingSeq =
				facts
					.filter((event) => event.type === CLOUD_EVENTS.ResourceDestroying)
					.at(-1)?.seq ?? 0;
			const failed = facts.some(
				(event) =>
					event.type === CLOUD_EVENTS.ResourceCompensationFailed &&
					event.seq > destroyingSeq,
			);
			blocked.push({
				resourceId: resource.name,
				reason: failed ? "destroy-failed" : "destroy-outcome-unknown",
				dependents: [],
			});
		} else if (snapshot?.state === "Failed") {
			blocked.push({
				resourceId: resource.name,
				reason: "failed-after-provisioning",
				dependents: [],
			});
		}
	}
	return blocked;
}

function compensationResult(
	status: CompensationResult["status"],
	destroyedOrder: string[],
	events: EventEnvelope[],
	plan: DeploymentPlan,
	deploymentId: string,
): CompensationResult {
	return {
		status,
		destroyedOrder,
		events,
		blocked: compensationBlockers(plan, events, deploymentId),
	};
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
	const stream = streamId(deploymentId);
	const appendOpts = {
		actor: ctx.actor,
		tenant: ctx.tenant,
		...(ctx.correlationId !== undefined
			? { correlationId: ctx.correlationId }
			: undefined),
	};

	let events: EventEnvelope[] = [];
	let rollbackStartSeq: number | undefined;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		events = await collectStream(deps.store, stream);
		const epochStart = events.reduce(
			(position, event) =>
				event.type === CLOUD_EVENTS.DeploymentPlanned ||
				event.type === CLOUD_EVENTS.DeploymentDeployed ||
				event.type === CLOUD_EVENTS.ResourceProvisioning
					? event.seq
					: position,
			0,
		);
		const started = events
			.filter(
				(event) =>
					event.type === CLOUD_EVENTS.DeploymentRollbackStarted &&
					event.seq > epochStart,
			)
			.at(-1);
		if (started) {
			rollbackStartSeq = started.seq;
			break;
		}
		const lastSeq = events.at(-1)?.seq ?? 0;
		const fenceToken = currentFenceToken(deps.store, stream);
		try {
			const emitted = await emit(
				deps.store,
				stream,
				[
					deploymentRollbackStarted({
						deploymentId,
						resourceId: triggeringFailure.resourceId,
						reason: triggeringFailure.reason,
					}),
				],
				{
					expectedSeq: lastSeq,
					...(fenceToken !== undefined ? { fenceToken } : undefined),
					...appendOpts,
				},
			);
			rollbackStartSeq = emitted.seq;
			break;
		} catch (error) {
			if (!(error instanceof Error) || !isOptimisticConflict(error))
				throw error;
		}
	}
	if (rollbackStartSeq === undefined)
		throw new Error("deployment remained busy while recording rollback");

	const actorDeps: ResourceActorDeps = {
		store: deps.store,
		actorHost: deps.actorHost,
		executor: deps.executor,
		broker: deps.broker,
	};
	const byName = new Map(plan.resources.map((r) => [r.name, r]));
	const destroyedOrder: string[] = [];

	let progressed = true;
	let conflicts = 0;
	while (progressed) {
		progressed = false;
		events = await collectStream(deps.store, stream);
		const snapshots = new Map<string, ResourceActorSnapshot>(
			plan.resources.map((r) => [
				r.name,
				foldResourceActor(events, { ...r, deploymentId }),
			]),
		);
		const states = new Map<string, ResourceActorState>(
			[...snapshots].map(([name, snapshot]) => [name, snapshot.state]),
		);

		for (const resourceId of reverseDependencyOrder(plan, states)) {
			const state = states.get(resourceId);
			if (state === "Destroyed") continue;
			if (state !== "Provisioned" && state !== "Updating") continue;

			const liveDependents = dependentsOf(plan, resourceId).filter((depId) =>
				hasLiveResource(snapshots.get(depId)),
			);
			if (liveDependents.length > 0) continue;

			const resource = byName.get(resourceId);
			if (!resource) continue;

			const last = events[events.length - 1];
			const lastSeq = last === undefined ? 0 : last.seq;
			const fenceToken = currentFenceToken(deps.store, stream);
			try {
				await emit(
					deps.store,
					stream,
					[
						resourceDestroying({
							deploymentId,
							resourceId,
							reason: "rollback-compensation",
						}),
					],
					{
						expectedSeq: lastSeq,
						...(fenceToken !== undefined ? { fenceToken } : undefined),
						...appendOpts,
					},
				);
				conflicts = 0;
			} catch (error) {
				if (
					!(error instanceof Error) ||
					!isOptimisticConflict(error) ||
					++conflicts >= 8
				)
					throw error;
				progressed = true;
				break;
			}

			const outcome = await destroyResource(
				actorDeps,
				{ ...resource, deploymentId },
				{
					deploymentId,
					tenant: ctx.tenant,
					actor: ctx.actor,
					...(ctx.correlationId !== undefined
						? { correlationId: ctx.correlationId }
						: undefined),
				},
			);
			if (outcome.kind === "failed") {
				const reason = outcome.reason.trim() || "provider destroy failed";
				let recorded = false;
				for (let attempt = 0; attempt < 8; attempt += 1) {
					events = await collectStream(deps.store, stream);
					const last = events.at(-1);
					const fenceToken = currentFenceToken(deps.store, stream);
					try {
						await emit(
							deps.store,
							stream,
							[
								resourceCompensationFailed({
									deploymentId,
									resourceId,
									reason,
								}),
								incidentEscalationRequested({
									deploymentId,
									resourceId,
									reason: "compensation-failed",
								}),
							],
							{
								expectedSeq: last?.seq ?? 0,
								...(fenceToken !== undefined ? { fenceToken } : undefined),
								...appendOpts,
							},
						);
						recorded = true;
						break;
					} catch (error) {
						if (!(error instanceof Error) || !isOptimisticConflict(error))
							throw error;
					}
				}
				if (!recorded)
					throw new Error(
						"deployment remained busy while recording compensation failure",
					);
				events = await collectStream(deps.store, stream);
				return compensationResult(
					"needs-human",
					destroyedOrder,
					events,
					plan,
					deploymentId,
				);
			}
			if (outcome.kind === "destroyed") destroyedOrder.push(resourceId);
			progressed = true;
			break;
		}
	}

	events = await collectStream(deps.store, stream);
	const incomplete = plan.resources.some((resource) =>
		hasLiveResource(foldResourceActor(events, { ...resource, deploymentId })),
	);
	if (incomplete)
		return compensationResult(
			"needs-human",
			destroyedOrder,
			events,
			plan,
			deploymentId,
		);
	for (let attempt = 0; attempt < 8; attempt += 1) {
		events = await collectStream(deps.store, stream);
		if (
			events.some(
				(event) =>
					event.seq > rollbackStartSeq &&
					(event.type === CLOUD_EVENTS.DeploymentPlanned ||
						event.type === CLOUD_EVENTS.DeploymentDeployed ||
						event.type === CLOUD_EVENTS.ResourceProvisioning),
			)
		)
			return compensationResult(
				"needs-human",
				destroyedOrder,
				events,
				plan,
				deploymentId,
			);
		if (
			events.some(
				(event) =>
					event.type === CLOUD_EVENTS.DeploymentRolledBack &&
					event.seq > rollbackStartSeq,
			)
		)
			return compensationResult(
				"rolled-back",
				destroyedOrder,
				events,
				plan,
				deploymentId,
			);
		if (
			plan.resources.some((resource) =>
				hasLiveResource(
					foldResourceActor(events, { ...resource, deploymentId }),
				),
			)
		)
			return compensationResult(
				"needs-human",
				destroyedOrder,
				events,
				plan,
				deploymentId,
			);
		const fenceToken = currentFenceToken(deps.store, stream);
		try {
			await emit(deps.store, stream, [deploymentRolledBack({ deploymentId })], {
				expectedSeq: events.at(-1)?.seq ?? 0,
				...(fenceToken !== undefined ? { fenceToken } : undefined),
				...appendOpts,
			});
			events = await collectStream(deps.store, stream);
			return compensationResult(
				"rolled-back",
				destroyedOrder,
				events,
				plan,
				deploymentId,
			);
		} catch (error) {
			if (!(error instanceof Error) || !isOptimisticConflict(error))
				throw error;
		}
	}
	throw new Error("deployment remained busy while completing rollback");
}
