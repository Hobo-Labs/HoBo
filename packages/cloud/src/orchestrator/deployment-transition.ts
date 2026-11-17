import { createHash, randomUUID } from "node:crypto";
import type { EventEnvelope } from "@hobo/core";
import { CLOUD_EVENTS, type DeploymentTransitionData } from "../events.js";
import { isJsonObject, isJsonString } from "../json.js";
import type { DeploymentPlan, ResourcePlan } from "../plan-types.js";
import { desiredSpecHash } from "./desired-state.js";

export class DeploymentTransitionError extends Error {
	readonly code = "DEPLOYMENT_TRANSITION_BLOCKED";
	constructor(message: string) {
		super(message);
		this.name = "DeploymentTransitionError";
	}
}

type OpenState = {
	readonly status: "open";
	readonly reopenedPlanHash?: string;
	readonly reopenedResources?: ReadonlyMap<string, string>;
};
export type DeploymentTransitionState =
	| OpenState
	| {
			readonly status: "active";
			readonly transition: DeploymentTransitionData;
			readonly previousOpen: OpenState;
	  }
	| {
			readonly status: "closed";
			readonly rollbackEventId: string;
			readonly legacy: boolean;
	  };

export function deploymentPlanHash(plan: DeploymentPlan): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
}

export function newTransitionId(events: readonly EventEnvelope[]): string {
	const used = new Set<string>();
	for (const event of events)
		if (
			event.type === CLOUD_EVENTS.DeploymentTransitionStarted &&
			isJsonObject(event.data) &&
			isJsonString(event.data.transitionId)
		)
			used.add(event.data.transitionId);
	for (let attempt = 0; attempt < 4; attempt++) {
		const id = randomUUID();
		if (!used.has(id)) return id;
	}
	throw new DeploymentTransitionError(
		"deployment transition identity could not be allocated",
	);
}

export function transitionResourceNames(plan: DeploymentPlan): string[] {
	const names = plan.resources.map((resource) => resource.name);
	if (
		names.length > 256 ||
		new Set(names).size !== names.length ||
		names.some(
			(name) =>
				!isJsonString(name) ||
				name.length === 0 ||
				name.length > 200 ||
				name.trim() !== name ||
				/[\p{Cc}]/u.test(name),
		)
	)
		throw new DeploymentTransitionError(
			"deployment transition resource set is invalid",
		);
	return names.sort();
}

function parseTransition(event: EventEnvelope): DeploymentTransitionData {
	const data = event.data;
	if (
		!isJsonObject(data) ||
		!isJsonString(data.deploymentId) ||
		!isJsonString(data.transitionId) ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
			data.transitionId,
		) ||
		(data.kind !== "rollback" && data.kind !== "prune") ||
		!isJsonString(data.planHash) ||
		!/^sha256:[a-f0-9]{64}$/u.test(data.planHash) ||
		!Array.isArray(data.resourceIds) ||
		data.resourceIds.length > 256 ||
		!data.resourceIds.every(
			(id) => isJsonString(id) && id.length > 0 && id.length <= 200,
		) ||
		new Set(data.resourceIds).size !== data.resourceIds.length ||
		(data.kind === "rollback" &&
			(!isJsonString(data.triggerResource) || !isJsonString(data.reason)))
	)
		throw new DeploymentTransitionError(
			"deployment transition fact is malformed",
		);
	const result: DeploymentTransitionData = {
		deploymentId: data.deploymentId,
		transitionId: data.transitionId,
		kind: data.kind,
		planHash: data.planHash,
		resourceIds: data.resourceIds.filter(isJsonString),
	};
	if (isJsonString(data.triggerResource))
		result.triggerResource = data.triggerResource;
	if (isJsonString(data.reason)) result.reason = data.reason;
	return result;
}

/** Fold the durable CAS barrier; invalid or incomplete histories fail closed. */
export function foldDeploymentTransition(
	events: readonly EventEnvelope[],
): DeploymentTransitionState {
	let state: DeploymentTransitionState = { status: "open" };
	let completingRollback = false;
	const transitionIds = new Set<string>();
	const pendingApplies = new Set<string>();
	const unresolvedFailures = new Set<string>();
	for (const event of events) {
		if (completingRollback && event.type !== CLOUD_EVENTS.DeploymentRolledBack)
			throw new DeploymentTransitionError("rollback completion is incomplete");
		if (
			event.type === CLOUD_EVENTS.ResourceProvisioning &&
			state.status !== "open"
		)
			throw new DeploymentTransitionError(
				"apply started while a deployment transition blocked it",
			);
		if (
			event.type === CLOUD_EVENTS.ResourceDestroying &&
			(state.status === "closed" ||
				(state.status === "active" &&
					(!isJsonObject(event.data) ||
						!isJsonString(event.data.resourceId) ||
						!state.transition.resourceIds.includes(event.data.resourceId))))
		)
			throw new DeploymentTransitionError(
				"destroy started outside the active transition",
			);
		if (
			event.type === CLOUD_EVENTS.DeploymentDeployed &&
			state.status !== "open"
		)
			throw new DeploymentTransitionError(
				"deployment completed while a transition blocked it",
			);
		if (event.type === CLOUD_EVENTS.DeploymentTransitionStarted) {
			if (state.status !== "open")
				throw new DeploymentTransitionError(
					"another deployment transition is active",
				);
			if (pendingApplies.size > 0 || unresolvedFailures.size > 0)
				throw new DeploymentTransitionError(
					"deployment transition started while an effect was unresolved",
				);
			const transition = parseTransition(event);
			if (transitionIds.has(transition.transitionId))
				throw new DeploymentTransitionError(
					"deployment transition identity was reused",
				);
			transitionIds.add(transition.transitionId);
			state = {
				status: "active",
				transition,
				previousOpen: state,
			};
		} else if (event.type === CLOUD_EVENTS.DeploymentTransitionCompleted) {
			const completed = parseTransition(event);
			if (
				state.status !== "active" ||
				JSON.stringify(state.transition) !== JSON.stringify(completed)
			)
				throw new DeploymentTransitionError(
					"deployment transition completion does not match its start",
				);
			if (completed.kind === "rollback") {
				completingRollback = true;
				state = { status: "closed", rollbackEventId: "", legacy: false };
			} else state = state.previousOpen;
		} else if (event.type === CLOUD_EVENTS.DeploymentRolledBack) {
			if (state.status === "active")
				throw new DeploymentTransitionError("rollback was not completed");
			state = {
				status: "closed",
				rollbackEventId: event.id,
				legacy: !completingRollback,
			};
			completingRollback = false;
		} else if (event.type === CLOUD_EVENTS.DeploymentReopened) {
			const data = event.data;
			if (
				state.status !== "closed" ||
				!isJsonObject(data) ||
				data.rollbackEventId !== state.rollbackEventId ||
				!isJsonString(data.planHash) ||
				!/^sha256:[a-f0-9]{64}$/u.test(data.planHash) ||
				!Array.isArray(data.resources) ||
				data.resources.length > 256 ||
				!data.resources.every(
					(resource) =>
						isJsonObject(resource) &&
						isJsonString(resource.resourceId) &&
						resource.resourceId.length > 0 &&
						resource.resourceId.length <= 200 &&
						isJsonString(resource.specHash) &&
						/^sha256:[a-f0-9]{64}$/u.test(resource.specHash),
				)
			)
				throw new DeploymentTransitionError(
					"deployment reopening does not match its rollback",
				);
			const resources = new Map<string, string>();
			for (const resource of data.resources) {
				if (
					!isJsonObject(resource) ||
					!isJsonString(resource.resourceId) ||
					!isJsonString(resource.specHash) ||
					resources.has(resource.resourceId)
				)
					throw new DeploymentTransitionError(
						"deployment reopening resources are malformed",
					);
				resources.set(resource.resourceId, resource.specHash);
			}
			state = {
				status: "open",
				reopenedPlanHash: data.planHash,
				reopenedResources: resources,
			};
		} else if (
			event.type === CLOUD_EVENTS.DeploymentDeployed &&
			state.status === "open"
		) {
			state = { status: "open" };
		}
		if (isJsonObject(event.data) && isJsonString(event.data.resourceId)) {
			if (event.type === CLOUD_EVENTS.ResourceProvisioning)
				pendingApplies.add(event.data.resourceId);
			if (
				event.type === CLOUD_EVENTS.ResourceProvisioned ||
				event.type === CLOUD_EVENTS.ResourceFailed
			)
				pendingApplies.delete(event.data.resourceId);
			if (
				event.type === CLOUD_EVENTS.ResourceFailed &&
				event.data.requiresReconciliation === true
			)
				unresolvedFailures.add(event.id);
			if (
				event.type === CLOUD_EVENTS.ResourceReconciled &&
				isJsonString(event.data.failureEventId) &&
				isJsonString(event.data.outcome) &&
				["applied", "destroyed", "no-effect"].includes(event.data.outcome) &&
				(event.data.outcome !== "no-effect" ||
					(isJsonString(event.data.restoredState) &&
						["provisioned", "destroyed", "failed"].includes(
							event.data.restoredState,
						)))
			)
				unresolvedFailures.delete(event.data.failureEventId);
		}
	}
	if (completingRollback)
		throw new DeploymentTransitionError("rollback completion is incomplete");
	return state;
}

/** No apply can start after a transition wins the stream CAS. */
export function requireApplyOpen(
	events: readonly EventEnvelope[],
	resource: ResourcePlan,
): void {
	const state = foldDeploymentTransition(events);
	if (
		state.status !== "open" ||
		(state.reopenedResources !== undefined &&
			state.reopenedResources.get(resource.name) !== desiredSpecHash(resource))
	)
		throw new DeploymentTransitionError(
			"deployment is transitioning or requires an explicit new run",
		);
}

/** A transition can destroy only the targets fixed when it started. */
export function requireDestroyAllowed(
	events: readonly EventEnvelope[],
	resourceId: string,
): void {
	const state = foldDeploymentTransition(events);
	if (
		state.status === "closed" ||
		(state.status === "active" &&
			!state.transition.resourceIds.includes(resourceId))
	)
		throw new DeploymentTransitionError(
			"resource is outside the active deployment transition",
		);
}
