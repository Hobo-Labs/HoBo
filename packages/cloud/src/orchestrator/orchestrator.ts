import type { EventEnvelope, EventStore, PrincipalRef } from "@hobo/core";
import type { ActorHost } from "@hobo/data";
import { emit } from "@hobo/events";

import { CLOUD_EVENTS, deploymentDeployed } from "../events.js";
import type { CredentialBroker, Executor } from "../executor/executor.js";
import type { DeploymentPlan, ResourcePlan } from "../plan-types.js";
import { collectStream, currentFenceToken } from "../store/index.js";
import { type CompensationResult, runCompensation } from "./compensation.js";
import {
	changedSinceLastDeployed,
	currentEpochStart,
	type DeploymentChangeSet,
	type DeploymentMode,
	orphansToPrune,
	planDeploymentChanges,
} from "./desired-state.js";
import {
	destroyResource,
	foldResourceActor,
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
	states: Map<string, ResourceActorState>,
): boolean {
	return resource.deps.every((dep) => states.get(dep) === "Provisioned");
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
	const initialEvents = await collectStream(deps.store, stream);
	// This run's epoch: facts after the last Deployed/RolledBack. Earlier
	// failures belong to an `up` that already ended.
	const epochStart = currentEpochStart(initialEvents);
	const changes = planDeploymentChanges(plan, initialEvents, mode);
	// Each resource is applied at most once per run: a retryable failure is
	// reported as `waiting`, not retried in a hot loop.
	const attempted = new Set<string>();

	while (progressed) {
		progressed = false;
		const events = await collectStream(deps.store, stream);
		const snapshots = resourceSnapshots(events, plan, deploymentId);
		const states = new Map(
			[...snapshots].map(([name, snapshot]) => [name, snapshot.state]),
		);

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
			if (!depsProvisioned(resource, states)) continue;
			attempted.add(resource.name);

			const outcome = await reconcileResource(
				actorDeps,
				{ ...resource, deploymentId },
				reconcileCtx,
			);
			progressed = true;
			if (outcome.kind === "failed" && outcome.crossedNoGoThreshold) {
				triggeringFailure = {
					resourceId: resource.name,
					reason: outcome.reason,
				};
			}
			// Re-fold from the log on the next while-iteration (level-triggered).
			break;
		}

		if (triggeringFailure) break;
	}

	let events = await collectStream(deps.store, stream);
	let states = resourceStates(events, plan, deploymentId);

	// Compensation path: a no-go failure triggers deployment.RolledBack + reverse
	// dependency-order destroys.
	if (triggeringFailure) {
		const compensation = await runCompensation(
			{
				store: deps.store,
				actorHost: deps.actorHost,
				executor: deps.executor,
				broker: deps.broker,
			},
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
		events = await collectStream(deps.store, stream);
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
	const pruned: string[] = [];
	let unprunable: string[] = [];
	const declaredConverged = plan.resources.every(
		(r) => states.get(r.name) === "Provisioned",
	);
	if (mode === "complete" && declaredConverged) {
		const orphans = orphansToPrune(plan, events);
		unprunable = [...orphans.unknown];
		for (const orphan of orphans.ordered) {
			const outcome = await destroyResource(
				actorDeps,
				{ ...orphan, deploymentId },
				reconcileCtx,
			);
			if (outcome.kind === "failed") {
				unprunable.push(orphan.name);
				continue;
			}
			if (outcome.kind === "destroyed") pruned.push(orphan.name);
		}
		if (pruned.length > 0) {
			events = await collectStream(deps.store, stream);
			states = resourceStates(events, plan, deploymentId);
		}
	}

	// All actors Provisioned → drive deployment.Deployed (choreography terminal).
	const allProvisioned = plan.resources.every(
		(r) => states.get(r.name) === "Provisioned",
	);
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
		events = await collectStream(deps.store, stream);
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
