import { KubernetesProviderError } from "./errors.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type StringBag,
} from "./json.js";

const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u;

const DNS_1123_SUBDOMAIN =
	/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$/u;

const IMAGE_REF =
	/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+(:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@sha256:[0-9a-f]{64})$/u;

const LABEL_KEY =
	/^([a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/u;
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/u;

export const MIN_CPU_MILLICORES = 10;
export const MAX_CPU_MILLICORES = 64_000;
export const MIN_MEMORY_BYTES = 4 * 1024 * 1024;
export const MAX_MEMORY_BYTES = 256 * 1024 * 1024 * 1024;
export const MAX_REPLICAS = 100;

export const MAX_SURGE = 1;

// public-contract: dispatcher resource class for Kubernetes placements.
export const PROVIDER_RESOURCE_CLASS = "kubernetes:deployment";

// public-contract: ownership label applied to managed resources.
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
// public-contract: name label applied to managed resources.
export const NAME_LABEL = "app.kubernetes.io/name";
// public-contract: ownership label value used for cleanup fencing.
export const MANAGED_BY_VALUE = "hobo";

export type ResourceQuantity = {
	readonly cpuMillicores: number;
	readonly memoryBytes: number;
};

export type WorkloadPlacement = {
	readonly workloadName: string;
	readonly namespace: string;
	readonly imageRef: string;
	readonly replicas: number;
	readonly containerPort: number;
	readonly requests: ResourceQuantity;
	readonly limits: ResourceQuantity;
	readonly labels: Readonly<Record<string, string>>;
};

const DEFAULT_REQUESTS: ResourceQuantity = {
	cpuMillicores: 250,
	memoryBytes: 128 * 1024 * 1024,
};
const DEFAULT_LIMITS: ResourceQuantity = {
	cpuMillicores: 500,
	memoryBytes: 256 * 1024 * 1024,
};

function jsonKind<T>(value: T): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "array";
	if (isJsonNumber(value)) return "number";
	if (isJsonString(value)) return "string";
	if (value === true || value === false) return "boolean";
	return "object";
}

function rejected(message: string, detail?: Record<string, string | number>) {
	return new KubernetesProviderError("PLACEMENT_REJECTED", message, {
		...(detail !== undefined ? { detail } : undefined),
	});
}

interface QuantitySuffixes {
	readonly [suffix: string]: number;
}

const BINARY_SUFFIXES: QuantitySuffixes = {
	Ki: 1024,
	Mi: 1024 ** 2,
	Gi: 1024 ** 3,
	Ti: 1024 ** 4,
};
const DECIMAL_SUFFIXES: QuantitySuffixes = {
	k: 1000,
	K: 1000,
	M: 1000 ** 2,
	G: 1000 ** 3,
	T: 1000 ** 4,
};

export function parseCpuMillicores<T>(value: T, field: string): number {
	let millicores: number;
	if (isJsonNumber(value)) {
		if (!Number.isFinite(value) || value <= 0) {
			throw rejected(`${field} must be a positive number of cores`);
		}
		millicores = Math.round(value * 1000);
	} else if (isJsonString(value)) {
		const match = /^([0-9]+(?:\.[0-9]+)?)(m?)$/u.exec(value.trim());
		if (match === null) {
			throw rejected(`${field} is not a Kubernetes CPU quantity`, {
				value: value.slice(0, 32),
			});
		}
		const scalar = Number(match[1]);
		millicores =
			match[2] === "m" ? Math.round(scalar) : Math.round(scalar * 1000);
	} else {
		throw rejected(`${field} must be a CPU quantity string or a number`);
	}
	if (millicores < MIN_CPU_MILLICORES || millicores > MAX_CPU_MILLICORES) {
		throw rejected(
			`${field} must be between ${MIN_CPU_MILLICORES}m and ${MAX_CPU_MILLICORES}m`,
			{ millicores },
		);
	}
	return millicores;
}

export function parseMemoryBytes<T>(value: T, field: string): number {
	let bytes: number;
	if (isJsonNumber(value)) {
		if (!Number.isInteger(value) || value <= 0) {
			throw rejected(`${field} must be a positive whole number of bytes`);
		}
		bytes = value;
	} else if (isJsonString(value)) {
		const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|K|M|G|T)?$/u.exec(
			value.trim(),
		);
		if (match === null) {
			throw rejected(`${field} is not a Kubernetes memory quantity`, {
				value: `${value}`.slice(0, 32),
			});
		}
		const scalar = Number(match[1]);
		const suffix = match[2];
		const multiplier =
			suffix === undefined
				? 1
				: (BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix] ?? 1);
		bytes = Math.round(scalar * multiplier);
	} else {
		throw rejected(`${field} must be a memory quantity string or a byte count`);
	}
	if (bytes < MIN_MEMORY_BYTES || bytes > MAX_MEMORY_BYTES) {
		throw rejected(
			`${field} must be between ${MIN_MEMORY_BYTES} and ${MAX_MEMORY_BYTES} bytes`,
			{ bytes },
		);
	}
	return bytes;
}

function requireLabel<T>(value: T, field: string): string {
	if (!isJsonString(value) || !DNS_1123_LABEL.test(value)) {
		throw rejected(`${field} is not an RFC 1123 label`, {
			value: isJsonString(value) ? value.slice(0, 64) : jsonKind(value),
		});
	}
	return `${value}`;
}

function parseQuantityBlock<T>(
	raw: T,
	field: string,
	fallback: ResourceQuantity,
): ResourceQuantity {
	if (raw === undefined) return fallback;
	if (!isJsonObject(raw) || raw === null || Array.isArray(raw)) {
		throw rejected(`${field} must be an object with cpu and memory`);
	}
	// SAFETY: assertion to `as JsonObject; r` is required at this boundary.
	const record = raw as JsonObject;
	return {
		cpuMillicores:
			record.cpu === undefined
				? fallback.cpuMillicores
				: parseCpuMillicores(record.cpu, `${field}.cpu`),
		memoryBytes:
			record.memory === undefined
				? fallback.memoryBytes
				: parseMemoryBytes(record.memory, `${field}.memory`),
	};
}

function parseLabels<T>(raw: T): StringBag {
	if (raw === undefined) return {};
	if (!isJsonObject(raw) || raw === null || Array.isArray(raw)) {
		throw rejected("labels must be a string map");
	}
	const labels: StringBag = {};
	// SAFETY: assertion to `as JsonObject)) {` is required at this boundary.
	for (const [key, value] of Object.entries(raw as JsonObject)) {
		if (!LABEL_KEY.test(key)) {
			throw rejected(
				`label key ${key.slice(0, 64)} is not a Kubernetes label key`,
			);
		}
		if (!isJsonString(value) || !LABEL_VALUE.test(value)) {
			throw rejected(`label ${key.slice(0, 64)} has a non-label value`);
		}
		if (key === MANAGED_BY_LABEL || key === NAME_LABEL) {
			throw rejected(
				`label ${key} is owned by this provider and cannot be set`,
			);
		}
		labels[key] = value;
	}
	return Object.freeze(labels);
}

export function parseWorkloadPlacement<T>(input: T): WorkloadPlacement {
	if (!isJsonObject(input) || input === null || Array.isArray(input)) {
		throw rejected("a placement must be an object");
	}
	// SAFETY: assertion to `t as JsonObject; ` is required at this boundary.
	const record = input as JsonObject;

	const workloadName = requireLabel(record.name, "name");
	const namespace = requireLabel(record.namespace, "namespace");

	const imageRef = record.image;
	if (!isJsonString(imageRef) || !IMAGE_REF.test(imageRef)) {
		throw rejected(
			"image must be a registry-qualified reference with a tag or digest",
			{
				value: isJsonString(imageRef)
					? `${imageRef}`.slice(0, 128)
					: jsonKind(imageRef),
			},
		);
	}

	const replicas = record.replicas === undefined ? 1 : record.replicas;
	if (
		!isJsonNumber(replicas) ||
		!Number.isInteger(replicas) ||
		replicas < 1 ||
		replicas > MAX_REPLICAS
	) {
		throw rejected(`replicas must be a whole number in 1..${MAX_REPLICAS}`);
	}

	const containerPort = record.port === undefined ? 8080 : record.port;
	if (
		!isJsonNumber(containerPort) ||
		!Number.isInteger(containerPort) ||
		containerPort < 1 ||
		containerPort > 65535
	) {
		throw rejected("port must be a whole number in 1..65535");
	}

	const requests = parseQuantityBlock(
		record.requests,
		"requests",
		DEFAULT_REQUESTS,
	);
	const limits = parseQuantityBlock(record.limits, "limits", DEFAULT_LIMITS);

	if (limits.cpuMillicores < requests.cpuMillicores) {
		throw rejected("cpu limit is below the cpu request", {
			limit: limits.cpuMillicores,
			request: requests.cpuMillicores,
		});
	}
	if (limits.memoryBytes < requests.memoryBytes) {
		throw rejected("memory limit is below the memory request", {
			limit: limits.memoryBytes,
			request: requests.memoryBytes,
		});
	}

	return Object.freeze({
		workloadName,
		namespace,
		imageRef,
		replicas,
		containerPort,
		requests,
		limits,
		labels: parseLabels(record.labels),
	});
}

export function clusterDnsName(placement: WorkloadPlacement): string {
	const name = `${placement.workloadName}.${placement.namespace}.svc.cluster.local`;
	if (!DNS_1123_SUBDOMAIN.test(name)) {
		throw rejected(`derived cluster DNS name ${name} is not a subdomain`);
	}
	return name;
}

export const SERVICE_PORT = 80;

export function clusterEndpointUrl(placement: WorkloadPlacement): string {
	return `http://${clusterDnsName(placement)}:${SERVICE_PORT}`;
}

function ownedLabels(placement: WorkloadPlacement): StringBag {
	return {
		...placement.labels,
		[NAME_LABEL]: placement.workloadName,
		[MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
	};
}

export function formatMemoryQuantity(bytes: number): string {
	for (const [suffix, multiplier] of [
		["Gi", BINARY_SUFFIXES.Gi],
		["Mi", BINARY_SUFFIXES.Mi],
		["Ki", BINARY_SUFFIXES.Ki],
	] as const) {
		if (multiplier !== undefined && bytes % multiplier === 0) {
			return `${bytes / multiplier}${suffix}`;
		}
	}
	return String(bytes);
}

export function renderNamespaceManifest(
	placement: WorkloadPlacement,
): JsonObject {
	return {
		apiVersion: "v1",
		kind: "Namespace",
		metadata: {
			name: placement.namespace,
			labels: {
				[MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
			},
		},
	};
}

export function renderDeploymentManifest(
	placement: WorkloadPlacement,
): JsonObject {
	return {
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: {
			name: placement.workloadName,
			namespace: placement.namespace,
			labels: ownedLabels(placement),
		},
		spec: {
			replicas: placement.replicas,
			selector: { matchLabels: { [NAME_LABEL]: placement.workloadName } },
			strategy: {
				type: "RollingUpdate",
				rollingUpdate: { maxSurge: MAX_SURGE, maxUnavailable: 0 },
			},
			template: {
				metadata: { labels: ownedLabels(placement) },
				spec: {
					automountServiceAccountToken: false,
					enableServiceLinks: false,
					securityContext: {
						runAsNonRoot: true,
						seccompProfile: { type: "RuntimeDefault" },
					},
					containers: [
						{
							name: placement.workloadName,
							image: placement.imageRef,
							imagePullPolicy: "IfNotPresent",
							ports: [
								{ containerPort: placement.containerPort, protocol: "TCP" },
							],
							resources: {
								requests: {
									cpu: `${placement.requests.cpuMillicores}m`,
									memory: formatMemoryQuantity(placement.requests.memoryBytes),
								},
								limits: {
									cpu: `${placement.limits.cpuMillicores}m`,
									memory: formatMemoryQuantity(placement.limits.memoryBytes),
								},
							},
							securityContext: {
								allowPrivilegeEscalation: false,
								readOnlyRootFilesystem: true,
								capabilities: { drop: ["ALL"] },
							},
						},
					],
				},
			},
		},
	};
}

export function renderServiceManifest(
	placement: WorkloadPlacement,
): JsonObject {
	return {
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name: placement.workloadName,
			namespace: placement.namespace,
			labels: ownedLabels(placement),
		},
		spec: {
			type: "ClusterIP",
			selector: { [NAME_LABEL]: placement.workloadName },
			ports: [
				{
					name: "http",
					port: SERVICE_PORT,
					targetPort: placement.containerPort,
					protocol: "TCP",
				},
			],
		},
	};
}
