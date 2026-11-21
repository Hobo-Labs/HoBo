import { ReconcileStatus } from "@hobo/cd";
import {
	collectStream,
	type DeploymentChangeSet,
	type DeploymentPlan,
	desiredSpecHash,
	parseDeploymentMode,
	planDeploymentChanges,
	planDeploymentChangesFromRecorded,
	type RecordedResource,
	recordedResources,
} from "@hobo/cloud";
import type { EventStore } from "@hobo/core";
import { campIdOf, type YardDelivery } from "./yard-client.js";


function deploymentStream(deploymentId: string): string {
	return `deployment:${deploymentId}`;
}

async function deliveryResources(
	delivery: YardDelivery,
	deploymentId: string,
): Promise<ReadonlyMap<string, RecordedResource>> {
	const campId = campIdOf(delivery.campFor?.(deploymentId) ?? deploymentId);
	const current = await delivery.cd.desired.current(campId);
	if (!current) return new Map();
	const observation = await delivery.cd.desired.status(campId);
	if (
		!observation ||
		observation.setId !== current.setId ||
		observation.status !== ReconcileStatus.CONVERGED
	)
		throw new Error(
			"the current CD deployment has no converged observation to preview",
		);
	const resolved = await delivery.cd.desired.resolved(current);
	const plans = new Map(
		resolved.plan.resources.map((resource) => [resource.name, resource]),
	);
	const recorded = new Map<string, RecordedResource>();
	for (const resource of observation.resources) {
		if (resource.driftKind.split(":")[0] === "deleted") continue;
		const plan = plans.get(resource.resource);
		const record: RecordedResource = plan
			? {
					resourceId: resource.resource,
					state: resource.healthy ? "Provisioned" : "Failed",
					plan,
					specHash: desiredSpecHash(plan),
				}
			: { resourceId: resource.resource, state: "Failed" };
		recorded.set(resource.resource, record);
	}
	return recorded;
}

export async function upWhatIf(
	store: EventStore,
	deploymentId: string,
	plan: DeploymentPlan,
	mode: string | null | undefined,
	delivery?: YardDelivery,
): Promise<DeploymentChangeSet> {
	if (delivery)
		return planDeploymentChangesFromRecorded(
			plan,
			await deliveryResources(delivery, deploymentId),
			parseDeploymentMode(mode),
		);
	const events = await collectStream(store, deploymentStream(deploymentId));
	return planDeploymentChanges(plan, events, parseDeploymentMode(mode));
}

export async function downWhatIf(
	store: EventStore,
	deploymentId: string,
	delivery?: YardDelivery,
): Promise<string[]> {
	if (delivery)
		return [...(await deliveryResources(delivery, deploymentId)).keys()].sort();
	const events = await collectStream(store, deploymentStream(deploymentId));
	return [...recordedResources(events).values()]
		.filter((resource) => resource.state !== "Destroyed")
		.map((resource) => resource.resourceId)
		.sort();
}

export function changeSummaryLine(changes: DeploymentChangeSet): string {
	const { summary } = changes;
	const line = `+${summary.create} ~${summary.update} -${summary.delete} =${summary["no-op"]}`;
	return summary.retain > 0 ? `${line} (retain ${summary.retain})` : line;
}
