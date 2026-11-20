import type { EventEnvelope, EventStore } from "@hobo/core";
import { CLOUD_EVENTS } from "../events.js";
import { isJsonObject, isJsonString } from "../json.js";
import { collectStream } from "../store/index.js";

export class DeploymentHistoryScopeError extends Error {
	readonly code = "DEPLOYMENT_HISTORY_SCOPE_MISMATCH";
	constructor() {
		super(
			"deployment history does not belong to the requested tenant and deployment",
		);
		this.name = "DeploymentHistoryScopeError";
	}
}

export function assertDeploymentHistoryScope(
	events: readonly EventEnvelope[],
	deploymentId: string,
	tenant: string,
): void {
	const stream = `deployment:${deploymentId}`;
	for (const event of events) {
		if (event.streamId !== stream || event.tenant !== tenant)
			throw new DeploymentHistoryScopeError();
		const scopedType =
			event.type.startsWith("resource.") ||
			event.type.startsWith("deployment.") ||
			event.type === CLOUD_EVENTS.MatchDecided;
		const data = event.data;
		if (
			scopedType &&
			(!isJsonObject(data) || data.deploymentId !== deploymentId)
		)
			throw new DeploymentHistoryScopeError();
		if (
			event.type.startsWith("resource.") &&
			(!isJsonObject(data) ||
				!isJsonString(data.resourceId) ||
				data.resourceId.length === 0 ||
				data.resourceId.length > 200)
		)
			throw new DeploymentHistoryScopeError();
		if (
			isJsonObject(data) &&
			"deploymentId" in data &&
			data.deploymentId !== deploymentId
		)
			throw new DeploymentHistoryScopeError();
		if (
			event.type === CLOUD_EVENTS.DeploymentRequested &&
			isJsonObject(data) &&
			"tenant" in data &&
			data.tenant !== tenant
		)
			throw new DeploymentHistoryScopeError();
	}
}

export async function readDeploymentHistory(
	store: Pick<EventStore, "read">,
	deploymentId: string,
	tenant: string,
): Promise<EventEnvelope[]> {
	const events = await collectStream(store, `deployment:${deploymentId}`);
	assertDeploymentHistoryScope(events, deploymentId, tenant);
	return events;
}
