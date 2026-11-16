import { defineProjection, type Projection } from "@hobo/data";

import { CLOUD_EVENTS } from "../events.js";
import type { JsonValue } from "../json.js";
import type { DeploymentPlan, PlanRemediation } from "../plan-types.js";

// The DeploymentView projection (control-plane.md "Choreography over
// orchestration": a DeploymentView reconstructs the saga graph from events for
// the dashboard). It is a read-model fold, rebuildable from zero — the log is
// authoritative, the materialized view is derived.

export interface DeploymentDecisionRow {
	resource: string;
	winner: string;
	providerId: string;
	port: string;
	region?: string;
	/** Winner beat the runner-up only on the definition-id tiebreak (ADR-0088). */
	tie?: boolean;
	/** Count of candidates rejected or outranked for this resource. */
	rejectedCount?: number;
}

// The provisioning-phase FSM status per resource, reconstructed for the saga
// graph (control-plane.md "a DeploymentView projection … reconstructs the saga
// graph from events for the dashboard").
export type ResourceLifecycle =
	| "provisioning"
	| "provisioned"
	| "failed"
	| "reconciliation-required"
	| "destroying"
	| "destroyed";

export interface DeploymentViewRow {
	deploymentId: string;
	status:
		| "requested"
		| "planned"
		| "rejected"
		| "deployed"
		| "rolled-back"
		| "needs-human";
	bindleHash?: string;
	decisions: DeploymentDecisionRow[];
	planHash?: string;
	plan?: DeploymentPlan;
	rejection?: { reason: string; remediations: PlanRemediation[] };
	// Saga graph: per-resource lifecycle folded from resource.* facts.
	resources: Record<string, ResourceLifecycle>;
	reconciliations?: Record<
		string,
		{
			reason: string;
			operation: "apply" | "destroy" | "unknown";
			reservationId?: string;
		}
	>;
	rollback?: { reason: string; targetSetId: string };
	// The principal that owns this deployment. Seeded from the requester on
	// `deployment.Requested`; rebound by `deployment.Claimed` (anonymous -> account)
	// while every provisioned fact — resources, outputs, URL — is preserved.
	owner?: { kind: string; id: string };
	// True once ownership has been claimed away from the original requester.
	claimed?: boolean;
	// True when this deployment was adopted from an existing estate (`hobo import`)
	// rather than provisioned by HoBo.
	imported?: boolean;
}

function base(
	row: DeploymentViewRow | undefined,
	deploymentId: string,
): DeploymentViewRow {
	if (row === undefined)
		return { deploymentId, status: "requested", decisions: [], resources: {} };
	const copy: DeploymentViewRow = {
		...row,
		decisions: [...row.decisions],
		resources: { ...row.resources },
	};
	if (row.reconciliations !== undefined)
		copy.reconciliations = { ...row.reconciliations };
	return copy;
}

function clearReconciliation(row: DeploymentViewRow, resourceId: string): void {
	if (row.reconciliations?.[resourceId] === undefined) return;
	delete row.reconciliations[resourceId];
	if (Object.keys(row.reconciliations).length === 0) {
		delete row.reconciliations;
		if (row.status === "needs-human") row.status = "planned";
	}
}

export const deploymentViewProjection: Projection<DeploymentViewRow> =
	defineProjection<DeploymentViewRow>({
		name: "deployment-view",
		// SAFETY: `key: (event) => (event.data as { deploymentId: string }).deploymentId,` is required at this I/O or test boundary.
		key: (event) => (event.data as { deploymentId: string }).deploymentId,
		on: {
			[CLOUD_EVENTS.DeploymentRequested]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; bindleHash: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; bindleHash: string };
				const next = base(row, data.deploymentId);
				next.status = "requested";
				next.bindleHash = data.bindleHash;
				// Seed ownership from the requesting principal (the envelope actor).
				if (next.owner === undefined && event.actor) {
					next.owner = { kind: event.actor.kind, id: event.actor.id };
				}
				return next;
			},
			[CLOUD_EVENTS.DeploymentImported]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					deploymentId: string;
					bindleHash: string;
					resources: string[];
				};
				const next = base(row, data.deploymentId);
				// The estate already exists: mark it deployed + adopted, each resource
				// provisioned. No provisioning ran — this records external reality.
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
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					deploymentId: string;
					newOwner: { kind: string; id: string };
				};
				const next = base(row, data.deploymentId);
				// Rebind ownership; ALL provisioned state (resources, plan, decisions,
				// outputs/URL) is carried forward untouched by `base`.
				next.owner = { kind: data.newOwner.kind, id: data.newOwner.id };
				next.claimed = true;
				return next;
			},
			[CLOUD_EVENTS.MatchDecided]: (row, event) => {
				// SAFETY: `const data = event.data as DeploymentDecisionRow & {` is required at this I/O or test boundary.
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
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
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
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
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
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "provisioning";
				return next;
			},
			[CLOUD_EVENTS.ResourceProvisioned]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "provisioned";
				clearReconciliation(next, data.resourceId);
				return next;
			},
			[CLOUD_EVENTS.ResourceFailed]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as {
					deploymentId: string;
					resourceId: string;
					reason: string;
					requiresReconciliation?: boolean;
					reconciliationOperation?: string;
					reservationId?: string;
				};
				const next = base(row, data.deploymentId);
				if (data.requiresReconciliation === true) {
					next.resources[data.resourceId] = "reconciliation-required";
					next.status = "needs-human";
					next.reconciliations ??= {};
					const reconciliation: NonNullable<
						DeploymentViewRow["reconciliations"]
					>[string] = {
						reason: data.reason,
						operation:
							data.reconciliationOperation === "apply" ||
							data.reconciliationOperation === "destroy"
								? data.reconciliationOperation
								: "unknown",
					};
					if (data.reservationId !== undefined)
						reconciliation.reservationId = data.reservationId;
					next.reconciliations[data.resourceId] = reconciliation;
				} else {
					next.resources[data.resourceId] = "failed";
				}
				return next;
			},
			[CLOUD_EVENTS.ResourceDestroying]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "destroying";
				return next;
			},
			[CLOUD_EVENTS.ResourceDestroyed]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				next.resources[data.resourceId] = "destroyed";
				clearReconciliation(next, data.resourceId);
				return next;
			},
			[CLOUD_EVENTS.DeploymentDeployed]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string };
				const next = base(row, data.deploymentId);
				if (next.reconciliations === undefined) next.status = "deployed";
				return next;
			},
			[CLOUD_EVENTS.DeploymentRolledBack]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					deploymentId: string;
					reason: string;
					targetSetId: string;
				};
				const next = base(row, data.deploymentId);
				if (next.reconciliations === undefined) next.status = "rolled-back";
				next.rollback = { reason: data.reason, targetSetId: data.targetSetId };
				return next;
			},
		},
	});
