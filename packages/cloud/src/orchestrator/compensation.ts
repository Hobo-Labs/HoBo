import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import type { ActorHost } from "@hobo/data";
import { emit } from "@hobo/events";

import {
	CLOUD_EVENTS,
	deploymentRolledBack,
	incidentEscalationRequested,
	resourceCompensationFailed,
	resourceDestroying,
} from "../events.js";
import type { CredentialBroker, Executor } from "../executor/executor.js";
import type { DeploymentPlan } from "../plan-types.js";
import { collectStream, currentFenceToken } from "../store/index.js";
import {
	destroyResource,
	foldResourceActor,
	type ResourceActorDeps,
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
	events: EventEnvelope[];
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

export async function runCompensation(
	deps: CompensationDeps,
	plan: DeploymentPlan,
	deploymentId: string,
	triggeringFailure: { resourceId: string; reason: string },
	ctx: CompensationContext,
): Promise<CompensationResult> {
	const stream = streamId(deploymentId);
	const appendOpts = {
		actor: ctx.actor,
		tenant: ctx.tenant,
		...(ctx.correlationId !== undefined
			? { correlationId: ctx.correlationId }
			: undefined),
	};

	let events = await collectStream(deps.store, stream);

	if (!events.some((e) => e.type === CLOUD_EVENTS.DeploymentRolledBack)) {
		const lastSeq =
			events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;
		const fenceToken = currentFenceToken(deps.store, stream);
		await emit(
			deps.store,
			stream,
			[
				deploymentRolledBack({
					deploymentId,
					targetSetId: `${deploymentId}-previous-set`,
					reason: `resource ${triggeringFailure.resourceId} crossed no-go threshold: ${triggeringFailure.reason}`,
				}),
			],
			{
				expectedSeq: lastSeq,
				...(fenceToken !== undefined ? { fenceToken } : undefined),
				...appendOpts,
			},
		);
		events = await collectStream(deps.store, stream);
	}

	const actorDeps: ResourceActorDeps = {
		store: deps.store,
		actorHost: deps.actorHost,
		executor: deps.executor,
		broker: deps.broker,
	};
	const byName = new Map(plan.resources.map((r) => [r.name, r]));
	const destroyedOrder: string[] = [];

	let progressed = true;
	while (progressed) {
		progressed = false;
		events = await collectStream(deps.store, stream);
		const states = new Map<string, ResourceActorState>(
			plan.resources.map((r) => [
				r.name,
				foldResourceActor(events, { ...r, deploymentId }).state,
			]),
		);

		for (const resourceId of reverseDependencyOrder(plan, states)) {
			const state = states.get(resourceId);
			if (state === "Destroyed") continue;
			if (state !== "Provisioned" && state !== "Updating") continue;

			const liveDependents = dependentsOf(plan, resourceId).filter((depId) => {
				const s = states.get(depId);
				return s === "Provisioned" || s === "Updating" || s === "Destroying";
			});
			if (liveDependents.length > 0) continue;

			const resource = byName.get(resourceId);
			if (!resource) continue;

			const beforeEvents = await collectStream(deps.store, stream);
			const last = beforeEvents[beforeEvents.length - 1];
			const lastSeq = last === undefined ? 0 : last.seq;
			const fenceToken = currentFenceToken(deps.store, stream);
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
				events = await collectStream(deps.store, stream);
				const last = events.at(-1);
				const reason = outcome.reason.trim() || "provider destroy failed";
				const fenceToken = currentFenceToken(deps.store, stream);
				await emit(
					deps.store,
					stream,
					[
						resourceCompensationFailed({ deploymentId, resourceId, reason }),
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
				events = await collectStream(deps.store, stream);
				return { status: "needs-human", destroyedOrder, events };
			}
			destroyedOrder.push(resourceId);
			progressed = true;
			break;
		}
	}

	events = await collectStream(deps.store, stream);
	const incomplete = plan.resources.some((resource) => {
		const snapshot = foldResourceActor(events, { ...resource, deploymentId });
		return (
			snapshot.state === "Provisioned" ||
			snapshot.state === "Updating" ||
			snapshot.state === "Destroying" ||
			(snapshot.state === "Failed" && snapshot.specHash !== undefined)
		);
	});
	return {
		status: incomplete ? "needs-human" : "rolled-back",
		destroyedOrder,
		events,
	};
}
