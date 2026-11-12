// Open Cluster Management ManifestWork (work.open-cluster-management.io/v1):
// rendering one single-cluster work per Camp and parsing its status. Never a
// ManifestWorkReplicaSet, never an OCM Placement (D26): HoBo places, fans out
// and rolls out; the hub only transports.
import { DepartureAction } from "@hobo/cd";
import type { JsonObject, JsonValue } from "@hobo/core";
import { arrayAt, isJsonObject, isJsonString, numberAt, objectAt, stringAt } from "../json.js";
import { campSlug, digest8, digestOf, HOBO_KEYS, identityOf, type KubeObject } from "../kube/objects.js";

export const OCM_WORK_API = "/apis/work.open-cluster-management.io/v1" as const;

/** Collection of ManifestWorks in one cluster namespace. */
export function worksPath(cluster: string): string {
	return `${OCM_WORK_API}/namespaces/${encodeURIComponent(cluster)}/manifestworks`;
}

/** `hobo-<camp>-<setdigest8>`: one ManifestWork per Camp and Set. */
export function workName(campId: string, setDigest: string): string {
	return `hobo-${campSlug(campId)}-${digest8(setDigest)}`;
}

/** Status fields an observe field can ask OCM to feed back (`status.*` only). */
export function feedbackPath(field: string): string | undefined {
	return field.startsWith("status.") && field.length > 7 ? `.${field.slice(7)}` : undefined;
}

// Kinds with an OCM WellKnownStatus feedback rule.
const WELL_KNOWN = new Set(["Deployment", "Job", "DaemonSet", "StatefulSet", "Pod"]);

function deleteOption(
	action: DepartureAction,
	objects: readonly KubeObject[],
	keep: ReadonlySet<string>,
): JsonObject {
	if (action === DepartureAction.DELETE && keep.size === 0) return { propagationPolicy: "Foreground" };
	if (action === DepartureAction.ORPHAN) return { propagationPolicy: "Orphan" };
	const orphaned = objects.filter(
		(o) => keep.has(o.resource) || (action !== DepartureAction.DELETE && o.data),
	);
	if (orphaned.length === 0) return { propagationPolicy: "Foreground" };
	return {
		propagationPolicy: "SelectivelyOrphan",
		selectivelyOrphans: {
			orphaningRules: orphaned.map((o) => ({
				group: o.info.group,
				resource: o.info.resource,
				...(o.info.namespaced ? { namespace: o.namespace } : undefined),
				name: o.name,
			})),
		},
	};
}

export type WorkSpecInput = Readonly<{
	campId: string;
	cluster: string;
	setId: string;
	contentHash: string;
	fence: bigint;
	reconcilerId: string;
	objects: readonly KubeObject[];
	observeFields: readonly string[];
	departure: DepartureAction;
	keep: ReadonlySet<string>;
}>;

/** The manifests array: canonical object bodies in resource order. */
export function manifestsOf(objects: readonly KubeObject[]): JsonValue[] {
	return objects.map((o) => o.body);
}

/** The full desired ManifestWork for one Camp. */
export function renderManifestWork(input: WorkSpecInput): JsonObject {
	const manifests = manifestsOf(input.objects);
	const statusPaths = input.observeFields
		.map((field) => ({ name: field, path: feedbackPath(field) }))
		.filter((p): p is { name: string; path: string } => p.path !== undefined);
	const manifestConfigs = input.objects
		.map((o) => {
			const rules: JsonObject[] = [];
			if (WELL_KNOWN.has(o.info.kind)) rules.push({ type: "WellKnownStatus" });
			if (statusPaths.length > 0) rules.push({ type: "JSONPaths", jsonPaths: statusPaths });
			if (rules.length === 0) return undefined;
			return {
				resourceIdentifier: {
					group: o.info.group,
					resource: o.info.resource,
					...(o.info.namespaced ? { namespace: o.namespace } : undefined),
					name: o.name,
				},
				feedbackRules: rules,
			};
		})
		.filter((c) => c !== undefined);
	return {
		apiVersion: "work.open-cluster-management.io/v1",
		kind: "ManifestWork",
		metadata: {
			name: workName(input.campId, input.contentHash),
			namespace: input.cluster,
			labels: {
				[HOBO_KEYS.managedBy]: HOBO_KEYS.managedByValue,
				[HOBO_KEYS.camp]: campSlug(input.campId),
			},
			annotations: {
				[HOBO_KEYS.campId]: input.campId,
				[HOBO_KEYS.setId]: input.setId,
				[HOBO_KEYS.contentHash]: input.contentHash,
				[HOBO_KEYS.manifestsDigest]: digestOf(manifests),
				[HOBO_KEYS.fence]: input.fence.toString(),
				[HOBO_KEYS.reconciler]: input.reconcilerId,
			},
		},
		spec: {
			workload: { manifests },
			deleteOption: deleteOption(input.departure, input.objects, input.keep),
			...(manifestConfigs.length > 0 ? { manifestConfigs } : undefined),
		},
	};
}

// ── Status ────────────────────────────────────────────────────────────────

export type Condition = Readonly<{
	type: string;
	status: "True" | "False" | "Unknown";
	reason: string;
	message: string;
	observedGeneration: number | undefined;
}>;

export type ManifestStatus = Readonly<{
	identity: string;
	conditions: readonly Condition[];
	feedback: Readonly<Record<string, string>>;
}>;

export type WorkStatus = Readonly<{
	name: string;
	generation: number;
	resourceVersion: string;
	manifestsDigest: string;
	contentHash: string;
	conditions: readonly Condition[];
	manifests: readonly ManifestStatus[];
}>;

export function parseConditions(value: JsonValue | undefined): readonly Condition[] {
	if (!Array.isArray(value)) return [];
	const out: Condition[] = [];
	for (const entry of value) {
		const type = stringAt(entry, "type");
		const status = stringAt(entry, "status");
		if (type === undefined || (status !== "True" && status !== "False" && status !== "Unknown")) continue;
		out.push({
			type,
			status,
			reason: stringAt(entry, "reason") ?? "",
			message: stringAt(entry, "message") ?? "",
			observedGeneration: numberAt(entry, "observedGeneration"),
		});
	}
	return out;
}

export function condition(conditions: readonly Condition[], type: string): Condition | undefined {
	return conditions.find((c) => c.type === type);
}

function feedbackValue(fieldValue: JsonValue | undefined): string | undefined {
	if (!isJsonObject(fieldValue)) return undefined;
	const type = stringAt(fieldValue, "type");
	if (type === "Integer") {
		const n = numberAt(fieldValue, "integer");
		return n === undefined ? undefined : String(n);
	}
	if (type === "String") return stringAt(fieldValue, "string");
	if (type === "Boolean") {
		const b = fieldValue.boolean;
		return b === true ? "true" : b === false ? "false" : undefined;
	}
	if (type === "JsonRaw") return stringAt(fieldValue, "jsonRaw");
	return undefined;
}

/** Parse a ManifestWork the hub returned. Missing status parses as empty. */
export function parseWorkStatus(work: JsonObject): WorkStatus {
	const metadata = objectAt(work, "metadata");
	const annotations = objectAt(metadata, "annotations");
	const status = objectAt(work, "status");
	const manifests: ManifestStatus[] = [];
	for (const entry of arrayAt(objectAt(status, "resourceStatus"), "manifests")) {
		const meta = objectAt(entry, "resourceMeta");
		const feedback: Record<string, string> = {};
		for (const value of arrayAt(objectAt(entry, "statusFeedback"), "values")) {
			const name = stringAt(value, "name");
			const text = feedbackValue(isJsonObject(value) ? value.fieldValue : undefined);
			if (name !== undefined && text !== undefined) feedback[name] = text;
		}
		manifests.push({
			identity: identityOf({
				group: stringAt(meta, "group") ?? "",
				kind: stringAt(meta, "kind") ?? "",
				namespace: stringAt(meta, "namespace") ?? "",
				name: stringAt(meta, "name") ?? "",
			}),
			conditions: parseConditions(isJsonObject(entry) ? entry.conditions : undefined),
			feedback,
		});
	}
	const manifestsValue = objectAt(objectAt(work, "spec"), "workload").manifests;
	return {
		name: stringAt(metadata, "name") ?? "",
		generation: numberAt(metadata, "generation") ?? 0,
		resourceVersion: stringAt(metadata, "resourceVersion") ?? "",
		manifestsDigest: Array.isArray(manifestsValue) ? digestOf(manifestsValue) : "",
		contentHash: isJsonString(annotations[HOBO_KEYS.contentHash]) ? String(annotations[HOBO_KEYS.contentHash]) : "",
		conditions: parseConditions(status.conditions),
		manifests,
	};
}
