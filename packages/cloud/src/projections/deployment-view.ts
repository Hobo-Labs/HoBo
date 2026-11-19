import { defineProjection, type Projection } from "@hobo/data";

import { CLOUD_EVENTS } from "../events.js";
import type { JsonValue } from "../json.js";
import type { DeploymentPlan, PlanRemediation } from "../plan-types.js";

export interface DeploymentDecisionRow {
	resource: string;
	winner: string;
	providerId: string;
	port: string;
	region?: string;
	tie?: boolean;
	rejectedCount?: number;
}

export type ResourceLifecycle =
	| "provisioning"
	| "provisioned"
	| "failed"
	| "destroying"
	| "destroyed";

export interface DeploymentViewRow {
	deploymentId: string;
	status:
		| "requested"
		| "planned"
		| "rejected"
		| "deployed"
		| "rolling-back"
		| "needs-human"
		| "rolled-back";
	bindleHash?: string;
	decisions: DeploymentDecisionRow[];
	planHash?: string;
	plan?: DeploymentPlan;
	rejection?: { reason: string; remediations: PlanRemediation[] };
	resources: Record<string, ResourceLifecycle>;
	rollback?: { resourceId: string; reason: string };
	owner?: { kind: string; id: string };
	claimed?: boolean;
	imported?: boolean;
}

function base(
	row: DeploymentViewRow | undefined,
	deploymentId: string,
): DeploymentViewRow {
	return row
		? { ...row, decisions: [...row.decisions], resources: { ...row.resources } }
		: { deploymentId, status: "requested", decisions: [], resources: {} };
}

export const deploymentViewProjection: Projection<DeploymentViewRow> =
	defineProjection<DeploymentViewRow>({
		name: "deployment-view",
		key: (event) => (event.data as { deploymentId: string }).deploymentId,
		on: {
			[CLOUD_EVENTS.DeploymentRequested]: (row, event) => {
				const data = event.data as { deploymentId: string; bindleHash: string };
				const next = base(row, data.deploymentId);
				next.status = "requested";
				next.bindleHash = data.bindleHash;
				if (next.owner === undefined && event.actor) {
					next.owner = { kind: event.actor.kind, id: event.actor.id };
				}
				return next;
			},
			[CLOUD_EVENTS.DeploymentImported]: (row, event) => {
				const data = event.data as {
					deploymentId: string;
					bindleHash: string;
					resources: string[];
				};
				const next = base(row, data.deploymentId);
				next.status = "deployed";
				next.bindleHash = data.bindleHash;
				next.imported = true;
				for (const resourceId of data.resources) {
					next.resources[resourceId] = "provisioned";
				}
				if (next.owner === undefined && event.actor) {
					next.owner = { kind: event.actor.kind, id: event.actor.id };
				}
				return next;
			},
			[CLOUD_EVENTS.DeploymentClaimed]: (row, event) => {
				const data = event.data as {
					deploymentId: string;
					newOwner: { kind: string; id: string };
				};
				const next = base(row, data.deploymentId);
				next.owner = { kind: data.newOwner.kind, id: data.newOwner.id };
				next.claimed = true;
				return next;
			},
			[CLOUD_EVENTS.MatchDecided]: (row, event) => {
				const data = event.data as DeploymentDecisionRow & {
					deploymentId: string;
					rejectedCandidates?: JsonValue[];
				};
				const next = base(row, data.deploymentId);
				const decision: DeploymentDecisionRow = {
					resource: data.resource,
					winner: data.winner,
					providerId: data.providerId,
					port: data.port,
				};
				if (data.region !== undefined) decision.region = data.region;
				if (data.tie !== undefined) decision.tie = data.tie;
				if (Array.isArray(data.rejectedCandidates))
					decision.rejectedCount = data.rejectedCandidates.length;
				next.decisions = [...next.decisions, decision].sort((a, b) =>
					a.resource.localeCompare(b.resource),
				);
				return next;
			},
			[CLOUD_EVENTS.DeploymentPlanned]: (row, event) => {
				const data = event.data as {
					deploymentId: string;
					planHash: string;
					plan: DeploymentPlan;
				};
				const next = base(row, data.deploymentId);
				next.status = "planned";
				next.planHash = data.planHash;
				next.plan = data.plan;
				return next;
			},
			[CLOUD_EVENTS.DeploymentPlanRejected]: (row, event) => {
				const data = event.data as {
					deploymentId: string;
					reason: string;
					remediations: PlanRemediation[];
				};
				const next = base(row, data.deploymentId);
				next.status = "rejected";
				next.rejection = {
					reason: data.reason,
					remediations: data.remediations,
				};
				return next;
			},
			[CLOUD_EVENTS.ResourceProvisioning]: (row, event) => {
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "provisioning";
				return next;
			},
			[CLOUD_EVENTS.ResourceProvisioned]: (row, event) => {
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "provisioned";
				return next;
			},
			[CLOUD_EVENTS.ResourceFailed]: (row, event) => {
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "failed";
				return next;
			},
			[CLOUD_EVENTS.ResourceDestroying]: (row, event) => {
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "destroying";
				return next;
			},
			[CLOUD_EVENTS.ResourceDestroyed]: (row, event) => {
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "destroyed";
				return next;
			},
			[CLOUD_EVENTS.DeploymentDeployed]: (row, event) => {
				const data = event.data as { deploymentId: string };
				const next = base(row, data.deploymentId);
				next.status = "deployed";
				delete next.rollback;
				return next;
			},
			[CLOUD_EVENTS.DeploymentRollbackStarted]: (row, event) => {
				const data = event.data as {
					deploymentId: string;
					resourceId: string;
					reason: string;
				};
				const next = base(row, data.deploymentId);
				next.status = "rolling-back";
				next.rollback = { resourceId: data.resourceId, reason: data.reason };
				return next;
			},
			[CLOUD_EVENTS.ResourceCompensationFailed]: (row, event) => {
				const data = event.data as { deploymentId: string };
				const next = base(row, data.deploymentId);
				next.status = "needs-human";
				return next;
			},
			[CLOUD_EVENTS.DeploymentRolledBack]: (row, event) => {
				const data = event.data as { deploymentId: string };
				const next = base(row, data.deploymentId);
				next.status = "rolled-back";
				return next;
			},
		},
	});
