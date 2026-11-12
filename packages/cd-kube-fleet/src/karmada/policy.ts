// Karmada (policy.karmada.io/v1alpha1, work.karmada.io/v1alpha2): the
// PropagationPolicy that pins a Camp's templates to exactly one member, and
// the ResourceBinding status HoBo observes. No OverridePolicy, no spread
// constraints, no failover: Karmada transports, HoBo decides (D26).
import { DepartureAction } from "@hobo/cd";
import type { JsonObject, JsonValue } from "@hobo/core";
import { arrayAt, isJsonBoolean, isJsonObject, objectAt, stringAt } from "../json.js";
import { apiVersionOf, campSlug, HOBO_KEYS, identityOf, type KubeObject } from "../kube/objects.js";

export const KARMADA_POLICY_API = "/apis/policy.karmada.io/v1alpha1" as const;
export const KARMADA_WORK_API = "/apis/work.karmada.io/v1alpha2" as const;

/** Cluster-wide list path for PropagationPolicies (filtered by label). */
export const POLICIES_PATH = `${KARMADA_POLICY_API}/propagationpolicies` as const;

export function policiesPath(namespace: string): string {
	return `${KARMADA_POLICY_API}/namespaces/${encodeURIComponent(namespace)}/propagationpolicies`;
}

/** `<name>-<kind lower-case>`: the binding Karmada names after a template. */
export function bindingPath(object: Pick<KubeObject, "namespace" | "name" | "info">): string {
	return `${KARMADA_WORK_API}/namespaces/${encodeURIComponent(object.namespace)}/resourcebindings/${encodeURIComponent(`${object.name}-${object.info.kind.toLowerCase()}`)}`;
}

export type PolicyClass = "compute" | "data";

export function policyName(campId: string, cls: PolicyClass): string {
	const base = `hobo-${campSlug(campId)}`;
	return cls === "data" ? `${base}-data` : base;
}

/**
 * Whether a policy class preserves member resources when its template is
 * deleted: compute only under ORPHAN; data unless DELETE.
 */
export function preserves(cls: PolicyClass, action: DepartureAction): boolean {
	return cls === "compute" ? action === DepartureAction.ORPHAN : action !== DepartureAction.DELETE;
}

/** One selected template, as recorded in the policy's resource index. */
export type Selected = Readonly<{
	identity: string;
	resource: string;
	apiVersion: string;
	kind: string;
	plural: string;
	namespace: string;
	name: string;
}>;

export const RESOURCE_INDEX = "hobo.dev/resource-index";

export function selectedOf(object: KubeObject): Selected {
	return {
		identity: identityOf({ group: object.info.group, kind: object.info.kind, namespace: object.namespace, name: object.name }),
		resource: object.resource,
		apiVersion: apiVersionOf(object.info),
		kind: object.info.kind,
		plural: object.info.resource,
		namespace: object.namespace,
		name: object.name,
	};
}

export type PolicyInput = Readonly<{
	campId: string;
	namespace: string;
	cls: PolicyClass;
	member: string;
	selected: readonly Selected[];
	action: DepartureAction;
	fence: bigint;
	reconcilerId: string;
}>;

/** A PropagationPolicy pinned to exactly one member, `Duplicated`. */
export function renderPolicy(input: PolicyInput): JsonObject {
	const selected = [...input.selected].sort((a, b) => a.identity.localeCompare(b.identity));
	return {
		apiVersion: "policy.karmada.io/v1alpha1",
		kind: "PropagationPolicy",
		metadata: {
			name: policyName(input.campId, input.cls),
			namespace: input.namespace,
			labels: {
				[HOBO_KEYS.managedBy]: HOBO_KEYS.managedByValue,
				[HOBO_KEYS.camp]: campSlug(input.campId),
			},
			annotations: {
				[HOBO_KEYS.campId]: input.campId,
				[HOBO_KEYS.fence]: input.fence.toString(),
				[HOBO_KEYS.reconciler]: input.reconcilerId,
				[RESOURCE_INDEX]: JSON.stringify(selected),
			},
		},
		spec: {
			resourceSelectors: selected.map((s) => ({
				apiVersion: s.apiVersion,
				kind: s.kind,
				namespace: s.namespace,
				name: s.name,
			})),
			placement: {
				clusterAffinity: { clusterNames: [input.member] },
				replicaScheduling: { replicaSchedulingType: "Duplicated" },
			},
			preserveResourcesOnDeletion: preserves(input.cls, input.action),
			conflictResolution: "Abort",
			propagateDeps: false,
		},
	};
}

/** The resource index a policy recorded. */
export function indexOf(policy: JsonObject): readonly Selected[] {
	const raw = stringAt(objectAt(objectAt(policy, "metadata"), "annotations"), RESOURCE_INDEX);
	if (raw === undefined) return [];
	let parsed: JsonValue;
	try {
		// SAFETY: JSON.parse of an annotation this package wrote; shape checked below.
		parsed = JSON.parse(raw) as JsonValue;
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: Selected[] = [];
	for (const row of parsed) {
		const fields = ["identity", "resource", "apiVersion", "kind", "plural", "namespace", "name"] as const;
		const values = fields.map((f) => stringAt(row, f));
		if (values.some((v) => v === undefined)) continue;
		const [identity, resource, apiVersion, kind, plural, namespace, name] = values.map((v) => v ?? "");
		out.push({ identity: identity ?? "", resource: resource ?? "", apiVersion: apiVersion ?? "", kind: kind ?? "", plural: plural ?? "", namespace: namespace ?? "", name: name ?? "" });
	}
	return out;
}

export function policyPreserves(policy: JsonObject): boolean {
	const value = objectAt(policy, "spec").preserveResourcesOnDeletion;
	return isJsonBoolean(value) && value;
}

// ── ResourceBinding status ───────────────────────────────────────────────

export type MemberStatus = Readonly<{
	cluster: string;
	applied: boolean | undefined;
	appliedMessage: string;
	health: string;
	status: JsonObject;
}>;

export type BindingStatus = Readonly<{
	resourceVersion: string;
	clusters: readonly string[];
	members: readonly MemberStatus[];
}>;

export function parseBinding(binding: JsonObject): BindingStatus {
	const spec = objectAt(binding, "spec");
	const members: MemberStatus[] = [];
	for (const entry of arrayAt(objectAt(binding, "status"), "aggregatedStatus")) {
		const cluster = stringAt(entry, "clusterName");
		if (cluster === undefined) continue;
		const applied = isJsonObject(entry) ? entry.applied : undefined;
		members.push({
			cluster,
			applied: isJsonBoolean(applied) ? applied : undefined,
			appliedMessage: stringAt(entry, "appliedMessage") ?? "",
			health: stringAt(entry, "health") ?? "Unknown",
			status: objectAt(entry, "status"),
		});
	}
	return {
		resourceVersion: stringAt(objectAt(spec, "resource"), "resourceVersion") ?? "",
		clusters: arrayAt(spec, "clusters")
			.map((c) => stringAt(c, "name"))
			.filter((c): c is string => c !== undefined),
		members,
	};
}
