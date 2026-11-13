// SIG-Multicluster ClusterProfile (multicluster.x-k8s.io/v1alpha1, KEP-4322)
// → HoBo Camp. Parse, don't validate: a profile becomes an `ImportedCamp`
// here or is skipped with a reason. Imported Camps are OBSERVE_ONLY; their
// properties, labels and status become *claims* and conditions, never
// declared topology (I19: claims narrow, never grant). Access-provider
// endpoints and credentials are never copied into a record.
import { create } from "@bufbuild/protobuf";
import {
	type CampClaimRecord,
	CampClaimRecordSchema,
	type CampConditionRecord,
	CampConditionRecordSchema,
	CampConditionType,
	type CampId,
	CampManagement,
	type CampTopology,
	ConditionStatus,
	type ReasonRecord,
	SignalSource,
} from "@hobo/cd";
import type { JsonObject } from "@hobo/core";
import {
	type ImportedClusterRecord,
	ImportedClusterRecordSchema,
} from "../_generated/kube_fleet_pb.js";
import {
	type ClusterProfileImport,
	DNS1123_LABEL,
	DNS1123_SUBDOMAIN,
} from "../config.js";
import { reason } from "../errors.js";
import {
	arrayAt,
	isJsonObject,
	isJsonString,
	objectAt,
	type StringMap,
	stringAt,
} from "../json.js";
import { campSlug } from "../kube/objects.js";

const CLUSTER_PROFILE_API = "/apis/multicluster.x-k8s.io/v1alpha1" as const;

export function profilesPath(namespace: string | undefined): string {
	return namespace === undefined
		? `${CLUSTER_PROFILE_API}/clusterprofiles`
		: `${CLUSTER_PROFILE_API}/namespaces/${encodeURIComponent(namespace)}/clusterprofiles`;
}

/** Access provider names and their (in-memory only) cluster endpoints. */
export type AccessProvider = Readonly<{
	name: string;
	server: string | undefined;
}>;

export type ImportedCamp = Readonly<{
	topology: CampTopology;
	conditions: readonly CampConditionRecord[];
	claims: readonly CampClaimRecord[];
	/** Secret-free record of what was imported. */
	record: ImportedClusterRecord;
	/** Observed attributes for posture (`kind: kubernetes-cluster`). */
	attributes: Readonly<Record<string, string>>;
	/** Never recorded: used host-side to reach the member API. */
	access: readonly AccessProvider[];
}>;

const CLAIM_NAME = /^[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const LABEL_KEY = /^[A-Za-z0-9]([A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const MAX_VALUE = 256;

// Well-known labels that map to the claim names inventory compares with
// declared topology (WP22 CLAIMS_CONSISTENT).
const LABEL_CLAIMS: Readonly<Record<string, string>> = Object.freeze({
	"topology.kubernetes.io/region": "region",
	"topology.kubernetes.io/zone": "zone",
});

const CONDITION_STATUS: Readonly<Record<string, ConditionStatus>> =
	Object.freeze({
		True: ConditionStatus.TRUE,
		False: ConditionStatus.FALSE,
		Unknown: ConditionStatus.UNKNOWN,
	});

/** Camp id of a profile: `<prefix><slug(namespace-name)>`. */
export function campIdOf(
	config: ClusterProfileImport,
	namespace: string,
	name: string,
): string {
	return `${config.campIdPrefix}${campSlug(`${namespace}-${name}`)}`;
}

function claim(
	name: string,
	value: string,
	reportedBy: string,
	observedAt: string,
): CampClaimRecord | undefined {
	if (
		!CLAIM_NAME.test(name.replace(/^label:/u, "")) ||
		value.length > MAX_VALUE
	)
		return undefined;
	return create(CampClaimRecordSchema, { name, value, reportedBy, observedAt });
}

export type ParseResult =
	| Readonly<{ ok: true; camp: ImportedCamp }>
	| Readonly<{ ok: false; reason: ReasonRecord }>;

/** Parse one ClusterProfile list item. `observedAt` is the import time (ISO). */
export function parseClusterProfile(
	item: JsonObject,
	config: ClusterProfileImport,
	observedAt: string,
): ParseResult {
	const metadata = objectAt(item, "metadata");
	const name = stringAt(metadata, "name");
	const namespace = stringAt(metadata, "namespace");
	if (
		name === undefined ||
		namespace === undefined ||
		!DNS1123_SUBDOMAIN.test(name) ||
		!DNS1123_LABEL.test(namespace)
	)
		return {
			ok: false,
			reason: reason(
				"clusterprofile-invalid",
				`profile ${namespace ?? "?"}/${name ?? "?"} lacks a valid name or namespace`,
			),
		};
	const kind = stringAt(item, "kind");
	if (kind !== undefined && kind !== "ClusterProfile")
		return {
			ok: false,
			reason: reason(
				"clusterprofile-invalid",
				`${namespace}/${name} is a ${kind}`,
			),
		};
	const spec = objectAt(item, "spec");
	const status = objectAt(item, "status");
	const manager =
		stringAt(objectAt(spec, "clusterManager"), "name") ?? config.hub.name;
	const reportedBy = `service:cluster-manager/${manager}`;
	const campId = campIdOf(config, namespace, name);
	const claims: CampClaimRecord[] = [];
	const attributes: Record<string, string> = {};
	const labels = objectAt(metadata, "labels");
	const topologyLabels = {
		"hobo.cd/cluster-profile-namespace": namespace,
		"hobo.cd/cluster-profile-name": name,
	} satisfies StringMap;
	for (const [key, value] of Object.entries(labels).sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		if (!isJsonString(value) || !LABEL_KEY.test(key)) continue;
		const mapped = LABEL_CLAIMS[key];
		const c = claim(mapped ?? `label:${key}`, value, reportedBy, observedAt);
		if (c !== undefined) claims.push(c);
		attributes[`label.${key}`] = value;
	}
	const kubernetesVersion =
		stringAt(objectAt(status, "version"), "kubernetes") ?? "";
	if (kubernetesVersion !== "") {
		const c = claim(
			"kubernetes.version",
			kubernetesVersion,
			reportedBy,
			observedAt,
		);
		if (c !== undefined) claims.push(c);
		attributes["kubernetes.version"] = kubernetesVersion;
	}
	for (const property of arrayAt(status, "properties")) {
		const pname = stringAt(property, "name");
		const pvalue = stringAt(property, "value");
		if (pname === undefined || pvalue === undefined) continue;
		const at = stringAt(property, "lastObservedTime") ?? observedAt;
		const c = claim(pname, pvalue, reportedBy, at);
		if (c !== undefined) claims.push(c);
		attributes[`property.${pname}`] = pvalue;
	}
	const conditions: CampConditionRecord[] = [];
	for (const entry of arrayAt(status, "conditions")) {
		const type = stringAt(entry, "type");
		const raw = stringAt(entry, "status") ?? "Unknown";
		attributes[`condition.${type ?? "?"}`] = raw;
		if (type !== "ControlPlaneHealthy") continue;
		conditions.push(
			create(CampConditionRecordSchema, {
				type: CampConditionType.READY,
				status: CONDITION_STATUS[raw] ?? ConditionStatus.UNKNOWN,
				// A fleet manager's report is an external observation: it can
				// narrow (NO_PLACE) but never alone trigger failover.
				source: SignalSource.HEALTH_SOURCE,
				reason: `clusterprofile:${stringAt(entry, "reason") ?? raw}`,
				since: stringAt(entry, "lastTransitionTime") ?? observedAt,
			}),
		);
	}
	const providers = [
		...arrayAt(status, "accessProviders"),
		...arrayAt(status, "credentialProviders"),
	]
		.filter(isJsonObject)
		.map((p) => ({
			name: stringAt(p, "name") ?? "",
			server: stringAt(objectAt(p, "cluster"), "server"),
		}))
		.filter((p) => p.name !== "");
	const topology: CampTopology = Object.freeze({
		// SAFETY: brand applied to the import's deterministic Camp id.
		campId: campId as CampId,
		yardId: config.yardId,
		stationId: config.stationId,
		provider: config.provider,
		regions: config.regions,
		envType: config.envType,
		labels: Object.freeze(topologyLabels),
		management: CampManagement.OBSERVE_ONLY,
	});
	return {
		ok: true,
		camp: Object.freeze({
			topology,
			conditions: Object.freeze(conditions),
			claims: Object.freeze(claims),
			record: create(ImportedClusterRecordSchema, {
				campId,
				profileNamespace: namespace,
				profileName: name,
				clusterManager: manager,
				kubernetesVersion,
				accessProviders: [...new Set(providers.map((p) => p.name))].sort(),
				resourceVersion: stringAt(metadata, "resourceVersion") ?? "",
			}),
			attributes: Object.freeze(attributes),
			access: Object.freeze(providers),
		}),
	};
}
