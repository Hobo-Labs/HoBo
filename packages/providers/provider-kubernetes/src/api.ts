/**
 * Parse-don't-validate boundary for Kubernetes apiserver responses.
 *
 * Source of truth: the core/v1 and apps/v1 object schemas
 * (https://kubernetes.io/docs/reference/kubernetes-api/, checked 2026-08-08).
 * Every field this driver depends on is checked here once; downstream code
 * sees a {@link NamespaceRecord}, {@link DeploymentRecord} or
 * {@link ServiceRecord} and never a bag of unknowns.
 *
 * The one derivation that matters is {@link rolloutPhaseFor}. A Deployment has
 * no phase field — it has a generation, an observed generation, four replica
 * counters and a condition list that disagree with each other for the whole
 * length of a rollout. Reading `readyReplicas` on its own reports the previous
 * ReplicaSet's success as the new rollout's.
 */

import { contractChanged, redactClusterText } from "./errors.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
} from "./json.js";

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u;
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RESOURCE_VERSION = /^[A-Za-z0-9]{1,64}$/u;
const IPV4 = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/u;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/u;
const CONDITION_REASON = /^[A-Za-z][A-Za-z0-9]{2,63}$/u;

export const NAMESPACE_PHASES = ["Active", "Terminating"] as const;
export type NamespacePhase = (typeof NAMESPACE_PHASES)[number];

export const ROLLOUT_PHASES = [
	"pending",
	"progressing",
	"available",
	"failed",
] as const;
export type RolloutPhase = (typeof ROLLOUT_PHASES)[number];

export type ObjectMeta = {
	readonly name: string;
	readonly namespace?: string;
	readonly uid: string;
	readonly resourceVersion: string;
	readonly generation?: number;
	readonly createdAtMs?: number;
};

export type NamespaceRecord = {
	readonly name: string;
	readonly uid: string;
	readonly resourceVersion: string;
	readonly phase: NamespacePhase;
	readonly createdAtMs: number;
	/** True only when this driver's own POST created it. Adoption never sets it. */
	readonly createdByHobo: boolean;
};

export type DeploymentRecord = {
	readonly name: string;
	readonly namespace: string;
	readonly uid: string;
	readonly resourceVersion: string;
	readonly generation: number;
	readonly observedGeneration: number;
	readonly desiredReplicas: number;
	readonly updatedReplicas: number;
	readonly readyReplicas: number;
	readonly availableReplicas: number;
	readonly phase: RolloutPhase;
	/** The controller's own condition reason. Empty unless `phase` is `failed`. */
	readonly failureReason: string;
};

export type ServiceRecord = {
	readonly name: string;
	readonly namespace: string;
	readonly clusterIp: string;
	readonly port: number;
	readonly targetPort: number;
	readonly clusterDnsName: string;
};

export type ApiStatus = {
	readonly kind: "Status";
	readonly status: string;
	readonly reason: string;
	readonly message: string;
	readonly code: number;
};

function decodeObject(body: string, what: string): JsonObject {
	let decoded: unknown;
	try {
		// SAFETY: assertion to `ON.parse(body) as unknown; ` is required at this boundary.
		decoded = JSON.parse(body) as unknown;
	} catch {
		contractChanged(`${what} response was not JSON`, {
			preview: redactClusterText(body, 80),
		});
	}
	if (!isJsonObject(decoded) || decoded === null || Array.isArray(decoded)) {
		contractChanged(`${what} response was not a JSON object`);
	}
	// SAFETY: assertion to `coded as JsonObject; ` is required at this boundary.
	return decoded as JsonObject;
}

function child(record: JsonObject, key: string, what: string): JsonObject {
	const value = record[key];
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		contractChanged(`${what} is missing its ${key} object`);
	}
	// SAFETY: assertion to `lue as JsonObject; ` is required at this boundary.
	return value as JsonObject;
}

function optionalChild(record: JsonObject, key: string): JsonObject {
	const value = record[key];
	if (!isJsonObject(value) || value === null || Array.isArray(value)) {
		return {};
	}
	// SAFETY: assertion to `lue as JsonObject; ` is required at this boundary.
	return value as JsonObject;
}

function requireKind(record: JsonObject, kind: string): JsonObject {
	if (record.kind !== kind) {
		contractChanged(
			`apiserver returned kind ${redactClusterText(String(record.kind), 32)} where ${kind} was expected`,
		);
	}
	return record;
}

function requireCount(
	record: JsonObject,
	key: string,
	what: string,
	fallback?: number,
): number {
	const value = record[key];
	if (value === undefined && fallback !== undefined) return fallback;
	if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
		contractChanged(`${what} field ${key} is not a whole non-negative number`);
	}
	return value;
}

function parseMeta(
	record: JsonObject,
	what: string,
	options: { readonly namespaced: boolean },
): ObjectMeta {
	const metadata = child(record, "metadata", what);
	const name = metadata.name;
	if (!isJsonString(name) || !DNS_1123_LABEL.test(name)) {
		contractChanged(`${what} metadata.name is not an RFC 1123 label`);
	}
	const uid = metadata.uid;
	if (!isJsonString(uid) || !UID.test(uid)) {
		contractChanged(`${what} metadata.uid is not a UID`);
	}
	const resourceVersion = metadata.resourceVersion;
	if (
		!isJsonString(resourceVersion) ||
		!RESOURCE_VERSION.test(resourceVersion)
	) {
		contractChanged(`${what} metadata.resourceVersion is not an opaque token`);
	}
	let namespace: string | undefined;
	if (options.namespaced) {
		const raw = metadata.namespace;
		if (!isJsonString(raw) || !DNS_1123_LABEL.test(raw)) {
			contractChanged(`${what} metadata.namespace is not an RFC 1123 label`);
		}
		namespace = raw;
	}
	let createdAtMs: number | undefined;
	if (metadata.creationTimestamp !== undefined) {
		if (!isJsonString(metadata.creationTimestamp)) {
			contractChanged(`${what} metadata.creationTimestamp is not a string`);
		}
		const parsed = Date.parse(metadata.creationTimestamp);
		if (!Number.isFinite(parsed)) {
			contractChanged(
				`${what} metadata.creationTimestamp is not an RFC 3339 instant`,
			);
		}
		createdAtMs = parsed;
	}
	let generation: number | undefined;
	if (metadata.generation !== undefined) {
		generation = requireCount(metadata, "generation", `${what} metadata`);
	}

	return {
		name,
		...(namespace !== undefined ? { namespace } : undefined),
		uid,
		resourceVersion,
		...(generation !== undefined ? { generation } : undefined),
		...(createdAtMs !== undefined ? { createdAtMs } : undefined),
	};
}

/** Parse the `kind: "Status"` envelope every non-2xx apiserver body carries. */
export function parseApiStatus(body: string): ApiStatus {
	const record = decodeObject(body, "apiserver Status");
	requireKind(record, "Status");
	const reason = record.reason;
	if (!isJsonString(reason) || !CONDITION_REASON.test(reason)) {
		contractChanged("apiserver Status carries no machine-readable reason");
	}
	const code = record.code;
	if (!isJsonNumber(code) || code < 400 || code >= 600) {
		contractChanged("apiserver Status carries no HTTP failure code");
	}
	return {
		kind: "Status",
		status: isJsonString(record.status) ? record.status : "Failure",
		reason,
		message: isJsonString(record.message)
			? redactClusterText(record.message, 512)
			: "",
		code,
	};
}

/** Parse a core/v1 Namespace. */
export function parseNamespaceRecord(
	body: string,
	options: { readonly createdByHobo: boolean },
): NamespaceRecord {
	const record = decodeObject(body, "Namespace");
	requireKind(record, "Namespace");
	const meta = parseMeta(record, "Namespace", { namespaced: false });
	const status = child(record, "status", "Namespace");
	const phase = status.phase;
	if (
		!isJsonString(phase) ||
		// SAFETY: assertion to `MESPACE_PHASES as readonly string[]).` is required at this boundary.
		!(NAMESPACE_PHASES as readonly string[]).includes(phase)
	) {
		contractChanged(
			`Namespace status.phase ${redactClusterText(String(phase), 32)} is not one of the documented phases`,
		);
	}
	if (meta.createdAtMs === undefined) {
		contractChanged("Namespace metadata.creationTimestamp is missing");
	}
	return {
		name: meta.name,
		uid: meta.uid,
		resourceVersion: meta.resourceVersion,
		// SAFETY: assertion to `ase as NamespacePhase, ` is required at this boundary.
		phase: phase as NamespacePhase,
		createdAtMs: meta.createdAtMs,
		createdByHobo: options.createdByHobo,
	};
}

type Condition = {
	readonly type: string;
	readonly status: string;
	readonly reason: string;
};

function parseConditions(status: JsonObject): readonly Condition[] {
	const raw = status.conditions;
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		contractChanged("Deployment status.conditions is not a list");
	}
	return raw.map((entry) => {
		if (!isJsonObject(entry) || entry === null || Array.isArray(entry)) {
			contractChanged("Deployment status.conditions holds a non-object");
		}
		// SAFETY: assertion to `try as JsonObject; ` is required at this boundary.
		const condition = entry as JsonObject;
		if (!isJsonString(condition.type) || !isJsonString(condition.status)) {
			contractChanged("Deployment condition is missing its type or status");
		}
		return {
			type: condition.type,
			status: condition.status,
			reason: isJsonString(condition.reason) ? condition.reason : "",
		};
	});
}

/**
 * Derive the rollout phase from the counters and conditions the controller
 * actually publishes.
 *
 * Order matters. A failure is reported even when the counters look healthy —
 * `ReplicaFailure` with every old replica still available is exactly the case
 * where "ready" is true and the rollout is dead.
 */
export interface RolloutPhaseResult {
	readonly phase: RolloutPhase;
	readonly failureReason: string;
}

export function rolloutPhaseFor(input: {
	readonly generation: number;
	readonly observedGeneration: number;
	readonly desiredReplicas: number;
	readonly replicas: number;
	readonly updatedReplicas: number;
	readonly availableReplicas: number;
	readonly conditions: readonly Condition[];
}): RolloutPhaseResult {
	const failure = input.conditions.find(
		(condition) =>
			(condition.type === "Progressing" &&
				condition.status === "False" &&
				CONDITION_REASON.test(condition.reason)) ||
			(condition.type === "ReplicaFailure" && condition.status === "True"),
	);
	if (failure !== undefined) {
		return {
			phase: "failed",
			failureReason: CONDITION_REASON.test(failure.reason)
				? failure.reason
				: "ReplicaFailure",
		};
	}
	if (input.observedGeneration < input.generation) {
		return { phase: "pending", failureReason: "" };
	}
	if (
		input.replicas === input.desiredReplicas &&
		input.availableReplicas === input.desiredReplicas &&
		input.updatedReplicas === input.desiredReplicas
	) {
		return { phase: "available", failureReason: "" };
	}
	return { phase: "progressing", failureReason: "" };
}

/** Parse an apps/v1 Deployment, from either the object or its `/status` subresource. */
export function parseDeploymentRecord(body: string): DeploymentRecord {
	const record = decodeObject(body, "Deployment");
	requireKind(record, "Deployment");
	const meta = parseMeta(record, "Deployment", { namespaced: true });
	if (meta.generation === undefined || meta.generation < 1) {
		contractChanged("Deployment metadata.generation is missing");
	}
	const spec = child(record, "spec", "Deployment");
	const desiredReplicas = requireCount(spec, "replicas", "Deployment spec");
	if (desiredReplicas < 1) {
		contractChanged("Deployment spec.replicas is below one");
	}
	// A freshly created Deployment has an empty status. That is not a contract
	// change — it is the pending state, and every counter defaults to zero.
	const status = optionalChild(record, "status");
	const observedGeneration = requireCount(
		status,
		"observedGeneration",
		"Deployment status",
		0,
	);
	if (observedGeneration > meta.generation) {
		contractChanged(
			"Deployment status.observedGeneration is ahead of metadata.generation",
		);
	}
	const updatedReplicas = requireCount(
		status,
		"updatedReplicas",
		"Deployment status",
		0,
	);
	const replicas = requireCount(status, "replicas", "Deployment status", 0);
	const readyReplicas = requireCount(
		status,
		"readyReplicas",
		"Deployment status",
		0,
	);
	const availableReplicas = requireCount(
		status,
		"availableReplicas",
		"Deployment status",
		0,
	);
	if (availableReplicas > readyReplicas) {
		contractChanged(
			"Deployment reports more available replicas than ready ones",
		);
	}
	const conditions = parseConditions(status);
	const { phase, failureReason } = rolloutPhaseFor({
		generation: meta.generation,
		observedGeneration,
		desiredReplicas,
		updatedReplicas,
		replicas,
		availableReplicas,
		conditions,
	});

	return {
		name: meta.name,
		// SAFETY: assertion to `amespace as string, ui` is required at this boundary.
		namespace: meta.namespace as string,
		uid: meta.uid,
		resourceVersion: meta.resourceVersion,
		generation: meta.generation,
		observedGeneration,
		desiredReplicas,
		updatedReplicas,
		readyReplicas,
		availableReplicas,
		phase,
		failureReason,
	};
}

/** Parse a core/v1 Service. ClusterIP only — this provider creates no others. */
export function parseServiceRecord(body: string): ServiceRecord {
	const record = decodeObject(body, "Service");
	requireKind(record, "Service");
	const meta = parseMeta(record, "Service", { namespaced: true });
	const spec = child(record, "spec", "Service");
	if (spec.type !== "ClusterIP") {
		contractChanged(
			`Service type ${redactClusterText(String(spec.type), 32)} is not the ClusterIP this provider asked for`,
		);
	}
	const clusterIp = spec.clusterIP;
	if (
		!isJsonString(clusterIp) ||
		clusterIp === "None" ||
		!(IPV4.test(clusterIp) || IPV6.test(clusterIp))
	) {
		// A headless Service has no address, so a record built from one would
		// promise an endpoint that does not exist.
		contractChanged("Service spec.clusterIP is not a routable cluster address");
	}
	const ports = spec.ports;
	if (!Array.isArray(ports) || ports.length !== 1) {
		contractChanged(
			"Service must expose exactly the one port this provider set",
		);
	}
	// SAFETY: assertion to ` as JsonObject; const` is required at this boundary.
	const port = ports[0] as JsonObject;
	const servicePort = requireCount(port, "port", "Service port");
	const targetPort = requireCount(port, "targetPort", "Service port");
	if (
		servicePort < 1 ||
		servicePort > 65535 ||
		targetPort < 1 ||
		targetPort > 65535
	) {
		contractChanged("Service ports are outside 1..65535");
	}

	return {
		name: meta.name,
		// SAFETY: assertion to `espace as string, clus` is required at this boundary.
		namespace: meta.namespace as string,
		clusterIp,
		port: servicePort,
		targetPort,
		clusterDnsName: `${meta.name}.${meta.namespace}.svc.cluster.local`,
	};
}
