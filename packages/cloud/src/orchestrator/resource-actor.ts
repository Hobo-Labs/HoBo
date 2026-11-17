import { createHash, randomUUID } from "node:crypto";

import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import type { ActorHost } from "@hobo/data";
import { emit } from "@hobo/events";
import {
	CLOUD_EVENTS,
	execDiff,
	execSucceeded,
	type ResourceFailedData,
	resourceDestroyed,
	resourceDestroying,
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
	iacExecutionId,
} from "../executor/executor.js";
import { isJsonObject, isJsonString } from "../json.js";
import type { ResourcePlan } from "../plan-types.js";
import { currentFenceToken } from "../store/index.js";
import {
	requireApplyOpen,
	requireDestroyAllowed,
} from "./deployment-transition.js";
import {
	type BlockedProviderMove,
	blockedProviderMove,
	desiredSpecHash,
	hasDestroyProvenance,
	recordedResources,
} from "./desired-state.js";
import { readDeploymentHistory } from "./history-scope.js";

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
	"ReconciliationRequired",
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
	/**
	 * Hash of the desired spec the resource was last provisioned from
	 * (`desiredSpecHash`). Absent before the first Provisioned fact, and on
	 * facts written before spec hashes were recorded.
	 */
	specHash?: string;
}

export function resourceActorKey(
	deploymentId: string,
	resourceId: string,
): string {
	return `resource:${deploymentId}:${resourceId}`;
}

/** Find unresolved effects even when the latest plan no longer declares them. */
export function hasUnresolvedReconciliation(
	events: readonly EventEnvelope[],
): boolean {
	const unresolved = new Map<string, Set<string>>();
	for (const event of events) {
		if (!isJsonObject(event.data) || !isJsonString(event.data.resourceId))
			continue;
		const resourceId = event.data.resourceId;
		if (
			event.type === CLOUD_EVENTS.ResourceFailed &&
			event.data.requiresReconciliation === true
		) {
			const failures = unresolved.get(resourceId) ?? new Set<string>();
			failures.add(event.id);
			unresolved.set(resourceId, failures);
		} else if (
			event.type === CLOUD_EVENTS.ResourceReconciled &&
			isJsonString(event.data.outcome) &&
			["applied", "destroyed", "no-effect"].includes(event.data.outcome) &&
			(event.data.outcome !== "no-effect" ||
				(isJsonString(event.data.restoredState) &&
					["provisioned", "destroyed", "failed"].includes(
						event.data.restoredState,
					))) &&
			isJsonString(event.data.failureEventId)
		) {
			const failures = unresolved.get(resourceId);
			failures?.delete(event.data.failureEventId);
			if (failures?.size === 0) unresolved.delete(resourceId);
		}
	}
	return unresolved.size > 0;
}

// Fold a resource's own facts (filtered from the deployment stream) into its FSM
// snapshot. Authoritative state is derived, never stored — this is what makes the
// actor crash-resumable: drop in-memory state, replay the log, resume.
export function foldResourceActor(
	events: Iterable<EventEnvelope>,
	resource: ResourcePlan,
): ResourceActorSnapshot {
	const history = Array.isArray(events) ? events : [...events];
	const snapshot: ResourceActorSnapshot = {
		deploymentId: resource.deploymentId ?? "",
		resourceId: resource.name,
		state: "Pending",
		sequence: 0,
		outputs: {},
		deps: [...resource.deps],
	};
	const unresolvedIds = new Set<string>();

	for (const event of history) {
		// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
		const data = event.data as {
			resourceId?: string;
			outputs?: Record<string, string>;
			specHash?: string;
			requiresReconciliation?: boolean;
			failureEventId?: string;
			outcome?: string;
			restoredState?: string;
		};
		if (data.resourceId !== resource.name) continue;
		switch (event.type) {
			case CLOUD_EVENTS.ResourceProvisioning:
				if (snapshot.state === "ReconciliationRequired") {
					snapshot.sequence += 1;
					break;
				}
				// Re-applying a provisioned resource is an in-place update (upsert);
				// its outputs stay readable until the new apply replaces them.
				snapshot.state =
					snapshot.state === "Provisioned" || snapshot.state === "Updating"
						? "Updating"
						: "Provisioning";
				snapshot.sequence += 1;
				break;
			case CLOUD_EVENTS.ResourceProvisioned:
				if (unresolvedIds.size > 0) {
					snapshot.sequence += 1;
					break;
				}
				snapshot.state = "Provisioned";
				snapshot.sequence += 1;
				if (data.outputs) snapshot.outputs = { ...data.outputs };
				if (isJsonString(data.specHash)) snapshot.specHash = data.specHash;
				else delete snapshot.specHash;
				break;
			case CLOUD_EVENTS.ResourceFailed:
				if (
					snapshot.state === "ReconciliationRequired" &&
					data.requiresReconciliation !== true
				) {
					snapshot.sequence += 1;
					break;
				}
				snapshot.state =
					data.requiresReconciliation === true
						? "ReconciliationRequired"
						: "Failed";
				if (data.requiresReconciliation === true) unresolvedIds.add(event.id);
				snapshot.sequence += 1;
				break;
			case CLOUD_EVENTS.ResourceReconciled:
				if (
					snapshot.state === "ReconciliationRequired" &&
					data.outcome !== undefined &&
					["applied", "destroyed", "no-effect"].includes(data.outcome) &&
					(data.outcome !== "no-effect" ||
						(data.restoredState !== undefined &&
							["provisioned", "destroyed", "failed"].includes(
								data.restoredState,
							))) &&
					data.failureEventId !== undefined &&
					unresolvedIds.has(data.failureEventId)
				) {
					unresolvedIds.delete(data.failureEventId);
					if (unresolvedIds.size === 0) {
						if (data.outcome === "applied") {
							snapshot.state = "Provisioned";
							if (data.outputs) snapshot.outputs = { ...data.outputs };
							if (isJsonString(data.specHash))
								snapshot.specHash = data.specHash;
							else delete snapshot.specHash;
						} else if (data.outcome === "destroyed") {
							snapshot.state = "Destroyed";
							snapshot.outputs = {};
							delete snapshot.specHash;
						} else if (data.outcome === "no-effect") {
							if (data.restoredState === "provisioned")
								snapshot.state = "Provisioned";
							else if (data.restoredState === "destroyed") {
								snapshot.state = "Destroyed";
								snapshot.outputs = {};
								delete snapshot.specHash;
							} else snapshot.state = "Failed";
						}
					}
					snapshot.sequence += 1;
				}
				break;
			case CLOUD_EVENTS.ResourceDestroying:
				if (snapshot.state === "ReconciliationRequired") {
					snapshot.sequence += 1;
					break;
				}
				snapshot.state = "Destroying";
				snapshot.sequence += 1;
				break;
			case CLOUD_EVENTS.ResourceDestroyed:
				if (unresolvedIds.size > 0) {
					snapshot.sequence += 1;
					break;
				}
				snapshot.state = "Destroyed";
				snapshot.sequence += 1;
				snapshot.outputs = {};
				delete snapshot.specHash;
				break;
			default:
				break;
		}
	}
	// Old facts have no hash. When their original plan is in the log, derive
	// the baseline from that plan rather than ignoring every subsequent change.
	if (snapshot.state === "Provisioned" && snapshot.specHash === undefined) {
		const recordedHash = recordedResources(history).get(
			resource.name,
		)?.specHash;
		if (recordedHash !== undefined) snapshot.specHash = recordedHash;
	}
	return snapshot;
}

export interface ResourceActorDeps {
	store: EventStore;
	actorHost: ActorHost;
	executor: Executor;
	broker: CredentialBroker;
	/** Trusted host guarantees this generation cannot overlap or duplicate prior effects. */
	verifyResume?: (input: {
		readonly tenant: string;
		readonly deploymentId: string;
		readonly resourceId: string;
		readonly action: "apply" | "destroy";
		readonly operationGeneration: string;
		readonly programHash: string;
		readonly specHash: string;
	}) => boolean | Promise<boolean>;
}

export interface ReconcileContext {
	deploymentId: string;
	tenant: string;
	actor: PrincipalRef;
	correlationId?: string;
	destroyReason?: string;
	// A resource whose apply crosses the no-go threshold triggers choreographed
	// compensation (control-plane.md "Compensation"). Tests seed this set.
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
	| { kind: "reconciliation-required"; snapshot: ResourceActorSnapshot }
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

/** A generation cannot be reused within a deployment's durable history. */
function newOperationGeneration(events: readonly EventEnvelope[]): string {
	const prior = new Set<string>();
	for (const event of events)
		if (
			isJsonObject(event.data) &&
			isJsonString(event.data.operationGeneration)
		)
			prior.add(event.data.operationGeneration);
	for (let attempt = 0; attempt < 4; attempt++) {
		const value = randomUUID();
		if (!prior.has(value)) return value;
	}
	throw new Error("operation generation could not be allocated");
}

function operationGeneration(
	event: EventEnvelope | undefined,
	input: {
		type: string;
		tenant: string;
		deploymentId: string;
		resourceId: string;
		programHash: string;
		specHash: string;
	},
): string | undefined {
	if (
		event?.type !== input.type ||
		event.tenant !== input.tenant ||
		!isJsonObject(event.data) ||
		event.data.deploymentId !== input.deploymentId ||
		event.data.resourceId !== input.resourceId ||
		event.data.programHash !== input.programHash ||
		event.data.specHash !== input.specHash ||
		!isJsonString(event.data.operationGeneration) ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			event.data.operationGeneration,
		)
	)
		return undefined;
	return event.data.operationGeneration;
}

function latestOperation(
	events: readonly EventEnvelope[],
	type: string,
	resourceId: string,
): EventEnvelope | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (
			event &&
			event.type === type &&
			isJsonObject(event.data) &&
			event.data.resourceId === resourceId
		)
			return event;
	}
	return undefined;
}

/** Return only the generation bound to this exact durable in-flight apply. */
export function pendingApplyGeneration(
	events: readonly EventEnvelope[],
	resource: ResourcePlan,
	ctx: Pick<ReconcileContext, "tenant" | "deploymentId">,
): string | undefined {
	const program = iacProgramFor(
		ctx.deploymentId,
		resource,
		"apply",
		ctx.tenant,
	);
	const programHash = `sha256:${createHash("sha256").update(JSON.stringify(program)).digest("hex")}`;
	const pending = latestOperation(
		events,
		CLOUD_EVENTS.ResourceProvisioning,
		resource.name,
	);
	const generation = operationGeneration(pending, {
		type: CLOUD_EVENTS.ResourceProvisioning,
		tenant: ctx.tenant,
		deploymentId: ctx.deploymentId,
		resourceId: resource.name,
		programHash,
		specHash: desiredSpecHash(resource),
	});
	if (
		generation === undefined ||
		!isJsonObject(pending?.data) ||
		pending.data.providerId !== resource.provider ||
		pending.data.execId !==
			iacExecutionId({ ...program, operationGeneration: generation })
	)
		return undefined;
	return generation;
}

function streamId(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

function finalStateHash(resourceId: string): string {
	return `sha256:${createHash("sha256").update(resourceId).digest("hex")}`;
}

/**
 * True when a resource's recorded state already matches its declaration, so
 * reconciling it must call no provider: it is Provisioned from the same
 * desired spec, or Provisioned by a legacy fact whose original plan is not
 * available (treated as converged rather than guessing what was applied).
 */
export function isConverged(
	snapshot: ResourceActorSnapshot,
	resource: ResourcePlan,
): boolean {
	if (snapshot.state !== "Provisioned") return false;
	return (
		snapshot.specHash === undefined ||
		snapshot.specHash === desiredSpecHash(resource)
	);
}

// The reconcile core records the generation before dispatch under the resource
// lease. After a crash, the same generation is dispatched again only when a
// trusted host verifies that replay cannot overlap or duplicate an old effect;
// otherwise the actor records a reconciliation-required failure.
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
		let events = await readDeploymentHistory(
			deps.store,
			ctx.deploymentId,
			ctx.tenant,
		);
		requireApplyOpen(events, resource);
		let snapshot = foldResourceActor(events, {
			...resource,
			deploymentId: ctx.deploymentId,
		});
		// Recheck under the actor lease: another reconciliation may have
		// recorded an apply since the orchestrator inspected its snapshot.
		const move = blockedProviderMove(
			recordedResources(events).get(resource.name),
			resource,
		);
		if (move) return { kind: "blocked", snapshot, move };

		// Converged: nothing to do (empty diff — the controller no-op). A
		// Destroyed resource is not converged: `up` declares it should exist, so
		// it is re-created. A Provisioned one whose declared spec changed is
		// updated in place (upsert).
		if (isConverged(snapshot, resource)) {
			return { kind: "converged", snapshot };
		}
		const updating =
			snapshot.state === "Provisioned" || snapshot.state === "Updating";
		const specHash = desiredSpecHash(resource);
		if (snapshot.state === "ReconciliationRequired") {
			return { kind: "reconciliation-required", snapshot };
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
		if (snapshot.state === "Destroying") {
			await emit(
				deps.store,
				stream,
				[
					resourceFailed({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						reason: "an interrupted destroy must be reconciled before apply",
						classification: "fatal",
						crossedNoGoThreshold: false,
						requiresReconciliation: true,
						reconciliationOperation: "destroy",
					}),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
			snapshot = foldResourceActor(events, {
				...resource,
				deploymentId: ctx.deploymentId,
			});
			return { kind: "reconciliation-required", snapshot };
		}

		// Transition Pending/Planning → Provisioning (durable boundary) unless we
		// are resuming an already-in-flight Provisioning after a crash.
		const program = iacProgramFor(
			ctx.deploymentId,
			resource,
			"apply",
			ctx.tenant,
		);
		const programHash = `sha256:${createHash("sha256").update(JSON.stringify(program)).digest("hex")}`;
		const operationScope = {
			type: CLOUD_EVENTS.ResourceProvisioning,
			tenant: ctx.tenant,
			deploymentId: ctx.deploymentId,
			resourceId: resource.name,
			programHash,
			specHash,
		};
		let pending = latestOperation(events, operationScope.type, resource.name);
		const resuming =
			snapshot.state === "Provisioning" || snapshot.state === "Updating";
		if (!resuming) {
			const generation = newOperationGeneration(events);
			const emitted = await emit(
				deps.store,
				stream,
				[
					resourceProvisioning({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						execId: iacExecutionId({
							...program,
							operationGeneration: generation,
						}),
						programHash,
						specHash,
						providerId: resource.provider,
						operationGeneration: generation,
					}),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			const recorded = emitted.appended[0];
			if (
				emitted.appended.length !== 1 ||
				recorded === undefined ||
				recorded.seq !== lastSeq + 1
			)
				throw new Error("operation start acknowledgement is invalid");
			lastSeq = emitted.seq;
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
			pending = events.find(
				(event) => event.id === recorded.id && event.seq === recorded.seq,
			);
			if (operationGeneration(pending, operationScope) !== generation)
				throw new Error("operation start could not be confirmed");
		}
		const generation = pendingApplyGeneration(events, resource, ctx);
		let replaySafe = !resuming;
		if (resuming && generation !== undefined) {
			try {
				replaySafe =
					(await deps.verifyResume?.({
						tenant: ctx.tenant,
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						action: "apply",
						operationGeneration: generation,
						programHash,
						specHash,
					})) === true;
			} catch {
				replaySafe = false;
			}
		}
		if (generation === undefined || !replaySafe) {
			await emit(
				deps.store,
				stream,
				[
					resourceFailed({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						reason:
							"in-flight apply identity, specification or safe replay is unverified",
						classification: "fatal",
						crossedNoGoThreshold: false,
						requiresReconciliation: true,
						reconciliationOperation: "apply",
					}),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
			snapshot = foldResourceActor(events, {
				...resource,
				deploymentId: ctx.deploymentId,
			});
			return { kind: "reconciliation-required", snapshot };
		}
		program.operationGeneration = generation;
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
			// Dispatch the IacProgram to the sandboxed Executor (preview → apply).
			const result = await deps.executor.run(program, credential);

			if (result.status === "failed") {
				const crossed =
					result.requiresReconciliation === true
						? false
						: (ctx.noGoThresholdResources?.has(resource.name) ??
							result.classification === "fatal");
				const failureBase = {
					deploymentId: ctx.deploymentId,
					resourceId: resource.name,
					reason: result.reason,
				};
				const failure: ResourceFailedData =
					result.requiresReconciliation === true
						? {
								...failureBase,
								classification: "fatal",
								crossedNoGoThreshold: false,
								requiresReconciliation: true,
								reconciliationOperation: "apply",
							}
						: {
								...failureBase,
								classification: result.classification,
								crossedNoGoThreshold: crossed,
							};
				if (
					failure.requiresReconciliation === true &&
					result.reservationId !== undefined
				)
					failure.reservationId = result.reservationId;
				const emitted = await emit(
					deps.store,
					stream,
					[
						tokenGranted(grant),
						resourceFailed(failure),
						tokenRevoked({ grantId: grant.grantId, reason: "apply failed" }),
					],
					{ expectedSeq: lastSeq, ...appendOpts },
				);
				lastSeq = emitted.seq;
				events = await readDeploymentHistory(
					deps.store,
					ctx.deploymentId,
					ctx.tenant,
				);
				snapshot = foldResourceActor(events, {
					...resource,
					deploymentId: ctx.deploymentId,
				});
				if (result.requiresReconciliation === true)
					return { kind: "reconciliation-required", snapshot };
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
						specHash,
					}),
					tokenUsed({ grantId: grant.grantId }),
					tokenRevoked({ grantId: grant.grantId, reason: "apply complete" }),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			lastSeq = emitted.seq;
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
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
		let events = await readDeploymentHistory(
			deps.store,
			ctx.deploymentId,
			ctx.tenant,
		);
		requireDestroyAllowed(events, resource.name);
		let snapshot = foldResourceActor(events, {
			...resource,
			deploymentId: ctx.deploymentId,
		});
		if (snapshot.state === "Destroyed") return { kind: "converged", snapshot };
		if (snapshot.state === "ReconciliationRequired")
			return {
				kind: "failed",
				snapshot,
				reason: "reconciliation required before destroy",
			};

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
		if (snapshot.state === "Provisioning" || snapshot.state === "Updating") {
			await emit(
				deps.store,
				stream,
				[
					resourceFailed({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						reason: "an interrupted apply must be reconciled before destroy",
						classification: "fatal",
						crossedNoGoThreshold: false,
						requiresReconciliation: true,
						reconciliationOperation: "apply",
					}),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
			snapshot = foldResourceActor(events, {
				...resource,
				deploymentId: ctx.deploymentId,
			});
			return {
				kind: "failed",
				snapshot,
				reason: "reconciliation required before destroy",
			};
		}
		if (
			!hasDestroyProvenance(
				recordedResources(events).get(resource.name),
				resource,
			)
		) {
			if (snapshot.state === "Destroying") {
				await emit(
					deps.store,
					stream,
					[
						resourceFailed({
							deploymentId: ctx.deploymentId,
							resourceId: resource.name,
							reason:
								"in-flight destroy provenance does not match the requested target",
							classification: "fatal",
							crossedNoGoThreshold: false,
							requiresReconciliation: true,
							reconciliationOperation: "destroy",
						}),
					],
					{ expectedSeq: lastSeq, ...appendOpts },
				);
				events = await readDeploymentHistory(
					deps.store,
					ctx.deploymentId,
					ctx.tenant,
				);
				snapshot = foldResourceActor(events, {
					...resource,
					deploymentId: ctx.deploymentId,
				});
			}
			return {
				kind: "failed",
				snapshot,
				reason:
					"recorded resource provenance does not match the destroy target",
			};
		}

		const program = iacProgramFor(
			ctx.deploymentId,
			resource,
			"destroy",
			ctx.tenant,
		);
		const programHash = `sha256:${createHash("sha256").update(JSON.stringify(program)).digest("hex")}`;
		const specHash = desiredSpecHash(resource);
		const operationScope = {
			type: CLOUD_EVENTS.ResourceDestroying,
			tenant: ctx.tenant,
			deploymentId: ctx.deploymentId,
			resourceId: resource.name,
			programHash,
			specHash,
		};
		let pending = latestOperation(events, operationScope.type, resource.name);
		const resuming = snapshot.state === "Destroying";
		if (!resuming) {
			const generation = newOperationGeneration(events);
			const emitted = await emit(
				deps.store,
				stream,
				[
					resourceDestroying({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						reason: ctx.destroyReason ?? "destroy",
						operationGeneration: generation,
						programHash,
						specHash,
					}),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			const recorded = emitted.appended[0];
			if (
				emitted.appended.length !== 1 ||
				recorded === undefined ||
				recorded.seq !== lastSeq + 1
			)
				throw new Error("operation start acknowledgement is invalid");
			lastSeq = emitted.seq;
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
			pending = events.find(
				(event) => event.id === recorded.id && event.seq === recorded.seq,
			);
			if (operationGeneration(pending, operationScope) !== generation)
				throw new Error("operation start could not be confirmed");
		}
		const generation = operationGeneration(pending, operationScope);
		let replaySafe = !resuming;
		if (resuming && generation !== undefined) {
			try {
				replaySafe =
					(await deps.verifyResume?.({
						tenant: ctx.tenant,
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						action: "destroy",
						operationGeneration: generation,
						programHash,
						specHash,
					})) === true;
			} catch {
				replaySafe = false;
			}
		}
		if (generation === undefined || !replaySafe) {
			await emit(
				deps.store,
				stream,
				[
					resourceFailed({
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						reason:
							"in-flight destroy identity, specification or safe replay is unverified",
						classification: "fatal",
						crossedNoGoThreshold: false,
						requiresReconciliation: true,
						reconciliationOperation: "destroy",
					}),
				],
				{ expectedSeq: lastSeq, ...appendOpts },
			);
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
			snapshot = foldResourceActor(events, {
				...resource,
				deploymentId: ctx.deploymentId,
			});
			return {
				kind: "failed",
				snapshot,
				reason: "reconciliation required before destroy",
			};
		}
		program.operationGeneration = generation;
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
				if (result.requiresReconciliation === true) {
					const failure: ResourceFailedData = {
						deploymentId: ctx.deploymentId,
						resourceId: resource.name,
						reason: result.reason,
						classification: "fatal",
						crossedNoGoThreshold: false,
						requiresReconciliation: true,
						reconciliationOperation: "destroy",
					};
					if (result.reservationId !== undefined)
						failure.reservationId = result.reservationId;
					const emitted = await emit(
						deps.store,
						stream,
						[resourceFailed(failure)],
						{ expectedSeq: lastSeq, ...appendOpts },
					);
					lastSeq = emitted.seq;
				}
				events = await readDeploymentHistory(
					deps.store,
					ctx.deploymentId,
					ctx.tenant,
				);
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
			events = await readDeploymentHistory(
				deps.store,
				ctx.deploymentId,
				ctx.tenant,
			);
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
