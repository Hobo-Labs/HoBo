import { createHash } from "node:crypto";

import type { EventEnvelope } from "@hobo/core";
import {
	type JsonValue as PlanJsonValue,
	parseResourcePlan,
	ResourcePlanError,
} from "@hobo/manifest-plan";

import { CLOUD_EVENTS } from "../events.js";
import { isJsonArray, isJsonObject, isJsonString } from "../json.js";
import type { DeploymentPlan, ResourcePlan } from "../plan-types.js";

export type DeploymentMode = "incremental" | "complete";

export const DEPLOYMENT_MODES: readonly DeploymentMode[] = Object.freeze([
	"incremental",
	"complete",
]);

export function parseDeploymentMode(
	value: string | null | undefined,
): DeploymentMode {
	if (value === undefined || value === null || value === "")
		return "incremental";
	if (value === "incremental" || value === "complete") return value;
	throw new TypeError(
		`deployment mode must be "incremental" or "complete", got ${JSON.stringify(value)}`,
	);
}

export type DesiredSpecHash = `sha256:${string}`;

interface DesiredSpecDocument {
	[key: string]: PlanJsonValue;
}

function sorted(value: PlanJsonValue): PlanJsonValue {
	if (isJsonArray(value)) return value.map(sorted);
	if (isJsonObject(value)) {
		const out: DesiredSpecDocument = {};
		for (const key of Object.keys(value).sort()) {
			const child = value[key];
			if (child !== undefined) out[key] = sorted(child);
		}
		return out;
	}
	return value;
}

export function desiredSpecHash(resource: ResourcePlan): DesiredSpecHash {
	const spec: DesiredSpecDocument = {
		name: resource.name,
		port: resource.port,
		provider: resource.provider,
		deps: [...resource.deps].sort(),
	};
	if (resource.strategy !== undefined) spec.strategy = resource.strategy;
	if (resource.readyDeps !== undefined)
		spec.readyDeps = [...resource.readyDeps].sort();
	if (resource.completedDeps !== undefined)
		spec.completedDeps = [...resource.completedDeps].sort();
	if (resource.region !== undefined) spec.region = resource.region;
	if (resource.productId !== undefined) spec.productId = resource.productId;
	if (resource.realizationParameters !== undefined)
		spec.realizationParameters = { ...resource.realizationParameters };
	if (resource.nonPortableRows !== undefined)
		spec.nonPortableRows = [...resource.nonPortableRows].sort();
	const digest = createHash("sha256")
		.update(JSON.stringify(sorted(spec)))
		.digest("hex");
	return `sha256:${digest}`;
}

const TERMINAL_DEPLOYMENT_FACTS: ReadonlySet<string> = new Set([
	CLOUD_EVENTS.DeploymentDeployed,
	CLOUD_EVENTS.DeploymentRolledBack,
]);

export function currentEpochStart(events: readonly EventEnvelope[]): number {
	let start = 0;
	for (const event of events)
		if (TERMINAL_DEPLOYMENT_FACTS.has(event.type)) start = event.seq;
	return start;
}

export function changedSinceLastDeployed(
	events: readonly EventEnvelope[],
): boolean {
	let lastDeployed = -1;
	for (const event of events)
		if (event.type === CLOUD_EVENTS.DeploymentDeployed)
			lastDeployed = event.seq;
	if (lastDeployed < 0) return true;
	return events.some(
		(event) =>
			event.seq > lastDeployed &&
			event.type.startsWith("resource.") &&
			event.type !== CLOUD_EVENTS.ResourcePlanning,
	);
}

export interface RecordedResource {
	readonly resourceId: string;
	readonly state:
		| "Provisioning"
		| "Provisioned"
		| "Failed"
		| "Destroying"
		| "Destroyed";
	readonly specHash?: string;
	readonly plan?: ResourcePlan;
	readonly providerId?: string;
}

export interface BlockedProviderMove {
	readonly resource: string;
	readonly from?: string;
	readonly to: string;
}

export function blockedProviderMove(
	previous: RecordedResource | undefined,
	resource: ResourcePlan,
): BlockedProviderMove | undefined {
	if (previous === undefined || previous.state === "Destroyed")
		return undefined;
	const provider = previous.providerId;
	if (provider === resource.provider) return undefined;
	return {
		resource: resource.name,
		...(provider !== undefined ? { from: provider } : undefined),
		to: resource.provider,
	};
}

function resourceIdOf(event: EventEnvelope): string | undefined {
	return isJsonObject(event.data) && isJsonString(event.data.resourceId)
		? event.data.resourceId
		: undefined;
}

export function requireResourceSpecHash(value: string | undefined): string {
	if (!isJsonString(value) || !/^sha256:[0-9a-f]{64}$/u.test(value))
		throw new TypeError("resource fact requires a valid spec hash");
	return value;
}

function specHashOf(event: EventEnvelope): string {
	const value = isJsonObject(event.data) ? event.data.specHash : undefined;
	return requireResourceSpecHash(isJsonString(value) ? value : undefined);
}

function providerIdOf(event: EventEnvelope): string {
	const providerId = isJsonObject(event.data)
		? event.data.providerId
		: undefined;
	if (!isJsonString(providerId) || !providerId.trim())
		throw new TypeError("resource provisioning requires a provider");
	return providerId;
}

function plannedResources(event: EventEnvelope): readonly ResourcePlan[] {
	if (!isJsonObject(event.data)) return [];
	const plan = event.data.plan;
	if (!isJsonObject(plan) || !Array.isArray(plan.resources)) return [];
	return plan.resources.flatMap((node, index) => {
		try {
			const parsed = parseResourcePlan(node, `plan.resources[${index}]`);
			const authoring: ResourcePlan = {
				...parsed,
				deps: [...parsed.deps],
				...(parsed.nonPortableRows !== undefined
					? { nonPortableRows: [...parsed.nonPortableRows] }
					: undefined),
			};
			return [authoring];
		} catch (error) {
			if (error instanceof ResourcePlanError) return [];
			throw error;
		}
	});
}

export function recordedResources(
	events: readonly EventEnvelope[],
): ReadonlyMap<string, RecordedResource> {
	const states = new Map<string, Omit<RecordedResource, "resourceId">>();
	const plans = new Map<string, ResourcePlan>();
	for (const event of events) {
		if (event.type === CLOUD_EVENTS.DeploymentPlanned) {
			for (const resource of plannedResources(event))
				plans.set(resource.name, resource);
			continue;
		}
		const resourceId = resourceIdOf(event);
		if (resourceId === undefined) continue;
		const previous = states.get(resourceId);
		switch (event.type) {
			case CLOUD_EVENTS.ResourceProvisioning: {
				const targetHash = specHashOf(event);
				const candidate = plans.get(resourceId);
				const targetProvider = providerIdOf(event);
				const providerId =
					previous && previous.state !== "Destroyed"
						? previous.providerId === targetProvider
							? previous.providerId
							: undefined
						: targetProvider;
				const plan =
					previous !== undefined &&
					previous.state !== "Destroyed" &&
					previous.specHash !== undefined
						? targetHash === previous.specHash
							? previous.plan
							: undefined
						: candidate && desiredSpecHash(candidate) === targetHash
							? candidate
							: undefined;
				states.set(resourceId, {
					state: "Provisioning",
					...(previous?.specHash !== undefined
						? { specHash: previous.specHash }
						: undefined),
					...(plan !== undefined ? { plan } : undefined),
					...(providerId !== undefined ? { providerId } : undefined),
				});
				break;
			}
			case CLOUD_EVENTS.ResourceProvisioned: {
				const eventHash = specHashOf(event);
				if (!previous || previous.state !== "Provisioning")
					throw new Error("resource provisioned without a provisioning fact");
				const candidate = plans.get(resourceId);
				const plan =
					candidate && desiredSpecHash(candidate) === eventHash
						? candidate
						: undefined;
				const providerId = previous.providerId;
				states.set(resourceId, {
					state: "Provisioned",
					specHash: eventHash,
					...(plan !== undefined ? { plan } : undefined),
					...(providerId !== undefined ? { providerId } : undefined),
				});
				break;
			}
			case CLOUD_EVENTS.ResourceFailed:
				states.set(resourceId, { ...previous, state: "Failed" });
				break;
			case CLOUD_EVENTS.ResourceDestroying:
				states.set(resourceId, { ...previous, state: "Destroying" });
				break;
			case CLOUD_EVENTS.ResourceDestroyed:
				states.set(resourceId, { state: "Destroyed" });
				break;
			default:
				break;
		}
	}
	const out = new Map<string, RecordedResource>();
	for (const [resourceId, recorded] of states) {
		out.set(resourceId, {
			resourceId,
			...recorded,
		});
	}
	return out;
}

export type ResourceChangeAction =
	| "create"
	| "update"
	| "no-op"
	| "delete"
	| "retain";

export interface ResourceChange {
	readonly resourceId: string;
	readonly action: ResourceChangeAction;
	readonly reason: string;
	readonly desiredSpecHash?: DesiredSpecHash;
	readonly recordedSpecHash?: string;
}

export interface DeploymentChangeSet {
	readonly mode: DeploymentMode;
	readonly changes: readonly ResourceChange[];
	readonly summary: Readonly<Record<ResourceChangeAction, number>>;
	readonly converged: boolean;
}

export function classifyResource(
	resource: ResourcePlan,
	recorded: RecordedResource | undefined,
): ResourceChange {
	const desired = desiredSpecHash(resource);
	const base = { resourceId: resource.name, desiredSpecHash: desired };
	if (recorded === undefined)
		return { ...base, action: "create", reason: "not yet provisioned" };
	const recordedHash =
		recorded.specHash !== undefined
			? { recordedSpecHash: recorded.specHash }
			: undefined;
	switch (recorded.state) {
		case "Destroyed":
			return { ...base, action: "create", reason: "destroyed; re-create" };
		case "Provisioning":
			return {
				...base,
				...recordedHash,
				action: "create",
				reason: "provisioning did not finish; resume",
			};
		case "Failed":
			return {
				...base,
				...recordedHash,
				action: recorded.specHash === undefined ? "create" : "update",
				reason: "last apply failed; retry",
			};
		case "Destroying":
			return {
				...base,
				...recordedHash,
				action: "create",
				reason: "teardown did not finish; re-create",
			};
		case "Provisioned":
			if (recorded.specHash === undefined)
				throw new Error("provisioned resource is missing its spec hash");
			return recorded.specHash === desired
				? { ...base, ...recordedHash, action: "no-op", reason: "up to date" }
				: {
						...base,
						...recordedHash,
						action: "update",
						reason: "declared spec changed",
					};
	}
}

export function planDeploymentChanges(
	plan: DeploymentPlan,
	events: readonly EventEnvelope[],
	mode: DeploymentMode = "incremental",
): DeploymentChangeSet {
	return planDeploymentChangesFromRecorded(
		plan,
		recordedResources(events),
		mode,
	);
}

export function planDeploymentChangesFromRecorded(
	plan: DeploymentPlan,
	recorded: ReadonlyMap<string, RecordedResource>,
	mode: DeploymentMode = "incremental",
): DeploymentChangeSet {
	const declared = new Set(plan.resources.map((resource) => resource.name));
	const changes: ResourceChange[] = plan.resources.map((resource) =>
		classifyResource(resource, recorded.get(resource.name)),
	);
	const undeclared = [...recorded.values()]
		.filter(
			(entry) => !declared.has(entry.resourceId) && entry.state !== "Destroyed",
		)
		.sort((a, b) => a.resourceId.localeCompare(b.resourceId));
	for (const entry of undeclared) {
		changes.push(
			mode === "complete"
				? {
						resourceId: entry.resourceId,
						action: "delete",
						reason: "no longer declared (complete mode)",
						...(entry.specHash !== undefined
							? { recordedSpecHash: entry.specHash }
							: undefined),
					}
				: {
						resourceId: entry.resourceId,
						action: "retain",
						reason: "no longer declared; kept (incremental mode)",
						...(entry.specHash !== undefined
							? { recordedSpecHash: entry.specHash }
							: undefined),
					},
		);
	}
	const summary = {
		create: 0,
		update: 0,
		"no-op": 0,
		delete: 0,
		retain: 0,
	};
	for (const change of changes) summary[change.action] += 1;
	return Object.freeze({
		mode,
		changes: Object.freeze(changes),
		summary: Object.freeze(summary),
		converged: summary.create + summary.update + summary.delete === 0,
	});
}

export interface OrphanPrunePlan {
	readonly ordered: readonly ResourcePlan[];
	readonly unknown: readonly string[];
}

export function orphansToPrune(
	plan: DeploymentPlan,
	events: readonly EventEnvelope[],
): OrphanPrunePlan {
	const declared = new Set(plan.resources.map((resource) => resource.name));
	const orphans = [...recordedResources(events).values()].filter(
		(entry) => !declared.has(entry.resourceId) && entry.state !== "Destroyed",
	);
	const unknown = orphans
		.filter((entry) => entry.plan === undefined)
		.map((entry) => entry.resourceId)
		.sort();
	const known = orphans
		.flatMap((entry) => (entry.plan === undefined ? [] : [entry.plan]))
		.sort((a, b) => a.name.localeCompare(b.name));
	const ordered: ResourcePlan[] = [];
	const visited = new Set<string>();
	const visit = (resource: ResourcePlan) => {
		if (visited.has(resource.name)) return;
		visited.add(resource.name);
		for (const dependent of known)
			if (dependent.deps.includes(resource.name)) visit(dependent);
		ordered.push(resource);
	};
	for (const resource of known) visit(resource);
	return { ordered, unknown };
}
