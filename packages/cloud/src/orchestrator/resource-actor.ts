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

// The ResourceActor reconciliation FSM (control-plane.md "The ResourceActor
// reconciliation FSM"). Each resource in a plan gets a durable virtual actor
// keyed `resource:<deployment>:<name>`; its job is to converge observed → desired
// idempotently, surviving crashes by replaying its own event stream. This module
// is the actor's fold (state derived only from facts) and its reconcile loop
// (single-writer lease + fencing via the ActorHost port, then Executor dispatch).

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

// domain-view: parsed ResourceActorSnapshot; wire form is ResourceActorSnapshot in data-models/cloud.proto.
export interface ResourceActorSnapshot {
	deploymentId: string;
	resourceId: string;
	state: ResourceActorState;
	sequence: number;
	outputs: Record<string, string>;
	deps: string[];
}

export function resourceActorKey(
	deploymentId: string,
	resourceId: string,
): string {
	return `resource:${deploymentId}:${resourceId}`;
}

// Fold a resource's own facts (filtered from the deployment stream) into its FSM
// snapshot. Authoritative state is derived, never stored — this is what makes the
// actor crash-resumable: drop in-memory state, replay the log, resume.
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
		// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
		const data = event.data as {
			resourceId?: string;
			outputs?: Record<string, string>;
		};
		if (data.resourceId !== resource.name) continue;
		switch (event.type) {
			case CLOUD_EVENTS.ResourceProvisioning:
				snapshot.state = "Provisioning";
				snapshot.sequence += 1;
				break;
			case CLOUD_EVENTS.ResourceProvisioned:
				snapshot.state = "Provisioned";
				snapshot.sequence += 1;
				if (data.outputs) snapshot.outputs = { ...data.outputs };
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
	// A resource whose apply crosses the no-go threshold triggers choreographed
	// compensation (control-plane.md "Compensation"). Tests seed this set.
	noGoThresholdResources?: ReadonlySet<string>;
}

export type ReconcileOutcome =
	| { kind: "converged"; snapshot: ResourceActorSnapshot }
	| { kind: "provisioned"; snapshot: ResourceActorSnapshot; execId: string }
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
	};
}

function streamId(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

function finalStateHash(resourceId: string): string {
	return `sha256:${createHash("sha256").update(resourceId).digest("hex")}`;
}

// The idempotent reconcile core (control-plane.md reconcile loop). Runs under the
// per-resource single-writer lease (ActorHost fencing). Because it emits
// resource.Provisioning to the durable log BEFORE dispatching apply, a crash
// between "provisioning" and "provisioned" is recoverable: on resume the fold
// sees Provisioning and re-dispatches the (idempotent) apply through to
// resource.Provisioned.
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

		// Converged: nothing to do (empty diff — the controller no-op).
		if (snapshot.state === "Provisioned" || snapshot.state === "Destroyed") {
			return { kind: "converged", snapshot };
		}

		const fenceToken = currentFenceToken(deps.store, stream);
		const appendOpts = {
			actor: ctx.actor,
			tenant: ctx.tenant,
			// The deployment stream may already be fenced by an earlier leased
			// write; continue it under the current owner epoch (no rotation).
			...(fenceToken !== undefined ? { fenceToken } : undefined),
			...(ctx.correlationId !== undefined
				? { correlationId: ctx.correlationId }
				: undefined),
		};
		let lastSeq =
			// SAFETY: `events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;` is required at this I/O or test boundary.
			events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;

		// Transition Pending/Planning → Provisioning (durable boundary) unless we
		// are resuming an already-in-flight Provisioning after a crash.
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
		// Credential-audit metadata (NFR-018): the grant is recorded as a
		// `token.Granted` fact, then `token.Used` on a successful apply and
		// `token.Revoked` when the scoped credential is dropped — a full,
		// replayable grant -> use -> revoke trail correlated by correlationId.
		const grant = {
			grantId: credential.id,
			tokenRef: `tokenref://scoped/${credential.id}`,
			...(ctx.actor?.id !== undefined ? { svidSubject: ctx.actor.id } : undefined),
			scope: {
				port: resource.port,
				resource: resource.name,
				action: "apply",
			},
		};

		try {
			if (snapshot.state !== "Provisioning") {
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
						}),
					],
					{ expectedSeq: lastSeq, ...appendOpts },
				);
				lastSeq = emitted.seq;
			}

			// Dispatch the IacProgram to the sandboxed Executor (preview → apply).
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

			// exec.Succeeded → record outputs, emit resource.Provisioned.
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
			return { kind: "provisioned", snapshot, execId: result.execId };
		} finally {
			deps.broker.revoke(credential);
		}
	} finally {
		lease.release();
	}
}

// Destroy a provisioned resource under its lease (choreographed compensation).
export async function destroyResource(
	deps: ResourceActorDeps,
	resource: ResourcePlan,
	ctx: ReconcileContext,
): Promise<{
	kind: "destroyed" | "converged" | "failed";
	snapshot: ResourceActorSnapshot;
	reason?: string;
}> {
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
			// Same fenced-stream rule as reconcile: continue under the current
			// owner epoch.
			...(fenceToken !== undefined ? { fenceToken } : undefined),
			...(ctx.correlationId !== undefined
				? { correlationId: ctx.correlationId }
				: undefined),
		};
		let lastSeq =
			// SAFETY: `events.length > 0 ? (events[events.length - 1] as EventEnvelope).seq : 0;` is required at this I/O or test boundary.
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
