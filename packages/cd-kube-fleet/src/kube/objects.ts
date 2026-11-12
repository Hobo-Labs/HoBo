// Kubernetes object forms of a resolved Set. Parse, don't validate: a plan
// resource becomes a `KubeObject` here (or a typed refusal), and the hub
// renderers only ever see parsed objects. One plan resource is one object.
import { createHash } from "node:crypto";
import type { RealizeInput } from "@hobo/cd";
import { type JsonObject, type JsonValue, stableDigest } from "@hobo/core";
import { DNS1123_LABEL, DNS1123_SUBDOMAIN } from "../config.js";
import { KubeFleetError } from "../errors.js";
import { cloneAsJson, isJsonBoolean, isJsonObject, isJsonString, objectAt, stringAt } from "../json.js";

export type ResolvedSet = RealizeInput["resolved"];

/** Group/version/kind and REST plural of one object kind. */
export type KindInfo = Readonly<{
	group: string;
	version: string;
	kind: string;
	resource: string;
	namespaced: boolean;
}>;

/** One Kubernetes object, parsed from one plan resource. */
export type KubeObject = Readonly<{
	/** Plan resource name. */
	resource: string;
	/** Plan resource port (the observation's `kind`). */
	port: string;
	classification: string;
	/** Holds state a re-create would lose (kept by ORPHAN_DATA). */
	data: boolean;
	info: KindInfo;
	namespace: string;
	name: string;
	/** Canonical body: apiVersion, kind, metadata (name, namespace, labels, annotations), payload. */
	body: JsonObject;
}>;

const kind = (
	group: string,
	version: string,
	k: string,
	resource: string,
	namespaced = true,
): KindInfo => Object.freeze({ group, version, kind: k, resource, namespaced });

// public-contract: built-in kinds the realizers render without extra hints.
// Secret is deliberately absent: secrets never travel in a Set (I9).
export const KNOWN_KINDS: Readonly<Record<string, KindInfo>> = Object.freeze({
	Deployment: kind("apps", "v1", "Deployment", "deployments"),
	StatefulSet: kind("apps", "v1", "StatefulSet", "statefulsets"),
	DaemonSet: kind("apps", "v1", "DaemonSet", "daemonsets"),
	Service: kind("", "v1", "Service", "services"),
	ConfigMap: kind("", "v1", "ConfigMap", "configmaps"),
	ServiceAccount: kind("", "v1", "ServiceAccount", "serviceaccounts"),
	PersistentVolumeClaim: kind("", "v1", "PersistentVolumeClaim", "persistentvolumeclaims"),
	Namespace: kind("", "v1", "Namespace", "namespaces", false),
	Job: kind("batch", "v1", "Job", "jobs"),
	CronJob: kind("batch", "v1", "CronJob", "cronjobs"),
	Ingress: kind("networking.k8s.io", "v1", "Ingress", "ingresses"),
	NetworkPolicy: kind("networking.k8s.io", "v1", "NetworkPolicy", "networkpolicies"),
	HorizontalPodAutoscaler: kind("autoscaling", "v2", "HorizontalPodAutoscaler", "horizontalpodautoscalers"),
	PodDisruptionBudget: kind("policy", "v1", "PodDisruptionBudget", "poddisruptionbudgets"),
	Role: kind("rbac.authorization.k8s.io", "v1", "Role", "roles"),
	RoleBinding: kind("rbac.authorization.k8s.io", "v1", "RoleBinding", "rolebindings"),
});

// productId (lower-case) → kind, for plan resources authored as product + spec.
const PRODUCT_KINDS: Readonly<Record<string, string>> = Object.freeze(
	Object.fromEntries(Object.keys(KNOWN_KINDS).map((k) => [k.toLowerCase(), k])),
);

const DATA_KINDS = new Set(["PersistentVolumeClaim"]);
const DATA_PORT =
	/(database|^db$|kv|queue|object|storage|bucket|blob|volume|data|cache|stream|search|vector|postgres|mysql|redis)/iu;

const SERVER_FIELDS = ["resourceVersion", "uid", "creationTimestamp", "generation", "managedFields", "selfLink", "deletionTimestamp", "ownerReferences"];

/** apiVersion string of a kind. */
export function apiVersionOf(info: KindInfo): string {
	return info.group === "" ? info.version : `${info.group}/${info.version}`;
}

/** REST path of a collection (namespace ignored for cluster-scoped kinds). */
export function collectionPath(info: KindInfo, namespace: string): string {
	const root = info.group === "" ? `/api/${info.version}` : `/apis/${info.group}/${info.version}`;
	return info.namespaced
		? `${root}/namespaces/${encodeURIComponent(namespace)}/${info.resource}`
		: `${root}/${info.resource}`;
}

export function objectPath(object: KubeObject): string {
	return `${collectionPath(object.info, object.namespace)}/${encodeURIComponent(object.name)}`;
}

/** A stable identity key: group/kind/namespace/name. */
export function identityOf(
	o: Readonly<{ group: string; kind: string; namespace: string; name: string }>,
): string {
	return `${o.group}/${o.kind}/${o.namespace}/${o.name}`;
}

function splitApiVersion(apiVersion: string): Readonly<{ group: string; version: string }> {
	const slash = apiVersion.indexOf("/");
	return slash < 0
		? { group: "", version: apiVersion }
		: { group: apiVersion.slice(0, slash), version: apiVersion.slice(slash + 1) };
}

function refuse(code: "kube-object-unrenderable" | "kube-kind-unknown" | "kube-secret-refused" | "kube-name-invalid", resource: string, message: string): KubeFleetError {
	return new KubeFleetError(code, `${resource}: ${message}`);
}

function stringMap(value: JsonValue | undefined): Readonly<Record<string, string>> {
	if (!isJsonObject(value)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) if (isJsonString(v)) out[k] = v;
	return out;
}

function kindInfoFor(
	resource: string,
	apiVersion: string,
	kindName: string,
	params: JsonObject,
): KindInfo {
	if (kindName === "Secret")
		throw refuse("kube-secret-refused", resource, "a Secret manifest would put secret material in a record");
	const known = KNOWN_KINDS[kindName];
	const { group, version } = splitApiVersion(apiVersion);
	if (known !== undefined && known.group === group) return Object.freeze({ ...known, version });
	const plural = params.resource;
	const namespaced = params.namespaced;
	if (isJsonString(plural) && /^[a-z][a-z0-9]{0,62}$/u.test(plural) && isJsonBoolean(namespaced))
		return kind(group, version, kindName, plural, namespaced);
	throw refuse("kube-kind-unknown", resource, `kind ${apiVersion}/${kindName} is not built in`);
}

function sanitizeMetadata(metadata: JsonObject): JsonObject {
	const out: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (SERVER_FIELDS.includes(key)) continue;
		out[key] = value;
	}
	return out;
}

type Plan = ResolvedSet["plan"]["resources"][number];

function renderOne(plan: Plan, defaultNamespace: string): KubeObject {
	const params: JsonObject = isJsonObject(plan.realizationParameters)
		? { ...plan.realizationParameters }
		: {};
	const classification = stringAt(params, "classification") ?? "";
	const manifest = params.manifest;
	let body: JsonObject;
	let info: KindInfo;
	if (isJsonObject(manifest)) {
		const apiVersion = stringAt(manifest, "apiVersion");
		const kindName = stringAt(manifest, "kind");
		if (apiVersion === undefined || kindName === undefined)
			throw refuse("kube-object-unrenderable", plan.name, "manifest needs apiVersion and kind");
		info = kindInfoFor(plan.name, apiVersion, kindName, params);
		const rest = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "status"));
		body = { ...rest, metadata: sanitizeMetadata(objectAt(manifest, "metadata")) };
	} else {
		const productId = (plan.productId ?? "").toLowerCase();
		if (productId === "secret")
			throw refuse("kube-secret-refused", plan.name, "a Secret would put secret material in a record");
		const kindName = PRODUCT_KINDS[productId];
		const known = kindName === undefined ? undefined : KNOWN_KINDS[kindName];
		const payloadKey = kindName === "ConfigMap" ? "data" : "spec";
		const payload = params[payloadKey];
		if (known === undefined || !isJsonObject(payload))
			throw refuse(
				"kube-object-unrenderable",
				plan.name,
				"no realizationParameters.manifest and no known productId with realizationParameters.spec",
			);
		info = known;
		const labels = stringMap(params.labels);
		body = {
			apiVersion: apiVersionOf(info),
			kind: info.kind,
			metadata: {
				name: stringAt(params, "name") ?? plan.name,
				...(Object.keys(labels).length > 0 ? { labels } : undefined),
			},
			[payloadKey]: payload,
		};
	}
	const metadata = objectAt(body, "metadata");
	const name = stringAt(metadata, "name") ?? "";
	if (!DNS1123_SUBDOMAIN.test(name))
		throw refuse("kube-name-invalid", plan.name, `name ${JSON.stringify(name)} is not DNS-1123`);
	const namespace = info.namespaced
		? (stringAt(metadata, "namespace") ?? stringAt(params, "namespace") ?? defaultNamespace)
		: "";
	if (info.namespaced && !DNS1123_LABEL.test(namespace))
		throw refuse("kube-name-invalid", plan.name, `namespace ${JSON.stringify(namespace)} is not DNS-1123`);
	const canonical: JsonObject = {
		...body,
		apiVersion: apiVersionOf(info),
		kind: info.kind,
		metadata: { ...metadata, name, ...(info.namespaced ? { namespace } : undefined) },
	};
	return Object.freeze({
		resource: plan.name,
		port: plan.port,
		classification,
		data: classification !== "" || DATA_KINDS.has(info.kind) || DATA_PORT.test(plan.port),
		info,
		namespace,
		name,
		// SAFETY: canonical is built from parsed JSON values only.
		body: cloneAsJson(canonical) as JsonObject,
	});
}

/**
 * Render every plan resource of a resolved set. Any resource without a
 * Kubernetes form refuses the whole set: a partial apply would converge a
 * Camp to something nobody declared.
 */
export function renderObjects(
	resolved: ResolvedSet,
	defaultNamespace: string,
): readonly KubeObject[] {
	const objects = resolved.plan.resources.map((plan) => renderOne(plan, defaultNamespace));
	const seen = new Set<string>();
	for (const object of objects) {
		const id = identityOf({ group: object.info.group, kind: object.info.kind, namespace: object.namespace, name: object.name });
		if (seen.has(id))
			throw refuse("kube-object-unrenderable", object.resource, `two plan resources render to ${id}`);
		seen.add(id);
	}
	return Object.freeze(
		[...objects].sort((a, b) => a.resource.localeCompare(b.resource)),
	);
}

/** First 8 hex characters of a `sha256:` digest (or of the sha256 of a string). */
export function digest8(value: string): string {
	const hex = value.startsWith("sha256:") ? value.slice(7) : createHash("sha256").update(value).digest("hex");
	return hex.slice(0, 8).toLowerCase();
}

/**
 * A DNS-1123 slug for a Camp id, at most 40 characters. When sanitizing
 * changes the id, a 6-hex digest of the original keeps slugs distinct.
 */
export function campSlug(campId: string): string {
	const base = campId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/gu, "-")
		.replace(/-+/gu, "-")
		.replace(/^-|-$/gu, "");
	if (base === campId && base.length <= 40 && base !== "") return base;
	const suffix = createHash("sha256").update(campId).digest("hex").slice(0, 6);
	const head = base.slice(0, 33).replace(/-$/u, "");
	return head === "" ? `c-${suffix}` : `${head}-${suffix}`;
}

/** Digest of a JSON value (canonical, key-sorted). */
export function digestOf(value: JsonValue): string {
	return stableDigest(value);
}

// public-contract: labels and annotations HoBo writes on hub objects.
export const HOBO_KEYS = Object.freeze({
	managedBy: "app.kubernetes.io/managed-by",
	managedByValue: "hobo",
	camp: "hobo.dev/camp",
	campId: "hobo.dev/camp-id",
	setId: "hobo.dev/set-id",
	contentHash: "hobo.dev/content-hash",
	manifestsDigest: "hobo.dev/manifests-digest",
	fence: "hobo.dev/fence",
	reconciler: "hobo.dev/reconciler",
} as const);

/** The fence recorded on a hub object, if any. */
export function fenceOf(object: JsonObject): bigint | undefined {
	const raw = stringAt(objectAt(objectAt(object, "metadata"), "annotations"), HOBO_KEYS.fence);
	if (raw === undefined || !/^[0-9]{1,30}$/u.test(raw)) return undefined;
	return BigInt(raw);
}
