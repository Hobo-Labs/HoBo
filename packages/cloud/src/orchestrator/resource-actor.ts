import { createHash } from "node:crypto";

import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import type { ActorHost } from "@hobo/data";
import { emit } from "@hobo/events";
import {
	CLOUD_EVENTS,
	execDiff,
	execSucceeded,
	resourceDestroyed,
	resourceFailed,
	resourceProvisioned,
	resourceProvisioning,
	tokenGranted,
	tokenRevoked,
	tokenUsed,
} from "../events.js";
import {
	type CredentialBroker,
	credentialScope,
	type Executor,
	type IacProgram,
} from "../executor/executor.js";
import type { ResourcePlan } from "../plan-types.js";
import { collectStream, currentFenceToken } from "../store/index.js";
import {
	type BlockedProviderMove,
	blockedProviderMove,
	desiredSpecHash,
	recordedResources,
	requireResourceSpecHash,
} from "./desired-state.js";

export const RESOURCE_ACTOR_STATES = Object.freeze([
	"Pending",
	"Planning",
	"Provisioning",
	"Provisioned",
	"Updating",
	"Failed",
	"Compensating",
	"Destroying",
	"Destroyed",
] as const);

export type ResourceActorState = (typeof RESOURCE_ACTOR_STATES)[number];

export interface ResourceActorSnapshot {
	deploymentId: string;
	resourceId: string;
	state: ResourceActorState;
	sequence: number;
	outputs: Record<string, string>;
	deps: string[];
	specHash?: string;
}

export function resourceActorKey(
	deploymentId: string,
	resourceId: string,
): string {
	return `resource:${deploymentId}:${resourceId}`;
}

export function foldResourceActor(
	events: Iterable<EventEnvelope>,
	resource: ResourcePlan,
): ResourceActorSnapshot {
	const snapshot: ResourceActorSnapshot = {
		deploymentId: resource.deploymentId ?? "",
		resourceId: resource.name,
		state: "Pending",
		sequence: 0,
		outputs: {},
		deps: [...resource.deps],
	};

	for (const event of events) {
		const data = event.data as {
			resourceId?: string;
			outputs?: Record<string, string>;
			specHash?: string;
		};
		if (data.resourceId !== resource.name) continue;
		switch (event.type) {
			case CLOUD_EVENTS.ResourceProvisioning:
				snapshot.state =
					snapshot.state === "Provisioned" || snapshot.state === "Updating"
						? "Updating"
						: "Provisioning";
				snapshot.sequence += 1;
				break;
			case CLOUD_EVENTS.ResourceProvisioned:
				snapshot.state = "Provisioned";
				snapshot.sequence += 1;
				if (data.outputs) snapshot.outputs = { ...data.outputs };
				snapshot.specHash = requireResourceSpecHash(data.specHash);
				break;
			case CLOUD_EVENTS.ResourceFailed:
				snapshot.state = "Failed";
				snapshot.sequence += 1;
				break;
			case CLOUD_EVENTS.ResourceDestroying:
				snapshot.state = "Destroying";
				snapshot.sequence += 1;
				break;
			case CLOUD_EVENTS.ResourceDestroyed:
				snapshot.state = "Destroyed";
				snapshot.sequence += 1;
				snapshot.outputs = {};
				delete snapshot.specHash;
				break;
			default:
				break;
		}
	}
	return snapshot;
}

export interface ResourceActorDeps {
	store: EventStore;
	actorHost: ActorHost;
	executor: Executor;
	broker: CredentialBroker;
}

export interface ReconcileContext {
	deploymentId: string;
	tenant: string;
	actor: PrincipalRef;
	correlationId?: string;
	noGoThresholdResources?: ReadonlySet<string>;
}

export type ReconcileOutcome =
	| { kind: "converged"; snapshot: ResourceActorSnapshot }
	| {
			kind: "blocked";
			snapshot: ResourceActorSnapshot;
			move: BlockedProviderMove;
	  }
	| { kind: "provisioned"; snapshot: ResourceActorSnapshot; execId: string }
	| { kind: "updated"; snapshot: ResourceActorSnapshot; execId: string }
	| {
			kind: "failed";
			snapshot: ResourceActorSnapshot;
			reason: string;
			crossedNoGoThreshold: boolean;
	  };

export function iacProgramFor(
	deploymentId: string,
	resource: ResourcePlan,
	action: "preview" | "apply" | "destroy",
	tenant: string,
): IacProgram {
	return {
		programId: `${deploymentId}:${resource.name}`,
		deploymentId,
		resourceId: resource.name,
		provider: resource.provider,
		driver:
			resource.strategy && resource.strategy !== "reconcile"
				? resource.strategy
				: "pulumi",
		action,
		stackName: `${tenant}/${deploymentId}/${resource.name}`,
		resource: structuredClone(resource),
	};
}

function streamId(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

function finalStateHash(resourceId: string): string {
	return `sha256:${createHash("sha256").update(resourceId).digest("hex")}`;
}

export function isConverged(
	snapshot: ResourceActorSnapshot,
	resource: ResourcePlan,
): boolean {
	if (snapshot.state !== "Provisioned") return false;
	return (
		requireResourceSpecHash(snapshot.specHash) === desiredSpecHash(resource)
	);
}

export async function reconcileResource(
	deps: ResourceActorDeps,
	resource: ResourcePlan,
	ctx: ReconcileContext,
): Promise<ReconcileOutcome> {
	const key = resourceActorKey(ctx.deploymentId, resource.name);
	const holderId = `resource-actor:${key}`;
	const lease = deps.actorHost.acquire(key, { holderId });

	try {
		const stream = streamId(ctx.deploymentId);
		let events = await collectStream(deps.store, stream);
		let snapshot = foldResourceActor(events, {
			...resource,
			deploymentId: ctx.deploymentId,
		});
		const move = blockedProviderMove(
			recordedResources(events).get(resource.name),
			resource,
		);
		if (move) return { kind: "blocked", snapshot, move };

		if (isConverged(snapshot, resource)) {
			return { kind: "converged", snapshot };
		}
		const updating =
			snapshot.state === "Provisioned" || snapshot.state === "Updating";
		const specHash = desiredSpecHash(resource);

		const fenceToken = currentFenceToken(deps.store, stream);
		const appendOpts = {
			actor: ctx.actor,
			tenant: ctx.tenant,
			...(fenceToken !== undefined ? { fenceToken } : undefined),
			...(ctx.correlationId !== undefined
				? { correlationId: ctx.correlationId }
				: undefined),
		};
		let lastSeq =
			events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;

		const program = iacProgramFor(
			ctx.deploymentId,
			resource,
			"apply",
			ctx.tenant,
		);
		const programHash = `sha256:${createHash("sha256").update(JSON.stringify(program)).digest("hex")}`;
		const credential = deps.broker.issue({
			scope: credentialScope({
				tenant: ctx.tenant,
				resourceId: resource.name,
				driver: program.driver,
				action: "apply",
			}),
		});
		const grant = {
			grantId: credential.id,
			tokenRef: `tokenref://scoped/${credential.id}`,
			...(ctx.actor?.id !== undefined
				? { svidSubject: ctx.actor.id }
				: undefined),
			scope: {
				port: resource.port,
				resource: resource.name,
				action: "apply",
			},
		};

		try {
			if (snapshot.state !== "Provisioning" && snapshot.state !== "Updating") {
				const provisioningId = `exec-apply-${resource.name}`;
				const emitted = await emit(
					deps.store,
					stream,
					[
						resourceProvisioning({
							deploymentId: ctx.deploymentId,
							resourceId: resource.name,
							execId: provisioningId,
							programHash,
							specHash,
							providerId: resource.provider,
						}),
					],
					{ expectedSeq: lastSeq, ...appendOpts },
				);
				lastSeq = emitted.seq;
			}

			const result = await deps.executor.run(program, credential);

			if (result.status === "failed") {
				const crossed =
					ctx.noGoThresholdResources?.has(resource.name) ??
					result.classification === "fatal";
				const emitted = await emit(
					deps.store,
					stream,
					[
						tokenGranted(grant),
						resourceFailed({
							deploymentId: ctx.deploymentId,
							resourceId: resource.name,
							reason: result.reason,
							classification: result.classification,
							crossedNoGoThreshold: crossed,
						}),
						tokenRevoked({ grantId: grant.grantId, reason: "apply failed" }),
					],
					{ expectedSeq: lastSeq, ...appendOpts },
				);
				lastSeq = emitted.seq;
				events = await collectStream(deps.store, stream);
				snapshot = foldResourceActor(events, {
					...resource,
					deploymentId: ctx.deploymentId,
				});
				return {
					kind: "failed",
					snapshot,
					reason: result.reason,
					crossedNoGoThreshold: crossed,
				};
			}

			const emitted = await emit(
				deps.store,
				stream,
				[
					tokenGranted(grant),
					execDiff({
						execId: result.execId,
						summary: result.diff.summary,
						changes: result.diff.changes,
					}),
					execSucceeded({
						execId: result.execId,
						outputsHash: `sha256:${createHash("sha256").update(JSON.stringify(result.outputs)).digest("hex")}`,
						outputs: result.outputs,
					}),
					resourceProvisioned({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						outputs: result.outputs,
						execId: result.execId,
						specHash,
					}),
					tokenUsed({ grantId: grant.grantId }),
					tokenRevoked({ grantId: grant.grantId, reason: "apply complete" }),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			lastSeq = emitted.seq;
			events = await collectStream(deps.store, stream);
			snapshot = foldResourceActor(events, {
				...resource,
				deploymentId: ctx.deploymentId,
			});
			return {
				kind: updating ? "updated" : "provisioned",
				snapshot,
				execId: result.execId,
			};
		} finally {
			deps.broker.revoke(credential);
		}
	} finally {
		lease.release();
	}
}

export async function destroyResource(
	deps: ResourceActorDeps,
	resource: ResourcePlan,
	ctx: ReconcileContext,
): Promise<
	| { kind: "destroyed" | "converged"; snapshot: ResourceActorSnapshot }
	| { kind: "failed"; snapshot: ResourceActorSnapshot; reason: string }
> {
	const key = resourceActorKey(ctx.deploymentId, resource.name);
	const lease = deps.actorHost.acquire(key, {
		holderId: `resource-actor:${key}`,
	});
	try {
		const stream = streamId(ctx.deploymentId);
		let events = await collectStream(deps.store, stream);
		let snapshot = foldResourceActor(events, {
			...resource,
			deploymentId: ctx.deploymentId,
		});
		if (snapshot.state === "Destroyed") return { kind: "converged", snapshot };

		const fenceToken = currentFenceToken(deps.store, stream);
		const appendOpts = {
			actor: ctx.actor,
			tenant: ctx.tenant,
			...(fenceToken !== undefined ? { fenceToken } : undefined),
			...(ctx.correlationId !== undefined
				? { correlationId: ctx.correlationId }
				: undefined),
		};
		let lastSeq =
			events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;

		const program = iacProgramFor(
			ctx.deploymentId,
			resource,
			"destroy",
			ctx.tenant,
		);
		const credential = deps.broker.issue({
			scope: credentialScope({
				tenant: ctx.tenant,
				resourceId: resource.name,
				driver: program.driver,
				action: "destroy",
			}),
		});
		try {
			const result = await deps.executor.run(program, credential);
			if (result.status === "failed") {
				events = await collectStream(deps.store, stream);
				snapshot = foldResourceActor(events, {
					...resource,
					deploymentId: ctx.deploymentId,
				});
				return { kind: "failed", snapshot, reason: result.reason };
			}
			const emitted = await emit(
				deps.store,
				stream,
				[
					resourceDestroyed({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						finalStateHash: finalStateHash(resource.name),
					}),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			lastSeq = emitted.seq;
			events = await collectStream(deps.store, stream);
			snapshot = foldResourceActor(events, {
				...resource,
				deploymentId: ctx.deploymentId,
			});
			return { kind: "destroyed", snapshot };
		} finally {
			deps.broker.revoke(credential);
		}
	} finally {
		lease.release();
	}
}
