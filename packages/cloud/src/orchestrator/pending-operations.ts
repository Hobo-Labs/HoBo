import { createHash } from "node:crypto";
import type { EventEnvelope } from "@hobo/core";
import { CLOUD_EVENTS } from "../events.js";
import { isJsonObject } from "../json.js";
import type { DeploymentPlan, ResourcePlan } from "../plan-types.js";
import { desiredSpecHash, recordedResources } from "./desired-state.js";
import {
	iacProgramFor,
	pendingApplyGeneration,
	type ResourceActorDeps,
} from "./resource-actor.js";

export interface PendingResourceOperation {
	readonly resourceId: string;
	readonly operation: "apply" | "destroy";
	readonly reason:
		| "removed-from-plan"
		| "opposite-operation"
		| "apply-spec-unverified"
		| "resume-unverified"
		| "dependency-unverified"
		| "apply-in-progress";
}

function latestApply(
	events: readonly EventEnvelope[],
	resourceId: string,
): EventEnvelope | undefined {
	for (let index = events.length - 1; index >= 0; index--) {
		const event = events[index];
		if (
			event?.type === CLOUD_EVENTS.ResourceProvisioning &&
			isJsonObject(event.data) &&
			event.data.resourceId === resourceId
		)
			return event;
	}
	return undefined;
}

/** Block orphaned or conflicting effects before convergence or any new provider work. */
export async function pendingOrchestrationBarriers(
	events: readonly EventEnvelope[],
	plan: DeploymentPlan,
	ctx: {
		readonly deploymentId: string;
		readonly tenant: string;
		readonly verifyResume?: ResourceActorDeps["verifyResume"];
	},
): Promise<PendingResourceOperation[]> {
	const recorded = recordedResources(events);
	const declared = new Map(
		plan.resources.map((resource) => [resource.name, resource]),
	);
	const output: PendingResourceOperation[] = [];
	const dependenciesStable = (
		resource: ResourcePlan,
		seen: Set<string>,
	): boolean => {
		for (const name of resource.deps) {
			if (seen.has(name)) continue;
			seen.add(name);
			const desired = declared.get(name);
			const previous = recorded.get(name);
			if (
				desired === undefined ||
				previous?.state !== "Provisioned" ||
				previous.specHash !== desiredSpecHash(desired) ||
				!dependenciesStable(desired, seen)
			)
				return false;
		}
		return true;
	};
	for (const previous of recorded.values()) {
		if (previous.state !== "Provisioning" && previous.state !== "Destroying")
			continue;
		const resource = declared.get(previous.resourceId);
		const operation = previous.state === "Provisioning" ? "apply" : "destroy";
		let reason: PendingResourceOperation["reason"] | undefined;
		if (resource === undefined) reason = "removed-from-plan";
		else if (operation === "destroy") reason = "opposite-operation";
		else {
			const start = latestApply(events, previous.resourceId);
			const actual = { ...resource, deploymentId: ctx.deploymentId };
			const generation = pendingApplyGeneration(events, actual, ctx);
			if (
				!isJsonObject(start?.data) ||
				start.data.specHash !== desiredSpecHash(resource) ||
				generation === undefined
			)
				reason = "apply-spec-unverified";
			else if (!dependenciesStable(resource, new Set([resource.name])))
				reason = "dependency-unverified";
			else {
				const program = iacProgramFor(
					ctx.deploymentId,
					actual,
					"apply",
					ctx.tenant,
				);
				const programHash = `sha256:${createHash("sha256").update(JSON.stringify(program)).digest("hex")}`;
				let verified = false;
				try {
					verified =
						(await ctx.verifyResume?.({
							tenant: ctx.tenant,
							deploymentId: ctx.deploymentId,
							resourceId: resource.name,
							action: "apply",
							operationGeneration: generation,
							programHash,
							specHash: desiredSpecHash(resource),
						})) === true;
				} catch {
					verified = false;
				}
				if (!verified) reason = "resume-unverified";
			}
		}
		if (reason !== undefined)
			output.push({ resourceId: previous.resourceId, operation, reason });
	}
	return output.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}

/** Rollback can resume a recorded destroy, but cannot overtake a pending apply. */
export function pendingCompensationBarriers(
	events: readonly EventEnvelope[],
	plan: DeploymentPlan,
): PendingResourceOperation[] {
	const declared = new Set(plan.resources.map((resource) => resource.name));
	const output: PendingResourceOperation[] = [];
	for (const previous of recordedResources(events).values()) {
		if (previous.state !== "Provisioning" && previous.state !== "Destroying")
			continue;
		const operation = previous.state === "Provisioning" ? "apply" : "destroy";
		const reason = !declared.has(previous.resourceId)
			? "removed-from-plan"
			: operation === "apply"
				? "apply-in-progress"
				: undefined;
		if (reason !== undefined)
			output.push({ resourceId: previous.resourceId, operation, reason });
	}
	return output.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}
