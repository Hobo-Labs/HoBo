import { defineProjection, type Projection } from "@hobo/data";

import { CLOUD_EVENTS } from "../events.js";
import type { DeploymentPlan } from "../plan-types.js";
import type { ResourceLifecycle } from "./deployment-view.js";

export type TopologyNodeKind = "bindle" | "resource" | "yard";

// domain-view: parsed app-graph node; wire form is TopologyNode in data-models/cloud.proto.
export interface TopologyNode {
	id: string;
	kind: TopologyNodeKind;
	label: string;
	port?: string;
	providerId?: string;
	region?: string;
	lifecycle?: ResourceLifecycle;

	reconciliationEventId?: string;
	otherReconciliationEventIds?: string[];
}

export type TopologyEdgeKind = "binding" | "placement";

// domain-view: parsed app-graph edge; wire form is TopologyEdge in data-models/cloud.proto.
export interface TopologyEdge {
	from: string;
	to: string;
	kind: TopologyEdgeKind;
	region?: string;
}

// domain-view: parsed app-graph row; wire form is TopologyViewRow in data-models/cloud.proto.
export interface TopologyViewRow {
	deploymentId: string;
	bindleHash?: string;
	nodes: TopologyNode[];
	edges: TopologyEdge[];
}

function base(
	row: TopologyViewRow | undefined,
	deploymentId: string,
): TopologyViewRow {
	return row
		? { ...row, nodes: row.nodes.map((n) => ({ ...n })), edges: [...row.edges] }
		: { deploymentId, nodes: [], edges: [] };
}

function upsertNode(row: TopologyViewRow, node: TopologyNode): void {
	const existing = row.nodes.find((n) => n.id === node.id);
	if (existing) {
		if (node.port !== undefined) existing.port = node.port;
		if (node.providerId !== undefined) existing.providerId = node.providerId;
		if (node.region !== undefined) existing.region = node.region;
		if (node.lifecycle !== undefined) existing.lifecycle = node.lifecycle;
		if (node.reconciliationEventId !== undefined)
			existing.reconciliationEventId = node.reconciliationEventId;
		return;
	}
	row.nodes = [...row.nodes, node].sort((a, b) => a.id.localeCompare(b.id));
}

function upsertEdge(row: TopologyViewRow, edge: TopologyEdge): void {
	const exists = row.edges.some(
		(e) => e.from === edge.from && e.to === edge.to && e.kind === edge.kind,
	);
	if (exists) return;
	row.edges = [...row.edges, edge].sort(
		(a, b) =>
			a.from.localeCompare(b.from) ||
			a.to.localeCompare(b.to) ||
			a.kind.localeCompare(b.kind),
	);
}

function resourceNodeId(name: string): string {
	return `resource:${name}`;
}

function yardNodeId(providerId: string): string {
	return `yard:${providerId}`;
}

function placeResource(
	row: TopologyViewRow,
	data: {
		resource: string;
		providerId: string;
		port?: string;
		region?: string;
	},
): void {
	const node: TopologyNode = {
		id: resourceNodeId(data.resource),
		kind: "resource",
		label: data.resource,
		providerId: data.providerId,
	};
	if (data.port !== undefined) node.port = data.port;
	if (data.region !== undefined) node.region = data.region;
	upsertNode(row, node);
	upsertNode(row, {
		id: yardNodeId(data.providerId),
		kind: "yard",
		label: data.providerId,
	});
	const edge: TopologyEdge = {
		from: resourceNodeId(data.resource),
		to: yardNodeId(data.providerId),
		kind: "placement",
	};
	if (data.region !== undefined) edge.region = data.region;
	upsertEdge(row, edge);
}

function setLifecycle(
	row: TopologyViewRow,
	resourceId: string,
	lifecycle: ResourceLifecycle,
): void {
	const previous = row.nodes.find(
		(node) => node.id === resourceNodeId(resourceId),
	);
	if (
		previous?.lifecycle === "reconciliation-required" &&
		(lifecycle === "provisioning" ||
			lifecycle === "destroying" ||
			lifecycle === "failed")
	)
		return;
	upsertNode(row, {
		id: resourceNodeId(resourceId),
		kind: "resource",
		label: resourceId,
		lifecycle,
	});
}

export const topologyViewProjection: Projection<TopologyViewRow> =
	defineProjection<TopologyViewRow>({
		name: "topology-view",
		// SAFETY: `key: (event) => (event.data as { deploymentId: string }).deploymentId,` is required at this I/O or test boundary.
		key: (event) => (event.data as { deploymentId: string }).deploymentId,
		on: {
			[CLOUD_EVENTS.DeploymentRequested]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; bindleHash: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; bindleHash: string };
				const next = base(row, data.deploymentId);
				next.bindleHash = data.bindleHash;
				upsertNode(next, {
					id: `bindle:${data.deploymentId}`,
					kind: "bindle",
					label: data.bindleHash,
				});
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
				next.bindleHash = data.bindleHash;
				upsertNode(next, {
					id: `bindle:${data.deploymentId}`,
					kind: "bindle",
					label: data.bindleHash,
				});
				for (const resourceId of data.resources) {
					const node = next.nodes.find(
						(entry) => entry.id === resourceNodeId(resourceId),
					);
					if (node?.lifecycle !== "reconciliation-required")
						setLifecycle(next, resourceId, "provisioned");
				}
				return next;
			},
			[CLOUD_EVENTS.MatchDecided]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					deploymentId: string;
					resource: string;
					providerId: string;
					port: string;
					region?: string;
				};
				const next = base(row, data.deploymentId);
				const placement: Parameters<typeof placeResource>[1] = {
					resource: data.resource,
					providerId: data.providerId,
					port: data.port,
				};
				if (data.region !== undefined) placement.region = data.region;
				placeResource(next, placement);
				return next;
			},
			[CLOUD_EVENTS.DeploymentPlanned]: (row, event) => {
				// SAFETY: `const data = event.data as {` is required at this I/O or test boundary.
				const data = event.data as {
					deploymentId: string;
					plan: DeploymentPlan;
				};
				const next = base(row, data.deploymentId);
				for (const resource of data.plan.resources) {
					const placement: Parameters<typeof placeResource>[1] = {
						resource: resource.name,
						providerId: resource.provider,
						port: resource.port,
					};
					if (resource.region !== undefined) placement.region = resource.region;
					placeResource(next, placement);
					for (const dep of resource.deps) {
						upsertEdge(next, {
							from: resourceNodeId(resource.name),
							to: resourceNodeId(dep),
							kind: "binding",
						});
					}
				}
				return next;
			},
			[CLOUD_EVENTS.ResourceProvisioning]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				setLifecycle(next, data.resourceId, "provisioning");
				return next;
			},
			[CLOUD_EVENTS.ResourceProvisioned]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				const node = next.nodes.find(
					(entry) => entry.id === resourceNodeId(data.resourceId),
				);
				if (node?.reconciliationEventId === undefined) {
					setLifecycle(next, data.resourceId, "provisioned");
					if (node !== undefined) {
						delete node.reconciliationEventId;
						delete node.otherReconciliationEventIds;
					}
				}
				return next;
			},
			[CLOUD_EVENTS.ResourceFailed]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as {
					deploymentId: string;
					resourceId: string;
					requiresReconciliation?: boolean;
				};
				const next = base(row, data.deploymentId);
				setLifecycle(
					next,
					data.resourceId,
					data.requiresReconciliation === true
						? "reconciliation-required"
						: "failed",
				);
				if (data.requiresReconciliation === true) {
					const node = next.nodes.find(
						(entry) => entry.id === resourceNodeId(data.resourceId),
					);
					if (node !== undefined) {
						if (node.reconciliationEventId !== undefined)
							node.otherReconciliationEventIds = [
								...(node.otherReconciliationEventIds ?? []),
								node.reconciliationEventId,
							];
						node.reconciliationEventId = event.id;
					}
				}
				return next;
			},
			[CLOUD_EVENTS.ResourceReconciled]: (row, event) => {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: resource.Reconciled is the verified recovery fact from this package.
				const data = event.data as {
					deploymentId: string;
					resourceId: string;
					failureEventId: string;
					outcome: string;
					restoredState?: string;
				};
				const next = base(row, data.deploymentId);
				const node = next.nodes.find(
					(entry) => entry.id === resourceNodeId(data.resourceId),
				);
				if (
					["no-effect", "applied", "destroyed"].includes(data.outcome) &&
					(data.outcome !== "no-effect" ||
						(data.restoredState !== undefined &&
							["provisioned", "destroyed", "failed"].includes(
								data.restoredState,
							))) &&
					node?.reconciliationEventId !== undefined
				) {
					const ids = [
						...(node.otherReconciliationEventIds ?? []),
						node.reconciliationEventId,
					];
					const remaining = ids.filter((id) => id !== data.failureEventId);
					if (remaining.length < ids.length) {
						const last = remaining.at(-1);
						if (last === undefined) {
							node.lifecycle =
								data.outcome === "applied" ||
								data.restoredState === "provisioned"
									? "provisioned"
									: data.outcome === "destroyed" ||
											data.restoredState === "destroyed"
										? "destroyed"
										: "failed";
							delete node.reconciliationEventId;
							delete node.otherReconciliationEventIds;
						} else {
							node.reconciliationEventId = last;
							if (remaining.length === 1)
								delete node.otherReconciliationEventIds;
							else node.otherReconciliationEventIds = remaining.slice(0, -1);
						}
					}
				}
				return next;
			},
			[CLOUD_EVENTS.ResourceDestroying]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				setLifecycle(next, data.resourceId, "destroying");
				return next;
			},
			[CLOUD_EVENTS.ResourceDestroyed]: (row, event) => {
				// SAFETY: `const data = event.data as { deploymentId: string; resourceId: string };` is required at this I/O or test boundary.
				const data = event.data as { deploymentId: string; resourceId: string };
				const next = base(row, data.deploymentId);
				const node = next.nodes.find(
					(entry) => entry.id === resourceNodeId(data.resourceId),
				);
				if (node?.reconciliationEventId === undefined) {
					setLifecycle(next, data.resourceId, "destroyed");
					if (node !== undefined) {
						delete node.reconciliationEventId;
						delete node.otherReconciliationEventIds;
					}
				}
				return next;
			},
		},
	});
