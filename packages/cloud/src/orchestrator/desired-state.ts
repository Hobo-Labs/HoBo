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

// Desired State Reconciliation (control-plane.md "reconcile loop"): `up`
// declares what should exist, this module compares it with what the durable log
// records, and the orchestrator applies only the difference. Three properties
// follow, named the way Pulumi, Terraform and Bicep name them:
//
// - **Upsert.** A resource the log has never provisioned is created; one it
//   provisioned from a different desired spec is updated in place; one it
//   provisioned from the same spec is left alone.
// - **Idempotent deployment.** Re-running `up` with an unchanged declaration
//   appends no fact and calls no provider: the what-if diff is all `no-op`.
// - **Incremental vs complete mode** (Bicep's terms). In `incremental` mode, the
//   default, a resource the log provisioned but the declaration no longer names
//   is kept and reported as `retain`. In `complete` mode it is destroyed, so the
//   deployment converges to exactly what is declared.
//
// A desired spec is identified by `desiredSpecHash`. The hash is recorded on
// `resource.Provisioning` and `resource.Provisioned`. A Provisioned fact written
// before hashes existed carries none; it is treated as converged, so upgrading
// HoBo never re-applies an estate nobody changed.

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

/** The desired spec as hashed: plan JSON, keyed by field name. */
interface DesiredSpecDocument {
	[key: string]: PlanJsonValue;
}

/** Key-sorted JSON: the byte-stable form a desired spec is hashed in. */
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

/**
 * The content address of what a resource is declared to be. Everything that
 * changes what the provider builds is in it: port, provider, product,
 * strategy, region, realization parameters and dependencies (sorted, since
 * order carries no meaning). `deploymentId` is not, so the same declaration
 * hashes the same in every Camp.
 */
export function desiredSpecHash(resource: ResourcePlan): DesiredSpecHash {
	const spec: DesiredSpecDocument = {
		name: resource.name,
		port: resource.port,
		provider: resource.provider,
		deps: [...resource.deps].sort(),
	};
	if (resource.strategy !== undefined) spec.strategy = resource.strategy;
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

/**
 * The sequence number after which a run's own facts begin: the last
 * `deployment.Deployed` or `deployment.RolledBack`. A no-go failure before it
 * belongs to an earlier `up` that has already been rolled back or superseded,
 * so it must not stop a new `up` from converging. A run that crashed before
 * its terminal fact resumes inside the same epoch and still sees its failure.
 */
export function currentEpochStart(events: readonly EventEnvelope[]): number {
	let start = 0;
	for (const event of events)
		if (TERMINAL_DEPLOYMENT_FACTS.has(event.type)) start = event.seq;
	return start;
}

/** True when the log changed after the last `deployment.Deployed`. */
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

/** The recorded state of one resource, folded from its own facts. */
export interface RecordedResource {
	readonly resourceId: string;
	readonly state:
		| "Provisioning"
		| "Provisioned"
		| "Failed"
		| "Destroying"
		| "Destroyed";
	/** Hash of the spec it was last provisioned from; absent on legacy facts. */
	readonly specHash?: string;
	/** The last plan that declared it, from `deployment.Planned`. */
	readonly plan?: ResourcePlan;
}

function resourceIdOf(event: EventEnvelope): string | undefined {
	return isJsonObject(event.data) && isJsonString(event.data.resourceId)
		? event.data.resourceId
		: undefined;
}

function specHashOf(event: EventEnvelope): string | undefined {
	return isJsonObject(event.data) && isJsonString(event.data.specHash)
		? event.data.specHash
		: undefined;
}

function plannedResources(event: EventEnvelope): readonly ResourcePlan[] {
	if (!isJsonObject(event.data)) return [];
	const plan = event.data.plan;
	if (!isJsonObject(plan) || !Array.isArray(plan.resources)) return [];
	// A node that does not parse is skipped: complete mode then reports that
	// orphan unprunable instead of destroying from a guessed spec.
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

/** Every resource the deployment log has ever recorded, by id. */
export function recordedResources(
	events: readonly EventEnvelope[],
): ReadonlyMap<string, RecordedResource> {
	const states = new Map<
		string,
		{ state: RecordedResource["state"]; specHash?: string }
	>();
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
			case CLOUD_EVENTS.ResourceProvisioning:
				states.set(resourceId, {
					state: "Provisioning",
					...(previous?.specHash !== undefined
						? { specHash: previous.specHash }
						: undefined),
				});
				break;
			case CLOUD_EVENTS.ResourceProvisioned: {
				const specHash = specHashOf(event);
				states.set(resourceId, {
					state: "Provisioned",
					...(specHash !== undefined ? { specHash } : undefined),
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
		const plan = plans.get(resourceId);
		out.set(resourceId, {
			resourceId,
			...recorded,
			...(plan !== undefined ? { plan } : undefined),
		});
	}
	return out;
}

/**
 * What `up` would do to one resource. `create`, `update` and `delete` change
 * the provider; `no-op` and `retain` do not.
 */
export type ResourceChangeAction =
	| "create"
	| "update"
	| "no-op"
	| "delete"
	| "retain";

export interface ResourceChange {
	readonly resourceId: string;
	readonly action: ResourceChangeAction;
	/** Why, in one phrase a person can read in a what-if listing. */
	readonly reason: string;
	readonly desiredSpecHash?: DesiredSpecHash;
	readonly recordedSpecHash?: string;
}

export interface DeploymentChangeSet {
	readonly mode: DeploymentMode;
	/** Declared resources first, in plan order, then undeclared ones by id. */
	readonly changes: readonly ResourceChange[];
	readonly summary: Readonly<Record<ResourceChangeAction, number>>;
	/** True when applying this change set would call no provider. */
	readonly converged: boolean;
}

/** Classify one declared resource against what the log recorded for it. */
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
				return {
					...base,
					action: "no-op",
					reason: "provisioned before spec hashes; treated as converged",
				};
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

/**
 * The what-if: every change `up` would make, computed from the plan and the
 * log alone. Pure: reads nothing, writes nothing, calls no provider.
 */
export function planDeploymentChanges(
	plan: DeploymentPlan,
	events: readonly EventEnvelope[],
	mode: DeploymentMode = "incremental",
): DeploymentChangeSet {
	const recorded = recordedResources(events);
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

/** Orphans `complete` mode would destroy, and those it cannot. */
export interface OrphanPrunePlan {
	/** Dependents before their dependencies: the safe destroy order. */
	readonly ordered: readonly ResourcePlan[];
	/** Undeclared resources with no recorded plan (no provider to destroy with). */
	readonly unknown: readonly string[];
}

/**
 * Undeclared resources `complete` mode removes, dependents first: a resource
 * is destroyed only after every orphan that depends on it. Orphans whose last
 * plan is unknown cannot be destroyed (the executor needs their provider) and
 * are returned separately so the caller can report them instead of guessing.
 */
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
	// Reverse topological order over the orphan subgraph.
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
